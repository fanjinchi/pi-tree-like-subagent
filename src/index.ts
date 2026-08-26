import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type MessageRenderer,
  type ModelRegistry,
  type RegisteredCommand,
  type SessionEntry,
  type SessionMessageEntry,
  type Skill,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { Api, Model } from "@earendil-works/pi-ai";

import { Box, Text, type AutocompleteItem } from "@earendil-works/pi-tui";

import { Type, type Static } from "typebox";

import { renderTextContent, taskResultTextContent } from "./text-content.js";

export function toolPushTask(pi: PushTaskAPI): ToolDefinition {
  return defineTool({
    name: "push-task",
    label: "Push Task",
    description: "Store a task prompt for a user-started navigation branch.",
    promptSnippet: "Store a focused task prompt for a user-started navigation branch.",
    promptGuidelines: [
      "Use push-task to hand off a self-contained task for isolated execution.",
      "Use fork: true when the task depends on the current conversation (e.g. implementing a plan just discussed); the task branch then inherits the current context instead of starting fresh.",
      "Do not batch multiple push-task calls together, and do not mix push-task with other tool calls in the same turn.",
      "push-task notifies the user itself; do not write any further text in the same turn after calling it.",
    ],
    parameters: pushTaskParameters,
    renderCall(args: PushTaskParams, theme, context) {
      const title = args.title.trim();
      const forkMarker = args.fork ? " (fork)" : "";
      const header = theme.fg("toolTitle", theme.bold(`push-task: ${title}${forkMarker}`));
      return renderCollapsibleToolCall(header, args.prompt, theme, context.expanded);
    },
    renderResult() {
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params: PushTaskParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Task storage aborted.");
      }

      if (currentTask(ctx.sessionManager)) {
        throw new Error(
          "Cannot queue a task from inside a task branch. Finish or abort the current task first, then queue the task from the mainline.",
        );
      }

      const title = params.title.trim();
      const fork = params.fork === true;

      const { rewritten, unresolved } = resolveSkillRefs(params.prompt);

      pi.appendEntry(TASK_ENTRY_TYPE, {
        title,
        prompt: rewritten,
        ...(fork ? { fork: true } : {}),
      });

      const storedMessage = fork
        ? "Task stored (forks the current context). Use `/start-task` or `/auto` to start it."
        : "Task stored. Use `/start-task` or `/auto` to start it.";

      if (ctx.hasUI) {
        refreshTaskStatus(ctx);
        if (unresolved.length > 0) {
          const names = unresolved.map((n) => `/skill:${n}`).join(", ");
          ctx.ui.notify(`Warning: ${names} were not resolved.\n${storedMessage}`, "warning");
        } else {
          ctx.ui.notify(storedMessage, "info");
        }
      }

      return {
        content: [
          {
            type: "text",
            text: storedMessage,
          },
        ],
        details: {
          title,
          prompt: rewritten,
          ...(fork ? { fork: true } : {}),
        },
        terminate: true,
      };
    },
  });
}

export function toolResumeTask(pi: ResumeTaskAPI): ToolDefinition {
  return defineTool({
    name: "resume-task",
    label: "Resume Task",
    description:
      "Queue a resume of a finished, aborted, or suspended task branch, carrying a message (e.g. review findings) back into the task context.",
    promptSnippet: "Queue a resume of a suspended task branch with a message.",
    promptGuidelines: [
      "Use resume-task to send follow-up input (review findings, answers, corrections) into a task branch that finished, aborted, or was suspended.",
      "resume-task queues the resume; it takes effect when the user runs /resume-task or /auto.",
      "resume-task notifies the user itself; do not write any further text in the same turn after calling it.",
      "Do not batch multiple resume-task calls together, and do not mix resume-task with other tool calls in the same turn.",
    ],
    parameters: resumeTaskParameters,
    renderCall(args: ResumeTaskParams, theme, context) {
      const title = args.title?.trim() || "latest suspended task";
      const header = theme.fg("toolTitle", theme.bold(`resume-task: ${title}`));
      return renderCollapsibleToolCall(header, args.message, theme, context.expanded);
    },
    renderResult() {
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params: ResumeTaskParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Resume request aborted.");
      }

      if (currentTask(ctx.sessionManager)) {
        throw new Error(
          "Cannot queue a task resume from inside a task branch. Finish or abort the current task first, then resume from the mainline.",
        );
      }

      const title = params.title?.trim() || undefined;

      pi.appendEntry(TASK_RESUME_ENTRY_TYPE, {
        ...(title ? { title } : {}),
        message: params.message,
      });

      if (ctx.hasUI) {
        refreshTaskStatus(ctx);
        ctx.ui.notify("Resume queued. Run `/resume-task` or `/auto` to execute it.", "info");
      }

      return {
        content: [
          {
            type: "text",
            text: "Resume queued. It takes effect via `/resume-task` or `/auto`.",
          },
        ],
        details: {
          title,
          message: params.message,
        },
        terminate: true,
      };
    },
  });
}

export function toolTaskAsk(pi: TaskAskAPI): ToolDefinition {
  return defineTool({
    name: "task-ask",
    label: "Task Ask",
    description:
      "Ask the mainline orchestrator a question from inside a task branch. The task suspends until the answer arrives via resume.",
    promptSnippet: "Ask the mainline orchestrator a question from inside a task branch.",
    promptGuidelines: [
      "Use task-ask only inside a task branch when you need information or a decision from the mainline orchestrator to continue the task.",
      "After calling task-ask, stop working and wait: the question is recorded and relayed to the mainline (automatically under /auto, or when the user runs /suspend-task); the answer arrives as a resume message. Do not call other tools alongside task-ask.",
      "If the question needs a human answer and a user-question tool (such as ask_user_question) is available, prefer it over relaying through the mainline - it works inside task branches and resumes your turn directly.",
      "task-ask is not for the final report - the last assistant message of a task is its report.",
    ],
    parameters: taskAskParameters,
    renderCall(args: TaskAskParams, theme, context) {
      const header = theme.fg("toolTitle", theme.bold("task-ask"));
      return renderCollapsibleToolCall(header, args.question, theme, context.expanded);
    },
    renderResult() {
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params: TaskAskParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Task question aborted.");
      }

      if (!currentTask(ctx.sessionManager)) {
        throw new Error("task-ask is only available inside a task branch.");
      }

      pi.appendEntry(TASK_ASK_ENTRY_TYPE, { question: params.question });

      if (ctx.hasUI) {
        ctx.ui.notify(
          "Task question recorded. The task suspends automatically under /auto; otherwise run /suspend-task to relay it, or answer it directly in this branch.",
          "info",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: "Question recorded; the task is now waiting for an answer. Under /auto the task suspends and the question is relayed to the mainline orchestrator automatically; otherwise the user may relay it with /suspend-task or answer directly in this branch. The answer arrives as a resume message. Stop working until the answer arrives.",
          },
        ],
        details: { question: params.question },
        terminate: true,
      };
    },
  });
}

