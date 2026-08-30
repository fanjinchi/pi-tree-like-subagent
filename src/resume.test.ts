import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  resumeTask,
  task,
  taskAsk,
  taskResult,
  user,
  TestHarness,
} from "./test-helpers/index.js";

describe("resume-task", () => {
  it("finish records a resumable point and /resume-task navigates back with a message", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("Fix the edge case.", responds("Fixed."));
    h.llm.onPrompt("[task-result: AAA]\n\nFixed.", responds("Thanks!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 1);

      await h.prompt("/resume-task Fix the edge case.");
      // The resumed branch extends the original task branch.
      h.assertSession(
        user("some prompt"),
        assistant("Done."),
        user("Fix the edge case."),
        assistant("Fixed."),
      );
      h.assertStatus("current task: AAA");
      const starts = h.branchCustomData("task-start") as Array<{ resume?: boolean }>;
      assert.strictEqual(starts[starts.length - 1].resume, true);

      await h.prompt("/finish-task");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
        taskResult("AAA", "Fixed."),
        assistant("Thanks!"),
      );
      // The task entry was consumed exactly once (first finish); the resumed
      // finish only records a fresh resumable point.
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 2);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("resume-task tool queues a request that /auto executes", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", resumeTask("AAA", "Please revise."));
    h.llm.onPrompt("Please revise.", responds("Revised."));
    h.llm.onPrompt("[task-result: AAA]\n\nRevised.", responds("ok"));

    try {
      await h.prompt("main work");
      await h.prompt("/auto");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("", "toolUse"),
        taskResult("AAA", "Revised."),
        assistant("ok"),
      );
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("aborted task is resumable and the resumed finish consumes its pending entry", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt('You are resuming the task "AAA".', responds("Resumed."));
    h.llm.onPrompt("[task-result: AAA]\n\nResumed.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/abort-task");
      h.assertStatus("pending task: AAA");
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 1);

      await h.prompt("/resume-task");
      h.assertSession(
        user("some prompt"),
        assistant("Done."),
        user('You are resuming the task "AAA". Continue from where you left off.'),
        assistant("Resumed."),
      );
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      // Abort left the task entry pending; the resumed run's finish consumes it.
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      h.assertStatus("suspended: AAA");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Resumed."),
        assistant("Great!"),
      );
    } finally {
      h.dispose();
    }
  });

  it("multiple resume cycles keep entry accounting stable", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("v1"));
    h.llm.onPrompt("[task-result: AAA]\n\nv1", responds("noted"));
    h.llm.onPrompt("round two", responds("v2"));
    h.llm.onPrompt("[task-result: AAA]\n\nv2", responds("noted"));
    h.llm.onPrompt("round three", responds("v3"));
    h.llm.onPrompt("[task-result: AAA]\n\nv3", responds("noted"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      await h.prompt("/resume-task round two");
      await h.prompt("/finish-task");
      await h.prompt("/resume-task round three");
      await h.prompt("/finish-task");

      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-suspended"), 3);
      // task-start entries live on side branches, never on the mainline.
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 0);
      h.assertStatus("suspended: AAA");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "v1"),
        assistant("noted"),
        taskResult("AAA", "v2"),
        assistant("noted"),
        taskResult("AAA", "v3"),
        assistant("noted"),
      );
    } finally {
      h.dispose();
    }
  });

  it("branch guards reject cross-context tool calls", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("working in branch..."));
    h.llm.onPromptSequence("continue", [
      [pushTask("BBB", "nested")],
      [resumeTask(undefined, "resume from branch")],
      [responds("done")],
    ]);
    h.llm.onPrompt("[task-result: AAA]\n\ndone", responds("noted"));
    h.llm.onPromptSequence("mainline ask", [[taskAsk("question from mainline")], [responds("ok")]]);

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");

      // push-task/resume-task are hidden inside branches; force-activate them
      // to reach the execute-time guards.
      h.setActiveToolNames([...h.activeToolNames(), "push-task", "resume-task"]);
      await h.prompt("continue");

      const inBranchMessages = h.lastPromptMessages() ?? [];
      assert.ok(
        inBranchMessages.some(
          (m) =>
            m.role === "toolResult" &&
            m.text.includes("Cannot queue a task from inside a task branch"),
        ),
        "push-task guard error missing",
      );
      assert.ok(
        inBranchMessages.some(
          (m) =>
            m.role === "toolResult" &&
            m.text.includes("Cannot queue a task resume from inside a task branch"),
        ),
        "resume-task guard error missing",
      );
      assert.strictEqual(h.countAllCustomEntries("task"), 1);

      await h.prompt("/finish-task");

      // task-ask is hidden outside branches; force-activate to reach the guard.
      h.setActiveToolNames([...h.activeToolNames(), "task-ask"]);
      await h.prompt("mainline ask");
      const mainlineMessages = h.lastPromptMessages() ?? [];
      assert.ok(
        mainlineMessages.some(
          (m) =>
            m.role === "toolResult" &&
            m.text.includes("task-ask is only available inside a task branch"),
        ),
        "task-ask guard error missing",
      );
      assert.strictEqual(h.countAllCustomEntries("task-ask"), 0);
    } finally {
      h.dispose();
    }
  });

  it("reports when there is nothing to resume", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."));
    try {
      await h.prompt("main work");
      await h.prompt("/resume-task");
      h.assertLastNotification(
        "No resumable task. A task becomes resumable after it is finished, aborted, or suspended.",
      );
      h.assertSession(user("main work"), assistant("working..."));
    } finally {
      h.dispose();
    }
  });

  it("a resumed finish does not consume an unrelated queued task", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("noted"));
    h.llm.onPrompt("queue BBB", responds("ok"), pushTask("BBB", "bbb prompt"));
    h.llm.onPrompt("Fix AAA.", responds("Fixed."));
    h.llm.onPrompt("[task-result: AAA]\n\nFixed.", responds("noted"));
    h.llm.onPrompt("bbb prompt", responds("BBB done."));
    h.llm.onPrompt("[task-result: BBB]\n\nBBB done.", responds("all done"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      await h.prompt("queue BBB");

      await h.prompt("/resume-task Fix AAA.");
      await h.prompt("/finish-task");

      // Regression: plain done/task counting below AAA's entry offset its
      // consuming done against BBB's entry and silently consumed BBB.
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      h.assertStatus("pending task: BBB");

      await h.prompt("/start-task");
      h.assertSession(user("bbb prompt"), assistant("BBB done."));

      await h.prompt("/finish-task");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
      h.assertStatus("suspended: BBB");
    } finally {
      h.dispose();
    }
  });

  it("discards a titled resume request that matches no suspended task", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", resumeTask("Nope", "findings for nothing"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      // The result turn queued a resume request for a title that does not exist.
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 1);

      await h.prompt("/resume-task");
      h.assertLastNotification('Resume request discarded: no suspended task titled "Nope".');
      // Consumed (so /auto would not stall) and no navigation happened.
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 0);
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("shows the queued resume in the status bar", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", resumeTask("AAA", "fix it"));

    try {
      await h.prompt("main work");
      h.assertStatus("pending resume: AAA");
    } finally {
      h.dispose();
    }
  });
});
