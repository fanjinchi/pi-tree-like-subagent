# AGENTS.md — pi-tree-like-subagent

A Pi extension implementing tree-native task automation (no subagents). Fork of pi-supergsd.

## Architecture

- **`index.ts`** — extension entry: registers tools/commands/renderers, wires events.
- **`src/index.ts`** — task system core: tools (`push-task`, `resume-task`, `task-ask`), commands (`/start-task`, `/finish-task`, `/abort-task`, `/discard-task`, `/resume-task`, `/suspend-task`, `/auto`, `/auto-stop`), entry accounting, branch tool-visibility sync.
- **`src/test-helpers/`** — integration harness: `TestHarness.create()` (in-memory `AgentSession` + `SessionManager`, `MockLLM`/`MockUser`/`FauxProvider`), `TestNode` tree runner.
- **`skills/`** — committed skills. Served at runtime via `package.json` → `pi.skills`.

### Task state machine (custom session entries, not model-visible)

| Entry type          | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `task`              | Queued task (`{title, prompt, fork?}`)                               |
| `task-start`        | A run started (`{title, returnTo, taskEntryId?, fork?, resume?}`)     |
| `task-done`         | Consumes the queued task it names (`taskEntryId`); legacy entries without an id pop the nearest unconsumed task (pre-FIFO rule) |
| `task-suspended`    | Resumable point (`{title, branchLeafId, reason, taskEntryId?}`)       |
| `task-resume`       | Queued resume request (`{title?, message}`)                          |
| `task-resume-done`  | Consumes the resume request it names (`resumeEntryId`); legacy entries without an id pop the newest unconsumed request (pre-FIFO rule) |
| `task-ask`          | Pending question for the mainline (`{question}`)                     |

Invariants:

- Every `task` entry is consumed by exactly one `task-done`. Consumption is id-checked via `taskEntryId` (a resumed run consumes its entry iff it is still pending, e.g. after an abort).
- Queue order is FIFO: `/start-task`, `/discard-task`, and `/auto` always act on the oldest unconsumed `task` above the latest `task-start`. Queued resume requests run oldest first too. Consumption is id-checked (`taskEntryId`/`resumeEntryId`); legacy entries without an id pop the newest unconsumed entry (pre-FIFO rule).
- `task-suspended`/`task-ask`/`task-resume*` never participate in `pendingTask` accounting.
- When leaving a branch, `returnTo` must be captured **after** appending all bookkeeping entries meant for the departure branch — otherwise the return navigation orphans them.
- `navigateTree` is only available on command context; never call it from event handlers.

### Task-branch identity (delivery framing + system-prompt block)

A branch tip's model-visible delivery always opens with a `[<kind>: <label>]` marker and a **static framing sentence** stating that the task is already running: `[task-start: <title>]` for a started task (fork and fresh wording differ — a fork must not read the inherited `push-task` receipt as "not started yet"), `[task-resume: <title>]` for a resume, next to the older `task-result` / `task-question` markers. The start and resume delivery call sites label with `taskMarkerTitle(<raw title>) || "untitled"` (a title made of `]`/whitespace only sanitizes to `""`); the marker helpers stay pure formatting (no sanitizing inside). The older `task-result` / `task-question` call sites pass `taskMarkerTitle(...)` without that fallback — pre-existing and unchanged here.

The branch system prompt carries the static `TASK_BRANCH_SYSTEM_PROMPT` block, appended in the root `index.ts` `before_agent_start` handler whenever `taskBranchSystemPromptAppend(ctx.sessionManager)` finds a `currentTask` — the same predicate as the tool-visibility sync, so prompt variant and tool set never diverge. Two rules for that block: its first sentence must assert the identity on its own (extensions are chained in **load** order, so a later-loaded extension appends *after* us — position is not authority), and it must stay free of dynamic data (titles travel only in the branch-tip message). Mode blocks (plan mode, ACP) stay in force inside branches by design; the block says so instead of overriding them.

### Task supervisor (auto / relay)

- One foreground serial loop supervises task work. `armSupervisor(pi, ctx, mode)` — called from a command handler, never an event handler — starts or upgrades a detached loop and returns immediately; the loop navigates only through the `ExtensionCommandContext` captured at arming time. Two modes:
  - `relay` — armed **silently** by `/start-task` and `/resume-task` whenever a run actually started (`"started"` or `"launch-timeout"`). It only relays `task-ask`: on a pending ask it suspends the task, returns to the mainline (the injected question self-instructs the mainline to answer with `resume-task`), and picks up the queued resume. It never starts queued tasks and never finishes an open run.
  - `auto` — `/auto` as a switch: everything relay does, plus starting queued tasks/queued resumes and finishing an open branch once it has a reply.
