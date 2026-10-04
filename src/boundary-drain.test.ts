import assert from "node:assert";

import { describe, it } from "node:test";

import {
  pushTask,
  responds,
  resumeTask,
  TestHarness,
  thinks,
  userEsc,
} from "./test-helpers/index.js";

describe("boundary drain (rpc flat mode)", () => {
  it("drains a forked task chain inside one run and settles exactly once", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt(
      "main work",
      pushTask("A", "do A", true),
      pushTask("B", "do B", true),
      responds("queued both"),
    );
    h.llm.onPrompt("do A", responds("A report"));
    h.llm.onPrompt("[task-result: A]", responds("noted A"));
    h.llm.onPrompt("do B", responds("B report"));
    h.llm.onPrompt("[task-result: B]", responds("all done"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1, "exactly one settle for the whole drain");
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);

      const finalContext = lastRequestText(h);
      const assistantContext = lastAssistantContextText(h);
      // The raw task transcripts are masked; the results (user-role custom
      // messages) legitimately quote the report text.
      assert.ok(!assistantContext.includes("A report"), "task A transcript must be masked");
      assert.ok(!assistantContext.includes("B report"), "task B transcript must be masked");
      assert.ok(finalContext.includes("noted A"), "mainline replies are kept");
      assert.ok(finalContext.includes("do A"), "delivered prompts are kept");
    } finally {
      h.dispose();
    }
  });

  it("hides the mainline from a fresh task and restores it at finish", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("F", "do F"), responds("queued"));
    h.llm.onPrompt("do F", responds("F report"));
    h.llm.onPrompt("[task-result: F]", responds("consumed"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1);

      const taskContext = requestText(h, 1);
      assert.ok(!taskContext.includes("main work"), "fresh task must not see the mainline history");
      assert.ok(taskContext.includes("do F"), "the delivered prompt is visible to the task");

      const finalContext = lastRequestText(h);
      assert.ok(finalContext.includes("main work"), "mainline history restored after finish");
      assert.ok(
        !lastAssistantContextText(h).includes("F report"),
        "fresh task transcript masked at finish",
      );
    } finally {
      h.dispose();
    }
  });

  it("closes an aborted task epoch at the boundary and settles honestly", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("X", "do X", true), responds("queued"));
    h.llm.onPrompt("do X", responds("partial X answer"));
    h.user.onAssistant("partial X answer", userEsc());
    h.llm.onPrompt("after", responds("ok"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1, "abort-close must not continue the run");
      const dones = h.branchCustomData("task-done");
      assert.strictEqual(dones.length, 1);
      assert.strictEqual((dones[0] as { reason?: string }).reason, "aborted");

      // The epoch is closed: a later prompt must not trip over the open task.
      await h.prompt("after");
      assert.strictEqual(h.settledCount(), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
    } finally {
      h.dispose();
    }
  });

  it("resumes a drained task by checkpoint injection, still settling once", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("R", "do R", true), responds("queued"));
    h.llm.onPrompt("do R", responds("R checkpoint text"));
    h.llm.onPromptSequence("[task-result: R]", [
      [responds("reviewed"), resumeTask("R", "fix the edge case")],
      [responds("all good")],
    ]);
    h.llm.onPrompt("fix the edge case", responds("R fixed"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 1);

      const resumeContext = requestText(h, 3);
      assert.ok(resumeContext.includes("R checkpoint text"), "checkpoint injected");
      assert.ok(resumeContext.includes("fix the edge case"), "resume message delivered");

      assert.ok(
        !lastAssistantContextText(h).includes("R fixed"),
        "resume epoch transcript masked at finish",
      );
    } finally {
      h.dispose();
    }
  });

  it("keeps a client prompt injected mid-drain through the transcript masks", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("A", "do A", true), responds("queued"));
    h.llm.onPrompt("do A", responds("A report"));
    h.llm.onPrompt("[task-result: A]", responds("noted"));
    h.llm.onPrompt("client inject", responds("noted inject"));

    try {
      const run = h.prompt("main work");
      await h.promptFollowUp("client inject");
      await run;

      assert.strictEqual(h.settledCount(), 1);
      const finalContext = lastRequestText(h);
      assert.ok(
        finalContext.includes("client inject"),
        "injected user prompt must survive the masks",
      );
      assert.ok(!lastAssistantContextText(h).includes("A report"), "task transcript masked");
    } finally {
      h.dispose();
    }
  });

  it("leaves queued tasks parked and settles normally when auto is off", async () => {
    const h = await TestHarness.create({ mode: "rpc" });
    h.llm.onPrompt("main work", pushTask("A", "do A", true), responds("queued"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countBranchCustomEntries("task"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 0);
    } finally {
      h.dispose();
    }
  });

  it("rejects tree-navigation commands outside the TUI", async () => {
    const h = await TestHarness.create({ mode: "rpc" });
    h.llm.onPrompt("main work", responds("working"));

    try {
      await h.prompt("main work");

      await h.prompt("/start-task");
      h.assertExtensionError("only available in the TUI");
      await h.prompt("/discard-task");
      h.assertExtensionError("only available in the TUI");
      await h.prompt("/finish-task");
      h.assertExtensionError("only available in the TUI");
      await h.prompt("/abort-task");
      h.assertExtensionError("only available in the TUI");
      await h.prompt("/suspend-task");
      h.assertExtensionError("only available in the TUI");
      await h.prompt("/resume-task go");
      h.assertExtensionError("only available in the TUI");
    } finally {
      h.dispose();
    }
  });

  it("applies the branch tool set to boundary continuations", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("A", "do A", true), responds("queued"));
    // Inside the task run push-task must be hidden: the inner call should be
    // rejected by the active-tool filter, and the retry round replies plainly.
    h.llm.onPromptSequence("do A", [[pushTask("inner", "inner prompt")], [responds("A report")]]);
    h.llm.onPrompt("[task-result: A]", responds("noted"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(
        h.countBranchCustomEntries("task"),
        1,
        "the inner push-task must not have queued (only the outer task entry exists)",
      );
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);
    } finally {
      h.dispose();
    }
  });

  it("settles once per drained epoch across multiple user prompts", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("work one", pushTask("A", "do A", true), responds("queued"));
    h.llm.onPrompt("do A", responds("A report"));
    h.llm.onPrompt("[task-result: A]", responds("noted A"));
    h.llm.onPrompt("work two", pushTask("B", "do B", true), responds("queued"));
    h.llm.onPrompt("do B", responds("B report"));
    h.llm.onPrompt("[task-result: B]", responds("noted B"));

    try {
      await h.prompt("work one");
      assert.strictEqual(h.settledCount(), 1);

      await h.prompt("work two");
      assert.strictEqual(h.settledCount(), 2, "one settle per user-driven epoch");
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
    } finally {
      h.dispose();
    }
  });

  it("does not intercept settles in the TUI (the supervisor loop drains there)", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", pushTask("A", "do A", true), responds("queued"));
    h.llm.onPrompt("do A", responds("A report"));
    h.llm.onPrompt("[task-result: A]", responds("noted"));

    try {
      await h.prompt("/auto");
      await h.prompt("main work");
      await h.waitForAutoParked();

      assert.ok(h.settledCount() > 1, "TUI keeps one settle per run segment");
      // Tree semantics: the task branch lives off the mainline.
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 0);
      assert.strictEqual(h.countAllCustomEntries("task-start"), 1);
      assert.strictEqual(h.countAllCustomEntries("task-done"), 1);
    } finally {
      h.dispose();
    }
  });

  it("keeps draining when a task finishes without a text report", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt(
      "main work",
      pushTask("A", "do A", true),
      pushTask("B", "do B", true),
      responds("queued both"),
    );
    // A's reply carries a thinking block only: the FINISH boundary finds no
    // resultText, but the run must stay alive for the queued B.
    h.llm.onPrompt("do A", thinks("reasoning only"));
    h.llm.onPrompt("without a text report", responds("noted A"));
    h.llm.onPrompt("do B", responds("B report"));
    h.llm.onPrompt("[task-result: B]", responds("all done"));

    try {
      await h.prompt("main work");

      assert.strictEqual(
        h.settledCount(),
        1,
        "an empty result must not settle while the queue is non-empty",
      );
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 2);
      const finalContext = lastRequestText(h);
      assert.ok(
        finalContext.includes("The task finished without a text report"),
        "the empty result is delivered as an explicit notice",
      );
      assert.ok(finalContext.includes("noted A"), "the drain continued past the empty result");
    } finally {
      h.dispose();
    }
  });

  it("restores the mainline history when a fresh task is aborted mid-run", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("F", "do F"), responds("queued"));
    h.llm.onPrompt("do F", responds("partial F answer"));
    h.user.onAssistant("partial F answer", userEsc());
    h.llm.onPrompt("after", responds("ok"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1, "abort-close must not continue the run");
      const dones = h.branchCustomData("task-done") as Array<{ reason?: string }>;
      assert.strictEqual(dones.length, 1);
      assert.strictEqual(dones[0].reason, "aborted");

      await h.prompt("after");
      assert.ok(
        lastRequestText(h).includes("main work"),
        "the restore compaction brings the mainline history back after an aborted fresh task",
      );
    } finally {
      h.dispose();
    }
  });

  it("discards a resume request for an aborted task that left no checkpoint", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt("main work", pushTask("X", "do X", true), responds("queued"));
    h.llm.onPrompt("do X", responds("partial X answer"));
    h.user.onAssistant("partial X answer", userEsc());
    h.llm.onPrompt("resume it", resumeTask("X", "try again"), responds("resume queued"));

    try {
      await h.prompt("main work");
      assert.strictEqual(h.settledCount(), 1);

      await h.prompt("resume it");
      // The abort erased the epoch's text, so there is no checkpoint to
      // inject: the request is consumed with a warning instead of reopening
      // the epoch, and the settle stays honest.
      assert.strictEqual(h.settledCount(), 2);
      assert.strictEqual(h.countBranchCustomEntries("task-resume"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-resume-done"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 1, "no new epoch opened");
      h.assertLastNotification('Resume request discarded: no resumable task titled "X".');
    } finally {
      h.dispose();
    }
  });

  it("runs three queued tasks in FIFO order inside one drained epoch", async () => {
    const h = await createRpcAutoHarness();
    h.llm.onPrompt(
      "main work",
      pushTask("A", "do A", true),
      pushTask("B", "do B", true),
      pushTask("C", "do C", true),
      responds("queued all"),
    );
    h.llm.onPrompt("do A", responds("A report"));
    h.llm.onPrompt("[task-result: A]", responds("noted A"));
    h.llm.onPrompt("do B", responds("B report"));
    h.llm.onPrompt("[task-result: B]", responds("noted B"));
    h.llm.onPrompt("do C", responds("C report"));
    h.llm.onPrompt("[task-result: C]", responds("all done"));

    try {
      await h.prompt("main work");

      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 3);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 3);

      // The requeue preserves branch order: deliveries start A, then B, then C.
      const firstRequestWith = (needle: string): number =>
        h.promptHistory().findIndex((request) => request.some((m) => m.text.includes(needle)));
      const startA = firstRequestWith("[task-start: A]");
      const startB = firstRequestWith("[task-start: B]");
      const startC = firstRequestWith("[task-start: C]");
      assert.ok(startA !== -1 && startB !== -1 && startC !== -1, "all three tasks started");
      assert.ok(startA < startB && startB < startC, "tasks run oldest first");
    } finally {
      h.dispose();
    }
  });
});

function lastRequestText(h: TestHarness): string {
  return requestText(h, h.promptHistory().length - 1);
}

/**
 * Boundary-drain (flat mode) tests: outside the TUI the agent_before_settle
 * handler runs one supervisor action per settle boundary, so agent_settled
 * fires exactly once per drained epoch. Context visibility is asserted
 * against FauxProvider.promptHistory (role/text per LLM request).
 */

function requestText(h: TestHarness, index: number): string {
  const request = h.promptHistory()[index] ?? [];
  return request.map((message) => `${message.role}:${message.text}`).join("\n");
}

/** Text of the assistant-role messages in the most recent LLM request. */
function lastAssistantContextText(h: TestHarness): string {
  const request = h.promptHistory()[h.promptHistory().length - 1] ?? [];
  return request
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
}

/** RPC-mode harness with the auto supervisor armed and parked. */
async function createRpcAutoHarness(): Promise<TestHarness> {
  const h = await TestHarness.create({ mode: "rpc" });
  await h.prompt("/auto");
  await h.waitForAutoParked();
  return h;
}
