import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  captureToolOrder,
  cmdAbortTask,
  cmdAuto,
  cmdAutoStop,
  cmdDiscardTask,
  cmdFinishTask,
  cmdResumeTask,
  cmdStartTask,
  cmdSuspendTask,
  refreshTaskStatus,
  rendererTaskQuestion,
  rendererTaskResult,
  setSkillsFromEvent,
  setModelRegistry,
  setupTaskSupervisor,
  syncTaskToolVisibility,
  taskBranchSystemPromptAppend,
  toolPushTask,
  toolResumeTask,
  toolTaskAsk,
} from "./src/index.js";

export default function register(pi: ExtensionAPI): void {
  pi.registerTool(toolPushTask(pi));
  pi.registerTool(toolResumeTask(pi));
  pi.registerTool(toolTaskAsk(pi));
  pi.registerCommand("start-task", cmdStartTask(pi));
  pi.registerCommand("discard-task", cmdDiscardTask(pi));
  pi.registerCommand("finish-task", cmdFinishTask(pi));
  pi.registerCommand("abort-task", cmdAbortTask(pi));
  pi.registerCommand("resume-task", cmdResumeTask(pi));
  pi.registerCommand("suspend-task", cmdSuspendTask(pi));
  pi.registerCommand("auto", cmdAuto(pi));
  pi.registerCommand("auto-stop", cmdAutoStop());

  pi.registerMessageRenderer("task-result", rendererTaskResult);
  pi.registerMessageRenderer("task-question", rendererTaskQuestion);

  // Session events for the task supervisor (auto / relay). The supervisor can
  // be armed by /auto, /start-task, or /resume-task, so its park/wake and
  // shutdown handling must not depend on the /auto command ever running.
  setupTaskSupervisor(pi);

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.systemPromptOptions.skills?.length) {
      setSkillsFromEvent(event.systemPromptOptions.skills);
    }
    // Inside a task branch the system prompt must say so: the branch inherits
    // the mainline transcript (push-task receipt included), and nothing else
    // in the prompt tells the model the task is already running.
    const branchAppend = taskBranchSystemPromptAppend(ctx.sessionManager);
    return branchAppend ? { systemPrompt: event.systemPrompt + branchAppend } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    setModelRegistry(ctx.modelRegistry);
    captureToolOrder(pi.getActiveTools());
    syncTaskToolVisibility(pi, ctx.sessionManager);
    refreshTaskStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshTaskStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    syncTaskToolVisibility(pi, ctx.sessionManager);
    refreshTaskStatus(ctx);
  });
}