- Arming is idempotent and returns `"armed" | "upgraded" | "already-auto" | "already-supervised"`: `/auto` over a parked relay upgrades the same loop in place (no second loop, no double `agent_end` handling). `/auto-stop` stops either mode. An arm request that arrives while the loop is stopping (the `/auto-stop` → `/start-task` window) is latched in `state.reArm` and re-armed by the loop's `finally` instead of being swallowed; the latch is honored only when that stop was requested and `stop()` drops older latches too, so neither a stale latch nor a loop that stopped itself (abort, launch timeout, cancelled navigation) can resurrect supervision. Per-session state lives in `supervisorStates` (a `WeakMap` keyed by `SessionManager`) — never module-level globals, or parallel harness sessions leak into each other.
- The loop parks whenever it has nothing to do; the `agent_end` handler only resolves the park promise (all navigation stays inside the loop). The loop snapshots a monotonically increasing `agent_end` counter at the park point so an `agent_end` that fired mid-drain is never lost (every wake trigger — a pushed task, a `/start-task`, a finished task — is preceded by a run ending).
- Interrupts: an aborted last assistant turn stops `auto` but leaves `relay` armed; a cancelled navigation (an explicit user Esc) ends either loop, as do `/auto-stop` and session shutdown — a later `/start-task`/`/resume-task` arms a fresh relay. A launch timeout ends `auto` but parks `relay`, because the next question is still worth relaying. No self-unloading logic, no timers, no polling while parked.
- `whenAutoParked(sessionManager)` (exported from `src/index.ts`) resolves once the running loop has parked — **parked, not drained**: the loop parks after every suspension, so it is a barrier for "the loop is idle now", not "the queue is empty". The test harness wraps it as `h.waitForAutoParked()` — await it after `h.prompt("/auto")` before asserting.
- The `"[auto] "` status prefix is sticky while auto runs: `refreshTaskStatus` applies it by default whenever `isAutoActive(sessionManager)`. All status writes must go through `refreshTaskStatus` (including the `session_start`/`turn_end`/`session_tree` handlers in root `index.ts`) — a direct `updateTaskStatus` call would strip the prefix. Relay supervision passes no prefix.
- `navigateTree` is only available on command context; never call it from event handlers. Task actions therefore return `TaskActionResult = "started" | "cancelled" | "launch-timeout" | "error" | void` (`void` when the action never started a run) and the loop owns the exit policy for each value.

### Cache constraints (do not regress)

1. State entries are `appendEntry` custom entries (model-invisible) — keep it that way.
2. Model-visible injections (`task-result`, `task-question`, the `[task-start: …]` / `[task-resume: …]` deliveries, resume messages) only ever append at the branch tip, each as `[<kind>: <label>]` + static framing + payload (`taskStartMarker` / `taskResumeMarker` with `TASK_START_FRAMING_FORK|FRESH` / `TASK_RESUME_FRAMING`).
3. Tool visibility sync (`syncTaskToolVisibility`) must filter subsets of the canonical order captured at `session_start`, so exactly two byte-stable system prompts exist (mainline / task branch): the branch variant is the mainline prompt **with the branch tool set** (`task-ask` in place of `push-task`/`resume-task`) **and** the static `TASK_BRANCH_SYSTEM_PROMPT` block appended at the end by the root `index.ts` `before_agent_start` handler, via the same `currentTask(session) !== null` predicate. `src/prompt-framing.test.ts` pins both the delivery wording and the appended block.
4. System prompt takes static text only — dynamic data (task titles) travels in user messages, never in the system prompt.
5. Same for the **tool descriptions and `promptGuidelines`**: `task-ask` / `resume-task` wording is part of the two byte-stable system prompts, so it must stay mode-neutral — never interpolate the live supervisor mode (`isSupervisorActive`) into it. Mode-dependent wording is allowed only in branch-tip messages (notify / tool results), which are not cached.

## Conventions

- TypeScript, ES modules, Node 20+, `tsx` for execution
- Node built-in test runner (`node:test`)

## Commands

```bash
npm run fix           # Prettier then ESLint autofix
npm test              # All tests (src/ + scripts/)
npx tsc --noEmit      # Type-check src/ + scripts/
npm run verify        # Full gate: tsc → eslint → test → prettier --check
```

**Commit sequence:** `fix` first to autofix what it can, then `verify` for the full gate (tsc → eslint → test → prettier --check). Never skip `fix`.

## Formatting

- **Prettier** formats all `.ts` files. Default config except `singleQuote: true` to match codebase conventions.
- Generated `skills/` directory is ignored via `.prettierignore`.
- `npm run fix` runs Prettier write then ESLint autofix.
- `npm run verify` includes `prettier --check` to enforce formatting in CI.

## Testing policy

- Integration tests through the public surface: LLM tool calls (mocked via `MockLLM` rules) and slash commands (`h.prompt("/start-task")`).
- Scenario trees with `node(...).children(...)` (`src/test-helpers/test-tree.ts`); each leaf test re-runs the ancestor chain on a fresh harness.
- Mock LLM: `onPrompt(text, ...descriptors)` matches the last user message by substring; descriptors are `responds`, `thinks`, `pushTask(title, prompt, fork?)`, `resumeTask(title?, message)`, `taskAsk(question)`. Use `onPromptSequence(text, rounds)` when consecutive calls with the same prompt must differ (e.g. a tool guard error followed by a plain reply).
- Assert branch state with `h.assertSession(...)` (converted descriptors; custom bookkeeping entries are invisible). `h.assertSession` compares the **current branch only** — after a suspend/relay the branch-side `task-ask`/`task-resume-done` entries are no longer on the path, so use `h.countAllCustomEntries(type)` for cross-branch accounting and `h.countBranchCustomEntries(type)`/`h.branchCustomData(type)` for on-path entries. Tool visibility with `h.activeToolNames()`, prompt stability with `h.systemPromptText()`.
- Supervisor audit rule: `/start-task` and `/resume-task` arm the relay, which consumes queued resume requests and suspends on a pending ask by itself. Any test that injects bookkeeping entries by hand, drives resume consumption itself, or wants to answer an ask inside the branch must therefore `await h.prompt("/auto-stop")` right after `/start-task` — deterministic only when that branch turn does not end with an ask; otherwise use the order "close the turn with a normal reply, `/auto-stop`, then create the ask" (mocks: `responds(...)` then `taskAsk(...)`). Tests about the relay itself stay armed and use `await h.waitForAutoParked()` as the barrier.
- The FauxProvider fails fast on no-progress mock loops (same prompt + same responses 3× inside one turn) — if a test hits it, fix the rules or the tool's `terminate` behavior.
- Manual session injection only for Pi-produced entries (user/assistant messages), not task state.

## Adding or modifying a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`)
2. Add supporting files alongside
3. Commit
