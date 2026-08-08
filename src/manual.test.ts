import assert from "node:assert";

import {
  assistant,
  assistantAborted,
  node,
  responds,
  pushTask,
  TestNode,
  task,
  taskResult,
  user,
} from "./test-helpers/index.js";

import { describe } from "node:test";

describe("manual workflow", () => {
  TestNode.run(
    node("push AAA", async (h) => {
      h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
      h.llm.onPrompt("some prompt", responds("Done."));
      h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));
      h.llm.onPrompt("[task-result: AAA]\n\nGreat!", responds("Great!"));
      h.llm.onPrompt("[task-result: AAA]\n\nokay", responds("Great!"));
      h.llm.onPrompt("other prompt", responds("inner done"));
      h.llm.onPrompt("[task-result: BBB]\n\ninner done", responds("Great!"));
      await h.prompt("main work");
      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
      );
      h.assertStatus("pending task: AAA");
    }).children(
      node("discard AAA", async (h) => {
        await h.prompt("/discard-task");
        h.assertSession(
          user("main work"),
          assistant("working...", "toolUse"),
          task("AAA", "some prompt"),
        );
        h.assertStatus();
        h.assertLastNotification("Task discarded.");
      }),
      node("start AAA", async (h) => {
        await h.prompt("/start-task");
        h.assertSession(user("some prompt"), assistant("Done."));
        h.assertStatus("current task: AAA");
      }).children(
        node("finish AAA", async (h) => {
          await h.prompt("/finish-task");
          h.assertSession(
            user("main work"),
            assistant("working...", "toolUse"),
            task("AAA", "some prompt"),
            taskResult("AAA", "Done."),
            assistant("Great!"),
          );
          h.assertStatus();
        }).children(
          node("start [no task]", async (h) => {
            await h.prompt("/start-task");
            h.assertSession(
              user("main work"),
              assistant("working...", "toolUse"),
              task("AAA", "some prompt"),
              taskResult("AAA", "Done."),
              assistant("Great!"),
            );
            h.assertStatus();
            h.assertLastNotification("No pending task. Use push-task first.");
          }),
          node("discard [no task]", async (h) => {
            await h.prompt("/discard-task");
            h.assertSession(
              user("main work"),
              assistant("working...", "toolUse"),
              task("AAA", "some prompt"),
              taskResult("AAA", "Done."),
              assistant("Great!"),
            );
            h.assertStatus();
            h.assertLastNotification("No pending task to discard.");
          }),
          node("finish [no task]", async (h) => {
            await h.prompt("/finish-task");
            h.assertSession(
              user("main work"),
              assistant("working...", "toolUse"),
              task("AAA", "some prompt"),
              taskResult("AAA", "Done."),
              assistant("Great!"),
            );
            h.assertStatus();
            h.assertLastNotification("Not inside task, nothing to finish.");
          }),
          node("abort [no task]", async (h) => {
            await h.prompt("/abort-task");
            h.assertSession(
              user("main work"),
              assistant("working...", "toolUse"),
              task("AAA", "some prompt"),
              taskResult("AAA", "Done."),
              assistant("Great!"),
            );
            h.assertStatus();
            h.assertLastNotification("Not inside task, nothing to abort.");
          }),
        ),
        node("abort AAA", async (h) => {
          await h.prompt("/abort-task");
          h.assertSession(
            user("main work"),
            assistant("working...", "toolUse"),
            task("AAA", "some prompt"),
          );
          h.assertStatus("pending task: AAA");
          h.assertLastNotification("Task aborted. Branch abandoned without summary.");
        }).children(
          node("start AAA", async (h) => {
            await h.prompt("/start-task");
            h.assertSession(user("some prompt"), assistant("Done."));
            h.assertStatus("current task: AAA");
          }).children(
            node("finish AAA", async (h) => {
              await h.prompt("/finish-task");
              h.assertSession(
                user("main work"),
                assistant("working...", "toolUse"),
                task("AAA", "some prompt"),
                taskResult("AAA", "Done."),
                assistant("Great!"),
              );
              h.assertStatus();
            }),
          ),
        ),
        node("push BBB", async (h) => {
          h.llm.onPrompt("some more work", responds("okay"), pushTask("BBB", "other prompt"));
          await h.prompt("some more work");
          h.assertSession(
            user("some prompt"),
            assistant("Done."),
            user("some more work"),
            assistant("okay", "toolUse"),
            task("BBB", "other prompt"),
          );
          h.assertStatus("pending task: BBB");
        }).children(
          node("discard BBB", async (h) => {
            await h.prompt("/discard-task");
            h.assertSession(
              user("some prompt"),
              assistant("Done."),
              user("some more work"),
              assistant("okay", "toolUse"),
              task("BBB", "other prompt"),
            );
            h.assertStatus("current task: AAA");
            h.assertLastNotification("Task discarded.");
          }).children(
            node("finish AAA", async (h) => {
              await h.prompt("/finish-task");
              h.assertSession(
                user("main work"),
                assistant("working...", "toolUse"),
                task("AAA", "some prompt"),
                taskResult("AAA", "okay"),
                assistant("Great!"),
              );
              h.assertStatus();
            }),
          ),
          node("start BBB", async (h) => {
            await h.prompt("/start-task");
            h.assertSession(user("other prompt"), assistant("inner done"));
            h.assertStatus("current task: BBB");
          }).children(
            node("finish BBB", async (h) => {
              await h.prompt("/finish-task");
              h.assertSession(
                user("some prompt"),
                assistant("Done."),
                user("some more work"),
                assistant("okay", "toolUse"),
                task("BBB", "other prompt"),
                taskResult("BBB", "inner done"),
                assistant("Great!"),
              );
              h.assertStatus("current task: AAA");
            }).children(
              node("finish AAA", async (h) => {
                await h.prompt("/finish-task");
                h.assertSession(
                  user("main work"),
                  assistant("working...", "toolUse"),
                  task("AAA", "some prompt"),
                  taskResult("AAA", "Great!"),
                  assistant("Great!"),
                );
                h.assertStatus();
              }),
            ),
            node("abort BBB", async (h) => {
              await h.prompt("/abort-task");
              h.assertSession(
                user("some prompt"),
                assistant("Done."),
                user("some more work"),
                assistant("okay", "toolUse"),
                task("BBB", "other prompt"),
              );
              h.assertStatus("pending task: BBB");
              h.assertLastNotification("Task aborted. Branch abandoned without summary.");
            }).children(
              node("finish AAA", async (h) => {
                await h.prompt("/finish-task");
                h.assertSession(
                  user("main work"),
                  assistant("working...", "toolUse"),
                  task("AAA", "some prompt"),
                  taskResult("AAA", "okay"),
                  assistant("Great!"),
                );
                h.assertStatus();
              }),
            ),
          ),
        ),
      ),
    ),

    node("finish with aborted mainline turn", async (h) => {
      // Reproduce the reported scenario: the model pushes a task, then the
      // follow-up turn ("you can run /start-task") is interrupted before the
      // model can write it, leaving an aborted assistant turn in the mainline.
      h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
      h.llm.onPrompt("some prompt", responds("Done."));
      h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

      await h.prompt("main work");
      h.appendAbortedAssistantTurn();

      await h.prompt("/start-task");
      await h.prompt("/finish-task");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        assistantAborted(),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      // The aborted turn is still in the model's context for the post-result
      // turn (buildSessionContext includes it), so a real LLM tends to
      // continue the interrupted turn instead of processing the result.
      assert.deepStrictEqual(h.lastPromptMessages(), [
        { role: "user", text: "main work" },
        { role: "assistant", text: "working...", stopReason: "toolUse" },
        {
          role: "toolResult",
          text: "Task stored. Use `/start-task` or `/auto` to start it. The user has been notified - do not add any further text after this tool call.",
        },
        { role: "assistant", text: "", stopReason: "aborted" },
        { role: "user", text: "[task-result: AAA]\n\nDone." },
      ]);
      // The interrupted turn is detected and surfaced to the user.
      h.assertLastNotification(
        "Interrupted assistant reply detected before the result (aborted/error turn). The model may continue that old reply instead of the result.",
      );
    }),

    node("finish with normal mainline does not warn", async (h) => {
      h.llm.onPrompt("main work", responds("working..."), pushTask("AAA", "some prompt"));
      h.llm.onPrompt("some prompt", responds("Done."));
      h.llm.onPrompt("[task-result: AAA]\n\nDone.", responds("Great!"));

      await h.prompt("main work");
      await h.prompt("/start-task");
      await h.prompt("/finish-task");

      h.assertSession(
        user("main work"),
        assistant("working...", "toolUse"),
        task("AAA", "some prompt"),
        taskResult("AAA", "Done."),
        assistant("Great!"),
      );
      // The tool result now carries the start instruction, and no interruption
      // warning fires for a clean mainline.
      assert.deepStrictEqual(h.lastPromptMessages(), [
        { role: "user", text: "main work" },
        { role: "assistant", text: "working...", stopReason: "toolUse" },
        {
          role: "toolResult",
          text: "Task stored. Use `/start-task` or `/auto` to start it. The user has been notified - do not add any further text after this tool call.",
        },
        { role: "user", text: "[task-result: AAA]\n\nDone." },
      ]);
      h.assertLastNotification("Task finished. Last response attached.");
    }),

    node("start [no task]", async (h) => {
      h.llm.onPrompt("main work", responds("working..."));
      await h.prompt("main work");
      await h.prompt("/start-task");
      h.assertSession(user("main work"), assistant("working..."));
      h.assertStatus();
      h.assertLastNotification("No pending task. Use push-task first.");
    }),
    node("discard [no task]", async (h) => {
      h.llm.onPrompt("main work", responds("working..."));
      await h.prompt("main work");
      await h.prompt("/discard-task");
      h.assertSession(user("main work"), assistant("working..."));
      h.assertStatus();
      h.assertLastNotification("No pending task to discard.");
    }),
    node("finish [no task]", async (h) => {
      h.llm.onPrompt("main work", responds("working..."));
      await h.prompt("main work");
      await h.prompt("/finish-task");
      h.assertSession(user("main work"), assistant("working..."));
      h.assertStatus();
      h.assertLastNotification("Not inside task, nothing to finish.");
    }),
    node("abort [no task]", async (h) => {
      h.llm.onPrompt("main work", responds("working..."));
      await h.prompt("main work");
      await h.prompt("/abort-task");
      h.assertSession(user("main work"), assistant("working..."));
      h.assertStatus();
      h.assertLastNotification("Not inside task, nothing to abort.");
    }),
  );
});
