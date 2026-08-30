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

describe("task-ask", () => {
  it("syncs tool visibility per branch and keeps the system prompt byte-stable", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      const mainlineTools = h.activeToolNames();
      const mainlinePrompt = h.systemPromptText();
      assert.ok(!mainlineTools.includes("task-ask"), "task-ask hidden on mainline");
      assert.ok(mainlineTools.includes("push-task"));
      assert.ok(mainlineTools.includes("resume-task"));

      await h.prompt("/start-task");
      const branchTools = h.activeToolNames();
      assert.ok(branchTools.includes("task-ask"), "task-ask visible in branch");
      assert.ok(!branchTools.includes("push-task"), "push-task hidden in branch");
      assert.ok(!branchTools.includes("resume-task"), "resume-task hidden in branch");

      await h.prompt("/finish-task");
      assert.deepStrictEqual(h.activeToolNames(), mainlineTools);
      assert.strictEqual(h.systemPromptText(), mainlinePrompt);
    } finally {
      h.dispose();
    }
  });

  it("keeps the task-branch system prompt byte-stable across task runs", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("AAA", "prompt aaa"),
      pushTask("BBB", "prompt bbb"),
    );
    // LIFO: BBB starts first.
    h.llm.onPrompt("prompt bbb", responds("bbb done"));
    h.llm.onPrompt("[task-result: BBB]\n\nbbb done", responds("noted"));
    h.llm.onPrompt("prompt aaa", responds("aaa done"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      const firstBranchPrompt = h.systemPromptText();

      await h.prompt("/finish-task");
      await h.prompt("/start-task");
      assert.strictEqual(h.systemPromptText(), firstBranchPrompt);
    } finally {
      h.dispose();
    }
  });

  it("auto relays a task question through the mainline", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database should I use?"));
    h.llm.onPrompt("[task-question: AAA]", resumeTask("AAA", "Use SQLite."));
    h.llm.onPrompt("Use SQLite.", responds("Done with SQLite."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone with SQLite.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/auto");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database should I use?"),
        assistant("", "toolUse"),
        taskResult("AAA", "Done with SQLite."),
        assistant("Great!"),
      );
      assert.strictEqual(h.countAllCustomEntries("task-ask"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 2);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("manual /suspend-task relays the question; /resume-task carries the answer", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));
    h.llm.onPrompt("The answer is SQLite.", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      // task-ask terminated the turn; still inside the branch.
      h.assertStatus("current task: AAA");
      assert.strictEqual(h.countBranchCustomEntries("task-ask"), 1);

      await h.prompt("/suspend-task");
      // The question was relayed to the mainline as a user-visible message.
      const messages = h.lastPromptMessages() ?? [];
      assert.ok(
        messages.some(
          (m) => m.role === "user" && m.text.includes("[task-question: AAA]\n\nWhich database?"),
        ),
        "relayed question missing from the mainline prompt",
      );
      // The relayed question self-instructs the mainline (no external protocol needed).
      assert.ok(
        messages.some((m) => m.role === "user" && m.text.includes("call resume-task")),
        "relay instruction missing from the question message",
      );
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database?"),
        assistant("Let me check."),
      );
      h.assertStatus("awaiting answer: AAA");

      await h.prompt("/resume-task The answer is SQLite.");
      h.assertSession(
        user("some prompt"),
        assistant("", "toolUse"),
        user("The answer is SQLite."),
        assistant("Done."),
      );
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskQuestion("AAA", "Which database?"),
        assistant("Let me check."),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("a direct answer in the branch consumes the ask (no suspend on /auto)", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database?"));
    h.llm.onPrompt("SQLite.", responds("Thanks, done."));
    h.llm.onPrompt("[task-result: AAA]\n\nThanks, done.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      h.assertStatus("current task: AAA");

      // The user answers directly inside the branch instead of suspending.
      await h.prompt("SQLite.");

      await h.prompt("/auto");
      // auto finishes the task instead of suspending it.
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Thanks, done."),
        assistant("Great!"),
      );
      const suspended = h.branchCustomData("task-suspended") as Array<{ reason?: string }>;
      assert.strictEqual(suspended.length, 1);
      assert.strictEqual(suspended[0].reason, "finish");
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("manual /suspend-task without a question records a resumable point", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("half done"));
    h.llm.onPrompt('You are resuming the task "AAA".', responds("all done"));
    h.llm.onPrompt("[task-result: AAA]\n\nall done", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/suspend-task");

      h.assertLastNotification("Task suspended. Resume with `/resume-task` or `/auto`.");
      // The task entry was consumed so /auto does not restart the task.
      h.assertStatus("suspended: AAA");
      const suspended = h.branchCustomData("task-suspended") as Array<{ reason?: string }>;
      assert.strictEqual(suspended.length, 1);
      assert.strictEqual(suspended[0].reason, "manual");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);

      await h.prompt("/resume-task");
      h.assertSession(
        user("some prompt"),
        assistant("half done"),
        user('You are resuming the task "AAA". Continue from where you left off.'),
        assistant("all done"),
      );
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 2);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });
});