export function cmdStartTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Navigate to a fresh context and inject the active task prompt",
    getArgumentCompletions: (argumentPrefix: string) => {
      if (!modelRegistry) return null;
      return getModelCompletions(argumentPrefix, modelRegistry);
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const modelArg = args.trim() || undefined;
      await startTask(pi, ctx, { modelArg });
    },
  };
}

export function cmdDiscardTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Discard the active task without executing it",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await discardTask(pi, ctx);
    },
  };
}

export function cmdFinishTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Finish the current task and return to the task start point",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await finishTask(pi, ctx);
    },
  };
}

export function cmdAbortTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Abort the current task without finishing",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await abortTask(pi, ctx);
    },
  };
}

export function cmdResumeTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description:
      "Resume the most recently suspended task branch (or a queued resume-task request), optionally with an extra message",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await resumeTask(pi, ctx, { messageArg: args });
    },
  };
}

export function cmdSuspendTask(pi: TaskCommandAPI): CommandOptions {
  return {
    description:
      "Suspend the current task and return to the mainline (relays a pending task-ask question)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      await suspendTask(pi, ctx);
    },
  };
}

export function cmdAuto(pi: AutoCommandAPI): CommandOptions {
  let running = false;
  let stopCurrentRun: (() => void) | null = null;
  let agentStartWaiter: AgentStartWaiter | null = null;

  const settleAgentStartWaiter = (started: boolean): void => {
    const waiter = agentStartWaiter;
    if (!waiter) return;

    agentStartWaiter = null;
    clearTimeout(waiter.timeout);
    waiter.resolve(started);
  };

  const waitForAgentStart = (taskStartId: string): Promise<boolean> => {
    if (agentStartWaiter) {
      throw new Error("An agent-start waiter is already active.");
    }

    return new Promise((resolve) => {
      agentStartWaiter = {
        taskStartId,
        resolve,
        timeout: setTimeout(() => settleAgentStartWaiter(false), AUTO_AGENT_START_TIMEOUT_MS),
      };
    });
  };

  pi.on("agent_start", (_event, ctx) => {
    if (agentStartWaiter && currentTask(ctx.sessionManager)?.id === agentStartWaiter.taskStartId) {
      settleAgentStartWaiter(true);
    }
  });

  pi.on("session_shutdown", async () => {
    stopCurrentRun?.();
    settleAgentStartWaiter(false);
  });

  return {
    description: "Automatically run pushed task branches",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (running) {
        ctx.ui.notify("Auto is already running.", "warning");
        return;
      }

      running = true;
      let stopped = false;
      let sawTaskActivity = false;
      stopCurrentRun = () => {
        stopped = true;
      };

      const autoStatusOptions = {
        prefix: "[auto] ",
      } satisfies TaskStatusOptions;
      refreshTaskStatus(ctx, autoStatusOptions);

      try {
        while (!stopped) {
          await ctx.waitForIdle();

          // Re-check after idle: userCtrlC/stopped may have been set
          // while we were waiting (the reaction engine runs before the
          // waiter resolves). Without this, we'd fall through to task
          // processing and might call finishTask even though the session
          // was shut down.
          if (stopped) break;

          if (lastAssistantWasAborted(ctx.sessionManager)) break;

          if (pendingTask(ctx.sessionManager)) {
            const result = await startTask(pi, ctx, {
              statusPrefix: autoStatusOptions.prefix,
              waitForAgentStart,
            });
            if (result === "cancelled" || result === "launch-timeout") break;
            sawTaskActivity = true;
            continue;
          }

          if (pendingResume(ctx.sessionManager)) {
            const result = await resumeTask(pi, ctx, {
              statusPrefix: autoStatusOptions.prefix,
              waitForAgentStart,
            });
            // A discarded resume request ("error") is consumed with a visible
            // warning — keep the loop alive so queued tasks still run.
            // Only break on cancel/timeout.
            if (result && result !== "error") break;
            sawTaskActivity = true;
            continue;
          }

          const activeTask = currentTask(ctx.sessionManager);
          if (activeTask) {
            // Never auto-finalize before the task branch has produced a reply.
            if (!hasAssistantAfterTaskStart(ctx.sessionManager, activeTask.id)) {
              ctx.ui.notify(
                "Auto stopped: the task agent has not produced a reply yet. Re-run /auto to resume supervision.",
                "warning",
              );
              break;
            }

            // A pending task-ask is relayed by suspending first, so the
            // mainline answers it instead of the task being finalized.
            if (pendingAsk(ctx.sessionManager, activeTask.id)) {
              const result = await suspendTask(pi, ctx, {
                statusPrefix: autoStatusOptions.prefix,
              });
              if (result === "cancelled") break;
              sawTaskActivity = true;
              continue;
            }

            const result = await finishTask(pi, ctx, {
              statusPrefix: autoStatusOptions.prefix,
            });
            if (result === "cancelled") break;
            sawTaskActivity = true;
            continue;
          }

          // No pending tasks and no current task
          if (!sawTaskActivity) {
            // Never had any task activity — nothing to process
            ctx.ui.notify("No pending tasks to run.", "info");
            break;
          }

          if (!ctx.hasPendingMessages()) {
            break;
          }
        }
      } finally {
        settleAgentStartWaiter(false);
        stopCurrentRun = null;
        refreshTaskStatus(ctx);
        running = false;
      }
    },
  };
}

export const rendererTaskResult: MessageRenderer<{ title?: string }> = (
  message,
  _options,
  theme,
): Box => {
  const label = message.details?.title
    ? theme.fg("customMessageLabel", `${message.details.title} result:`)
    : theme.fg("customMessageLabel", "result:");
  // The marker is for the model (customType is lost in context); the label
  // already carries the title in the UI, so strip it here.
  const text = renderTextContent(message.content).replace(/^\[task-result: [^\]\n]*\]\n\n/, "");
  const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`${label}\n${text}`, 0, 0));
  return box;
};

