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
  handleTaskBoundary,
  refreshTaskStatus,
  rendererTaskResult,
  setSkillsFromEvent,
  setModelRegistry,
  setupTaskSupervisor,
  syncTaskToolVisibility,
  taskBranchSystemPromptAppend,
  TASK_BRANCH_SYSTEM_PROMPT,
  toolPushTask,
  toolResumeTask,
} from "./src/index.js";

export default function register(pi: ExtensionAPI): void {
  pi.registerTool(toolPushTask(pi));
  pi.registerTool(toolResumeTask(pi));
  pi.registerCommand("start-task", cmdStartTask(pi));
  pi.registerCommand("discard-task", cmdDiscardTask(pi));
  pi.registerCommand("finish-task", cmdFinishTask(pi));
  pi.registerCommand("abort-task", cmdAbortTask(pi));
  pi.registerCommand("resume-task", cmdResumeTask(pi));
  pi.registerCommand("suspend-task", cmdSuspendTask(pi));
  pi.registerCommand("auto", cmdAuto(pi));
  pi.registerCommand("auto-stop", cmdAutoStop());

  pi.registerMessageRenderer("task-result", rendererTaskResult);

  // Session events for the task supervisor (auto mode). The supervisor is
  // armed by /auto, so its park/wake and shutdown handling must not depend
  // on the /auto command ever running.
  setupTaskSupervisor(pi);

  // Flat draining outside the TUI: with auto armed, each settle boundary
  // runs one supervisor action inside the current run, so agent_settled
  // only fires when the queue is truly drained (RPC clients can rely on it).
  pi.on("agent_before_settle", (event, ctx) => handleTaskBoundary(pi, event, ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.systemPromptOptions.skills?.length) {
      setSkillsFromEvent(event.systemPromptOptions.skills);
    }
    // Inside a task branch the system prompt must say so: the branch inherits
    // the mainline transcript (push-task receipt included), and nothing else
    // in the prompt tells the model the task is already running. Contribute the
    // block as a named prompt section (0.87.1) instead of returning
    // systemPrompt: the return value force-replaces the whole prompt and would
    // clobber other extensions' contributions, while sections render at the
    // tail and are recorded in the transcript's system message.
    const branchPrompt = taskBranchSystemPromptAppend(ctx.sessionManager);
    if (branchPrompt) {
      const sections = (event.systemPromptOptions.sections ??= {});
      sections.task_branch = TASK_BRANCH_SYSTEM_PROMPT;
    }
  });

  pi.on("session_start", async (event, ctx) => {
    setModelRegistry(ctx.modelRegistry);
    captureToolOrder(pi.getActiveTools());
    syncTaskToolVisibility(pi, ctx.sessionManager);
    // /auto is on by default for brand-new sessions. Synthesize the command
    // through the normal extension-command dispatch: prompt() executes
    // extension commands before model validation and appends no entry when
    // the command handles the message, so the sole visible effects are the
    // /auto notify and the auto status prefix, and the two byte-stable
    // system prompts stay untouched. The dispatched command context carries
    // the navigation actions the supervisor loop captures, so queued tasks
    // run without /auto ever being typed. Reason semantics: "startup" is the
    // first frame of a normal launch, "new" a /new (runtime replacement)
    // frame; both can still carry a restored old session, so arm only when
    // this session holds no message entries yet (a fresh session has none
    // before its first model turn). "resume"/"fork"/"reload" sessions and
    // restored ones keep their previous state; /auto-stop turns it off for
    // the session.
    if (event.reason === "startup" || event.reason === "new") {
      const freshSession = !ctx.sessionManager.getEntries().some((e) => e.type === "message");
      if (freshSession) {
        try {
          // expandPromptTemplates routes "/auto" through the extension-command
          // pipeline (pi 0.87.1+ forwards it natively); without it the text
          // would reach the model instead of the command handler.
          pi.sendUserMessage("/auto", { expandPromptTemplates: true });
        } catch {
          // Never let a synthesized /auto break session startup.
        }
      }
    }
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
