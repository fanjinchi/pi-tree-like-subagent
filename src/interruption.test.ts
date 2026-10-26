import assert from "node:assert/strict";
import { test } from "node:test";

import { TASK_INTERRUPTED_FRAMING } from "./index.js";
import {
  fails,
  pushTask,
  responds,
  resumeTask,
  taskResult,
  TestHarness,
} from "./test-helpers/index.js";

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
 * An interrupted task used to leave nothing a later resume could find: the
 * `task-done` checkpoint only feeds the flat RESUME fallback, and a flat
 * resume re-injects a `task-suspended` checkpoint first. Without an anchor
 * written at interrupt time the mainline could not reopen the task the user
 * asked to continue. This pins the whole round trip: interrupt -> report that
 * offers `resume-task` -> queued resume -> reopened epoch carrying the
 * checkpoint and the follow-up input.
 */
test("flat mode anchors an interrupted task and resume-task reopens it", async () => {
  const h = await TestHarness.create({ mode: "rpc", allowAssistantErrors: true });
  await h.waitForAutoParked();
  h.llm.onPrompt(
    "main work",
    responds("Starting the task."),
    pushTask("repair", "Repair the edge case."),
  );
  // Round 1 writes partial output and trips the branch tool guard (a
  // toolResult follows), round 2 is the failed turn pi appends with an empty
  // content array.
  h.llm.onPromptSequence("Repair the edge case.", [
    [responds("Halfway through the repair."), pushTask("nested", "not allowed in a branch")],
    [fails(ERROR_MESSAGE)],
  ]);
  h.llm.onPromptSequence("[task-result: repair]", [
    [responds("Noted, that repair was cut off."), resumeTask("repair", "finish the repair")],
    [responds("Resume accepted.")],
  ]);
  h.llm.onPrompt("finish the repair", responds("Repair completed."));

  await h.prompt("main work");

  // 1. The interruption report offers the resume, conditionally.
  h.assertSessionContains(
    taskResult("repair", expectedReport(ERROR_MESSAGE, "Halfway through the repair.")),
  );

  // 2. The cut epoch left a resumable anchor carrying the partial output.
  const suspended = h.branchCustomData("task-suspended") as Array<{
    content?: string;
    reason?: string;
  }>;
  assert.equal(suspended.length, 1, "the interrupted epoch writes exactly one anchor");
  assert.equal(suspended[0].content, "Halfway through the repair.");
  assert.equal(suspended[0].reason, "interrupted");

  // 3. The queued resume reopened the task and injected the checkpoint plus
  // the follow-up input as the resumed run's context.
  const starts = h.branchCustomData("task-start") as Array<{ resume?: boolean }>;
  assert.equal(starts.length, 2, "the resume opened a second run epoch");
  assert.equal(starts[1].resume, true);
  const resumeRequest = h
    .promptHistory()
    .find((request) => request.some((message) => message.text.includes("Checkpoint:")));
  assert.ok(resumeRequest, "the resumed run must receive a checkpoint request");
  const resumeRequestText = resumeRequest.map((message) => message.text).join("\n");
  assert.ok(resumeRequestText.includes("Checkpoint:"), "checkpoint block injected");
  assert.ok(
    resumeRequestText.includes("Halfway through the repair."),
    "the partial output is the checkpoint",
  );
  assert.ok(resumeRequestText.includes("finish the repair"), "the resume message is delivered");

  // 4. The whole chain drained inside one run: the client settles once.
  assert.equal(h.settledCount(), 1);
  assert.equal(h.countBranchCustomEntries("task-done"), 2);
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
  // Pinned verbatim: this sentence tells the mainline how to reopen the cut
  // task, and it must stay conditional (an instruction to retry would make
  // the mainline relaunch work the user never asked for).
  const resumeHint =
    "\n\nIf the user asks to continue this task, call resume-task to reopen it at this point.";
  return `⚠️ ${TASK_INTERRUPTED_FRAMING}\n\nCause: ${cause}${partial}${resumeHint}`;
}