export const rendererTaskQuestion: MessageRenderer<{ title?: string; question?: string }> = (
  message,
  _options,
  theme,
): Box => {
  const label = message.details?.title
    ? theme.fg("customMessageLabel", `${message.details.title} question:`)
    : theme.fg("customMessageLabel", "question:");
  // Same stripping as rendererTaskResult: the label already shows the title.
  const text = renderTextContent(message.content).replace(/^\[task-question: [^\]\n]*\]\n\n/, "");
  const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`${label}\n${text}`, 0, 0));
  return box;
};

export function updateTaskStatus(
  session: ReadonlySessionLike,
  setStatus: (key: string, value: string | undefined) => void,
  theme: TaskStatusTheme,
  options: TaskStatusOptions = {},
): void {
  const prefix = options.prefix ?? "";
  const pending = pendingTask(session);
  if (pending) {
    setStatus(
      "task",
      `${prefix}${theme.fg("dim", `pending task: ${taskTitle(pending.data.title)}`)}`,
    );
    return;
  }

  const resume = pendingResume(session);
  if (resume) {
    const resumeTitle = resume.data.title ? `: ${taskTitle(resume.data.title)}` : "";
    setStatus("task", `${prefix}${theme.fg("dim", `pending resume${resumeTitle}`)}`);
    return;
  }

  const active = currentTask(session);
  if (active) {
    setStatus(
      "task",
      `${prefix}${theme.fg("dim", `current task: ${taskTitle(active.data.title)}`)}`,
    );
    return;
  }

  setStatus("task", undefined);
}

export function setSkills(s: Skill[]): void {
  skills = s;
  skillsExternallySet = true;
}

/**
 * Used by before_agent_start handler to prime the registry from Pi's
 * skill list. Does nothing if skills were already explicitly set
 * (e.g., by tests calling setSkills before h.prompt()).
 */
export function setSkillsFromEvent(s: Skill[]): void {
  if (!skillsExternallySet) {
    skills = s;
  }
}

/** Re-capture the canonical tool order (called on session_start). */
export function captureToolOrder(activeTools: string[]): void {
  canonicalToolOrder = activeTools;
}

/**
 * Show task-ask inside task branches and push-task/resume-task outside them.
 * Session-level only (setActiveTools does not persist); execute-time guards
 * in the tools remain as a backstop for races. Tools the user disabled
 * before capture are not force-enabled; tools registered after capture keep
 * their relative order at the end.
 */
export function syncTaskToolVisibility(pi: ToolVisibilityAPI, session: ReadonlySessionLike): void {
  const active = pi.getActiveTools();
  canonicalToolOrder ??= active;

  const inTaskBranch = currentTask(session) !== null;
  const hidden = inTaskBranch ? MAINLINE_ONLY_TOOLS : TASK_BRANCH_ONLY_TOOLS;
  const shown = inTaskBranch ? TASK_BRANCH_ONLY_TOOLS : MAINLINE_ONLY_TOOLS;

  const desired = new Set(active.filter((name) => !hidden.includes(name)));
  for (const name of shown) {
    if (canonicalToolOrder.includes(name)) desired.add(name);
  }

  const next = canonicalToolOrder.filter((name) => desired.has(name));
  for (const name of active) {
    if (!canonicalToolOrder.includes(name) && desired.has(name)) next.push(name);
  }

  const unchanged = next.length === active.length && next.every((name, i) => name === active[i]);
  if (!unchanged) {
    pi.setActiveTools(next);
  }
}

export function setModelRegistry(mr: ModelRegistry): void {
  modelRegistry = mr;
}

/**
 * Marker injected before a task result: customType is dropped when the
 * message is converted into model context. Shared with the test helpers
 * (test-session) that strip it back off.
 */
export function taskResultMarker(title: string): string {
  return `[task-result: ${title}]\n\n`;
}

/** Marker injected before a relayed task question. See taskResultMarker. */
export function taskQuestionMarker(title: string): string {
  return `[task-question: ${title}]\n\n`;
}

/**
 * Relay instructions appended to an injected task question (after the
 * question text). Exported so tests can strip them in sync with production.
 */
export const taskQuestionInstructions =
  "(The task is suspended waiting for this answer. Answer it here, then call resume-task with the answer in `message` to resume the task; if you cannot answer, ask the user - with a user-question tool if one is available, otherwise in plain text - and relay their answer the same way.)";

const AUTO_AGENT_START_TIMEOUT_MS = 60_000;

// ── Tool visibility sync ──────────────────────────────────────────

const TASK_BRANCH_ONLY_TOOLS = ["task-ask"];

const MAINLINE_ONLY_TOOLS = ["push-task", "resume-task"];

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

type PushTaskAPI = Pick<ExtensionAPI, "appendEntry">;

type AutoCommandAPI = TaskCommandAPI & Pick<ExtensionAPI, "on">;

type TaskStatusTheme = Pick<Theme, "fg">;

type TaskStatusOptions = {
  prefix?: string;
};

type PushTaskParams = Static<typeof pushTaskParameters>;

