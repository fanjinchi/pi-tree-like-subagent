import { existsSync } from "node:fs";

import { readFile } from "node:fs/promises";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

import {
  createSyntheticSourceInfo,
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

/**
 * Cap on role-skill sections inlined into one delivered prompt. Resolution is
 * transitive (a role skill may reference further role skills), so a heavily
 * cross-referencing skill graph must not balloon the branch prompt.
 */
export const MAX_INLINED_ROLE_SKILLS = 4;

export function toolPushTask(pi: PushTaskAPI): ToolDefinition {
  return defineTool({
    name: "push-task",
    label: "Push Task",
    description:
      "Hand off a self-contained chunk of work (research, review, implementation, or a mechanical multi-file edit) to an isolated task branch; it runs later as its own agent turn, keeping this conversation clean.",
    promptSnippet:
      "Hand off work to an isolated task branch (research, review, implement, bulk edits).",
    promptGuidelines: [
      "push-task is the default way to handle any request that is not a single-step answer: hand the work off and keep this conversation for planning, decisions, and the user's own questions. Do the work inline only when it is a quick one- or two-tool-call change, or when it needs live back-and-forth with this conversation.",
      "Queue a task as soon as any of these is observable: the request touches two or more files; it needs builds, tests, logs, or large files you will not reference again; it needs an independent review (no author bias); it produces a report you will not re-read; the user just approved a plan and expects it executed. These are facts about the request - when one is true, queue the task.",
      'Choose role and context in the same breath: review - fresh context, reference /skill:task-review (fork: true only when the target exists nowhere but this discussion); research - always fresh with every input restated in the prompt, reference /skill:task-research; implement - fork: true when the plan is already in this discussion, fresh with the plan restated when this conversation is long and noisy; reference /skill:task-implement. A fresh prompt must be self-contained; a fork prompt may say "the plan above".',
      "A `/skill:<name>` token in the task prompt resolves to the skill file and inlines its full SKILL.md into the delivered prompt (fresh and fork alike) - referencing the skill in the prompt is what puts its content in the branch, so do it whenever the branch needs its procedure (a role card that merely names a skill inlines nothing). Names that resolve nowhere are reported back to you here, not to the branch.",
      "Queue independent tasks together in one reply: every push-task call in the same message is queued before the turn ends (with /auto active the first starts as soon as the turn ends, so cross-turn pushes only accumulate while /auto is off). Their order does not matter: the queue runs in call order (oldest first) and the completion order of parallel tool calls is not deterministic. Queue dependent stages one per turn, after the previous stage's result arrived.",
      "Do not queue work whose next step depends on what you just saw in this conversation (open-ended exploration, prototyping, interactive debugging). That exemption is narrow: a large mechanical edit, a wide search, or a self-contained investigation is a task even when it feels quick to start.",
      "One task = one outcome the user can review and accept on its own: split chained stages (implement, then review) into separate entries, merge small same-kind fixes into one. A queue of three to five stages is normal.",
      "push-task ends the turn and notifies the user itself; each tool result is the receipt (it reports the queue position), so one short line before the calls is enough - no text after them, and never start the same work inline.",
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

      const { rewritten, unresolved, resolved } = resolveSkillRefs(params.prompt);

      pi.appendEntry(TASK_ENTRY_TYPE, {
        title,
        prompt: rewritten,
        ...(fork ? { fork: true } : {}),
        ...(resolved.length > 0
          ? { skills: resolved.map((s) => ({ name: s.name, filePath: s.filePath })) }
          : {}),
      });

      const queuedCount = pendingTasks(ctx.sessionManager).length;
      const storedPrefix = fork ? "Task stored (forks the current context). " : "Task stored. ";
      const storedMessage = isAutoActive(ctx.sessionManager)
        ? queuedCount > 1
          ? `${storedPrefix}${queuedCount} tasks queued - auto mode is on, they run and finish automatically.`
          : `${storedPrefix}Auto mode is on - the task runs and finishes automatically.`
        : queuedCount > 1
          ? `${storedPrefix}${queuedCount} tasks queued - \`/start-task\` or \`/auto\` runs them oldest first.`
          : `${storedPrefix}Start it with \`/start-task\` or \`/auto\`.`;

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
      "resume-task queues the resume; while a task supervisor is running it executes automatically (supervision is armed by /start-task, /resume-task, and /auto, and stopped by /auto-stop); with supervision off it takes effect when the user runs /resume-task or /auto.",
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

      // Relay-aware, but branch-tip only (never part of a system prompt).
      const armed = isSupervisorActive(ctx.sessionManager);
      const resumeQueuedMessage = armed
        ? "Resume queued. It is executed automatically."
        : "Resume queued. It takes effect via `/resume-task` or `/auto`.";

      if (ctx.hasUI) {
        refreshTaskStatus(ctx);
        ctx.ui.notify(
          armed
            ? resumeQueuedMessage
            : "Resume queued. Run `/resume-task` or `/auto` to execute it.",
          "info",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: resumeQueuedMessage,
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
      "Ask the mainline orchestrator a question from inside a task branch. The task suspends and the question is relayed to the mainline automatically; the answer arrives as a resume message.",
    promptSnippet: "Ask the mainline orchestrator a question from inside a task branch.",
    promptGuidelines: [
      "Use task-ask only inside a task branch when you need information or a decision from the mainline orchestrator to continue the task.",
      "After calling task-ask, stop working and wait: the question is recorded and relayed to the mainline automatically (unless the relay was stopped with /auto-stop, in which case the user relays it with /suspend-task); the answer arrives as a resume message. Do not call other tools alongside task-ask.",
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
        // Branch-tip text only (never part of a system prompt), so it may
        // reflect the live supervisor state.
        ctx.ui.notify(
          isSupervisorActive(ctx.sessionManager)
            ? "Task question recorded. The task suspends and the question is relayed to the mainline automatically."
            : "Task question recorded. Run /suspend-task to relay it, or answer it directly in this branch.",
          "info",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: isSupervisorActive(ctx.sessionManager)
              ? "Question recorded; the task is now waiting for an answer. It is suspended and relayed to the mainline orchestrator automatically. The answer arrives as a resume message. Stop working until the answer arrives."
              : "Question recorded; the task is now waiting for an answer. The user may relay it with /suspend-task or answer directly in this branch. The answer arrives as a resume message. Stop working until the answer arrives.",
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
      const result = await startTask(pi, ctx, { modelArg });
      // Starting a task arms the supervisor in relay policy: from here on,
      // a task-ask switches back to the mainline by itself and the answer
      // comes back without the user running /suspend-task or /resume-task.
      if (result === "started" || result === "launch-timeout") {
        armSupervisor(pi, ctx, "relay");
      }
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
      const result = await resumeTask(pi, ctx, { messageArg: args });
      // Re-arm the relay: the resumed run keeps asking questions and getting
      // answers without manual /suspend-task and /resume-task calls.
      if (result === "started" || result === "launch-timeout") {
        armSupervisor(pi, ctx, "relay");
      }
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

/**
 * Wire the task supervisor's session events. Registered once at extension
 * load (root index.ts) instead of by the /auto command, so a relay
 * supervisor armed by /start-task or /resume-task gets the same wake and
 * shutdown handling without /auto ever having been run.
 */
export function setupTaskSupervisor(pi: Pick<ExtensionAPI, "on">): void {
  // The barrier resolves when Pi reports the run as active. Comparing the
  // current task guards against a stale waiter: an unrelated run (e.g. after
  // the user finished the task and started another) must not settle it.
  pi.on("agent_start", (_event, ctx) => {
    const state = supervisorStates.get(ctx.sessionManager);
    if (
      state?.agentStartWaiter &&
      currentTask(ctx.sessionManager)?.id === state.agentStartWaiter.taskStartId
    ) {
      settleAgentStartWaiter(state, true);
    }
  });

  // Wake the parked loop after every agent run: pushes, finishes, resumes,
  // and manual prompts all end in agent_end (the last event emitted for a
  // run), which is the safe point to re-check task state. The handler only
  // resolves the park promise — navigation stays inside the command loop
  // (navigateTree is command-context-only).
  pi.on("agent_end", (_event, ctx) => {
    const state = supervisorStates.get(ctx.sessionManager);
    if (!state) return;
    state.agentEndCount += 1;
    state.wake?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const state = supervisorStates.get(ctx.sessionManager);
    if (!state) return;
    state.stop?.();
    settleAgentStartWaiter(state, false);
  });
}

export function cmdAuto(pi: TaskCommandAPI): CommandOptions {
  return {
    description: "Turn on auto mode: queued tasks run and finish automatically until /auto-stop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const result = armSupervisor(pi, ctx, "auto");
      if (result === "already-auto") {
        ctx.ui.notify("Auto mode is already on.", "warning");
        return;
      }

      if (result === "armed") {
        refreshTaskStatus(ctx, { prefix: AUTO_STATUS_PREFIX });
      }
      ctx.ui.notify(
        "Auto mode on. Queued tasks run and finish automatically. /auto-stop turns it off.",
        "info",
      );
    },
  };
}

export function cmdAutoStop(): CommandOptions {
  return {
    description: "Turn supervision off (stops the /auto loop and the ask relay)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = supervisorStates.get(ctx.sessionManager);
      if (!state?.stop) {
        ctx.ui.notify("Auto is not running.", "warning");
        return;
      }

      const mode = state.mode;
      state.stop();
      ctx.ui.notify(
        mode === "relay"
          ? "Ask relay off. Task questions stay in the branch until /suspend-task; the next /start-task or /resume-task re-arms the relay."
          : "Auto mode off. It stops before the next step; the current task stays resumable.",
        "info",
      );
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

/** Marker injected before a started task's prompt. See taskResultMarker. */
export function taskStartMarker(title: string): string {
  return `[task-start: ${title}]\n\n`;
}

/** Marker injected before a resume message. See taskResultMarker. */
export function taskResumeMarker(title: string): string {
  return `[task-resume: ${title}]\n\n`;
}

/** Fork branches inherit the mainline transcript, including the push-task call. */
export const TASK_START_FRAMING_FORK =
  "This task is running now: the push-task call above only queued it and it has since been started. " +
  "The conversation above is the mainline context that produced the task - use it as background, do not redo it. " +
  "Execute the task below; your final message is the report to the mainline.\n\n";

/** Fresh branches start from an empty context, so the framing must not claim otherwise. */
export const TASK_START_FRAMING_FRESH =
  "This task is running now: it was queued on the mainline and started here from a fresh context. " +
  "Do not wait for or request a start. Execute the task below; your final message is the report to the mainline.\n\n";

/** Resume deliveries carry follow-up input, not a new task. */
export const TASK_RESUME_FRAMING =
  "This task is running again: the mainline started it here and sent the input below as follow-up " +
  "(review findings, an answer, or a correction). Continue the same task - this is new input, not a new task. " +
  "Your final message is the report to the mainline.\n\n";

/**
 * Appended to the system prompt inside a task branch. A branch inherits the
 * mainline transcript *and* its system prompt, so nothing else in the prompt
 * tells the model that the task it can see being queued is already running -
 * without this block the model can conclude it is still on the mainline and
 * that the task has not been started.
 *
 * Static text only: a task title here would break the two byte-stable system
 * prompts (mainline / task branch) that the cache depends on. Titles travel in
 * the branch-tip delivery message instead (see taskStartMarker).
 */
export const TASK_BRANCH_SYSTEM_PROMPT = `# Task branch

You are inside a queued task branch: this task is already running. The mainline queued it with push-task and started it here; the mainline is blocked while you work and receives only your final message, as the task result.

- Never report that no task is running, and never ask for this task to be started - it is live now.
- The push-task / resume-task tool descriptions in this prompt describe the mainline; those tools are not available in this branch.
- A "Task stored ... \`/start-task\` ..." receipt in the history above was written for the mainline before this task started; it is not a statement that this task is unstarted.
- Use task-ask if that tool is available and a question blocks progress; otherwise state the blocker in your final message.
- Mode rules stated elsewhere in this prompt (for example plan mode) stay in force in this branch; if they forbid what this task asks for, name the conflict in your final message instead of doing forbidden work.
- Work to completion and make your final message the full report.
`;

/** The system-prompt text appended inside a task branch ("" on the mainline). */
export function taskBranchSystemPromptAppend(session: ReadonlySessionLike): string {
  return currentTask(session) === null ? "" : `\n\n${TASK_BRANCH_SYSTEM_PROMPT}`;
}

export function refreshTaskStatus(ctx: TaskStatusContext, options: TaskStatusOptions = {}): void {
  if (ctx.hasUI) {
    // The "[auto]" prefix is sticky while the auto switch is on: every
    // refresh (including event-handler ones without explicit options)
    // carries it, and it disappears once the loop exits.
    const prefix = options.prefix ?? (isAutoActive(ctx.sessionManager) ? AUTO_STATUS_PREFIX : "");
    updateTaskStatus(ctx.sessionManager, ctx.ui.setStatus.bind(ctx.ui), ctx.ui.theme, {
      ...options,
      prefix,
    });
    syncTaskBranchWidget(ctx);
  }
}

/**
 * The widget key of the persistent in-branch indicator above the editor.
 *
 * The footer status line is the bottom-most element of the dock: on short
 * terminals (phones with a soft keyboard) it is the first thing squeezed off
 * the screen, so the branch marker must not live only there. While the
 * current session is inside a task branch, a widget pinned above the input
 * box states it; everywhere else the widget is cleared. Guarded by the same
 * `currentTask` predicate as the branch system-prompt append, so the widget
 * and the prompt variant can never disagree.
 */
function syncTaskBranchWidget(ctx: TaskStatusContext): void {
  const active = currentTask(ctx.sessionManager);
  // Folded marker-safe variant: a multi-line/whitespace-only title would
  // otherwise render a multi-line widget line (Text renders each element on
  // one row) and defeat the widget's purpose on short phone terminals. The
  // footer status keeps the bare taskTitle() — pre-existing behavior.
  const title = active ? taskMarkerTitle(active.data.title) || "untitled" : undefined;
  ctx.ui.setWidget(
    "task-branch",
    title === undefined ? undefined : [`${ctx.ui.theme.fg("warning", "任务分支")}: ${title}`],
    { placement: "aboveEditor" },
  );
}

export function updateTaskStatus(
  session: ReadonlySessionLike,
  setStatus: (key: string, value: string | undefined) => void,
  theme: TaskStatusTheme,
  options: TaskStatusOptions = {},
): void {
  const prefix = options.prefix ?? "";
  const suspended = latestSuspendedTask(session);

  // A relayed question outranks queued-but-unstarted work: while the relay is
  // answering it, "awaiting answer" is the state that needs attention (a
  // batch run would otherwise keep showing "pending task: ..." instead).
  if (suspended?.data.reason === "ask") {
    setStatus(
      "task",
      `${prefix}${theme.fg("muted", `awaiting answer: ${taskTitle(suspended.data.title)}`)}`,
    );
    return;
  }

  const pending = pendingTasks(session);
  if (pending.length > 0) {
    const title = taskTitle(pending[0].data.title);
    const queued = pending.length > 1 ? ` (+${pending.length - 1} queued)` : "";
    setStatus("task", `${prefix}${theme.fg("accent", `pending task: ${title}${queued}`)}`);
    return;
  }

  const resume = pendingResume(session);
  if (resume) {
    const resumeTitle = resume.data.title ? `: ${taskTitle(resume.data.title)}` : "";
    setStatus("task", `${prefix}${theme.fg("accent", `pending resume${resumeTitle}`)}`);
    return;
  }

  const active = currentTask(session);
  if (active) {
    setStatus(
      "task",
      `${prefix}${theme.fg("warning", `current task: ${taskTitle(active.data.title)}`)}`,
    );
    return;
  }

  // Suspended runs are resumable checkpoints (relayed questions were handled
  // above). Shown in muted so the actionable states above stay dominant.
  if (suspended) {
    setStatus(
      "task",
      `${prefix}${theme.fg("muted", `suspended: ${taskTitle(suspended.data.title)}`)}`,
    );
    return;
  }

  setStatus("task", undefined);
}

/**
 * Locate `skills/<name>/SKILL.md` relative to this file. The walk is capped
 * at depth 2 — the current directory (source layout, skills/ would sit next
 * to src/) and the package root (published layout, skills/ next to
 * src/index.ts) — so it never escapes the extension package and cannot pick
 * up same-named skills from ancestor directories.
 */
export function findOwnSkillFile(
  name: string,
  startDir = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 2; depth++) {
    const candidate = join(dir, "skills", name, "SKILL.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Whether auto mode is on (a supervisor loop armed in `auto` policy). */
export function isAutoActive(sessionManager: object): boolean {
  const state = supervisorStates.get(sessionManager);
  return state?.stop !== undefined && state.mode === "auto";
}

/**
 * Whether any supervisor loop is armed for this session (auto or relay).
 * Relay-aware wording uses this; the "[auto] " status prefix stays bound to
 * isAutoActive.
 */
export function isSupervisorActive(sessionManager: object): boolean {
  return supervisorStates.get(sessionManager)?.stop !== undefined;
}

/**
 * Resolve once the supervisor loop is parked (or no loop is running).
 * Resolves immediately when no loop is running or it is already parked.
 * Test-only synchronization: the arming command returns right after starting
 * the detached loop, so tests need a barrier before asserting.
 *
 * Note: this only guarantees "parked", not "drained" - the loop parks at the
 * end of every iteration (a relay supervisor parks after each suspend and
 * each resume), so assert on stable points and never on this barrier alone.
 */
export function whenAutoParked(sessionManager: object): Promise<void> {
  const state = supervisorStates.get(sessionManager);
  if (!state?.stop || state.parked) return Promise.resolve();
  return new Promise((resolve) => {
    state.parkedWaiters.push(resolve);
  });
}

/**
 * Relay instructions appended to an injected task question (after the
 * question text). Exported so tests can strip them in sync with production.
 */
export const taskQuestionInstructions =
  "(The task is suspended waiting for this answer. Answer it here, then call resume-task with the answer in `message` to resume the task; if you cannot answer, ask the user - with a user-question tool if one is available, otherwise in plain text - and relay their answer the same way.)";

// ── Tool visibility sync ──────────────────────────────────────────

const TASK_BRANCH_ONLY_TOOLS = ["task-ask"];

const MAINLINE_ONLY_TOOLS = ["push-task", "resume-task"];

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

type PushTaskAPI = Pick<ExtensionAPI, "appendEntry">;

type TaskStatusTheme = Pick<Theme, "fg">;

type TaskStatusOptions = {
  prefix?: string;
};

type PushTaskParams = Static<typeof pushTaskParameters>;

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

type TaskStatusContext = Pick<ExtensionCommandContext, "hasUI" | "sessionManager" | "ui">;

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

async function discardTask(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
): Promise<TaskActionResult> {
  const activeTask = pendingTask(ctx.sessionManager);
  if (!activeTask) {
    ctx.ui.notify("No pending task to discard.", "warning");
    return;
  }

  pi.appendEntry(TASK_DONE_ENTRY_TYPE, { taskEntryId: activeTask.id });
  ctx.ui.notify("Task discarded.", "info");

  refreshTaskStatus(ctx);
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
      "Full prompt for the task, including all context and instructions. Must be self-contained for fresh tasks; fork tasks may reference the current conversation. Reference the task role skill in the prompt (/skill:task-review, /skill:task-research, /skill:task-implement).",
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

let skillsExternallySet = false;

let modelRegistry: ModelRegistry | undefined;

/**
 * Arm (or upgrade) the per-session supervisor loop. Navigation is only
 * possible from a command context (navigateTree / waitForIdle exist on
 * ExtensionCommandContext, not on event or tool contexts), which is why the
 * arming command hands its context to the detached loop.
 */
function armSupervisor(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  mode: SupervisorMode,
): "armed" | "upgraded" | "already-auto" | "already-supervised" {
  const state = getSupervisorState(ctx.sessionManager);

  if (state.stop) {
    // The loop is still alive (`stop` is cleared by its `finally`). Remember
    // the request so that a loop which is stopping right now re-arms instead
    // of swallowing it (the `/auto-stop` → `/start-task` window). A latch
    // left behind by a healthy loop is dropped by the next `stop()` and is
    // never honored by a loop that stopped itself.
    state.reArm = mode;

    if (mode === "relay") return "already-supervised";
    if (state.mode === "auto") return "already-auto";

    // A parked relay loop waits on its wake promise; switch the policy and
    // wake it so it re-evaluates (it re-reads state.mode every iteration).
    state.mode = "auto";
    state.wake?.();
    refreshTaskStatus(ctx, { prefix: AUTO_STATUS_PREFIX });
    return "upgraded";
  }

  state.mode = mode;
  // Detach: the command returns immediately and the loop supervises task
  // work in the background until /auto-stop (or an interrupt) stops it.
  void runSupervisorLoop(pi, ctx, state).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ctx.ui.notify(`Supervisor stopped unexpectedly: ${message}`, "error");
    } catch {
      console.error(`[supervisor] loop crashed: ${message}`);
    }
  });
  return "armed";
}

/**
 * The single foreground supervision loop (one per session). It never polls:
 * each iteration does its work and parks on a promise that the agent_end
 * handler resolves. All navigation happens here, on the command context the
 * arming command supplied.
 */
async function runSupervisorLoop(
  pi: TaskCommandAPI,
  ctx: ExtensionCommandContext,
  state: TaskSupervisorState,
): Promise<void> {
  let stopped = false;
  // Only a stop the user (or the shutdown handler) asked for may re-arm: see
  // the latch handling in `finally`.
  let stoppedByRequest = false;
  state.stop = () => {
    // A latch belongs to this stop only: drop any older one, so a stop can
    // never be undone by a stale re-arm request.
    state.reArm = undefined;
    stoppedByRequest = true;
    stopped = true;
    state.wake?.();
  };

  try {
    while (!stopped) {
      await ctx.waitForIdle();

      // Re-check after idle: stopped may have been set while we were waiting
      // (the reaction engine runs before the waiter resolves). Without this,
      // we'd fall through to task processing and might call finishTask even
      // though the session was shut down.
      if (stopped) break;

      // Re-read the policy per iteration: /auto can upgrade a parked relay
      // supervisor, which changes what this loop is allowed to do.
      const auto = state.mode === "auto";
      // The "[auto] " prefix marks the /auto switch, so a relay supervisor
      // passes none (refreshTaskStatus keeps it sticky while auto runs).
      const statusPrefix = auto ? AUTO_STATUS_PREFIX : undefined;

      if (auto && lastAssistantWasAborted(ctx.sessionManager)) break;

      // Starting queued tasks is /auto's job; a relay supervisor never
      // touches the queue.
      if (auto && pendingTask(ctx.sessionManager)) {
        const result = await startTask(pi, ctx, {
          statusPrefix,
          waitForAgentStart: (taskStartId) => waitForAgentStart(state, taskStartId),
        });
        // "error" is a refused/failed start that was already reported to the
        // user; only a cancelled navigation or a launch timeout ends
        // supervision.
        if (result !== "started" && result !== "error") break;
        continue;
      }

      if (pendingResume(ctx.sessionManager)) {
        const result = await resumeTask(pi, ctx, {
          statusPrefix,
          waitForAgentStart: (taskStartId) => waitForAgentStart(state, taskStartId),
        });
        // A discarded resume request ("error") is consumed with a visible
        // warning — keep the loop alive so queued tasks still run. Only a
        // cancelled navigation ends supervision; a launch timeout ends auto
        // mode but merely parks a relay supervisor, which is still armed to
        // relay the next question.
        if (result === "cancelled") break;
        if (result === "launch-timeout" && auto) break;
        continue;
      }

      const activeTask = currentTask(ctx.sessionManager);
      if (activeTask) {
        const hasReply = hasAssistantAfterTaskStart(ctx.sessionManager, activeTask.id);
        if (!hasReply && auto) {
          // Never auto-finalize before the task branch has produced a reply.
          ctx.ui.notify(
            "Auto stopped: the task agent has not produced a reply yet. Re-run /auto to resume supervision.",
            "warning",
          );
          break;
        }

        // A pending task-ask is relayed by suspending first, so the mainline
        // answers it instead of the task being finalized.
        if (hasReply && pendingAsk(ctx.sessionManager, activeTask.id)) {
          const result = await suspendTask(pi, ctx, { statusPrefix });
          if (result === "cancelled") break;
          continue;
        }

        // Finishing a run is /auto's job; a relay supervisor leaves that
        // decision to the user (/finish-task, /abort-task) and parks instead.
        if (hasReply && auto) {
          const result = await finishTask(pi, ctx, { statusPrefix });
          if (result === "cancelled") break;
          continue;
        }
      }

      // Nothing to do: park until the next agent run ends (or a
      // stop) wakes the loop. The snapshot is taken synchronously with
      // the last state check, so an agent_end between the check and
      // the park is detected below instead of being lost.
      const agentEndsAtPark = state.agentEndCount;
      setSupervisorParked(ctx.sessionManager, true);
      await new Promise<void>((resolve) => {
        state.wake = () => {
          state.wake = undefined;
          setSupervisorParked(ctx.sessionManager, false);
          resolve();
        };
      });
      // An agent_end fired while the loop was draining (before this
      // park): state may have changed since the last check — skip
      // parking and re-check instead of going idle on stale state.
      if (state.agentEndCount > agentEndsAtPark) continue;
    }
  } finally {
    settleAgentStartWaiter(state, false);
    state.stop = undefined;
    state.wake = undefined;
    setSupervisorParked(ctx.sessionManager, false);
    flushParkedWaiters(ctx.sessionManager);
    try {
      refreshTaskStatus(ctx);
    } catch {
      // The session may already be disposed/reloaded (stale ctx); there is no
      // status line left to update.
    }

    // An arm request that arrived while this loop was stopping (the
    // /auto-stop → /start-task window) is latched instead of swallowed; arm a
    // fresh loop for it rather than leaving the session unsupervised. Only a
    // requested stop may re-arm: a loop that stopped itself (abort, launch
    // timeout, cancelled navigation) must not resurrect supervision from a
    // latch some earlier arm request left behind.
    const reArm = state.reArm;
    state.reArm = undefined;
    if (reArm && stoppedByRequest) armSupervisor(pi, ctx, reArm);
  }
}

const AUTO_STATUS_PREFIX = "[auto] ";

function waitForAgentStart(state: TaskSupervisorState, taskStartId: string): Promise<boolean> {
  if (state.agentStartWaiter) {
    throw new Error("An agent-start waiter is already active.");
  }

  return new Promise((resolve) => {
    state.agentStartWaiter = {
      taskStartId,
      resolve,
      timeout: setTimeout(() => settleAgentStartWaiter(state, false), AUTO_AGENT_START_TIMEOUT_MS),
    };
  });
}

const AUTO_AGENT_START_TIMEOUT_MS = 60_000;

function settleAgentStartWaiter(state: TaskSupervisorState, started: boolean): void {
  const waiter = state.agentStartWaiter;
  if (!waiter) return;

  state.agentStartWaiter = undefined;
  clearTimeout(waiter.timeout);
  waiter.resolve(started);
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
    return "error";
  }

  // ── Model switching ─────────────────────────────────────────────
  let previousModel: TaskStartData["previousModel"];
  if (options.modelArg) {
    const matched = resolveModelPattern(options.modelArg, ctx.modelRegistry);
    if (matched === null) {
      ctx.ui.notify(`No model matching "${options.modelArg}".`, "warning");
      return "error";
    }
    if (matched === "ambiguous") {
      const names = matchModels(options.modelArg, ctx.modelRegistry)
        .map((m) => `${m.provider}/${m.id}`)
        .join(", ");
      ctx.ui.notify(`Ambiguous model: matches ${names}.`, "warning");
      return "error";
    }

    const currentModel = ctx.model;
    if (currentModel) {
      previousModel = { provider: currentModel.provider, modelId: currentModel.id };
    }

    const switched = await pi.setModel(matched);
    if (!switched) {
      ctx.ui.notify(`No API key configured for ${matched.provider}/${matched.id}.`, "warning");
      return "error";
    }
  }

  // ── Task start ──────────────────────────────────────────────────
  const departureLeafId = ctx.sessionManager.getLeafId()!;
  const fork = activeTask.data.fork === true;
  if (!fork) {
    const freshTargetId = findFreshTargetId(ctx.sessionManager);
    if (!freshTargetId) {
      ctx.ui.notify("No starting point found on current branch.", "warning");
      return "error";
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
  const deliveredPrompt = await inlineRoleSkills(activeTask.data.prompt, activeTask.data.skills);
  // "untitled" fallback: a title made of "]"/whitespace only sanitizes to "".
  const label = taskMarkerTitle(activeTask.data.title) || "untitled";
  const framing = fork ? TASK_START_FRAMING_FORK : TASK_START_FRAMING_FRESH;
  pi.sendUserMessage(taskStartMarker(label) + framing + deliveredPrompt);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });

  if (agentStarted && !(await agentStarted)) {
    ctx.ui.notify(
      `Supervisor: no agent_start was observed within ${AUTO_AGENT_START_TIMEOUT_MS / 1000} seconds (timeout or session shutdown). The task prompt was already delivered and may still run; check the branch before restarting supervision.`,
      "error",
    );
    return "launch-timeout";
  }

  return "started";
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
    pi.appendEntry(TASK_DONE_ENTRY_TYPE, {
      ...(taskStart.data.taskEntryId ? { taskEntryId: taskStart.data.taskEntryId } : {}),
    });
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
        pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, { resumeEntryId: request.id });
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
      pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, { resumeEntryId: request.id });
      ctx.ui.notify("Resume request discarded: no resumable task on this branch.", "warning");
      refreshTaskStatus(ctx, { prefix: options.statusPrefix });
      return "error";
    }
    ctx.ui.notify(
      "No resumable task. A task becomes resumable after it is finished, aborted, or suspended.",
      "warning",
    );
    return "error";
  }

  const title = taskMarkerTitle(suspended.data.title) || "untitled";
  if (!message) {
    message = `You are resuming the task "${title}". Continue from where you left off.`;
  }

  // Consume the request before capturing the departure leaf: returnTo must
  // contain the task-resume-done entry, otherwise navigating back at finish
  // would orphan it on a side branch and /auto would re-execute the request.
  if (request) {
    pi.appendEntry(TASK_RESUME_DONE_ENTRY_TYPE, { resumeEntryId: request.id });
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
  pi.sendUserMessage(taskResumeMarker(title) + TASK_RESUME_FRAMING + message);

  refreshTaskStatus(ctx, { prefix: options.statusPrefix });

  if (agentStarted && !(await agentStarted)) {
    ctx.ui.notify(
      `Supervisor: no agent_start for the resumed task was observed within ${AUTO_AGENT_START_TIMEOUT_MS / 1000} seconds (timeout or session shutdown). The resume message was already delivered and may still run - auto mode stops here, a relay stays armed; check the branch before restarting supervision.`,
      "error",
    );
    return "launch-timeout";
  }

  return "started";
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
    pi.appendEntry(TASK_DONE_ENTRY_TYPE, {
      ...(taskStart.data.taskEntryId ? { taskEntryId: taskStart.data.taskEntryId } : {}),
    });
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

/**
 * Result of a task action. "started" means the prompt was delivered and Pi
 * reported the agent as active; the void members are actions that never start
 * a run at all (discard, finish, abort, suspend).
 */
type TaskActionResult = "started" | "cancelled" | "launch-timeout" | "error" | void;

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

/** Oldest unconsumed resume request (FIFO), or null inside a task branch. */
function pendingResume(session: ReadonlySessionLike): TaskResumeEntry | null {
  const stack: TaskResumeEntry[] = [];

  for (const entry of session.getBranch()) {
    if (entry.type === "custom" && entry.customType === TASK_START_ENTRY_TYPE) {
      // Inside a task branch the queue below it does not belong to the run.
      stack.length = 0;
      continue;
    }
    if (entry.type === "custom" && entry.customType === TASK_RESUME_DONE_ENTRY_TYPE) {
      // A done with an id removes exactly the request it names; a legacy done
      // without one consumes the newest request (the pre-FIFO LIFO rule).
      const id = taskResumeDoneEntryId(entry);
      if (id === undefined) {
        stack.pop();
        continue;
      }
      const index = stack.findIndex((request) => request.id === id);
      if (index !== -1) stack.splice(index, 1);
      continue;
    }
    if (isTaskResumeEntry(entry)) {
      stack.push(entry);
    }
  }

  return stack[0] ?? null;
}

/** Id recorded by a task-resume-done, or undefined for legacy entries without one. */
function taskResumeDoneEntryId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== TASK_RESUME_DONE_ENTRY_TYPE) {
    return undefined;
  }
  const data: unknown = entry.data;
  return isRecord(data) && typeof data.resumeEntryId === "string" ? data.resumeEntryId : undefined;
}

const TASK_RESUME_DONE_ENTRY_TYPE = "task-resume-done";

function latestSuspendedTask(session: ReadonlySessionLike): TaskSuspendedEntry | null {
  return findLastEntry(session, isTaskSuspendedEntry) ?? null;
}

/**
 * Whether finishing/suspending this run must consume its queued task entry.
 * The entry id recorded at start (carried through resume via task-suspended)
 * is checked against the FIFO queue accounting, so a resumed run consumes its
 * task entry exactly when it is still pending (e.g. after an abort) and never
 * consumes an unrelated earlier task. Legacy task-start entries without an
 * id fall back to the pre-resume rule.
 */
function shouldConsumeTaskEntry(session: ReadonlySessionLike, taskStart: TaskStartEntry): boolean {
  if (taskStart.data.taskEntryId !== undefined) {
    return taskEntryPending(session, taskStart.data.taskEntryId);
  }
  return !taskStart.data.resume && pendingTask(session) !== null;
}

/** Queue head: the task /start-task, /discard-task, and /auto act on. */
function pendingTask(session: ReadonlySessionLike): TaskEntry | null {
  return pendingTasks(session)[0] ?? null;
}

/** Whether the queued task entry is still unconsumed (id-based queue accounting). */
function taskEntryPending(session: ReadonlySessionLike, taskEntryId: string): boolean {
  return pendingTasks(session).some((task) => task.id === taskEntryId);
}

// ── Lookup utilities ──────────────────────────────────────────────

/**
 * Unconsumed tasks on this branch, enqueue order (oldest first). Forward scan
 * with a stack: a task-start clears the stack (inside a branch only the
 * current task counts), a task pushes, and a task-done removes the entry it
 * names (`taskEntryId`) - or, for legacy entries without an id, pops the
 * nearest unconsumed task (the pre-FIFO rule). The stack bottom is the queue
 * head: the next task /start-task, /discard-task, and /auto act on.
 */
function pendingTasks(session: ReadonlySessionLike): TaskEntry[] {
  const stack: TaskEntry[] = [];

  for (const entry of session.getBranch()) {
    if (entry.type === "custom" && entry.customType === TASK_START_ENTRY_TYPE) {
      stack.length = 0;
      continue;
    }
    if (entry.type === "custom" && entry.customType === TASK_DONE_ENTRY_TYPE) {
      const id = taskDoneEntryId(entry);
      if (id === undefined) {
        stack.pop();
        continue;
      }
      const index = stack.findIndex((task) => task.id === id);
      if (index !== -1) stack.splice(index, 1);
      continue;
    }
    if (isTaskEntry(entry)) {
      stack.push(entry);
    }
  }

  return stack;
}

/** Id recorded by a task-done, or undefined for legacy entries without one. */
function taskDoneEntryId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== TASK_DONE_ENTRY_TYPE) return undefined;
  const data: unknown = entry.data;
  return isRecord(data) && typeof data.taskEntryId === "string" ? data.taskEntryId : undefined;
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
    (value.fork === undefined || typeof value.fork === "boolean") &&
    (value.skills === undefined ||
      (Array.isArray(value.skills) &&
        value.skills.every(
          (s) => isRecord(s) && typeof s.name === "string" && typeof s.filePath === "string",
        )))
  );
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

/**
 * Rewrite `/skill:name` refs in a prompt to the referenced SKILL.md path, and
 * collect the names that resolve to nothing.
 *
 * The name pattern needs at least two characters (`[a-z0-9]`, single hyphens as
 * separators) and must end at a name boundary: a longer token is either a whole
 * name or no ref at all, so `/skill:ab--c` is left alone instead of being
 * rewritten into a path with a `--c` tail glued to it. A one-character ref such
 * as `/skill:a` is not matched, and is not reported either.
 *
 * Refs inside a fence are documentation, not refs (see splitFencedSegments).
 *
 * Unresolved names are returned to the caller and warned about on the mainline:
 * the mainline is still the active context and can fix the ref, and the token
 * stays in the delivered prompt as written. A ref inside an inlined role skill
 * is the opposite case — the branch never sees a mainline warning — so
 * inlineRoleSkills appends a Note to the delivered prompt for it instead.
 */
function resolveSkillRefs(prompt: string): ResolveResult {
  const unresolvedSet = new Set<string>();
  const resolved: Skill[] = [];
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }

  const rewriteSegment = (segment: string): string =>
    segment.replace(/\/skill:([a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9])(?![\w-])/g, (match, name) => {
      const skill = byName.get(name) ?? ownSkillByName(name);
      if (skill) {
        if (!resolved.some((s) => s.name === skill.name)) {
          resolved.push(skill);
        }
        return skill.filePath;
      }
      unresolvedSet.add(name);
      return match;
    });

  const rewritten = splitFencedSegments(prompt)
    .map((segment) => (segment.fenced ? segment.text : rewriteSegment(segment.text)))
    .join("");

  return { rewritten, unresolved: [...unresolvedSet], resolved };
}

/**
 * Split text into contiguous segments, flagging the fenced ones. A `/skill:`
 * mention inside a fence is documentation, not a ref, so only unfenced
 * segments are rewritten.
 *
 * These rules are prompt semantics, deliberately not CommonMark: the goal is to
 * skip anything that reads as a code sample, and CommonMark's stricter indent
 * rule would only lose mentions in indented code blocks that should have been
 * left alone.
 *
 * - A fence is opened by a line whose first non-whitespace characters are a run
 *   of 3+ backticks or 3+ tildes. Leading spaces and tabs are allowed, so an
 *   indented code sample counts as fenced too.
 * - It is closed by a line that *starts* with the same character in an equally
 *   long or longer run, whatever follows that run — a stray info string on the
 *   closing line counts as a close.
 * - An unclosed fence reaches the end of the text.
 * - Failure direction: a fenced segment is neither rewritten nor reported as
 *   unresolved (no Note is appended), so an over-eager fence only falls back to
 *   leaving the text alone, while a fence missed would silently drop a live ref.
 *   Hence the tolerance: err on the side of fencing.
 */
function splitFencedSegments(text: string): Array<{ text: string; fenced: boolean }> {
  const segments: Array<{ text: string; fenced: boolean }> = [];
  let buffer = "";
  let open: { char: string; length: number } | undefined;
  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, fenced: open !== undefined });
    }
    buffer = "";
  };

  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) {
      buffer += line;
      if (marker && marker[0] === open.char && marker.length >= open.length) {
        flush();
        open = undefined;
      }
      continue;
    }
    if (marker) {
      flush();
      open = { char: marker[0], length: marker.length };
      buffer = line;
      continue;
    }
    buffer += line;
  }
  flush();
  return segments;
}

