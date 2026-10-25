import assert from "node:assert";

import { describe, it } from "node:test";

import { pushTask, responds, TestHarness } from "./test-helpers/index.js";

/**
 * Print mode pins the README's json/print contract: such runs are **not**
 * supervised by default, but a leading `/auto` positional message arms them
 * (`pi -p "/auto" "…"`) and the same one-settle flat drain then applies.
 *
 * The leading command works because print mode hands every positional message
 * to `session.prompt(message)` with no options, so `expandPromptTemplates`
 * defaults to true and "/auto" goes through the extension-command pipeline
 * instead of reaching the model. The harness feeds the same two prompt calls.
 */
describe("boundary drain (print mode)", () => {
  it("drains a queued task inside one run when /auto leads the messages", async () => {
    const h = await TestHarness.create({ mode: "print" });
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));
    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      // Production shape: the first positional message is the command, the
      // second one is the actual request.
      await h.prompt("/auto");
      await h.waitForAutoParked();
      h.assertLastNotification(
        "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.",
      );

      await h.prompt("main work");

      // The whole chain (start -> task run -> result -> mainline answer) is one
      // run: the client sees a single agent_settled, after the mainline replied.
      assert.strictEqual(h.settledCount(), 1, "exactly one settle for the whole drain");
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);

      const requests = h
        .promptHistory()
        .map((request) => request.map((message) => `${message.role}:${message.text}`).join("\n"));
      assert.ok(
        requests.some((text) => text.includes("[task-start: quick fix]")),
        "the task branch-tip delivery was sent",
      );
      const finalRequest = requests[requests.length - 1] ?? "";
      assert.ok(
        finalRequest.includes("[task-result: quick fix]"),
        "final request carried the result",
      );
      assert.ok(finalRequest.includes("Fixed the bug."), "final request carried the report");
    } finally {
      h.dispose();
    }
  });

  it("stays queued without a leading /auto: print runs are not supervised", async () => {
    const h = await TestHarness.create({ mode: "print" });
    h.llm.onPrompt("main work", responds("working..."), pushTask("queued", "Q task."));

    try {
      await h.prompt("main work");

      // No /auto was typed, and print mode must not arm itself the way rpc
      // does: the queue stays parked and the run settles honestly.
      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countBranchCustomEntries("task"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 0, "nothing auto-started");
    } finally {
      h.dispose();
    }
  });
});