type AgentStartWaiter = {
  taskStartId: string;
  resolve: (started: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ResumeTaskOptions = TaskActionOptions & {
  /** Extra message from `/resume-task <text>`; appended to a queued request's message. */
  messageArg?: string;
};

type TaskActionOptions = {
  statusPrefix?: string;
  modelArg?: string;
  waitForAgentStart?: (taskStartId: string) => Promise<boolean>;
};

type ToolVisibilityAPI = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

type ResumeTaskParams = Static<typeof resumeTaskParameters>;

type TaskAskParams = Static<typeof taskAskParameters>;

type ResumeTaskAPI = Pick<ExtensionAPI, "appendEntry">;

type TaskAskAPI = Pick<ExtensionAPI, "appendEntry">;

/**
 * Shared call renderer for the task tools: a styled header followed by the
 * (collapsed, unless expanded) body lines.
 */
function renderCollapsibleToolCall(
  header: string,
  body: string,
  theme: Theme,
  expanded?: boolean,
): Text {
  const bodyLines = body.split("\n");
  // Collapsed call rendering shows the first few body lines only.
  const maxLines = expanded ? bodyLines.length : 7;
  const displayLines = bodyLines.slice(0, maxLines).map((l) => theme.fg("dim", l.trimEnd() || " "));

  if (!expanded && bodyLines.length > maxLines) {
    const moreLines = bodyLines.length - maxLines;
    displayLines.push(
      theme.fg(
        "muted",
        `... (${moreLines} more lines, ${bodyLines.length} total, ctrl+o to expand)`,
      ),
    );
  }

  return new Text([header, ...displayLines].join("\n"), 0, 0);
}

function lastAssistantWasAborted(session: ReadonlySessionLike): boolean {
  const branch = session.getBranch();
  const last = branch[branch.length - 1];
  return (
    last?.type === "message" &&
    last.message.role === "assistant" &&
    last.message.stopReason === "aborted"
  );
}

function hasAssistantAfterTaskStart(session: ReadonlySessionLike, taskStartId: string): boolean {
  let afterTaskStart = false;
  for (const entry of session.getBranch()) {
    if (entry.id === taskStartId) {
      afterTaskStart = true;
      continue;
    }
    if (afterTaskStart && isAssistantMessageEntry(entry)) return true;
  }
  return false;
}

async function startTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: TaskActionOptions = {},
): Promise<TaskActionResult> {
  const activeTask = pendingTask(ctx.sessionManager);
  if (!activeTask) {
    ctx.ui.notify("No pending task. Use push-task first.", "warning");
    return;
  }

  // ── Model switching ─────────────────────────────────────────────
  let previousModel: TaskStartData["previousModel"];
  if (options.modelArg) {
    const matched = resolveModelPattern(options.modelArg, ctx.modelRegistry);
    if (matched === null) {
      ctx.ui.notify(`No model matching "${options.modelArg}".`, "warning");
      return;
    }
    if (matched === "ambiguous") {
      const names = matchModels(options.modelArg, ctx.modelRegistry)
        .map((m) => `${m.provider}/${m.id}`)
        .join(", ");
      ctx.ui.notify(`Ambiguous model: matches ${names}.`, "warning");
      return;
    }

    const currentModel = ctx.model;
    if (currentModel) {
      previousModel = { provider: currentModel.provider, modelId: currentModel.id };
    }

    const switched = await pi.setModel(matched);
    if (!switched) {
      ctx.ui.notify(`No API key configured for ${matched.provider}/${matched.id}.`, "warning");
      return;
    }
  }

  // ── Task start ──────────────────────────────────────────────────
  const departureLeafId = ctx.sessionManager.getLeafId()!;
  const fork = activeTask.data.fork === true;
  if (!fork) {
    const freshTargetId = findFreshTargetId(ctx.sessionManager);
    if (!freshTargetId) {
      ctx.ui.notify("No starting point found on current branch.", "warning");
      return;
    }

    const result = await ctx.navigateTree(freshTargetId, { summarize: false });
    if (result.cancelled) return "cancelled";
  }

  const startEntryData: TaskStartData = {
    title: taskTitle(activeTask.data.title),
    returnTo: departureLeafId,
    taskEntryId: activeTask.id,
  };
  if (previousModel) {
    startEntryData.previousModel = previousModel;
  }
  if (fork) {
    startEntryData.fork = true;
  }
  pi.appendEntry(TASK_START_ENTRY_TYPE, startEntryData);
  // Appending task-start does not fire session_tree; sync visibility explicitly.
  syncTaskToolVisibility(pi, ctx.sessionManager);

  // The extension API returns from sendUserMessage before Pi marks the agent
  // as active; arm the barrier first so /auto cannot misread that window as idle.
  const taskStartId = ctx.sessionManager.getLeafId();
  if (taskStartId === null && options.waitForAgentStart) {
    ctx.ui.notify(
      "Warning: no session leaf after task start; the agent-start barrier is disabled.",
      "warning",
    );
  }
  const agentStarted = taskStartId ? options.waitForAgentStart?.(taskStartId) : undefined;
  pi.sendUserMessage(activeTask.data.prompt);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });

  if (agentStarted && !(await agentStarted)) {
    ctx.ui.notify(
      `Auto stopped supervising: no agent_start was observed within ${AUTO_AGENT_START_TIMEOUT_MS / 1000} seconds (timeout or session shutdown). The task prompt was already delivered and may still run; check the branch before re-running /auto.`,
      "error",
    );
    return "launch-timeout";
  }
}

async function discardTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
): Promise<TaskActionResult> {
  const activeTask = pendingTask(ctx.sessionManager);
  if (!activeTask) {
    ctx.ui.notify("No pending task to discard.", "warning");
    return;
  }

  pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
  ctx.ui.notify("Task discarded.", "info");

  refreshTaskStatus(ctx);
}

async function finishTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: TaskActionOptions = {},
): Promise<TaskActionResult> {
  const taskStart = currentTask(ctx.sessionManager);
  if (!taskStart) {
    ctx.ui.notify("Not inside task, nothing to finish.", "warning");
    return;
  }

  // Capture last assistant message content before navigation. Only text blocks
  // are valid for custom_message content; provider-specific thinking/tool blocks
  // must not be replayed into the parent branch.
  const lastAssistant = findLastEntry(ctx.sessionManager, isAssistantMessageEntry);
  const lastAssistantContent = lastAssistant
    ? taskResultTextContent(lastAssistant.message.content)
    : undefined;
  const lastAssistantId = lastAssistant?.id;

  const title = taskMarkerTitle(taskStart.data.title);
  // Record the task-branch leaf so /resume-task can navigate back here.
  const branchLeafId = ctx.sessionManager.getLeafId()!;

  const result = await ctx.navigateTree(taskStart.data.returnTo, {
    summarize: false,
  });
  if (result.cancelled) return "cancelled";

  syncTaskToolVisibility(pi, ctx.sessionManager);

  // Inject last assistant message after navigation
  if (lastAssistantId && lastAssistantContent !== undefined) {
    // Normalize the captured content to plain text so it can be prefixed with
    // the result marker (text blocks are joined with newlines).
    const resultText =
      typeof lastAssistantContent === "string"
        ? lastAssistantContent
        : lastAssistantContent.map((block) => block.text).join("\n");
    // Prefix the result with an explicit marker so the model recognizes it as
    // the task result (custom-message conversion drops customType/title, so a
    // bare report reads like an ordinary user message). An empty result stays
    // empty to avoid a dangling marker-only message.
    const resultContent = resultText
      ? `${taskResultMarker(title)}${resultText}`
      : lastAssistantContent;
    pi.sendMessage(
      {
        customType: "task-result",
        content: resultContent,
        display: true,
        details: { title },
      },
      { triggerTurn: true },
    );
  }

  if (shouldConsumeTaskEntry(ctx.sessionManager, taskStart)) {
    pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
  }
  pi.appendEntry(TASK_SUSPENDED_ENTRY_TYPE, {
    title,
    branchLeafId,
    reason: "finish",
    ...(taskStart.data.taskEntryId ? { taskEntryId: taskStart.data.taskEntryId } : {}),
  });

  const label = lastAssistantId ? "Last response attached." : "No last response to attach.";
  ctx.ui.notify(`Task finished. ${label}`, "info");

  if (lastAssistantInterrupted(ctx.sessionManager)) {
    ctx.ui.notify(
      "Interrupted assistant reply detected before the result (aborted/error turn). The model may continue that old reply instead of the result.",
      "warning",
    );
  }

  await restorePreviousModel(pi, taskStart, ctx);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });
}

