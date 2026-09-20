import assert from "node:assert";

import { describe, it } from "node:test";

import { pushTask, responds, TestHarness } from "./test-helpers/index.js";

import { TASK_BRANCH_SYSTEM_PROMPT } from "./index.js";

describe("task delivery framing", () => {
  it("frames a fork start delivery with the marker and the fork framing", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "plan work",
      responds("the plan is X"),
      pushTask("implement", "Implement plan X as discussed.", true),
    );
    h.llm.onPrompt("Implement plan X as discussed.", responds("Implemented."));

    try {
      await h.prompt("plan work");
      await h.prompt("/start-task");

      assert.strictEqual(
        lastUserText(h),
        "[task-start: implement]\n\n" +
          "This task is running now: the push-task call above only queued it and it has since been started. " +
          "The conversation above is the mainline context that produced the task - use it as background, do not redo it. " +
          "Execute the task below; your final message is the report to the mainline.\n\n" +
          "Implement plan X as discussed.",
      );
    } finally {
      h.dispose();
    }
  });

  it("frames a fresh start delivery with the marker and the fresh framing", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("queue AAA", pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));

    try {
      await h.prompt("queue AAA");
      await h.prompt("/start-task");

      assert.strictEqual(
        lastUserText(h),
        "[task-start: AAA]\n\n" +
          "This task is running now: it was queued on the mainline and started here from a fresh context. " +
          "Do not wait for or request a start. Execute the task below; your final message is the report to the mainline.\n\n" +
          "some prompt",
      );
    } finally {
      h.dispose();
    }
  });

  it("falls back to an untitled label when the title sanitizes to empty", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("queue it", pushTask("]", "deliver me"));
    h.llm.onPrompt("deliver me", responds("Done."));

    try {
      await h.prompt("queue it");
      await h.prompt("/start-task");

      assert.strictEqual(
        lastUserText(h),
        "[task-start: untitled]\n\n" +
          "This task is running now: it was queued on the mainline and started here from a fresh context. " +
          "Do not wait for or request a start. Execute the task below; your final message is the report to the mainline.\n\n" +
          "deliver me",
      );
    } finally {
      h.dispose();
    }
  });

  it("frames the default resume delivery with the resume framing", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("You are resuming the task", responds("Resumed."));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      await h.prompt("/resume-task");

      assert.strictEqual(
        lastUserText(h),
        "[task-resume: AAA]\n\n" +
          "This task is running again: the mainline started it here and sent the input below as follow-up " +
          "(review findings, an answer, or a correction). Continue the same task - this is new input, not a new task. " +
          "Your final message is the report to the mainline.\n\n" +
          'You are resuming the task "AAA". Continue from where you left off.',
      );
    } finally {
      h.dispose();
    }
  });

  it("frames a resume delivery that carries an explicit message", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("Fix the edge case.", responds("Fixed."));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");
      await h.prompt("/resume-task Fix the edge case.");

      assert.strictEqual(
        lastUserText(h),
        "[task-resume: AAA]\n\n" +
          "This task is running again: the mainline started it here and sent the input below as follow-up " +
          "(review findings, an answer, or a correction). Continue the same task - this is new input, not a new task. " +
          "Your final message is the report to the mainline.\n\n" +
          "Fix the edge case.",
      );
    } finally {
      h.dispose();
    }
  });
});

/**
 * The rest of the suite composes delivery expectations from the exported
 * constants, so a wording change there would pass unnoticed. These tests pin
 * the *literal* text of the branch-tip deliveries, the verbatim append of the
 * branch block, and the literal opening sentence that must stay self-contained
 * (extensions loaded later append their own blocks after ours).
 */
function lastUserText(h: TestHarness): string {
  const messages = h.lastPromptMessages() ?? [];
  const last = messages[messages.length - 1];
  assert.ok(last, "expected the last LLM stream to contain messages");
  assert.strictEqual(last.role, "user", "expected the delivery to be the last message");
  return last.text;
}

describe("task-branch system prompt", () => {
  it("is appended inside a branch, keeps titles out, and mainline bytes come back", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      const mainlinePrompt = h.systemPromptText();
      assert.ok(
        !mainlinePrompt.includes(TASK_BRANCH_SYSTEM_PROMPT),
        "mainline prompt must not carry the branch block",
      );

      await h.prompt("/start-task");
      const branchPrompt = h.systemPromptText();
      const blockSuffix = `\n\n${TASK_BRANCH_SYSTEM_PROMPT}`;
      assert.strictEqual(branchPrompt.slice(-blockSuffix.length), blockSuffix);
      // The per-branch tool/guideline sections are pre-existing branch
      // behaviour; the block sits below an otherwise untouched base.
      const branchBase = branchPrompt.slice(0, -blockSuffix.length);
      assert.ok(
        branchBase.startsWith(mainlinePrompt.slice(0, mainlinePrompt.indexOf("Available tools:"))),
      );
      assert.ok(
        branchBase.endsWith(
          mainlinePrompt.slice(mainlinePrompt.indexOf("- Be concise in your responses")),
        ),
      );
      assert.ok(branchBase.includes("- task-ask: Ask the mainline orchestrator"));
      assert.ok(!branchBase.includes("push-task is the default way to handle"));
      // Task titles only ever travel in the branch-tip delivery message.
      assert.ok(!branchPrompt.includes("AAA"), "title must not leak into the system prompt");
      // The inherited push-task receipt is neutralized in prose, not in history.
      assert.ok(TASK_BRANCH_SYSTEM_PROMPT.includes("Task stored"));
      // The opening sentence must assert the identity on its own: extensions
      // loaded later append their blocks *after* ours, so position is not authority.
      assert.ok(
        TASK_BRANCH_SYSTEM_PROMPT.startsWith(
          "# Task branch\n\nYou are inside a queued task branch: this task is already running.",
        ),
      );

      await h.prompt("/finish-task");
      assert.strictEqual(h.systemPromptText(), mainlinePrompt);
    } finally {
      h.dispose();
    }
  });

  it("is byte-identical for fresh and fork branches", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt(
      "plan work",
      responds("the plan is X"),
      pushTask("implement", "Implement plan X as discussed.", true),
    );
    h.llm.onPrompt("Implement plan X as discussed.", responds("Implemented."));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      const freshBranchPrompt = h.systemPromptText();
      assert.ok(freshBranchPrompt.includes(TASK_BRANCH_SYSTEM_PROMPT));

      await h.prompt("/finish-task");
      await h.prompt("plan work");
      await h.prompt("/start-task");
      assert.strictEqual(h.systemPromptText(), freshBranchPrompt);
    } finally {
      h.dispose();
    }
  });
});