interface ResolveResult {
  rewritten: string;
  unresolved: string[];
  resolved: Skill[];
}

/**
 * Append the resolved role skills' SKILL.md content to the delivered prompt.
 * Deterministic role loading: the task branch receives the full role contract
 * inline instead of depending on the model reading the referenced file paths.
 * Paths that fail to read fall back to the path reference already in the prompt
 * and add a trailing Note, so a ref that never got inlined is never silent.
 *
 * Resolution is transitive: a role skill may itself reference further role
 * skills with `/skill:name`, and those bodies are inlined as well. The inlined
 * bodies are the rewritten ones, so a nested ref reaches the branch as an
 * absolute path — Pi expands `/skill:` commands in user input only, never
 * inside a delivered prompt.
 */
async function inlineRoleSkills(prompt: string, refs?: TaskData["skills"]): Promise<string> {
  if (!refs || refs.length === 0) return prompt;
  const sections: string[] = [];
  const seen = new Set<string>();
  // Nested refs that resolve to nothing are reported to the branch instead of
  // being warned on the mainline: this runs after the branch was started and
  // the mainline is no longer the active context. Keyed by name so a ref that
  // several skills point at is reported once, naming the first referrer.
  const missing = new Map<string, string>();
  // A ref that resolved but whose SKILL.md could not be read keeps its
  // absolute path in the prompt, so the branch can read it on its own.
  const unreadable: Array<{ name: string; filePath: string }> = [];
  const queue: Array<{ name: string; filePath: string }> = [...refs];
  let capped = false;
  while (queue.length > 0) {
    if (sections.length >= MAX_INLINED_ROLE_SKILLS) {
      capped = true;
      break;
    }
    const ref = queue.shift();
    if (!ref || seen.has(ref.name)) continue;
    seen.add(ref.name);
    const content = await readRoleSkill(ref);
    if (content === undefined) {
      unreadable.push({ name: ref.name, filePath: ref.filePath });
      continue;
    }
    const { rewritten, resolved, unresolved } = resolveSkillRefs(content);
    for (const name of unresolved) {
      if (!missing.has(name)) missing.set(name, ref.name);
    }
    sections.push(`==== Task role skill: ${ref.name} ====\n${rewritten}`);
    for (const nested of resolved) {
      if (!seen.has(nested.name)) queue.push(nested);
    }
  }
  // Refs left queued by the cap: dedupe (the same ref can be queued by two
  // referrers) and drop names that were inlined before the cap was reached.
  const dropped: Array<{ name: string; filePath: string }> = [];
  if (capped) {
    const reported = new Set<string>();
    for (const ref of queue) {
      if (seen.has(ref.name) || reported.has(ref.name)) continue;
      reported.add(ref.name);
      dropped.push(ref);
    }
  }
  const notes = [
    ...[...missing].map(
      ([name, referencedBy]) =>
        `Note: /skill:${name} (referenced by ${referencedBy}) was not found.`,
    ),
    ...unreadable.map(
      ({ name, filePath }) => `Note: /skill:${name} could not be read (${filePath}).`,
    ),
    ...dropped.map(
      ({ name, filePath }) =>
        `Note: /skill:${name} was not inlined (MAX_INLINED_ROLE_SKILLS=${MAX_INLINED_ROLE_SKILLS} reached); read ${filePath}.`,
    ),
  ];
  if (sections.length === 0 && notes.length === 0) return prompt;
  const parts = [prompt];
  if (sections.length > 0) parts.push(sections.join("\n\n"));
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}

