# pi-tree-like-subagent

Minimal task automation for [Pi](https://pi.dev) without subagents, using the Pi session tree — plus a trimmed, patched subset of [Superpowers](https://github.com/obra/superpowers) skills. Fork of [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd).

## Install

From git:

```bash
pi install git:github.com/fanjinchi/pi-tree-like-subagent
```

Or from a local checkout (recommended for development — no copying, changes apply on reload):

```bash
pi install /absolute/path/to/pi-tree-like-subagent
```

If Pi is already running, restart it or run `/reload`.

## Philosophy

Pi coding agent doesn't include a built-in sub-agent tool. Its author [Mario Zechner](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) explains why: they're "a black box within a black box" — you can't see what they do, context doesn't transfer well, and debugging is painful. Pi's session tree gives you that control instead.

This extension adds a minimal task system that keeps those principles: minimal, in your control, nothing hidden. It introduces a few tools (`push-task`, `resume-task`, `task-ask`) and commands. No background processes, no parallel agents — `/auto` is a foreground serial loop, and `task-ask` is a suspend-relay, not async execution. A task runs as a branch in the session tree, so standard Pi tools work as expected, and every state transition is a visible entry you can navigate to. Start a fresh-context review, check the results, bring them back. Fork an implementation task with the current discussion as its context. Resume a finished task with review findings. Or queue tasks and run them hands-free with `/auto`, while still seeing everything that's happening and able to stop, reprompt, and continue at any point.

This extension also bundles a subset of [Superpowers](https://github.com/obra/superpowers) skills, adapted for Pi and routed through the task system rather than dispatching subagents.

## Differences from upstream (pi-supergsd)

This fork trims pi-supergsd to its task-automation core. Planning is left to dedicated tools: [pi-plan-mode](https://github.com/fanjinchi/pi-plan-mode) for read-only exploration and plan files, and [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven proposal → design → tasks workflows.

Removed plan-era skills (with their updater definitions):

- `writing-plans`, `executing-plans`, `finishing-a-development-branch`
- `brainstorming`, `writing-roadmaps`

Remaining skills:

- `requesting-code-review` / `receiving-code-review` — fresh-context code review via `push-task`
- `systematic-debugging`, `test-driven-development`, `verification-before-completion`
- `writing-skills`

## Tools and commands reference

| Command                 | Action                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `/start-task [model]`   | Saves a checkpoint and starts the pending task in a new branch                       |
| `/finish-task`          | Returns from task branch to saved checkpoint with the assistant response as a result |
| `/abort-task`           | Returns from task branch to saved checkpoint without attaching any result            |
| `/discard-task`         | Discards a pending task without executing it                                         |
| `/resume-task [text]`   | Resumes the most recently suspended task branch (or a queued resume-task request)    |
| `/suspend-task`         | Suspends the current task and returns to the mainline (relays a pending question)    |
| `/auto`                 | EXPERIMENTAL! Runs pending tasks and queued resumes hands-free, relaying questions   |

If `[model]` is passed to `/start-task`, the model switches before the task prompt is sent. On `/finish-task`, `/abort-task`, or `/suspend-task`, the original model is restored.

### `push-task` tool

Queues a task with `title` and `prompt`. By default tasks start from fresh context. The task sits pending — nothing runs until you start it.

With `fork: true` the task starts **from the current context** instead: `/start-task` does not navigate away, it forks a branch right at the current leaf. Use this for implementation tasks whose prompt depends on the discussion you just had — the fork prompt may reference the current conversation ("the plan above") instead of repeating it. Fresh-task prompts must stay fully self-contained.

### `resume-task` tool

Queues a resume of a finished, aborted, or suspended task branch, carrying a `message` (review findings, answers, corrections) back into the task context. Optionally takes a `title` to pick a specific suspended task (defaults to the most recent). Nothing runs until `/resume-task` or `/auto` executes the request: the session navigates to the recorded branch leaf and the message is injected as a new user turn — the task AI continues with its full branch context intact.

### `task-ask` tool (task branches only)

Lets the task AI ask the **mainline orchestrator** a question. The task suspends, the question is relayed to the mainline as a `[task-question: <title>]` message, the mainline AI answers (using its own context, escalating to you only when needed), and a `resume-task` carries the answer back into the branch. Under `/auto` this whole relay runs hands-free; manually, use `/suspend-task` to relay a pending question (or just answer it directly inside the branch).

Tool visibility is branch-scoped: `task-ask` only appears inside task branches, `push-task`/`resume-task` only outside them (session-level, not persisted; execute-time guards back it up). Note this means a task branch cannot queue nested tasks — orchestration stays on the mainline. If you disabled any of these tools via `/tools`, the visibility sync will re-enable them when the matching branch state applies.

## Use cases

### Review with fresh context

The LLM queues a review after implementation. You start it manually, correct review right in the branch, and then merge findings back.

```
LLM:     Implementation done. Let me queue a fresh review.

LLM:     [calls push-task({ title: "Review implementation", prompt: "Review the implementation
         against the plan. Check correctness, edge cases,
         and test coverage."})]

LLM:     Task stored. Run /start-task to review.

You:     /start-task

Pi:      [branches to fresh context, injects review prompt]

LLM:     [reviews code] Two issues: parse() swallows the original
         error, and the cache isn't invalidated on config changes.

You:     I agree with cache invalidation issue, but error handling
         in parse() was intentional. Adjust your report.

LLM:     [adjusts report]

You:     /finish-task

Pi:      [returns to main branch with report attached]

LLM:     [reads report] Good catches. Let me fix them.
```

### Implement with fork context, review fresh, fix with resume

The LLM queues the implementation as a fork task (keeping the discussed plan in context), then the orchestrator drives a review/fix loop.

```
LLM:     [discusses and finalizes the plan with you]

LLM:     [calls push-task({ title: "Implement feature", prompt: "Implement the plan above, phase 1.", fork: true })]

You:     /auto

Pi:      [forks a branch at the current context, injects the prompt]

LLM:     [implements] Phase 1 done: ...

Pi:      [returns to the mainline with the report attached]

LLM:     [reads report, calls push-task({ title: "Review phase 1", prompt: "Review src/... against this checklist: ..." })]

Pi:      [branches to fresh context, reviews] Two issues found: ...

LLM:     [reads review, calls resume-task({ title: "Implement feature", message: "Review findings: ... fix both." })]

Pi:      [resumes the implementation branch with the findings]

LLM:     [fixes both issues with full task context intact] Fixed: ...

Pi:      [returns to the mainline with the follow-up report]

... and so on until finished, blocked or interrupted by you.
```

### Task asks the mainline mid-run

A task hits a decision it can't make. It calls `task-ask` instead of guessing.

```
You:     /auto

Pi:      [task branch] LLM: [calls task-ask({ question: "Add a new config key or reuse X?" })]

Pi:      [suspends the task, returns to the mainline, relays the question]

LLM:     [mainline] Reuse X — it already covers this. [calls resume-task with the answer]

Pi:      [resumes the task branch with the answer]

LLM:     [task branch] Continues with X. ...
```

If the mainline AI can't answer either, it asks you (with a user-question plugin such as `ask_user_question` if you have one, otherwise in plain text) and relays your answer. Inside a task branch the AI can likewise use such a plugin directly to ask you without the relay.

### Batch implementation with /auto

You prepared a detailed multi-phase plan for implementing a feature, and run it hands-free.

```
LLM:     Roadmap has 3 phases. Let me queue phase 1.

LLM:     [calls push-task({ title: "Implement phase 1", prompt: "..." })]

You:     /auto

Pi:      [branches to fresh context, injects phase 1 plan]

LLM:     Scaffolds project, writes core types. Phase 1 report: ...

Pi:      [returns to the mainline with the report attached]

LLM:     [reads report] Let me review it fresh.

LLM:     [calls push-task({ title: "Review phase 1", prompt: "..." })]

Pi:      [branches to fresh context, injects review prompt]

LLM:     [reviews code] No issues.

Pi:      [returns to the mainline with the review attached]

LLM:     [reads review] No issues - good. Let me queue phase 2.

LLM:     [calls push-task({ title: "Implement phase 2", prompt: "..." })]

Pi:      [branches to fresh context, injects phase 2 plan]

LLM:     Implements CLI, adds tests. Phase 2 report: ...

... and so on until finished, blocked or interrupted by user.
```

## Credits

- Forked from [skhoroshavin/pi-supergsd](https://github.com/skhoroshavin/pi-supergsd).
- Skill content originates from [obra/superpowers](https://github.com/obra/superpowers).
- Context-management ideas were inspired by [gsd-build/gsd-2](https://github.com/gsd-build/gsd-2).

## License

MIT. See [LICENSE](./LICENSE).
