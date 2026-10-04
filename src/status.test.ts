import assert from "node:assert";
import { describe, it } from "node:test";

import { assistant, pushTask, responds, user, TestHarness } from "./test-helpers/index.js";
import { TASK_START_FRAMING_FRESH, taskStartMarker } from "./index.js";

describe("task status bar", () => {
  it("cycles through pending, current, suspended and back to pending", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("resuming the task", responds("resumed work"));
    h.llm.onPrompt("[task-result: AAA]\n\nresumed work", responds("Nice!"));

    try {
      await h.prompt("main work");
      h.assertStatus("pending task: AAA");

      await h.prompt("/start-task");
      h.assertSession(
        user(taskStartMarker("AAA") + TASK_START_FRAMING_FRESH + "some prompt"),
        assistant("Done."),
      );
      h.assertStatus("current task: AAA");

      // Abort leaves the entry pending, so the task is startable again.
      await h.prompt("/abort-task");
      h.assertStatus("pending task: AAA");

      await h.prompt("/start-task");
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertStatus("suspended: AAA");

      // The finished task stays resumable; the status reflects it.
      await h.prompt("/resume-task");
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("applies color styling to every status variant", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      assert.ok(h.lastStatusRaw?.includes("\x1b["), "pending status not styled");
      h.assertStatus("pending task: AAA");

      await h.prompt("/start-task");
      assert.ok(h.lastStatusRaw?.includes("\x1b["), "current status not styled");
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      assert.ok(h.lastStatusRaw?.includes("\x1b["), "suspended status not styled");
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("pins a persistent widget above the editor while inside a branch", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      // Queued on the mainline: no branch, no widget (the footer status line
      // is squeezed off short terminals like phones, so the widget is the
      // only persistent in-branch marker).
      h.assertWidget(undefined);

      await h.prompt("/start-task");
      h.assertWidget(["任务分支: AAA"]);
      h.assertStatus("current task: AAA");

      // Leaving the branch clears the widget again.
      await h.prompt("/abort-task");
      h.assertWidget(undefined);

      await h.prompt("/start-task");
      h.assertWidget(["任务分支: AAA"]);

      await h.prompt("/finish-task");
      h.assertWidget(undefined);
    } finally {
      h.dispose();
    }
  });
});
