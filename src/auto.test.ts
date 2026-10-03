import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assistant,
  assistantAborted,
  responds,
  pushTask,
  task,
  taskResult,
  user,
  userCtrlC,
  userEsc,
  userPrompts,
  TestHarness,
} from "./test-helpers/index.js";
import { TASK_START_FRAMING_FRESH, taskStartMarker } from "./index.js";

describe("automated workflow", () => {
  it("completes push-task -> /auto -> finish-task and injects the branch result", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));

    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "Fixed the bug."),
        assistant("Great!"),
      );
      h.assertStatus("[auto] suspended: quick fix");
    } finally {
      h.dispose();
    }
  });

  it("turns on with no pending tasks, then auto-executes a later push", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));

    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      // No tasks yet: the switch just turns on and parks.
      await h.prompt("/auto");
      h.assertSession();
      h.assertLastNotification(
        "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.",
      );

      // A task pushed afterwards runs and finishes automatically — no
      // further /auto invocation needed.
      await h.prompt("main work");
      await h.waitForAutoParked();

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "Fixed the bug."),
        assistant("Great!"),
      );
      h.assertStatus("[auto] suspended: quick fix");
    } finally {
      h.dispose();
    }
  });

  it("drains a batch queued in one reply back to back", async () => {
    const h = await TestHarness.create();
    // Two independent pushes in the same assistant reply: both are queued
    // before the turn ends, and /auto runs them oldest first without any
    // further mainline input between them.
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("AAA", "first prompt"),
      pushTask("BBB", "second prompt"),
    );
    h.llm.onPrompt("first prompt", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted 1"));
    h.llm.onPrompt("second prompt", responds("second done"));
    h.llm.onPrompt("[task-result: BBB]\n\nsecond done", responds("noted 2"));

    try {
      await h.prompt("/auto");
      await h.prompt("main work");
      await h.waitForAutoParked();

      assert.strictEqual(h.countBranchCustomEntries("task"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "first prompt"),
        task("BBB", "second prompt"),
        taskResult("AAA", "first done"),
        assistant("noted 1"),
        taskResult("BBB", "second done"),
        assistant("noted 2"),
      );
      h.assertStatus("[auto] suspended: BBB");
    } finally {
      h.dispose();
    }
  });

  it("warns and returns when /auto is already running", async () => {
    const h = await TestHarness.create();
    // Task rule first: the branch delivery carries the "[task-start: ...]"
    // marker plus framing text containing "start", so a mainline rule
    // registered earlier would swallow the branch's first call.
    h.llm.onPrompt("first task", responds("done"));

    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));
    h.llm.onPrompt("[task-result: x]\n\ndone", responds(""));

    // The second /auto runs while the loop is still draining the first task.
    h.user.onAssistant("done", userPrompts("/auto"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user("start"),
        assistant("", "toolUse"),
        task("x", "first task"),
        taskResult("x", "done"),
        assistant(""),
      );
      h.assertStatus("[auto] suspended: x");
    } finally {
      h.dispose();
    }
  });

  it("turns off when the last assistant message is aborted to empty text", async () => {
    const h = await TestHarness.create();
    // Branch rule first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("Implement phase 1.", responds("ABCDEFGHIJ"));

    h.llm.onPrompt("start", responds(""), pushTask("implement phase 1", "Implement phase 1."));
    h.user.onAssistant("FGHI", userEsc());

    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user(
          taskStartMarker("implement phase 1") + TASK_START_FRAMING_FRESH + "Implement phase 1.",
        ),
        assistantAborted(),
      );
      h.assertStatus("current task: implement phase 1");
    } finally {
      h.dispose();
    }
  });

  it("rejects a subtask pushed during a task", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("x", "parent task"));

    // push-task is hidden inside task branches (and guarded at execute time),
    // so the nested call fails and the task finishes with its own report.
    h.llm.onPromptSequence("parent task", [
      [responds("working on parent..."), pushTask("x", "subtask")],
      [responds("parent done")],
    ]);
    h.llm.onPrompt("[task-result: x]\n\nparent done", responds(""));

    try {
      await h.prompt("main work");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("x", "parent task"),
        taskResult("x", "parent done"),
        assistant(""),
      );
      h.assertStatus("[auto] suspended: x");
      // The rejected call never queued a subtask anywhere in the tree.
      assert.strictEqual(h.countAllCustomEntries("task"), 1);
    } finally {
      h.dispose();
    }
  });

  it("delivers a queued steering message when the task finishes, then finalizes", async () => {
    const h = await TestHarness.create();
    // Branch rules first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("Quick fix.", responds("thinking..."));
    h.llm.onPrompt("steer it", responds("adjusted response"));

    h.llm.onPrompt("start", responds(""), pushTask("quick fix", "Quick fix."));

    // Leaf continuations
    h.llm.onPrompt("[task-result: quick fix]\n\nadjusted response", responds(""));
    h.llm.onPrompt("", responds(""));

    h.user.onAssistant("thinking...", userPrompts("steer it"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      // The queued steering message becomes the task branch's next user turn;
      // the branch replies on its own and auto finishes with the adjusted
      // result (pi delivers queued messages at agent_end and emits
      // agent_settled only after the follow-up run).
      h.assertSession(
        user("start"),
        assistant("", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "adjusted response"),
        assistant(""),
      );
      h.assertStatus("[auto] suspended: quick fix");
    } finally {
      h.dispose();
    }
  });

  it("stops when session is shut down during auto", async () => {
    const h = await TestHarness.create();
    // Branch rule first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("Shutdown task", responds("working..."));

    h.llm.onPrompt("start", responds(""), pushTask("x", "Shutdown task"));

    // Leaf continuation (auto re-prompts after detecting Ctrl+C, but task is left open)
    h.llm.onPrompt("", responds(""));

    h.user.onAssistant("working...", userCtrlC());
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user(taskStartMarker("x") + TASK_START_FRAMING_FRESH + "Shutdown task"),
        assistant("working..."),
      );
      h.assertStatus("current task: x");
    } finally {
      h.dispose();
    }
  });

  it("notifies when auto stops before the task branch has replied", async () => {
    const h = await TestHarness.create();
    try {
      // A task-start with no assistant reply after it (e.g. the session was
      // interrupted right after /start-task) must not silently end /auto.
      h.appendCustomEntry("task-start", { title: "AAA", returnTo: "unknown" });
      await h.prompt("/auto");
      await h.waitForAutoParked();
      h.assertLastNotification(
        "Auto stopped: the task agent has not produced a reply yet. Re-run /auto to resume supervision.",
      );
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });

  it("stops on /auto-stop while a task is running", async () => {
    const h = await TestHarness.create();
    // Branch rule first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("first task", responds("working..."));

    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));

    // /auto-stop executes concurrently while the task agent streams; the loop
    // picks up the flag at the next step boundary and leaves the task open.
    h.user.onAssistant("working...", userPrompts("/auto-stop"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertLastNotification(
        "Auto mode off. It stops before the next step; the current task stays resumable.",
      );
      h.assertSession(
        user(taskStartMarker("x") + TASK_START_FRAMING_FRESH + "first task"),
        assistant("working..."),
      );
      h.assertStatus("current task: x");
    } finally {
      h.dispose();
    }
  });

  it("warns when /auto-stop is run with no /auto loop active", async () => {
    const h = await TestHarness.create();
    try {
      await h.prompt("/auto-stop");
      h.assertSession();
      h.assertLastNotification("Auto is not running.");
    } finally {
      h.dispose();
    }
  });

  it("is idempotent under repeated /auto-stop", async () => {
    const h = await TestHarness.create();
    // Branch rule first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("first task", responds("working..."));

    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));

    // Both commands run while the loop is still inside waitForIdle, against
    // the same armed stop closure — a second stop is a no-op re-request.
    h.user.onAssistant("working...", userPrompts("/auto-stop"), userPrompts("/auto-stop"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertLastNotification(
        "Auto mode off. It stops before the next step; the current task stays resumable.",
      );
      h.assertSession(
        user(taskStartMarker("x") + TASK_START_FRAMING_FRESH + "first task"),
        assistant("working..."),
      );
      h.assertStatus("current task: x");
    } finally {
      h.dispose();
    }
  });

  it("keeps a pushed task queued once auto mode is off", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));

    try {
      await h.prompt("/auto");
      h.assertLastNotification(
        "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.",
      );

      await h.prompt("/auto-stop");
      await h.waitForAutoParked();

      // With the switch off, a pushed task stays queued and is not executed.
      await h.prompt("start");

      h.assertSession(user("start"), assistant("", "toolUse"), task("x", "first task"));
      h.assertStatus("pending task: x");
    } finally {
      h.dispose();
    }
  });

  it("resumes supervision after /auto-stop via a new /auto run", async () => {
    const h = await TestHarness.create();
    // Branch rule first: the delivery text contains "start" (marker + framing).
    h.llm.onPrompt("first task", responds("working..."));

    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));

    // Mainline continuation after the second /auto run finalizes the open task.
    h.llm.onPrompt("[task-result: x]\n\nworking...", responds(""));

    h.user.onAssistant("working...", userPrompts("/auto-stop"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");
      await h.waitForAutoParked();
      // First run stopped at the step boundary; the task is left open.
      h.assertStatus("current task: x");

      // Re-running /auto picks the open task back up and finalizes it.
      await h.prompt("/auto");
      await h.waitForAutoParked();

      h.assertSession(
        user("start"),
        assistant("", "toolUse"),
        task("x", "first task"),
        taskResult("x", "working..."),
        assistant(""),
      );
      h.assertStatus("[auto] suspended: x");
    } finally {
      h.dispose();
    }
  });
});