/**
 * True if the last assistant message on the current branch was interrupted
 * (stopReason "aborted" or "error"). Call this AFTER navigating back to the
 * return branch: the result is injected at that branch's tip, and an
 * interrupted turn just below it makes a real LLM continue the old reply
 * instead of processing the result. (An interrupted reply on the task branch
 * is harmless — its text was already captured into the result.)
 */
function lastAssistantInterrupted(session: ReadonlySessionLike): boolean {
  const lastAssistant = findLastEntry(session, isAssistantMessageEntry);
  return (
    lastAssistant !== undefined &&
    (lastAssistant.message.stopReason === "aborted" || lastAssistant.message.stopReason === "error")
  );
}

async function abortTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
): Promise<TaskActionResult> {
  const taskStart = currentTask(ctx.sessionManager);
  if (!taskStart) {
    ctx.ui.notify("Not inside task, nothing to abort.", "warning");
    return;
  }

  const branchLeafId = ctx.sessionManager.getLeafId()!;

  const result = await ctx.navigateTree(taskStart.data.returnTo, {
    summarize: false,
  });
  if (result.cancelled) return "cancelled";

  // Abort produces no result but stays resumable: the task entry is not
  // consumed, keeping "abort = task pending again".
  pi.appendEntry(TASK_SUSPENDED_ENTRY_TYPE, {
    title: taskMarkerTitle(taskStart.data.title),
    branchLeafId,
    reason: "abort",
    ...(taskStart.data.taskEntryId ? { taskEntryId: taskStart.data.taskEntryId } : {}),
  });
  syncTaskToolVisibility(pi, ctx.sessionManager);

  ctx.ui.notify("Task aborted. Branch abandoned without summary.", "info");

  await restorePreviousModel(pi, taskStart, ctx);

  refreshTaskStatus(ctx);
}

/**
 * Resume a suspended task branch: navigate to the recorded branch leaf and
 * inject a message as a new user turn. A queued `task-resume` request (from
 * the resume-task tool) takes precedence and is consumed; otherwise the
 * latest `task-suspended` entry is resumed ad-hoc.
 */
async function resumeTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: ResumeTaskOptions = {},
): Promise<TaskActionResult> {
  if (currentTask(ctx.sessionManager)) {
    ctx.ui.notify("Inside a task branch. Finish or abort the current task first.", "warning");
    return "error";
  }

  const request = pendingResume(ctx.sessionManager);
  let suspended: TaskSuspendedEntry | null = null;
  let message: string;

  if (request) {
    if (request.data.title) {
      suspended = findSuspendedTaskByTitle(ctx.sessionManager, request.data.title);
      if (!suspended) {
        // Injecting a task-specific message into an unrelated branch is worse
        // than dropping the request; consume it so /auto does not stall on it.
        pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, {});
        ctx.ui.notify(
          `Resume request discarded: no suspended task titled "${request.data.title}".`,
          "warning",
        );
        refreshTaskStatus(ctx, { prefix: options.statusPrefix });
        return "error";
      }
    } else {
      // Only untitled requests fall back to the latest suspended task.
      suspended = latestSuspendedTask(ctx.sessionManager);
    }
    message = request.data.message;
    const extra = options.messageArg?.trim();
    if (extra) message = `${message}\n\n${extra}`;
  } else {
    suspended = latestSuspendedTask(ctx.sessionManager);
    message = options.messageArg?.trim() ?? "";
  }

  if (!suspended) {
    if (request) {
      // Consume the request that can never execute so /auto does not stall.
      pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, {});
      ctx.ui.notify("Resume request discarded: no resumable task on this branch.", "warning");
      refreshTaskStatus(ctx, { prefix: options.statusPrefix });
      return "error";
    }
    ctx.ui.notify(
      "No resumable task. A task becomes resumable after it is finished, aborted, or suspended.",
      "warning",
    );
    return;
  }

  const title = taskMarkerTitle(suspended.data.title);
  if (!message) {
    message = `You are resuming the task "${title}". Continue from where you left off.`;
  }

  // Consume the request before capturing the departure leaf: returnTo must
  // contain the task-resume-done entry, otherwise navigating back at finish
  // would orphan it on a side branch and /auto would re-execute the request.
  if (request) {
    pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, {});
  }
  const departureLeafId = ctx.sessionManager.getLeafId()!;

  const result = await ctx.navigateTree(suspended.data.branchLeafId, { summarize: false });
  if (result.cancelled) {
    if (request) {
      // The request is already consumed (see above); make the loss visible.
      ctx.ui.notify(
        `Resume of "${title}" cancelled. The queued message was consumed; re-queue it with resume-task if still needed.`,
        "warning",
      );
    }
    return "cancelled";
  }

  pi.appendEntry(TASK_START_ENTRY_TYPE, {
    title,
    returnTo: departureLeafId,
    resume: true,
    ...(suspended.data.taskEntryId ? { taskEntryId: suspended.data.taskEntryId } : {}),
  });
  // Appending task-start does not fire session_tree, so sync explicitly.
  syncTaskToolVisibility(pi, ctx.sessionManager);

  // Same barrier as startTask: sendUserMessage returns before Pi marks the
  // agent as active, so /auto must wait for agent_start to avoid a false idle.
  const taskStartId = ctx.sessionManager.getLeafId();
  if (taskStartId === null && options.waitForAgentStart) {
    ctx.ui.notify(
      "Warning: no session leaf after task resume; the agent-start barrier is disabled.",
      "warning",
    );
  }
  const agentStarted = taskStartId ? options.waitForAgentStart?.(taskStartId) : undefined;
  pi.sendUserMessage(message);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });

  if (agentStarted && !(await agentStarted)) {
    ctx.ui.notify(
      `Auto stopped supervising: no agent_start for the resumed task was observed within ${AUTO_AGENT_START_TIMEOUT_MS / 1000} seconds (timeout or session shutdown). The resume message was already delivered and may still run; check the branch before re-running /auto.`,
      "error",
    );
    return "launch-timeout";
  }
}

