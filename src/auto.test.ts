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

describe("automated workflow", () => {
  it("completes push-task -> /auto -> finish-task and injects the branch result", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));

    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/auto");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "Fixed the bug."),
        assistant("Great!"),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("notifies and exits when started with no pending tasks", async () => {
    const h = await TestHarness.create();
    try {
      await h.prompt("/auto");
      h.assertSession();
      h.assertLastNotification("No pending tasks to run.");
    } finally {
      h.dispose();
    }
  });

  it("warns and returns when /auto is already running", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("start", responds(""), pushTask("x", "first task"));

    // Task-execution
    h.llm.onPrompt("first task", responds("done"));
    h.llm.onPrompt("[task-result: x]\n\ndone", responds(""));

    h.user.onAssistant("done", userPrompts("/auto"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");

      h.assertSession(
        user("start"),
        assistant("", "toolUse"),
        task("x", "first task"),
        taskResult("x", "done"),
        assistant(""),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("stops when the last assistant message is aborted to empty text", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("start", responds(""), pushTask("implement phase 1", "Implement phase 1."));

    h.llm.onPrompt("Implement phase 1.", responds("ABCDEFGHIJ"));
    h.user.onAssistant("FGHI", userEsc());

    try {
      await h.prompt("start");

      await h.prompt("/auto");

      h.assertSession(user("Implement phase 1."), assistantAborted());
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

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("x", "parent task"),
        taskResult("x", "parent done"),
        assistant(""),
      );
      h.assertStatus();
      // The rejected call never queued a subtask anywhere in the tree.
      assert.strictEqual(h.countAllCustomEntries("task"), 1);
    } finally {
      h.dispose();
    }
  });

  it("continues processing when user queues a steering message during auto", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("start", responds(""), pushTask("quick fix", "Quick fix."));

    // Task-execution
    h.llm.onPrompt("Quick fix.", responds("thinking..."));
    h.llm.onPrompt("steer it", responds("adjusted response"));

    // Leaf continuations
    h.llm.onPrompt("[task-result: quick fix]\n\nadjusted response", responds(""));
    h.llm.onPrompt("", responds(""));

    h.user.onAssistant("thinking...", userPrompts("steer it"));
    try {
      await h.prompt("start");

      await h.prompt("/auto");

      h.assertSession(
        user("start"),
        assistant("", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "adjusted response"),
        assistant(""),
      );
      h.assertStatus();
    } finally {
      h.dispose();
    }
  });

  it("stops when session is shut down during auto", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("start", responds(""), pushTask("x", "Shutdown task"));

    // Task-execution
    h.llm.onPrompt("Shutdown task", responds("working..."));

    // Leaf continuation (auto re-prompts after detecting Ctrl+C, but task is left open)
    h.llm.onPrompt("", responds(""));

    h.user.onAssistant("working...", userCtrlC());
    try {
      await h.prompt("start");

      await h.prompt("/auto");

      h.assertSession(user("Shutdown task"), assistant("working..."));
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
      h.assertLastNotification(
        "Auto stopped: the task agent has not produced a reply yet. Re-run /auto to resume supervision.",
      );
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });
});
