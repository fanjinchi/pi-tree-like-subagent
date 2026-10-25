import assert from "node:assert";

import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  task,
  user,
  TestHarness,
  type SessionStartEvent,
} from "./test-helpers/index.js";

describe("auto is on by default for rpc sessions only", () => {
  it("arms auto on the rpc session frame with no prompt typed", async () => {
    const h = await TestHarness.create({ mode: "rpc", sessionStartEvent: STARTUP_SESSION });
    try {
      // The synthesized command left no trace in the transcript and never
      // reached the model: the session is empty.
      h.assertSession();
      h.assertLastNotification(AUTO_NOTIFY);
      // The supervisor loop is armed and parked (barrier resolves because
      // the loop is already parked).
      await h.waitForAutoParked();

      // Equivalence with the manual path: the armed state is the /auto state
      // machine, so a later /auto is the already-running no-op warning.
      await h.prompt("/auto");
      h.assertLastNotification("Auto mode is already on.");
    } finally {
      h.dispose();
    }
  });

  it("arms on a resumed rpc session that already holds a transcript", async () => {
    // The plugin-style launch (`pi --mode rpc --session <id>`) reopens an
    // existing session, so the frame's reason is "resume" and the transcript
    // is not empty. The pre-rpc-only rule gated on "no message entries yet"
    // and left such a session unsupervised, which meant a pushed task never
    // drained and the client never got its settle.
    const h = await TestHarness.create({
      mode: "rpc",
      sessionStartEvent: RESUME_SESSION,
      seedSession: (sessionManager) => {
        sessionManager.appendMessage({
          role: "user",
          content: "earlier turn",
          timestamp: Date.now(),
        });
      },
    });
    try {
      h.assertLastNotification(AUTO_NOTIFY);
      await h.waitForAutoParked();

      await h.prompt("/auto");
      h.assertLastNotification("Auto mode is already on.");
    } finally {
      h.dispose();
    }
  });

  it("drains a queued task inside one rpc run and settles exactly once", async () => {
    const h = await TestHarness.create({ mode: "rpc", sessionStartEvent: STARTUP_SESSION });
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));
    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      await h.prompt("main work");

      // The whole chain (start -> task run -> result -> mainline answer) is
      // one run: the client sees a single agent_settled, after the mainline
      // replied, and never a settle while the task is still queued.
      assert.strictEqual(h.settledCount(), 1, "exactly one settle for the whole drain");
      assert.strictEqual(h.countBranchCustomEntries("task-start"), 1);
      assert.strictEqual(h.countBranchCustomEntries("task-done"), 1);

      const requests = h
        .promptHistory()
        .map((request) => request.map((message) => `${message.role}:${message.text}`).join("\n"));
      assert.ok(
        requests.some((text) => text.includes("Quick fix.")),
        "the task prompt was delivered",
      );
      assert.ok(
        requests.some((text) => text.includes("[task-result: quick fix]")),
        "the task result reached the mainline",
      );
      // The last request of this single run carried the delivered result, so
      // the settle above happened after the mainline answer was produced.
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

  it("keeps tui sessions manual: a fresh tui session does not arm", async () => {
    // TUI tree navigation is a human-confirmed workflow: without /auto the
    // supervisor stays off, so a pushed task stays queued for /start-task.
    const h = await TestHarness.create({ sessionStartEvent: STARTUP_SESSION });
    h.llm.onPrompt("main work", responds("working..."), pushTask("queued", "Q task."));
    try {
      h.assertSession();
      h.assertLastNotification(undefined);

      await h.prompt("main work");
      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countAllCustomEntries("task-start"), 0, "nothing auto-started");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("queued", "Q task."),
      );
    } finally {
      h.dispose();
    }
  });

  it("/auto-stop turns rpc supervision off; the next rpc session arms again", async () => {
    const h = await TestHarness.create({ mode: "rpc", sessionStartEvent: STARTUP_SESSION });
    h.llm.onPrompt("main work", responds("working..."), pushTask("queued", "Q task."));
    try {
      await h.prompt("/auto-stop");
      h.assertLastNotification(
        "Auto mode off. It stops before the next step; the current task stays resumable.",
      );
      await h.waitForAutoParked();

      // The boundary gate is off, so the task stays queued and the run settles.
      await h.prompt("main work");
      assert.strictEqual(h.settledCount(), 1);
      assert.strictEqual(h.countAllCustomEntries("task-start"), 0, "task stays queued");

      // No persistent marker: the next rpc session defaults back on.
      const h2 = await TestHarness.create({ mode: "rpc", sessionStartEvent: RESUME_SESSION });
      try {
        h2.assertSession();
        h2.assertLastNotification(AUTO_NOTIFY);
        await h2.waitForAutoParked();
      } finally {
        h2.dispose();
      }
    } finally {
      h.dispose();
    }
  });
});

/**
 * Auto defaults to on for rpc sessions only: the root index.ts session_start
 * handler synthesizes "/auto" through the normal extension-command dispatch
 * whenever `ctx.mode === "rpc"`, whatever the frame's reason. An RPC client
 * has no interactive surface for per-step confirmation and relies on
 * agent_settled to know the work is done, so an unarmed supervisor would
 * leave the queue undrained and settle anyway. TUI sessions keep the manual
 * model, and the harness default frame (reason "resume") stays a legal frame
 * for both.
 */

const STARTUP_SESSION: SessionStartEvent = { type: "session_start", reason: "startup" };

const RESUME_SESSION: SessionStartEvent = { type: "session_start", reason: "resume" };

const AUTO_NOTIFY =
  "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.";
