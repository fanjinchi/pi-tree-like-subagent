import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assistant,
  pushTask,
  responds,
  task,
  taskResult,
  user,
  TestHarness,
} from "./test-helpers/index.js";

describe("fork tasks", () => {
  it("starts a fork task from the current context without navigation", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "plan work",
      responds("the plan is X"),
      pushTask("implement", "Implement plan X as discussed.", true),
    );
    h.llm.onPrompt("Implement plan X as discussed.", responds("Implemented."));
    h.llm.onPrompt("[task-result: implement]\n\nImplemented.", responds("Great!"));

    try {
      await h.prompt("plan work");
      await h.prompt("/start-task");

      // No navigation: the task branch extends the mainline context.
      h.assertSession(
        user("plan work"),
        assistant("the plan is X", "toolUse"),
        task("implement", "Implement plan X as discussed."),
        user("Implement plan X as discussed."),
        assistant("Implemented."),
      );
      h.assertStatus("current task: implement");
      const starts = h.branchCustomData("task-start") as Array<{ fork?: boolean }>;
      assert.strictEqual(starts.length, 1);
      assert.strictEqual(starts[0].fork, true);

      await h.prompt("/finish-task");

      // Finish returns to the departure leaf; the task work is a side branch.
      h.assertSession(
        user("plan work"),
        assistant("the plan is X", "toolUse"),
        task("implement", "Implement plan X as discussed."),
        taskResult("implement", "Implemented."),
        assistant("Great!"),
      );
      h.assertStatus();
      h.assertSessionContains(user("Implement plan X as discussed."), assistant("Implemented."));
    } finally {
      h.dispose();
    }
  });

  it("fresh tasks still navigate to a clean context", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      await h.prompt("/start-task");
      h.assertSession(user("some prompt"), assistant("Done."));
      const starts = h.branchCustomData("task-start") as Array<{ fork?: boolean }>;
      assert.strictEqual(starts.length, 1);
      assert.strictEqual(starts[0].fork, undefined);
    } finally {
      h.dispose();
    }
  });

  it("push-task with fork announces the fork in its notification", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("work", pushTask("AAA", "some prompt", true));
    try {
      await h.prompt("work");
      h.assertLastNotification(
        "Task stored (forks the current context). Use `/start-task` or `/auto` to start it.",
      );
    } finally {
      h.dispose();
    }
  });
});