/**
 * Suspend the current task: return to the mainline and record a resumable
 * point. With a pending task-ask (no user/assistant message after the ask
 * entry), the question is relayed to the mainline as a `[task-question: …]`
 * message. The pending task entry is consumed (original runs only) so /auto
 * does not immediately restart the suspended task.
 */
async function suspendTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  options: TaskActionOptions = {},
): Promise<TaskActionResult> {
  const taskStart = currentTask(ctx.sessionManager);
  if (!taskStart) {
    ctx.ui.notify("Not inside task, nothing to suspend.", "warning");
    return;
  }

  const ask = pendingAsk(ctx.sessionManager, taskStart.id);
  const branchLeafId = ctx.sessionManager.getLeafId()!;
  const title = taskMarkerTitle(taskStart.data.title);

  const result = await ctx.navigateTree(taskStart.data.returnTo, {
    summarize: false,
  });
  if (result.cancelled) return "cancelled";

  syncTaskToolVisibility(pi, ctx.sessionManager);

  if (shouldConsumeTaskEntry(ctx.sessionManager, taskStart)) {
    pi.appendEntry(TASK_DONE_ENTRY_TYPE, {});
  }
  pi.appendEntry(TASK_SUSPENDED_ENTRY_TYPE, {
    title,
    branchLeafId,
    reason: ask ? "ask" : "manual",
    ...(taskStart.data.taskEntryId ? { taskEntryId: taskStart.data.taskEntryId } : {}),
  });

  if (ask) {
    // customType is dropped in model context, so the content carries an
    // explicit marker; the trailing instruction tells the mainline AI how to
    // relay (answer + resume-task) without any external protocol.
    pi.sendMessage(
      {
        customType: "task-question",
        content: `${taskQuestionMarker(title)}${ask.data.question}\n\n${taskQuestionInstructions}`,
        display: true,
        details: { title, question: ask.data.question },
      },
      { triggerTurn: true },
    );
  } else {
    ctx.ui.notify("Task suspended. Resume with `/resume-task` or `/auto`.", "info");
  }

  await restorePreviousModel(pi, taskStart, ctx);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });
}

type TaskActionResult = "cancelled" | "launch-timeout" | "error" | void;

/** Restore the model that was active before a task started, if one was recorded. */
async function restorePreviousModel(
  pi: TaskCommandAPI,
  taskStart: TaskStartEntry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!taskStart.data.previousModel) return;

  const { provider, modelId } = taskStart.data.previousModel;
  const restoredModel = ctx.modelRegistry.find(provider, modelId);
  if (restoredModel) {
    if (!(await pi.setModel(restoredModel))) {
      ctx.ui.notify(`Failed to restore previous model ${provider}/${modelId}.`, "warning");
    }
  } else {
    ctx.ui.notify(`Previous model ${provider}/${modelId} no longer available.`, "warning");
  }
}

type TaskCommandAPI = Pick<
  ExtensionAPI,
  | "appendEntry"
  | "sendMessage"
  | "sendUserMessage"
  | "setModel"
  | "getActiveTools"
  | "setActiveTools"
>;

function refreshTaskStatus(ctx: TaskStatusContext, options: TaskStatusOptions = {}): void {
  if (ctx.hasUI) {
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme, options);
  }
}

type TaskStatusContext = Pick<ExtensionCommandContext, "hasUI" | "sessionManager" | "ui">;

/** Type guard: is the entry an assistant message with content? */
function isAssistantMessageEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: { role: "assistant" } } {
  return entry.type === "message" && entry.message.role === "assistant";
}

/**
 * Find the target ID for navigating to a fresh context.
 * Returns the parent of the first model-visible entry, or the branch root as fallback.
 * Returns null if no valid target is found.
 */
function findFreshTargetId(session: ReadonlySessionLike): string | null {
  const branch = session.getBranch();
  if (branch.length === 0) return null;

  const firstVisible = findPreConversationEntry(session);
  if (firstVisible) {
    return firstVisible.parentId ?? firstVisible.id;
  }

  // Fallback: use branch root's parent (or the root itself if no parent)
  return branch[0].parentId ?? branch[0].id;
}

/**
 * Find the first model-visible entry on the current branch (closest to root).
 *
 * "Model-visible" means the entry participates in LLM context via buildSessionContext:
 * messages (user/assistant), compaction summaries, branch summaries, and custom messages.
 * Entries like thinking_level_change, model_change, custom (data-only), label, and
 * session_info are NOT visible — Pi may insert them before the conversation begins.
 *
 * Returns null if the branch has no model-visible entries (e.g., only non-visible setup
 * entries) or if there is no leaf.
 */
function findPreConversationEntry(session: ReadonlySessionLike): SessionEntry | null {
  if (!session.getLeafId()) return null;

  const branch = session.getBranch();
  for (const entry of branch) {
    if (
      entry.type === "message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary" ||
      entry.type === "custom_message"
    ) {
      return entry;
    }
  }

  return null;
}

/** Latest unconsumed resume request, or null inside a task branch. */
function pendingResume(session: ReadonlySessionLike): TaskResumeEntry | null {
  const branch = session.getBranch();
  let skip = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === TASK_START_ENTRY_TYPE) {
      return null;
    }
    if (entry.type === "custom" && entry.customType === TASK_RESUME_DONE_ENTRY_TYPE) {
      skip++;
      continue;
    }
    if (isTaskResumeEntry(entry)) {
      if (skip === 0) return entry;
      skip--;
    }
  }

  return null;
}

const TASK_RESUME_DONE_ENTRY_TYPE = "task-resume-done";

