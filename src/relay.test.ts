import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  resumeTask,
  task,
  taskAsk,
  taskQuestion,
  taskResult,
  user,
  TestHarness,
} from "./test-helpers/index.js";
import {
  TASK_RESUME_FRAMING,
  TASK_START_FRAMING_FRESH,
  taskResumeMarker,
  taskStartMarker,
} from "./index.js";

describe("task relay", () => {
  it("manual mode relays a task question automatically", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));
    h.llm.onPromptSequence("The answer is SQLite.", [
      [resumeTask("AAA", "The answer is SQLite.")],
      [responds("Done.")],
    ]);
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();

      // The question switched back to the mainline on its own — and relay
      // supervision never adds the "[auto] " prefix.
      h.assertStatus("awaiting answer: AAA");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database?"),
        assistant("Let me check."),
      );
      assert.strictEqual(h.countAllCustomEntries("task-ask"), 1);
      const suspended = h.branchCustomData("task-suspended") as Array<{ reason?: string }>;
      assert.strictEqual(suspended.length, 1);
      assert.strictEqual(suspended[0].reason, "ask");

      // Answering on the mainline queues a resume; the relay executes it and
      // switches back into the branch without any command.
      await h.prompt("The answer is SQLite.");
      await h.waitForAutoParked();
      h.assertSession(
        user(taskStartMarker("AAA") + TASK_START_FRAMING_FRESH + "some prompt"),
        assistant("", "toolUse"),
        user(taskResumeMarker("AAA") + TASK_RESUME_FRAMING + "The answer is SQLite."),
        assistant("Done."),
      );
      h.assertStatus("current task: AAA");
      assert.strictEqual(h.countAllCustomEntries("task-resume-done"), 1);

      await h.prompt("/finish-task");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database?"),
        assistant("Let me check."),
        user("The answer is SQLite."),
        assistant("", "toolUse"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("manual mode returns to the branch without user action", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", resumeTask("AAA", "Use SQLite."));
    h.llm.onPrompt("Use SQLite.", responds("Done with SQLite."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone with SQLite.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      // One barrier covers the whole round trip: suspend, mainline answer,
      // resume, and the switch back into the branch.
      await h.waitForAutoParked();
      h.assertStatus("current task: AAA");
      assert.strictEqual(h.countAllCustomEntries("task-ask"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-resume-done"), 1);

      await h.prompt("/finish-task");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database?"),
        assistant("", "toolUse"),
        taskResult("AAA", "Done with SQLite."),
        assistant("Great!"),
      );
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("manual relay never finishes a task", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("half done"));
    h.llm.onPrompt("[task-result: AAA]\n\nhalf done", responds("noted"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();

      // Finishing a run stays the user's decision: the relay parked instead.
      h.assertStatus("current task: AAA");
      h.assertSession(
        user(taskStartMarker("AAA") + TASK_START_FRAMING_FRESH + "some prompt"),
        assistant("half done"),
      );
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 0);
      assert.strictEqual(h.countAllCustomEntries("task-done"), 0);

      await h.prompt("/finish-task");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "half done"),
        assistant("noted"),
      );
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-done"), 1);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("manual relay does not start queued tasks", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("AAA", "first prompt"),
      pushTask("BBB", "second prompt"),
    );
    h.llm.onPrompt("first prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));
    h.llm.onPrompt("Use SQLite.", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();

      // Parked on the mainline: AAA is suspended on its relayed question and
      // BBB is still queued. Starting queued work is /auto's job, so the relay
      // must leave BBB alone — dropping the `auto &&` guard on the loop's
      // queue branch fails on the assertions below.
      h.assertStatus("awaiting answer: AAA");
      assert.strictEqual(h.countAllCustomEntries("task-start"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 1);

      await h.prompt("/resume-task Use SQLite.");
      h.assertStatus("current task: AAA");
      // AAA's own start plus its resumed run — BBB was never started: the
      // relay lifts the queued resume ahead of the task queue.
      assert.strictEqual(h.countAllCustomEntries("task-start"), 2);

      await h.prompt("/finish-task");
      // Starting queued work is /auto's job; BBB stays pending.
      h.assertStatus("pending task: BBB");
      assert.strictEqual(h.countAllCustomEntries("task-start"), 2);
    } finally {
      h.dispose();
    }
  });

  it("/auto upgrades a parked relay supervisor", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("half done"));
    h.llm.onPrompt("[task-result: AAA]\n\nhalf done", responds("noted"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();
      h.assertStatus("current task: AAA");

      // /auto wakes the parked relay and upgrades it in place, so the open
      // task is now finished automatically.
      await h.prompt("/auto");
      await h.waitForAutoParked();
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "half done"),
        assistant("noted"),
      );
      h.assertStatus("[auto] suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("/auto-stop disarms the relay", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("looked around"));
    h.llm.onPrompt("need the schema", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();

      await h.prompt("/auto-stop");
      h.assertLastNotification(
        "Ask relay off. Task questions stay in the branch until /suspend-task; the next /start-task or /resume-task re-arms the relay.",
      );

      // With the relay off, an ask stays in the branch.
      await h.prompt("need the schema");
      h.assertStatus("current task: AAA");
      assert.strictEqual(h.countBranchCustomEntries("task-ask"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 0);
      assert.strictEqual(h.countAllCustomEntries("task-done"), 0);

      // The manual fallback still relays the question.
      await h.prompt("/suspend-task");
      h.assertStatus("awaiting answer: AAA");
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 1);
      const messages = h.lastPromptMessages() ?? [];
      assert.ok(
        messages.some(
          (m) => m.role === "user" && m.text.includes("[task-question: AAA]\n\nWhich database?"),
        ),
        "relayed question missing from the mainline prompt",
      );
    } finally {
      h.dispose();
    }
  });

  it("re-arms the relay on the next /start-task after /auto-stop", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "first prompt"));
    h.llm.onPrompt("first prompt", responds("first done"));
    h.llm.onPrompt(
      "[task-result: AAA]\n\nfirst done",
      responds("Queued BBB."),
      pushTask("BBB", "second prompt"),
    );
    h.llm.onPrompt("second prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: BBB]", responds("Let me check."));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();
      await h.prompt("/auto-stop");

      await h.prompt("/finish-task");
      h.assertStatus("pending task: BBB");

      // /auto-stop only disarms; the next /start-task arms a fresh relay, so
      // BBB's question is relayed without any manual /suspend-task.
      await h.prompt("/start-task");
      await h.waitForAutoParked();
      h.assertStatus("awaiting answer: BBB");
      assert.strictEqual(h.countAllCustomEntries("task-ask"), 1);
      // AAA's "finish" checkpoint plus BBB's relayed question.
      assert.strictEqual(h.countAllCustomEntries("task-suspended"), 2);
      const suspended = h.branchCustomData("task-suspended") as Array<{ reason?: string }>;
      assert.strictEqual(suspended.at(-1)?.reason, "ask");
    } finally {
      h.dispose();
    }
  });

  it("/auto-stop stays off after an /auto upgrade", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("half done"));
    h.llm.onPrompt("[task-result: AAA]\n\nhalf done", responds("noted"));
    h.llm.onPrompt("queue BBB", responds("queued"), pushTask("BBB", "second prompt"));
    h.llm.onPrompt("second prompt", responds("second done"));
    h.llm.onPrompt("[task-result: BBB]\n\nsecond done", responds("noted2"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();
      h.assertStatus("current task: AAA");

      // /auto upgrades the parked relay: the loop finishes the finished task.
      await h.prompt("/auto");
      await h.waitForAutoParked();
      h.assertStatus("[auto] suspended: AAA");

      await h.prompt("/auto-stop");
      h.assertLastNotification(
        "Auto mode off. It stops before the next step; the current task stays resumable.",
      );

      // The upgrade used to latch a re-arm: the queued task would then be
      // started by a supervisor that /auto-stop had just announced as off.
      await h.prompt("queue BBB");
      await h.waitForAutoParked();
      h.assertStatus("pending task: BBB");
      assert.strictEqual(h.countAllCustomEntries("task-start"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-done"), 1);
    } finally {
      h.dispose();
    }
  });

  it("/auto-stop leaves a queued resume request untouched", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted"));
    h.llm.onPrompt("more work", responds("need the schema"), taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));
    h.llm.onPrompt("answer it", resumeTask("AAA", "Use SQLite."));
    h.llm.onPrompt("Use SQLite.", responds("second done"));
    h.llm.onPrompt("[task-result: AAA]\n\nsecond done", responds("noted2"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.waitForAutoParked();
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertStatus("suspended: AAA");

      // Arming the relay through /resume-task must not leave a latch behind.
      await h.prompt("/resume-task more work");
      await h.waitForAutoParked();
      h.assertStatus("awaiting answer: AAA");

      await h.prompt("/auto-stop");
      h.assertLastNotification(
        "Ask relay off. Task questions stay in the branch until /suspend-task; the next /start-task or /resume-task re-arms the relay.",
      );

      // The mainline answers and queues a resume: with the relay off it stays
      // queued instead of being consumed by a resurrected supervisor.
      await h.prompt("answer it");
      await h.waitForAutoParked();
      h.assertStatus("awaiting answer: AAA");
      assert.strictEqual(h.countAllCustomEntries("task-resume-done"), 0);
      assert.strictEqual(h.countAllCustomEntries("task-start"), 2);
    } finally {
      h.dispose();
    }
  });
});
