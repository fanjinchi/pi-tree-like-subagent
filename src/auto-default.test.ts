import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  task,
  taskResult,
  user,
  TestHarness,
  type SessionStartEvent,
} from "./test-helpers/index.js";

describe("/auto is on by default for fresh sessions", () => {
  it("arms auto on the fresh-session frame with no transcript entry and no prompt", async () => {
    const h = await TestHarness.create({ sessionStartEvent: STARTUP_SESSION });
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

  it("queued tasks auto-run back to back without /auto or /start-task ever being typed", async () => {
    const h = await TestHarness.create({ sessionStartEvent: STARTUP_SESSION });
    h.llm.onPrompt("main work", responds("working..."), pushTask("quick fix", "Quick fix."));
    h.llm.onPrompt("Quick fix.", responds("Fixed the bug."));
    h.llm.onPrompt("[task-result: quick fix]\n\nFixed the bug.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.waitForAutoParked();

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("quick fix", "Quick fix."),
        taskResult("quick fix", "Fixed the bug."),
        assistant("Great!"),
      );
      h.assertStatus("[auto] suspended: quick fix");
    } finally {
      h.dispose();
    }
  });

  it("does not arm on non-fresh frames; /auto-stop turns it off; the next fresh session re-arms", async () => {
    // A non-fresh frame (the harness default, reason "resume" — a restored
    // session) leaves auto off: no notify, no armed loop — the pre-existing
    // behavior.
    const h = await TestHarness.create();
    try {
      h.assertSession();
      h.assertLastNotification(undefined);
    } finally {
      h.dispose();
    }

    // /auto-stop on a default-armed session turns auto off for the rest of
    // this session: a task pushed afterwards stays queued.
    const h2 = await TestHarness.create({ sessionStartEvent: STARTUP_SESSION });
    h2.llm.onPrompt("main work", responds("working..."), pushTask("queued", "Q task."));
    try {
      await h2.prompt("/auto-stop");
      h2.assertLastNotification(
        "Auto mode off. It stops before the next step; the current task stays resumable.",
      );

      await h2.prompt("main work");
      h2.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("queued", "Q task."),
      );

      // No persistent marker: a brand-new session defaults back on.
      const h3 = await TestHarness.create({ sessionStartEvent: STARTUP_SESSION });
      try {
        h3.assertSession();
        h3.assertLastNotification(AUTO_NOTIFY);
      } finally {
        h3.dispose();
      }
    } finally {
      h2.dispose();
    }
  });
});

/**
 * /auto is on by default for fresh sessions: the root index.ts session_start
 * handler synthesizes "/auto" through the normal extension-command dispatch
 * when the session_start frame reports reason "startup" or "new" and the
 * session holds no message entries yet. These tests pass STARTUP_SESSION —
 * the first frame of a production launch — explicitly; the harness default
 * (reason "resume") acts like a restored session, so pre-existing tests
 * (which never arm) stay byte-exact.
 */

const STARTUP_SESSION: SessionStartEvent = { type: "session_start", reason: "startup" };

const AUTO_NOTIFY =
  "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.";