function latestSuspendedTask(session: ReadonlySessionLike): TaskSuspendedEntry | null {
  return findLastEntry(session, isTaskSuspendedEntry) ?? null;
}

/**
 * Whether finishing/suspending this run must consume its queued task entry.
 * The entry id recorded at start (carried through resume via task-suspended)
 * is checked against the LIFO accounting, so a resumed run consumes its task
 * entry exactly when it is still pending (e.g. after an abort) and never
 * consumes an unrelated earlier task. Legacy task-start entries without an
 * id fall back to the pre-resume rule.
 */
function shouldConsumeTaskEntry(session: ReadonlySessionLike, taskStart: TaskStartEntry): boolean {
  if (taskStart.data.taskEntryId !== undefined) {
    return taskEntryPending(session, taskStart.data.taskEntryId);
  }
  return !taskStart.data.resume && pendingTask(session) !== null;
}

// ── Lookup utilities ──────────────────────────────────────────────

function pendingTask(session: ReadonlySessionLike): TaskEntry | null {
  const branch = session.getBranch();
  let skip = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === TASK_START_ENTRY_TYPE) {
      return null;
    }
    if (entry.type === "custom" && entry.customType === TASK_DONE_ENTRY_TYPE) {
      skip++;
      continue;
    }
    if (isTaskEntry(entry)) {
      if (skip === 0) return entry;
      skip--;
    }
  }

  return null;
}

/**
 * Whether the queued task entry is still unconsumed. Mirrors pendingTask's
 * LIFO accounting: a task-done consumes the nearest unconsumed task entry
 * above it, so walking upward with a skip counter, the entry is pending iff
 * it is reached with skip === 0. (Plain done/task counting misjudges once
 * other queued tasks sit below the entry: their task entries offset the
 * consuming done, and the extra done then silently eats the newer task.)
 */
function taskEntryPending(session: ReadonlySessionLike, taskEntryId: string): boolean {
  const branch = session.getBranch();
  let skip = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.id === taskEntryId) return skip === 0;
    if (entry.type === "custom" && entry.customType === TASK_DONE_ENTRY_TYPE) {
      skip++;
      continue;
    }
    if (isTaskEntry(entry) && skip > 0) {
      skip--;
    }
  }
  return false;
}

const TASK_DONE_ENTRY_TYPE = "task-done";

function findSuspendedTaskByTitle(
  session: ReadonlySessionLike,
  title: string,
): TaskSuspendedEntry | null {
  // Normalize both sides: stored titles went through taskMarkerTitle
  // (whitespace collapsed, "]" stripped) while the request title is raw.
  const wanted = taskMarkerTitle(title);
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (isTaskSuspendedEntry(entry) && taskMarkerTitle(entry.data.title) === wanted) return entry;
  }
  return null;
}

/**
 * The last task-ask entry after `taskStartId` that no user/assistant message
 * has superseded. Tool results do not consume an ask: the task-ask tool
 * terminates the turn, so its own tool result trails the entry without
 * answering it. A user message (direct answer or resume payload) or a new
 * assistant turn consumes it.
 */
function pendingAsk(session: ReadonlySessionLike, taskStartId: string): TaskAskEntry | null {
  let afterTaskStart = false;
  let candidate: TaskAskEntry | null = null;

  for (const entry of session.getBranch()) {
    if (entry.id === taskStartId) {
      afterTaskStart = true;
      continue;
    }
    if (!afterTaskStart) continue;
    if (
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant")
    ) {
      candidate = null;
      continue;
    }
    if (isTaskAskEntry(entry)) {
      candidate = entry;
    }
  }

  return candidate;
}

function currentTask(session: ReadonlySessionLike): TaskStartEntry | null {
  return findLastEntry(session, isTaskStartEntry) ?? null;
}

function findLastEntry<T extends SessionEntry>(
  session: ReadonlySessionLike,
  predicate: (entry: SessionEntry) => entry is T,
): T | undefined {
  const branch = session.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (predicate(entry)) return entry;
  }
  return undefined;
}

/**
 * Minimal read-only session interface needed by lookup functions.
 * Compatible with both ReadonlySessionManager (from ExtensionCommandContext)
 * and SessionManager (full mutable version).
 */
interface ReadonlySessionLike {
  getLeafId(): string | null;
  getBranch(): SessionEntry[];
}

function isTaskEntry(entry: SessionEntry): entry is TaskEntry {
  return isCustomEntry(entry, TASK_ENTRY_TYPE, isTaskData);
}

type TaskEntry = CustomEntry<typeof TASK_ENTRY_TYPE, TaskData>;

const TASK_ENTRY_TYPE = "task";

function isTaskData(value: unknown): value is TaskData {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.fork === undefined || typeof value.fork === "boolean")
  );
}

interface TaskData {
  title?: string;
  prompt: string;
  fork?: boolean;
}

function isTaskStartEntry(entry: SessionEntry): entry is TaskStartEntry {
  return isCustomEntry(entry, TASK_START_ENTRY_TYPE, isTaskStartData);
}

type TaskStartEntry = CustomEntry<typeof TASK_START_ENTRY_TYPE, TaskStartData>;

const TASK_START_ENTRY_TYPE = "task-start";

function isTaskStartData(value: unknown): value is TaskStartData {
  if (
    !isRecord(value) ||
    typeof value.returnTo !== "string" ||
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.fork !== undefined && typeof value.fork !== "boolean") ||
    (value.resume !== undefined && typeof value.resume !== "boolean") ||
    (value.taskEntryId !== undefined && typeof value.taskEntryId !== "string")
  ) {
    return false;
  }
  if (value.previousModel !== undefined) {
    return (
      isRecord(value.previousModel) &&
      typeof value.previousModel.provider === "string" &&
      typeof value.previousModel.modelId === "string"
    );
  }
  return true;
}

interface TaskStartData {
  title?: string;
  returnTo: string;
  previousModel?: { provider: string; modelId: string };
  fork?: boolean;
  resume?: boolean;
  /** Id of the queued `task` entry this run consumes on finish/suspend. */
  taskEntryId?: string;
}

function isTaskSuspendedEntry(entry: SessionEntry): entry is TaskSuspendedEntry {
  return isCustomEntry(entry, TASK_SUSPENDED_ENTRY_TYPE, isTaskSuspendedData);
}

type TaskSuspendedEntry = CustomEntry<typeof TASK_SUSPENDED_ENTRY_TYPE, TaskSuspendedData>;

