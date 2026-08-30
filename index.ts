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
  rendererTaskQuestion,
  rendererTaskResult,
  setSkillsFromEvent,
  setModelRegistry,
  syncTaskToolVisibility,
  toolPushTask,
  toolResumeTask,
  toolTaskAsk,
  updateTaskStatus,
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

  pi.on("before_agent_start", async (event) => {
    if (event.systemPromptOptions.skills?.length) {
      setSkillsFromEvent(event.systemPromptOptions.skills);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    setModelRegistry(ctx.modelRegistry);
    captureToolOrder(pi.getActiveTools());
    syncTaskToolVisibility(pi, ctx.sessionManager);
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme);
  });

  pi.on("session_tree", async (_event, ctx) => {
    syncTaskToolVisibility(pi, ctx.sessionManager);
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme);
  });
}
