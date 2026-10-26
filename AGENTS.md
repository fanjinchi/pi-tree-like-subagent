# AGENTS.md — pi-tree-like-subagent

A Pi extension implementing tree-native task automation (no subagents). Fork of pi-supergsd.

## Architecture

- **`index.ts`** — extension entry: registers tools/commands/renderers, wires events.
- **`src/index.ts`** — task system core: tools (`push-task`, `list-tasks`, `resume-task`), commands (`/start-task`, `/finish-task`, `/abort-task`, `/discard-task`, `/resume-task`, `/suspend-task`, `/auto`, `/auto-stop`), entry accounting, branch tool-visibility sync, the non-TUI boundary drain (`agent_before_settle`).
- **`src/test-helpers/`** — integration harness: `TestHarness.create()` (in-memory `AgentSession` + `SessionManager`, `MockLLM`/`MockUser`/`FauxProvider`), `TestNode` tree runner.
- **`skills/`** — committed skills. Served at runtime via `package.json` → `pi.skills`.

### Task state machine (custom session entries, not model-visible)

| Entry type          | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `task`              | Queued task (`{title, prompt, fork?}`)                               |
| `task-start`        | A run started (`{title, returnTo, taskEntryId?, fork?, resume?, restoreFromEntryId?, restoreSummary?}`) |
| `task-done`         | Consumes the queued task it names (`taskEntryId`); legacy entries without an id pop the nearest unconsumed task (pre-FIFO rule) |
| `task-suspended`    | Resumable point (`{title, branchLeafId, content?, reason, taskEntryId?}`) — TUI suspend/finish, plus the flat drain's interrupt/abort closures |
| `task-resume`       | Queued resume request (`{title?, message}`)                          |
| `task-resume-done`  | Consumes the resume request it names (`resumeEntryId`); legacy entries without an id pop the newest unconsumed request (pre-FIFO rule) |

These entries are model-invisible, and a finished epoch's transcript is masked, so `list-tasks` is the model's query surface over them: it reads `session.getBranch()`, groups by `taskEntryId` (one row per task however many times it was resumed), and reports a fixed lowercase status (`running` / `queued` / `interrupted` / `aborted` / `finished` / `discarded`) plus `resumable` = has a `task-suspended` anchor or a `task-done.content` checkpoint. It writes nothing.

Model-visible deliveries travel as `custom_message` entries with their own `customType`: `task-result` (finish report to the mainline), `task-start-delivery` / `task-resume-delivery` (flat-mode branch-tip framing).

Invariants:

- Every `task` entry is consumed by exactly one `task-done`. Consumption is id-checked via `taskEntryId` (a resumed run consumes its entry iff it is still pending, e.g. after an abort).
- Queue order is FIFO: `/start-task`, `/discard-task`, and `/auto` always act on the oldest unconsumed `task` above the latest `task-start`. Queued resume requests run oldest first too. Consumption is id-checked (`taskEntryId`/`resumeEntryId`); legacy entries without an id pop the newest unconsumed entry (pre-FIFO rule).
- `task-suspended`/`task-resume*` never participate in `pendingTask` accounting.
- A task's open epoch is the newest `task-start` not yet closed by a **matching** `task-done` (same `taskEntryId`; an id-less legacy done closes any open epoch). A done naming a different id (e.g. discarding a sibling queue entry mid-run) must not close the epoch.
- When leaving a branch, `returnTo` must be captured **after** appending all bookkeeping entries meant for the departure branch — otherwise the return navigation orphans them.
- `navigateTree` is only available on command context; never call it from event handlers.

### Task-branch identity (delivery framing + system-prompt block)

A branch tip's model-visible delivery always opens with a `[<kind>: <label>]` marker and a **static framing sentence** stating that the task is already running: `[task-start: <title>]` for a started task (fork and fresh wording differ — a fork must not read the inherited `push-task` receipt as "not started yet"), `[task-resume: <title>]` for a resume, next to the older `task-result` marker. The start and resume delivery call sites label with `taskMarkerTitle(<raw title>) || "untitled"` (a title made of `]`/whitespace only sanitizes to `""`); the marker helpers stay pure formatting (no sanitizing inside). The older `task-result` call site passes `taskMarkerTitle(...)` without that fallback — pre-existing and unchanged here.