interface TaskData {
  title?: string;
  prompt: string;
  fork?: boolean;
  /** Resolved role skills (/skill: refs) inlined into the delivered prompt. */
  skills?: Array<{ name: string; filePath: string }>;
}

/**
 * Read a resolved role skill's SKILL.md. If the recorded path fails to read
 * (e.g. it vanished since push), retry once against the extension's bundled
 * copy by name; only give up — and fall back to the path reference already
 * in the prompt — when both are unreadable.
 */
async function readRoleSkill(ref: { name: string; filePath: string }): Promise<string | undefined> {
  try {
    return await readFile(ref.filePath, "utf8");
  } catch {
    const fallback = ownSkillByName(ref.name);
    if (!fallback || fallback.filePath === ref.filePath) return undefined;
    try {
      return await readFile(fallback.filePath, "utf8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Fallback lookup in the extension's own bundled skills directory.
 *
 * The registry is primed from Pi's loaded skills via before_agent_start. If
 * Pi fails to load a skill (e.g. a rejected frontmatter parse) or the
 * extension runs without its package `pi.skills` metadata discovered, the
 * role skills must still resolve, so this walks up from this file's
 * directory looking for `skills/<name>/SKILL.md` — the extension stays
 * self-contained instead of depending on the upstream load chain.
 */
function ownSkillByName(name: string): Skill | undefined {
  const filePath = findOwnSkillFile(name);
  if (!filePath) return undefined;
  const baseDir = dirname(filePath);
  return {
    name,
    description: "Bundled role skill resolved from the extension's own skills directory.",
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "extension", origin: "package" }),
    disableModelInvocation: true,
  };
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

function setSupervisorParked(sessionManager: object, parked: boolean): void {
  const state = getSupervisorState(sessionManager);
  state.parked = parked;
  if (parked) flushParkedWaiters(sessionManager);
}

function getSupervisorState(sessionManager: object): TaskSupervisorState {
  let state = supervisorStates.get(sessionManager);
  if (!state) {
    state = {
      stop: undefined,
      mode: "auto",
      reArm: undefined,
      parked: false,
      parkedWaiters: [],
      wake: undefined,
      agentEndCount: 0,
      agentStartWaiter: undefined,
    };
    supervisorStates.set(sessionManager, state);
  }
  return state;
}

// One loop per session. Set while a supervisor loop is armed; /auto-stop
// calls `stop` to request a graceful stop at the next step boundary (no
// idempotence issue: the loop re-checks the stopped flag after every
// waitForIdle).
interface TaskSupervisorState {
  /** Set while a supervisor loop is armed for this session. */
  stop: (() => void) | undefined;
  /** Effective policy; /auto upgrades a running relay supervisor. */
  mode: SupervisorMode;
  /**
   * Arm request latched while the loop is stopping (its `finally` re-arms
   * with it): `/auto-stop` clears `stop` only after the current iteration,
   * so an arming command in that window must not be swallowed. It is honored
   * only when the stop was requested, and `stop()` drops any older latch, so
   * it can never outlive the stop it belongs to.
   */
  reArm: SupervisorMode | undefined;
  /** True while the loop is parked waiting for the next agent_end wake. */
  parked: boolean;
  /** Waiters resolved on each park transition (see whenAutoParked). */
  parkedWaiters: Array<() => void>;
  /** Resolves the current park; cleared when it fires. */
  wake: (() => void) | undefined;
  /**
   * Total agent_end events observed. The loop snapshots it at the park
   * point, so a run that ended during the drain cannot be lost by parking
   * anyway: the snapshot comparison makes the loop re-check instead.
   */
  agentEndCount: number;
  /** Barrier armed before sendUserMessage (AUTO_AGENT_START_TIMEOUT_MS). */
  agentStartWaiter: AgentStartWaiter | undefined;
}

type AgentStartWaiter = {
  taskStartId: string;
  resolve: (started: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * Which work the armed loop owns. `auto` is the /auto switch (start queued
 * tasks, relay questions, finish runs); `relay` only moves questions to the
 * mainline and carries the answer back into the branch.
 */
type SupervisorMode = "auto" | "relay";

function flushParkedWaiters(sessionManager: object): void {
  const state = supervisorStates.get(sessionManager);
  if (!state) return;
  const waiters = state.parkedWaiters;
  state.parkedWaiters = [];
  for (const resolve of waiters) resolve();
}

// Supervisor state is keyed by SessionManager: several sessions can share one
// process (the test harness runs many), so module-level globals would leak.
const supervisorStates = new WeakMap<object, TaskSupervisorState>();

// ── Skill resolution registry ─────────────────────────────────────

let skills: Skill[] = [];
