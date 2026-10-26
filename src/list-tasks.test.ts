import assert from "node:assert";

import { describe, it } from "node:test";

import {
  callsTool,
  fails,
  pushTask,
  responds,
  resumeTask,
  TestHarness,
} from "./test-helpers/index.js";

describe("list-tasks", () => {
  it("is visible on the mainline only", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]", responds("noted"));

    try {
      await h.prompt("main work");
      assert.ok(h.activeToolNames().includes("list-tasks"), "mainline must expose list-tasks");

      await h.prompt("/start-task");
      assert.ok(
        !h.activeToolNames().includes("list-tasks"),
        "a task branch must not expose list-tasks",
      );

      await h.prompt("/finish-task");
      assert.ok(h.activeToolNames().includes("list-tasks"), "the mainline gets it back");
    } finally {
      h.dispose();
    }
  });

  it("lists a finished task with a checkpoint and resumes it by the listed title", async () => {
    const h = await TestHarness.create({ mode: "rpc" });
    await h.waitForAutoParked();
    h.llm.onPrompt(
      "main work",
      responds("Starting."),
      pushTask("repair the importer", "Repair the importer."),
    );
    h.llm.onPrompt(
      "Repair the importer.",
      responds("Fixed the csv parser and added a regression test."),
    );
    h.llm.onPromptSequence("[task-result: repair the importer]", [
      [callsTool("list-tasks")],
      [resumeTask("repair the importer", "Also cover the quoted fields.")],
    ]);
    h.llm.onPrompt("Also cover the quoted fields.", responds("Covered the quoted fields."));
    h.llm.onPrompt("[task-result: repair the importer]", responds("noted"));

    try {
      await h.prompt("main work");

      const [listing] = listings(h);
      assert.ok(listing, "the model never saw a list-tasks result");
      assert.ok(listing.includes("Tasks in this session: 1 (newest first)"), listing);
      assert.ok(listing.includes('- "repair the importer" - finished, resumable'), listing);
      assert.ok(
        listing.includes("  checkpoint: Fixed the csv parser and added a regression test."),
        listing,
      );
      assert.ok(
        listing.includes('  resume with resume-task(title: "repair the importer", message: ...)'),
        listing,
      );

      // The title quoted by the listing is what resume-task matched: the second
      // start is a resume of the same task entry.
      const starts = h.branchCustomData("task-start") as Array<{
        resume?: boolean;
        taskEntryId?: string;
      }>;
      assert.strictEqual(starts.length, 2);
      assert.strictEqual(starts[0]?.resume, undefined);
      assert.strictEqual(starts[1]?.resume, true);
      assert.ok(starts[1]?.taskEntryId, "the resumed start names its queued task entry");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
      assert.strictEqual(h.settledCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("reports an interrupted task as resumable", async () => {
    const h = await TestHarness.create({ mode: "rpc", allowAssistantErrors: true });
    await h.waitForAutoParked();
    h.llm.onPrompt(
      "main work",
      responds("Starting."),
      pushTask("write review notes", "Write review notes."),
    );
    h.llm.onPrompt("Write review notes.", fails("429 Too Many Requests"));
    h.llm.onPromptSequence("[task-result: write review notes]", [
      [callsTool("list-tasks")],
      [responds("Logged.")],
    ]);

    try {
      await h.prompt("main work");

      const [listing] = listings(h);
      assert.ok(listing, "the model never saw a list-tasks result");
      assert.ok(listing.includes('- "write review notes" - interrupted, resumable'), listing);
      assert.ok(
        listing.includes('  resume with resume-task(title: "write review notes", message: ...)'),
        listing,
      );
      assert.strictEqual(rows(listing).length, 1);
    } finally {
      h.dispose();
    }
  });

  it("marks queued tasks and a discarded one", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "main work",
      responds("queued three"),
      pushTask("first", "first prompt"),
      pushTask("second", "second prompt"),
      pushTask("third", "third prompt"),
    );
    h.llm.onPromptSequence("status please", [[callsTool("list-tasks")], [responds("noted")]]);

    try {
      await h.prompt("main work");
      // /discard-task acts on the queue head, which never started.
      await h.prompt("/discard-task");
      h.assertLastNotification("Task discarded.");

      await h.prompt("status please");

      const [listing] = listings(h);
      assert.ok(listing, "the model never saw a list-tasks result");
      assert.ok(listing.includes("Tasks in this session: 3 (newest first)"), listing);
      assert.deepStrictEqual(rows(listing), [
        '- "third" - queued',
        '- "second" - queued',
        '- "first" - discarded',
      ]);
      assert.ok(!listing.includes("resume with"), "nothing is resumable yet");
    } finally {
      h.dispose();
    }
  });

  it("keeps one row per task across a resume", async () => {
    const h = await TestHarness.create({ mode: "rpc", allowAssistantErrors: true });
    await h.waitForAutoParked();
    h.llm.onPrompt("main work", responds("Starting."), pushTask("joined task", "Do the thing."));
    h.llm.onPrompt("Do the thing.", fails("connection reset"));
    h.llm.onPromptSequence("[task-result: joined task]", [
      [callsTool("list-tasks")],
      [resumeTask("joined task", "carry on")],
      [callsTool("list-tasks")],
    ]);
    h.llm.onPrompt("carry on", responds("Second run finished."));
    h.llm.onPrompt("[task-result: joined task]", responds("noted"));

    try {
      await h.prompt("main work");

      const [before, after] = listings(h);
      assert.ok(before && after, "both list-tasks calls must reach the model");
      assert.ok(before.includes('- "joined task" - interrupted, resumable'), before);

      // Two runs left two `task-start` entries; the listing still shows one row.
      assert.ok(after.includes("Tasks in this session: 1 (newest first)"), after);
      assert.strictEqual(rows(after).length, 1);
      assert.ok(after.includes('- "joined task" - finished, resumable'), after);
      assert.ok(after.includes("  checkpoint: Second run finished."), after);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 2);
    } finally {
      h.dispose();
    }
  });
});

/**
 * Every list-tasks result the model saw, oldest first, one per turn.
 *
 * Requests replay the whole history, so the same tool result shows up in every
 * later request; taking the newest listing of each request and dropping
 * consecutive repeats yields the list of distinct answers.
 */
function listings(h: TestHarness): string[] {
  const seen: string[] = [];
  for (const request of h.promptHistory()) {
    const latest = [...request]
      .reverse()
      .find(
        (message) =>
          message.role === "toolResult" &&
          (message.text.startsWith("Tasks in this session") ||
            message.text === "No tasks in this session."),
      );
    if (latest && seen[seen.length - 1] !== latest.text) seen.push(latest.text);
  }
  return seen;
}

/** Task rows of a listing (`- "<title>" - <status>...`), in listed order. */
function rows(listing: string): string[] {
  return listing.split("\n").filter((line) => line.startsWith('- "'));
}