The branch system prompt carries the static `TASK_BRANCH_SYSTEM_PROMPT` block, contributed as the `task_branch` prompt section by the root `index.ts` `before_agent_start` handler whenever `taskBranchSystemPromptAppend(ctx.sessionManager)` finds a `currentTask` — the same predicate as the tool-visibility sync, so prompt variant and tool set never diverge. (The handler must not return `systemPrompt`: in 0.87.1 that force-replaces the whole prompt and clobbers other extensions' contributions; a named section renders at the prompt tail and is recorded in the transcript's system message. `src/prompt-framing.test.ts` pins this.) Two rules for that block: its first sentence must assert the identity on its own (extensions contribute sections in **load** order, so a later-loaded extension's section may render *after* ours — position is not authority), and it must stay free of dynamic data (titles travel only in the branch-tip message). Mode blocks (plan mode, ACP) stay in force inside branches by design; the block says so instead of overriding them.

### Task supervisor (auto)

- One foreground serial loop supervises task work **in the TUI**. `armSupervisor(pi, ctx)` — called from a command handler, never an event handler — starts a detached loop and returns immediately; the loop navigates only through the `ExtensionCommandContext` captured at arming time. `/auto` arms it: it starts queued tasks/queued resumes and finishes an open branch once it has a reply. In RPC mode it is armed from the session's first moment, before any prompt (see the default-on bullet below).
- **The loop is TUI-only**: outside the TUI (`ctx.mode !== "tui"`) it parks immediately, because tree navigation is the TUI task model and non-TUI runs are drained by the boundary handler instead (see next section). The loop stays as the armed marker the boundary handler checks (`isAutoActive`).
- `/auto` is on by default **in RPC mode only**: the root `index.ts` `session_start` handler synthesizes `/auto` through the extension-command pipeline (so `armSupervisor` still runs from a command handler, on a command context) whenever `ctx.mode === "rpc"`, whatever the frame's reason (`"startup"` for a CLI launch, which a `--session` restore reuses; `"resume"`/`"new"`/`"fork"` from an in-process replacement; `"reload"`). Rationale: an RPC client has no interactive surface for per-step confirmation, and with the supervisor unarmed `agent_before_settle` never drains the queue — the client would still get its `agent_settled`, i.e. "done" with the task quietly parked. `supervisorStates` is in-memory, so a restored session carries no earlier `/auto-stop` to honor. The old fresh-session gate blocked a `--session` restore through its second condition, not its reason: `!getEntries().some((e) => e.type === "message")` is false once the restored transcript is non-empty, so reason is never consulted — `"startup"` is the frame for restores too. TUI sessions keep the manual model (auto stays off until `/auto` — tree navigation is a human-confirmed workflow), and `/auto-stop` still turns it off for the session. The harness defaults to TUI mode, so pre-existing tests stay unarmed regardless of their frame reason; `src/auto-default.test.ts` covers the RPC default (startup frame, resumed session with a transcript, one settle for a drained chain, TUI stays manual, `/auto-stop` then the next session re-arms).
- Arming is idempotent and returns `"armed" | "already-auto"`. `/auto-stop` stops the loop. An arm request that arrives while the loop is stopping (the `/auto-stop` → `/auto` window) is latched in `state.reArm` and re-armed by the loop's `finally` instead of being swallowed; the latch is honored only when that stop was requested and `stop()` drops older latches too, so neither a stale latch nor a loop that stopped itself (abort, launch timeout, cancelled navigation) can resurrect supervision. Per-session state lives in `supervisorStates` (a `WeakMap` keyed by `SessionManager`) — never module-level globals, or parallel harness sessions leak into each other.
- The loop parks whenever it has nothing to do; the `agent_end` handler only resolves the park promise (all navigation stays inside the loop). The loop snapshots a monotonically increasing `agent_end` counter at the park point so an `agent_end` that fired mid-drain is never lost (every wake trigger — a pushed task, a `/start-task`, a finished task — is preceded by a run ending).
- Interrupts: an interrupted last assistant turn — `stopReason: "aborted"` (user Esc) **or** `"error"` (retries exhausted, e.g. a 429 usage limit) — stops `auto`, as does a launch timeout; a cancelled navigation (an explicit user Esc) ends the loop, as do `/auto-stop` and session shutdown — a later `/auto` arms a fresh loop. No self-unloading logic, no timers, no polling while parked. The TUI check is `finishTask`'s verdict (`"interrupted"` → notify + `break`), not a raw scan: the report has already been delivered at that point, and draining the queue into the model that just failed only burns retries. Flat mode has no loop to stop and keeps draining (see below).
- `whenAutoParked(sessionManager)` (exported from `src/index.ts`) resolves once the running loop has parked — **parked, not drained**: the loop parks after every step, so it is a barrier for "the loop is idle now", not "the queue is empty". The test harness wraps it as `h.waitForAutoParked()` — await it after `h.prompt("/auto")` before asserting.
- The `"[auto] "` status prefix is sticky while auto runs: `refreshTaskStatus` applies it by default whenever `isAutoActive(sessionManager)`. All status writes must go through `refreshTaskStatus` (including the `session_start`/`turn_end`/`session_tree` handlers in root `index.ts`) — a direct `updateTaskStatus` call would strip the prefix.
- `navigateTree` is only available on command context; never call it from event handlers. Task actions therefore return `TaskActionResult = "started" | "cancelled" | "launch-timeout" | "error" | void` (`void` when the action never started a run) and the loop owns the exit policy for each value.

### Flat drain (non-TUI: rpc/json/print)

Outside the TUI, `agent_settled` is the client's completion signal, so it must not fire mid-queue. The tree model cannot help here: tree navigation is impossible during the settle window (`session.navigateTree` throws while the run is active), so `/start-task`, `/finish-task`, `/abort-task`, `/discard-task`, `/resume-task`, `/suspend-task` are TUI-only commands (they throw outside the TUI), and task work drains **inline on the current branch** through the `agent_before_settle` boundary handler (`handleTaskBoundary` → `boundaryDrainAction`), registered at load in root `index.ts`. The handler is armed only when the supervisor is active (`isAutoActive`) and `ctx.mode !== "tui"`; otherwise it returns `undefined` and the settle proceeds untouched. Since `/auto` defaults on in RPC mode, RPC runs are drained without any client action; json/print sessions (auto off by default) need an explicit `/auto`, and there the same one-settle guarantee applies only while it stays armed.

One action per boundary, in strict priority order:

1. **ABORT-CLOSE** — an open epoch whose last assistant message was aborted: append `task-done{reason:"aborted"}` + a `task-suspended` anchor (`reason:"aborted"`, `content` = the epoch's newest text, since the aborted turn itself has none) (+ transcript masks, + restore compaction for fresh) and let the settle happen (honest stop). The anchor is what a later flat `resume-task` injects.
2. **FINISH** — open epoch with a reply: `task-done` (+ fresh restore compaction + transcript masks +, when the turn was interrupted, a `task-suspended` anchor), then the result as a trailing `{type:"custom_message", customType:"task-result", display:true, details:{title}}` draft, `continue:true`. A **task result is never empty**: when the epoch's last turn was interrupted (`stopReason: "error"`/`"aborted"`) the draft carries `interruptionReport(...)` — `TASK_INTERRUPTED_FRAMING`, the provider error's first line (capped), the newest text the branch produced (`lastTaskText`, searched backwards past text-less turns), and a conditional `resume-task` hint — because that turn has no text blocks at all and the mainline cannot distinguish "produced nothing" from "never ran". The same partial text becomes the `task-done` checkpoint (`content`) and, on an interruption, the `task-suspended` anchor (`reason:"interrupted"`); draft order is `task-done` → `task-suspended` → restore compaction → masks → `task-result`, so the report stays the last user-role delivery. The continuation still runs: an rpc client reads the newest assistant text as the answer, so settling here would hand it the pre-task narration.
3. **RESUME** — a pending resume request: open a new epoch (`task-start{resume:true}` + `task-resume-done`), deliver the checkpoint (`task-suspended.data.content` if the request names/has an anchor — the TUI suspend/finish paths and the flat interrupt/abort closures all write one on the current branch — else the latest `task-done`'s `content`) as a `task-resume-delivery` custom_message draft, `continue:true`. No navigation: the checkpoint text *is* the resume.
4. **START** — queue head: `task-start` (+ fresh mask compaction) + surviving-queue requeue drafts + the task prompt as a `task-start-delivery` custom_message draft, `continue:true`. Tool visibility flips to the branch set via an explicit `setActiveTools` call (the precomputed base-prompt swap only affects *new* runs, and `agent.continue()` reuses the live prompt config).

Load-bearing mechanics (all pinned in `src/boundary-drain.test.ts`):

- **Delivery is a boundary draft, never a queued follow-up.** `sendUserMessage(_, {deliverAs:"followUp"})` races pi's synchronous `hasQueuedMessages()` check (its queueing awaits input handlers), and `Agent.continue()` on a toolResult-last state (how `push-task`'s terminate leaves the turn) first resumes the leftover tool loop (`runContinuation`), replaying the mainline into a now-hidden `push-task`. A trailing `custom_message` draft avoids both: pi commits drafts, `_refreshFinalizedContext()` replaces agent state with the projection (delivery = last user message), and `continue:true` makes `agent.continue()` resume straight from it.
- **Drafts replace, not merge**: pi uses the *last* non-empty `entries` returned for the boundary. `handleTaskBoundary` must merge its drafts with `event.entries` from earlier handlers or it clobbers them.
- **Fresh = double compaction**: START appends a self-retaining compaction (`firstKeptEntryId:null`, everything before it hidden) so the task runs truly fresh; FINISH/ABORT-CLOSE appends a restore compaction that supersedes it (only the newest compaction projects). The restore anchor (`restoreFromEntryId` = the previous active compaction's keep-zone start, plus its `restoreSummary`) is captured into `task-start.data` at START because the mask hides its source from FINISH-time scans.
- **Transcript masks** (`collectTranscriptMaskDrafts`): FINISH/ABORT-CLOSE append `context_edit{replacement:null}` drafts for the epoch's assistant/toolResult messages, so context stays ≈ tree-mode linear. Masks are computed by **branch position** (`findIndex` of the task-start, then slice) — never by entry-id comparison (ids are opaque, not monotonic; an early version compared them and masked at random). User messages and custom_message deliveries/results are kept deliberately (they project as user role: prompt traceability + client interjections survive).
- `currentTask` walks the branch from the leaf for the newest open epoch (see Invariants) — this powers FINISH/ABORT-CLOSE and is also what makes the branch prompt/tool-set predicate correct in flat mode.

Cache constraints (below) still hold: every system-prompt variant is byte-stable, and the boundary adds no new prompt text — it only appends session entries and flips the tool set between the precomputed variants.

### Cache constraints (do not regress)

1. State entries are `appendEntry` custom entries (model-invisible) — keep it that way.
2. Model-visible injections (`task-result`, the `[task-start: …]` / `[task-resume: …]` deliveries, resume messages) only ever append at the branch tip, each as `[<kind>: <label>]` + static framing + payload (`taskStartMarker` / `taskResumeMarker` with `TASK_START_FRAMING_FORK|FRESH` / `TASK_RESUME_FRAMING`; an interrupted epoch's result uses `TASK_INTERRUPTED_FRAMING` via `interruptionReport`). In flat mode they travel as boundary `custom_message` drafts (`task-start-delivery` / `task-result` / `task-resume-delivery`) — same byte-stable content, different transport.
3. Tool visibility sync must filter subsets of the canonical order captured at `session_start`, so every system-prompt variant stays byte-stable. TUI runs have exactly two variants (mainline / task branch): the branch variant is the mainline prompt **without `push-task`/`list-tasks`/`resume-task`** (`MAINLINE_ONLY_TOOLS`; `TASK_BRANCH_ONLY_TOOLS` is empty) **and** the static `TASK_BRANCH_SYSTEM_PROMPT` block contributed as the `task_branch` prompt section by the root `index.ts` `before_agent_start` handler, via the same `currentTask(session) !== null` predicate. Flat (non-TUI) continuations never fire `before_agent_start`, so a flat task turn renders a third byte-stable variant: the mainline prompt text with the branch tool set and **no** `task_branch` section — branch identity there travels only in the delivery message. `syncTaskToolVisibility` covers session_start/tree navigation and the TUI loop; the flat-drain boundary flips the set with explicit `setActiveTools` calls (`applyTaskToolSet`) because continuation requests reuse the live prompt config. `src/prompt-framing.test.ts` pins both the delivery wording and the section.
4. System prompt takes static text only — dynamic data (task titles) travels in user messages, never in the system prompt.
5. Same for the **tool descriptions and `promptGuidelines`**: `push-task` / `list-tasks` / `resume-task` wording is part of the byte-stable system-prompt variants, so it must stay mode-neutral — never interpolate the live supervisor state (`isSupervisorActive`) into it, and never read session state at description-build time (`toolListTasks()` takes no arguments on purpose). Mode-dependent wording is allowed only in branch-tip messages and tool results (the `list-tasks` listing itself), which are not cached.

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
- Mock LLM: `onPrompt(text, ...descriptors)` matches the last user message by substring; descriptors are `responds`, `thinks`, `fails(errorMessage)`, `pushTask(title, prompt, fork?)`, `resumeTask(title?, message)`, and the generic `callsTool(name, args)` for any other tool (`list-tasks`). `fails` produces a real failure turn (`stopReason: "error"`, empty content, `errorMessage`) — create the harness with `allowAssistantErrors: true`, otherwise the post-prompt sweep fails any prompt whose new assistant entry has an error stopReason. `h.appendErrorAssistantTurn(errorMessage)` injects the same shape by hand (a Pi-produced entry, so allowed) when the failure must land after `/start-task` rather than inside a prompt. Use `onPromptSequence(text, rounds)` when consecutive calls with the same prompt must differ (e.g. a tool guard error followed by a plain reply).
- Assert branch state with `h.assertSession(...)` (converted descriptors; custom bookkeeping entries are invisible). `h.assertSession` compares the **current branch only** — after a TUI suspend/resume the branch-side bookkeeping entries are no longer on the path, so use `h.countAllCustomEntries(type)` for cross-branch accounting and `h.countBranchCustomEntries(type)`/`h.branchCustomData(type)` for on-path entries. Tool visibility with `h.activeToolNames()` — `list-tasks` sits with `push-task`/`resume-task` (mainline only), so a branch that hides one hides all three; `src/list-tasks.test.ts` pins that and the rendered listing (`listings(h)` keeps the newest listing per request, since requests replay the whole history). Prompt stability with `h.systemPromptText()`.
- Supervisor audit rule (TUI): `/start-task` arms nothing by itself anymore; tests that drive the queue manually just issue the commands. Tests about the auto loop arm it with `/auto` and use `await h.waitForAutoParked()` as the barrier.
- Flat-mode (RPC) tests: `TestHarness.create({ mode: "rpc" })` binds extensions in rpc mode, which arms `/auto` at `session_start` (rpc default-on) — no `/auto` prompt is needed; `await h.waitForAutoParked()` before asserting. Assert settles with `h.settledCount()`, per-request context with `h.promptHistory()` (role/text per LLM request), client interjections with `await h.promptFollowUp(text)` (waits for `agent_start` first — calling it before the run starts races the non-streaming prompt path). Command errors surface through pi's `emitError` channel, not notifications: assert with `h.assertExtensionError(text)`.
- The FauxProvider fails fast on no-progress mock loops (same prompt + same responses 3× inside one turn) — if a test hits it, fix the rules or the tool's `terminate` behavior. Note the run-level continuation in flat mode does **not** trip this per-turn detector; a drain that never terminates shows up as a test timeout instead.
- Manual session injection only for Pi-produced entries (user/assistant messages), not task state.

## Adding or modifying a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`)
2. Add supporting files alongside
3. Commit
