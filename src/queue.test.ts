import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  resumeTask,
  task,
  taskResult,
  TestHarness,
  user,
} from "./test-helpers/index.js";

describe("task queue (FIFO)", () => {
  it("runs queued tasks in call order and consumes each entry by id", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("AAA", "first prompt"),
      pushTask("BBB", "second prompt"),
      pushTask("CCC", "third prompt"),
    );
    h.llm.onPrompt("first prompt", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted 1"));
    h.llm.onPrompt("second prompt", responds("second done"));
    h.llm.onPrompt("[task-result: BBB]\n\nsecond done", responds("noted 2"));

    try {
      await h.prompt("main work");
      h.assertStatus("pending task: AAA (+2 queued)");
      assert.strictEqual(h.countBranchCustomEntries("task"), 3);

      // FIFO: the oldest entry starts first.
      await h.prompt("/start-task");
      h.assertSession(user("first prompt"), assistant("first done"));
      await h.prompt("/finish-task");
      // Only AAA was consumed; BBB and CCC are still queued.
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
      h.assertStatus("pending task: BBB (+1 queued)");

      await h.prompt("/start-task");
      h.assertSession(user("second prompt"), assistant("second done"));
      await h.prompt("/finish-task");
      h.assertStatus("pending task: CCC");

      // /discard-task drops the queue head (CCC).
      await h.prompt("/discard-task");
      h.assertStatus("suspended: BBB");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 3);
      assert.strictEqual(h.countBranchCustomEntries("task"), 3);
    } finally {
      h.dispose();
    }
  });

  it("keeps legacy task-done entries without ids consuming the newest task", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("AAA", "first prompt"),
      pushTask("BBB", "second prompt"),
    );
    h.llm.onPrompt("first prompt", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted"));

    try {
      await h.prompt("main work");
      h.assertStatus("pending task: AAA (+1 queued)");

      // A stored session from before the FIFO change: the done carries no
      // taskEntryId, so it pops the newest unconsumed task (BBB).
      h.appendCustomEntry("task-done", {});

      // The queue head (AAA) still runs; BBB was consumed by the legacy done.
      await h.prompt("/start-task");
      h.assertSession(user("first prompt"), assistant("first done"));
      await h.prompt("/finish-task");
      h.assertStatus("suspended: AAA");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
    } finally {
      h.dispose();
    }
  });

  it("runs queued resume requests oldest first", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt(
      "[task-result: AAA]\n\nDone.",
      resumeTask("AAA", "First revision."),
      resumeTask("AAA", "Second revision."),
    );
    h.llm.onPrompt("First revision.", responds("First done."));
    h.llm.onPrompt("[task-result: AAA]\n\nFirst done.", responds("ok first"));
    h.llm.onPrompt("Second revision.", responds("Second done."));
    h.llm.onPrompt("[task-result: AAA]\n\nSecond done.", responds("ok second"));

    try {
      await h.prompt("main work");
      await h.prompt("/auto");

      // The first queued request was consumed and reported first.
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("", "toolUse"),
        taskResult("AAA", "First done."),
        assistant("ok first"),
        taskResult("AAA", "Second done."),
        assistant("ok second"),
      );
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);

      // Each done records the entry id of the request it consumed, in FIFO order.
      const requestIds = h.branchCustomEntryIds("task-resume");
      const doneIds = (
        h.branchCustomData("task-resume-done") as Array<{ resumeEntryId?: string }>
      ).map((data) => data.resumeEntryId);
      assert.deepStrictEqual(doneIds, requestIds);
    } finally {
      h.dispose();
    }
  });

  it("keeps legacy task-resume-done entries without ids consuming the newest request", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt(
      "[task-result: AAA]\n\nDone.",
      resumeTask("AAA", "First revision."),
      resumeTask("AAA", "Second revision."),
    );
    h.llm.onPrompt("First revision.", responds("First done."));
    h.llm.onPrompt("[task-result: AAA]\n\nFirst done.", responds("ok first"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");

      const [firstId, secondId] = h.branchCustomEntryIds("task-resume");
      assert.ok(firstId);
      assert.ok(secondId);

      // A stored session from before the FIFO change: the done carries no
      // resumeEntryId, so it pops the newest request (Second revision.).
      h.appendCustomEntry("task-resume-done", {});

      await h.prompt("/auto");

      // "First revision." was not consumed, so it was still the queue head.
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("", "toolUse"),
        taskResult("AAA", "First done."),
        assistant("ok first"),
      );
      assert.deepStrictEqual(h.branchCustomData("task-resume-done"), [
        {},
        { resumeEntryId: firstId },
      ]);
    } finally {
      h.dispose();
    }
  });

  it("removes exactly the resume request named by a task-resume-done id", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt(
      "[task-result: AAA]\n\nDone.",
      resumeTask("AAA", "First revision."),
      resumeTask("AAA", "Second revision."),
    );
    h.llm.onPrompt("First revision.", responds("First done."));
    h.llm.onPrompt("[task-result: AAA]\n\nFirst done.", responds("ok first"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");

      const [firstId, secondId] = h.branchCustomEntryIds("task-resume");
      assert.ok(firstId);
      assert.ok(secondId);

      // The done names the second request, so it must be removed exactly -
      // the first request stays the queue head and runs first.
      h.appendCustomEntry("task-resume-done", { resumeEntryId: secondId });

      await h.prompt("/auto");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("", "toolUse"),
        taskResult("AAA", "First done."),
        assistant("ok first"),
      );
      assert.deepStrictEqual(h.branchCustomData("task-resume-done"), [
        { resumeEntryId: secondId },
        { resumeEntryId: firstId },
      ]);
    } finally {
      h.dispose();
    }
  });

  it("reports the queue position in the push-task receipt", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("single", pushTask("AAA", "first prompt"));
    h.llm.onPrompt("many", pushTask("BBB", "second prompt"), pushTask("CCC", "third prompt"));

    try {
      await h.prompt("single");
      h.assertLastNotification("Task stored. Start it with `/start-task` or `/auto`.");

      await h.prompt("many");
      h.assertLastNotification(
        "Task stored. 3 tasks queued - `/start-task` or `/auto` runs them oldest first.",
      );
      assert.strictEqual(h.countBranchCustomEntries("task"), 3);
    } finally {
      h.dispose();
    }
  });

  it("queues two independent pushes from one turn and runs both", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("planning"),
      pushTask("AAA", "first prompt"),
      pushTask("BBB", "second prompt"),
    );
    h.llm.onPrompt("first prompt", responds("first done"));
    h.llm.onPrompt("[task-result: AAA]\n\nfirst done", responds("noted"));
    h.llm.onPrompt("second prompt", responds("second done"));
    h.llm.onPrompt("[task-result: BBB]\n\nsecond done", responds("noted 2"));

    try {
      await h.prompt("main work");
      // The mock provider runs tool calls in call order, so both entries are
      // queued back to back and both can be started.
      assert.strictEqual(h.countBranchCustomEntries("task"), 2);
      h.assertStatus("pending task: AAA (+1 queued)");

      await h.prompt("/start-task");
      h.assertSession(user("first prompt"), assistant("first done"));
      await h.prompt("/finish-task");
      h.assertStatus("pending task: BBB");

      await h.prompt("/start-task");
      h.assertSession(user("second prompt"), assistant("second done"));
      await h.prompt("/finish-task");
      h.assertStatus("suspended: BBB");
    } finally {
      h.dispose();
    }
  });

  it("ships the proactive push-task prompt text", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("hello", responds("hi"));

    try {
      await h.prompt("hello");
      const prompt = h.systemPromptText();

      assert.ok(
        prompt.includes("default way to handle any request"),
        "proactive default phrasing present",
      );
      assert.ok(prompt.includes("two or more files"), "observable threshold present");
      assert.ok(prompt.includes("runs in call order (oldest first)"), "FIFO rule present");
      assert.ok(
        !prompt.includes("otherwise just do the work inline"),
        "old inline default removed",
      );
      assert.ok(
        !prompt.includes("Do not batch multiple push-task calls"),
        "old same-turn ban removed",
      );
    } finally {
      h.dispose();
    }
  });
});
