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

describe("model switching on /start-task", () => {
  it("starts task without model arg (existing behavior unchanged)", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });

  it("switches model and restores on finish (substring match)", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task Other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");

      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("switches model via provider/modelId syntax", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task supergsd-test/other-model");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });

  it("notifies when no model matches", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task nonexistent-model-xyz");

      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification('No model matching "nonexistent-model-xyz".');
    } finally {
      h.dispose();
    }
  });

  it("notifies when multiple models match", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "other-model-v1", name: "Other Model V1" },
      { id: "other-model-v2", name: "Other Model V2" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task other-model");

      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification(
        "Ambiguous model: matches supergsd-test/other-model-v1, supergsd-test/other-model-v2.",
      );
    } finally {
      h.dispose();
    }
  });

  it("restores original model across sequential task runs", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("more work", responds("okay"), pushTask("BBB", "other prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("other prompt", responds("inner done"));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("[task-result: BBB]\n\ninner done", responds("nice"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");

      // First task with model switch — restores deterministic on finish
      await h.prompt("/start-task other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");

      // Second task queued from the mainline, started without model arg —
      // keeps the restored model.
      await h.prompt("more work");
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(user("other prompt"), assistant("inner done"));
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
        user("more work"),
        assistant("okay", "toolUse"),
        task("BBB", "other prompt"),
        taskResult("BBB", "inner done"),
        assistant("nice"),
      );
      h.assertStatus("suspended: BBB");
    } finally {
      h.dispose();
    }
  });

  it("independent model switches across sequential tasks", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("more work", responds("okay"), pushTask("BBB", "other prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("other prompt", responds("inner done"));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
    h.llm.onPrompt("[task-result: BBB]\n\ninner done", responds("nice"));

    try {
      await h.prompt("main work");
      await h.prompt("more work");

      // LIFO: BBB starts first, with model-b
      await h.prompt("/start-task model-b");
      h.assertModel("supergsd-test/model-b");
      h.assertSession(user("other prompt"), assistant("inner done"));

      // Finish — restores deterministic
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertStatus("pending task: AAA");

      // AAA starts with model-a
      await h.prompt("/start-task model-a");
      h.assertModel("supergsd-test/model-a");
      h.assertSession(user("some prompt"), assistant("Done."));

      // Finish — restores deterministic again
      await h.prompt("/finish-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        user("more work"),
        assistant("okay", "toolUse"),
        task("BBB", "other prompt"),
        taskResult("BBB", "inner done"),
        assistant("nice"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("warns when previous model unavailable on finish", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      // Switch to model-a (previousModel = deterministic)
      await h.prompt("/start-task model-a");
      h.assertModel("supergsd-test/model-a");
      h.assertSession(user("some prompt"), assistant("Done."));

      // Re-register without deterministic to make it unavailable
      h.modelRegistry.registerProvider("supergsd-test", {
        baseUrl: "memory://supergsd-test",
        apiKey: "test-key",
        api: "supergsd-test-api",
        models: [modelSpec("model-a", "Model A", false), modelSpec("model-b", "Model B", false)],
      });

      // Finish — tries to restore deterministic, which is now unavailable
      await h.prompt("/finish-task");
      // Model stays on model-a (restore failed, active model unchanged)
      h.assertModel("supergsd-test/model-a");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      h.assertLastNotification("Previous model supergsd-test/deterministic no longer available.");
      h.assertStatus("suspended: AAA");
    } finally {
      h.dispose();
    }
  });

  it("restores model on abort-task and leaves task pending", async () => {
    const h = await TestHarness.create();
    registerTestModels(h, [{ id: "other-model", name: "Other Model" }]);

    h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
    h.llm.onPrompt("some prompt", responds("Done."));
    h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

    try {
      await h.prompt("main work");
      h.assertModel("supergsd-test/deterministic");
      await h.prompt("/start-task other");
      h.assertModel("supergsd-test/other-model");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");

      // Abort switches model back and leaves task pending
      await h.prompt("/abort-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
      h.assertLastNotification("Task aborted. Branch abandoned without summary.");

      // Task can be started again (no model arg = deterministic, proving restore)
      await h.prompt("/start-task");
      h.assertModel("supergsd-test/deterministic");
      h.assertSession(user("some prompt"), assistant("Done."));
      h.assertStatus("current task: AAA");
    } finally {
      h.dispose();
    }
  });
});

/** Register extra test models under the supergsd-test provider. */
function registerTestModels(h: TestHarness, models: Array<{ id: string; name: string }>) {
  h.modelRegistry.registerProvider("supergsd-test", {
    baseUrl: "memory://supergsd-test",
    apiKey: "test-key",
    api: "supergsd-test-api",
    models: [
      modelSpec("deterministic", "Deterministic Test Model", true),
      ...models.map((m) => modelSpec(m.id, m.name, false)),
    ],
  });
}

function modelSpec(id: string, name: string, reasoning: boolean) {
  return {
    id,
    name,
    reasoning,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}