const TASK_SUSPENDED_ENTRY_TYPE = "task-suspended";

function isTaskSuspendedData(value: unknown): value is TaskSuspendedData {
  return (
    isRecord(value) &&
    typeof value.branchLeafId === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.taskEntryId === undefined || typeof value.taskEntryId === "string")
  );
}

interface TaskSuspendedData {
  title?: string;
  branchLeafId: string;
  reason?: "finish" | "abort" | "ask" | "manual";
  /** Propagated from the task-start so resumed runs keep entry accounting. */
  taskEntryId?: string;
}

function isTaskResumeEntry(entry: SessionEntry): entry is TaskResumeEntry {
  return isCustomEntry(entry, TASK_RESUME_ENTRY_TYPE, isTaskResumeData);
}

type TaskResumeEntry = CustomEntry<typeof TASK_RESUME_ENTRY_TYPE, TaskResumeData>;

const TASK_RESUME_ENTRY_TYPE = "task-resume";

function isTaskResumeData(value: unknown): value is TaskResumeData {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    (value.title === undefined || typeof value.title === "string")
  );
}

interface TaskResumeData {
  title?: string;
  message: string;
}

function isTaskAskEntry(entry: SessionEntry): entry is TaskAskEntry {
  return isCustomEntry(entry, TASK_ASK_ENTRY_TYPE, isTaskAskData);
}

type TaskAskEntry = CustomEntry<typeof TASK_ASK_ENTRY_TYPE, TaskAskData>;

const TASK_ASK_ENTRY_TYPE = "task-ask";

function isCustomEntry<TCustomType extends string, TData>(
  entry: SessionEntry,
  customType: TCustomType,
  isData: (value: unknown) => value is TData,
): entry is CustomEntry<TCustomType, TData> {
  return entry.type === "custom" && entry.customType === customType && isData(entry.data);
}

type CustomEntry<TCustomType extends string, TData> = SessionEntry & {
  type: "custom";
  customType: TCustomType;
  data: TData;
};

function isTaskAskData(value: unknown): value is TaskAskData {
  return isRecord(value) && typeof value.question === "string";
}

interface TaskAskData {
  question: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Single-line, marker-safe variant of taskTitle for embedding into
 * `[task-result: …]` / `[task-question: …]` prefixes: a multi-line title
 * would break the marker and its stripping in renderers and test helpers.
 */
function taskMarkerTitle(title?: string): string {
  // Strip "]" as well: it would terminate the marker early and break
  // prefix-stripping in renderers and test helpers.
  return taskTitle(title).replace(/\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Normalize an optional title to a non-empty display string. */
function taskTitle(title?: string): string {
  return title || "untitled";
}

function resolveSkillRefs(prompt: string): ResolveResult {
  const unresolvedSet = new Set<string>();
  const byName = new Map<string, string>();
  for (const skill of skills) {
    byName.set(skill.name, skill.filePath);
  }

  const rewritten = prompt.replace(
    /\/skill:([a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9])/g,
    (match, name) => {
      const filePath = byName.get(name);
      if (filePath) {
        return filePath;
      }
      unresolvedSet.add(name);
      return match;
    },
  );

  return { rewritten, unresolved: [...unresolvedSet] };
}

interface ResolveResult {
  rewritten: string;
  unresolved: string[];
}

/**
 * Resolve a model pattern to a single model, null (no match), or "ambiguous".
 *
 * Matching order:
 * 1. If pattern contains "/": split as provider/modelId, try exact lookup.
 *    Falls through to substring matching even if the exact lookup fails.
 * 2. Substring, case-insensitive match against each available model's
 *    id, name, and provider/id.
 */
function resolveModelPattern(
  pattern: string,
  registry: ModelRegistry,
): Model<Api> | "ambiguous" | null {
  if (pattern.includes("/")) {
    const slashIdx = pattern.indexOf("/");
    const found = registry.find(pattern.slice(0, slashIdx), pattern.slice(slashIdx + 1));
    if (found) return found;
  }

  const matches = matchModels(pattern, registry);
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

/**
 * Autocompletion for /start-task model argument, mirroring the /model
 * command: label is the model id, description is the provider, and value
 * is provider/id (what gets typed and resolved). Returns up to 20 items.
 */
function getModelCompletions(argumentPrefix: string, registry: ModelRegistry): AutocompleteItem[] {
  return matchModels(argumentPrefix, registry)
    .slice(0, 20)
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: m.id,
      description: m.provider,
    }));
}

/** Case-insensitive substring match of `pattern` against each available model's id, name, or provider/id. */
function matchModels(pattern: string, registry: ModelRegistry): Model<Api>[] {
  const lower = pattern.toLowerCase();
  return registry
    .getAvailable()
    .filter(
      (m) =>
        m.id.toLowerCase().includes(lower) ||
        m.name.toLowerCase().includes(lower) ||
        `${m.provider}/${m.id}`.toLowerCase().includes(lower),
    );
}

/**
 * Tool order captured at the first visibility sync. Pi rebuilds the system
 * prompt by concatenating promptGuidelines in the order of the array passed
 * to setActiveTools, so naive append would create a third system-prompt
 * variant and break prefix-cache reuse. Filtering subsets of this canonical
 * order keeps exactly two byte-stable prompts (mainline / task branch).
 */
let canonicalToolOrder: string[] | undefined;

const pushTaskParameters = Type.Object({
  title: Type.String({
    description: "Short task title shown in status, results, and tool rendering.",
  }),
  prompt: Type.String({
    description:
      "Full prompt for the task, including all context and instructions. Must be self-contained for fresh tasks; fork tasks may reference the current conversation.",
  }),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Start the task from the current context instead of a fresh one. Use for implementation tasks whose prompt depends on the current discussion.",
    }),
  ),
});

const resumeTaskParameters = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        "Title of the suspended task to resume. Defaults to the most recently suspended task.",
    }),
  ),
  message: Type.String({
    description:
      "Message injected into the task branch on resume, e.g. review findings or the answer to its question.",
  }),
});

const taskAskParameters = Type.Object({
  question: Type.String({
    description: "Question for the mainline orchestrator.",
  }),
});

// ── Skill resolution registry ─────────────────────────────────────

let skills: Skill[] = [];

let skillsExternallySet = false;

let modelRegistry: ModelRegistry | undefined;
