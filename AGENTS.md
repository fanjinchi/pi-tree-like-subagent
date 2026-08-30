# AGENTS.md — pi-tree-like-subagent

A Pi extension implementing tree-native task automation (no subagents). Fork of pi-supergsd.

## Architecture

- **`index.ts`** — extension entry: registers tools/commands/renderers, wires events.
- **`src/index.ts`** — task system core: tools (`push-task`, `resume-task`, `task-ask`), commands (`/start-task`, `/finish-task`, `/abort-task`, `/discard-task`, `/resume-task`, `/suspend-task`, `/auto`), entry accounting, branch tool-visibility sync.
- **`src/test-helpers/`** — integration harness: `TestHarness.create()` (in-memory `AgentSession` + `SessionManager`, `MockLLM`/`MockUser`/`FauxProvider`), `TestNode` tree runner.
- **`skills/`** — committed skills. Served at runtime via `package.json` → `pi.skills`.

### Task state machine (custom session entries, not model-visible)

| Entry type          | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `task`              | Queued task (`{title, prompt, fork?}`)                               |
| `task-start`        | A run started (`{title, returnTo, taskEntryId?, fork?, resume?}`)     |
| `task-done`         | Consumes the nearest unconsumed `task` above it (LIFO)               |
| `task-suspended`    | Resumable point (`{title, branchLeafId, reason, taskEntryId?}`)       |
| `task-resume`       | Queued resume request (`{title?, message}`)                          |
| `task-resume-done`  | Consumes one `task-resume` (LIFO)                                    |
| `task-ask`          | Pending question for the mainline (`{question}`)                     |

Invariants:

- Every `task` entry is consumed by exactly one `task-done`. Consumption is id-checked via `taskEntryId` (a resumed run consumes its entry iff it is still pending, e.g. after an abort).
- `task-suspended`/`task-ask`/`task-resume*` never participate in `pendingTask` accounting.
- When leaving a branch, `returnTo` must be captured **after** appending all bookkeeping entries meant for the departure branch — otherwise the return navigation orphans them.
- `navigateTree` is only available on command context; never call it from event handlers.

### Cache constraints (do not regress)

1. State entries are `appendEntry` custom entries (model-invisible) — keep it that way.
2. Model-visible injections (`task-result`, `task-question`, resume messages) only ever append at the branch tip.
3. Tool visibility sync (`syncTaskToolVisibility`) must filter subsets of the canonical order captured at `session_start`, so exactly two byte-stable system prompts exist (mainline / task branch).
4. System prompt takes static text only — dynamic data (task titles) travels in user messages, never in the system prompt.

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
- Assert branch state with `h.assertSession(...)` (converted descriptors; custom bookkeeping entries are invisible), raw accounting with `h.countBranchCustomEntries(type)`/`countAllCustomEntries(type)`/`branchCustomData(type)`, tool visibility with `h.activeToolNames()`, and prompt stability with `h.systemPromptText()`.
- The FauxProvider fails fast on no-progress mock loops (same prompt + same responses 3× inside one turn) — if a test hits it, fix the rules or the tool's `terminate` behavior.
- Manual session injection only for Pi-produced entries (user/assistant messages), not task state.

## Adding or modifying a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`)
2. Add supporting files alongside
3. Commit
