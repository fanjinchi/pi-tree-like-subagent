import assert from "node:assert";
import { describe, it } from "node:test";

import { assistant, pushTask, responds, taskAsk, user, TestHarness } from "./test-helpers/index.js";

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
      h.assertSession(user("some prompt"), assistant("Done."));
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

  it("shows awaiting answer while a task question is suspended", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", taskAsk("Which database?"));
    h.llm.onPrompt("[task-question: AAA]", responds("Let me check."));
    h.llm.onPrompt("The answer is SQLite.", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/suspend-task");
      h.assertStatus("awaiting answer: AAA");

      await h.prompt("/resume-task The answer is SQLite.");
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
});
