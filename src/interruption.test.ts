import assert from "node:assert/strict";
import { test } from "node:test";

import { TASK_INTERRUPTED_FRAMING } from "./index.js";
import { fails, pushTask, responds, taskResult, TestHarness } from "./test-helpers/index.js";

test("an interrupted task reports the interruption and keeps the partial output", async () => {
  const h = await TestHarness.create();
  h.llm.onPrompt("main work", responds("Starting the task."), pushTask("quick fix", "Quick fix."));
  h.llm.onPrompt("Quick fix.", responds("Halfway through the review."));
  h.llm.onPrompt("[task-result: quick fix]", responds("Understood. I will resume that later."));

  await h.prompt("main work");
  await h.prompt("/start-task");
  // The branch produced text, then its retries ran out: pi appends the failed
  // turn with an empty content array.
  h.appendErrorAssistantTurn(ERROR_MESSAGE);
  await h.prompt("/finish-task");

  h.assertSessionContains(
    taskResult("quick fix", expectedReport(ERROR_MESSAGE, "Halfway through the review.")),
  );
  // The checkpoint must not be empty either: a resumed task needs the partial
  // output to know where it stopped.
  const suspended = h.branchCustomData("task-suspended") as Array<{ content?: string }>;
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0].content, "Halfway through the review.");
});

test("an interrupted task with no text at all still delivers a report", async () => {
  const h = await TestHarness.create({ allowAssistantErrors: true });
  h.llm.onPrompt("main work", responds("Starting the task."), pushTask("quick fix", "Quick fix."));
  h.llm.onPrompt("Quick fix.", fails(ERROR_MESSAGE));
  h.llm.onPrompt("[task-result: quick fix]", responds("Understood."));

  await h.prompt("main work");
  await h.prompt("/start-task");
  await h.prompt("/finish-task");

  h.assertSessionContains(taskResult("quick fix", expectedReport(ERROR_MESSAGE)));
  // Nothing to checkpoint, so the optional content field stays absent.
  const suspended = h.branchCustomData("task-suspended") as Array<{ content?: string }>;
  assert.equal(suspended[0].content, undefined);
});

test("flat mode delivers interruption reports and settles once", async () => {
  const h = await TestHarness.create({ mode: "rpc", allowAssistantErrors: true });
  await h.waitForAutoParked();
  h.llm.onPrompt(
    "main work",
    responds("Starting both tasks."),
    pushTask("A", "Task A."),
    pushTask("B", "Task B."),
  );
  h.llm.onPrompt("Task A.", fails(ERROR_MESSAGE));
  h.llm.onPrompt("Task B.", fails(ERROR_MESSAGE));
  h.llm.onPrompt("[task-result: A]", responds("Task A was cut off."));
  h.llm.onPrompt("[task-result: B]", responds("Task B was cut off too."));

  await h.prompt("main work");

  h.assertSessionContains(taskResult("A", expectedReport(ERROR_MESSAGE)));
  h.assertSessionContains(taskResult("B", expectedReport(ERROR_MESSAGE)));
  assert.equal(h.countBranchCustomEntries("task-done"), 2);
  // Both epochs drained inside the same run: the client gets one completion.
  assert.equal(h.settledCount(), 1);
});

/**
 * A task branch whose last turn is cut off (retries exhausted -> stopReason
 * "error", or a cancelled turn) used to be closed as a normal completion and
 * delivered as an empty `task-result`: the mainline received `content: []` for
 * the work, and auto went on to start the next queued task into the broken
 * model. The report must always carry content, and the partial output the
 * branch did produce must not be thrown away.
 */
const ERROR_MESSAGE = "429: You've reached your 5-hour usage limit";

function expectedReport(cause: string, partialText?: string): string {
  const partial = partialText
    ? `\n\nLast output before the interruption (cut off, not a report):\n${partialText}`
    : "";
  return `⚠️ ${TASK_INTERRUPTED_FRAMING}\n\nCause: ${cause}${partial}`;
}
