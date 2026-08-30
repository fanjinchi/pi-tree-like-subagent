# pi-tree-like-subagent

Minimal task automation for [Pi](https://pi.dev) without subagents, using the Pi session tree. Fork of [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd).

## 为什么有这个分叉 / Why this fork

**中文**

用 Pi 的 session tree 来实现"类 subagent"的任务分支，这个想法很棒。但实际使用中我发现它每次任务都从一个干净的上下文开始，于是补上了几块拼图：

- **fork 启动**：任务可以直接从当前会话分叉出去执行，实现代码时不再丢失前面计划阶段的讨论上下文。
- **task-ask**：任务执行期间可以向主线（或经主线向用户）提问，而不是闷头干到底。
- **resume**：后续 review 发现问题时，带着意见回到当初实现代码的那个 session 分支继续修复，上下文一点不丢。

另一个灵感来源是 [ttttmr/pi-context](https://github.com/ttttmr/pi-context)：它自称受 Kimi 的 d-mail 启发，让 AI 自己管理上下文、自己决定跳转到哪里——思路很有意思，但不知是不是我的使用场景问题，实际很少触发（我日常压缩上下文用的是 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)）。不过这个思路值得借鉴：本项目既然已经用 tree 来代替 subagent，task 目的明确、分支清晰，天然契合"沿 tree 跳转上下文"的想法——resume/suspend 就是把这种跳转做成了带语义的、看得见的操作。

做着做着我也有点心虚：这不是越来越像"风味 subagent"了吗？最近还看到别人的 interactive-subagent 已经能实时监控任务执行，一度怀疑自己是不是造了个多余的轮子。但那个方案要手动配置开启插件工具，嫌麻烦，还是继续用这个了。

对比 fork 来源 [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd)，本项目的改动：

- 修复了 `/finish-task` 有时不唤醒 AI 的问题；
- 新增上面说的 fork（从当前上下文开始任务）、resume（带消息回到旧任务分支）、task-ask（任务内向主线/用户提问）；
- 删除了打包自 Superpowers 的 `brainstorming`、`executing-plans`、`finishing-a-development-branch`、`writing-plans`、`writing-roadmaps` 技能——我自己在用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 做工作流，感觉不再需要 Superpowers 的 plan 流程（也不知道哪个更好，详见下文 _Differences from upstream_）。

**English**

Using Pi's session tree to implement "subagent-like" task branches is a great idea. But in daily use I found that every task started from a clean context, so this fork adds a few missing pieces:

- **Forked starts**: a task can branch off the current session, so implementing code no longer loses the planning-phase discussion context.
- **task-ask**: a task can ask questions to the mainline (or, relayed through it, to the user) instead of working in silence.
- **resume**: when a later review finds problems, you can send the findings back into the very session branch that wrote the code and fix it there, with full context intact.

Another inspiration is [ttttmr/pi-context](https://github.com/ttttmr/pi-context), which — inspired by Kimi's d-mail — lets the AI manage its own context and decide where to jump. An interesting idea, though in my scenarios it rarely triggered (for context compression I use [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)). Still, the idea is worth borrowing: since this project already uses the tree instead of subagents, and tasks have clear purposes with explicit branches, it fits naturally with "jumping along the tree" — resume/suspend turns those jumps into semantic, visible operations.

Honestly, the further this goes, the more it feels like a "flavored subagent". I also noticed someone else's interactive-subagent can already monitor task execution in real time, and for a moment I wondered whether this project was redundant. But that one needs manual plugin/tool configuration — too much hassle, so I'm sticking with this.

Compared with the fork source [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd):

- fixed a bug where `/finish-task` sometimes failed to wake the AI;
- added the fork / resume / task-ask features described above;
- removed the bundled Superpowers skills `brainstorming`, `executing-plans`, `finishing-a-development-branch`, `writing-plans`, `writing-roadmaps` — I use [OpenSpec](https://github.com/Fission-AI/OpenSpec) for my workflow and no longer need Superpowers' planning flow (not sure which is better; see _Differences from upstream_ below).

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

This extension also bundles the task role skills (`task-implement`, `task-research`, `task-review`) that `push-task` inlines into task prompts.

## Differences from upstream (pi-supergsd)

This fork trims pi-supergsd to its task-automation core. Planning is left to dedicated tools: [pi-plan-mode](https://github.com/fanjinchi/pi-plan-mode) for read-only exploration and plan files, and [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven proposal → design → tasks workflows.

Removed plan-era skills (with their updater definitions):

- `writing-plans`, `executing-plans`, `finishing-a-development-branch`
- `brainstorming`, `writing-roadmaps`

The upstream-sync updater has been removed entirely; all Superpowers-derived skills are gone from the bundle.

Remaining skills:

- `task-implement`, `task-research`, `task-review` — task role skills inlined by `push-task` (see `/skill:` docs in the tool description)

## Tools and commands reference

| Command               | Action                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `/start-task [model]` | Saves a checkpoint and starts the pending task in a new branch                          |
| `/finish-task`        | Returns from task branch to saved checkpoint with the assistant response as a result    |
| `/abort-task`         | Returns from task branch to saved checkpoint without attaching any result               |
| `/discard-task`       | Discards a pending task without executing it                                            |
| `/resume-task [text]` | Resumes the most recently suspended task branch (or a queued resume-task request)       |
| `/suspend-task`       | Suspends the current task and returns to the mainline (relays a pending question)       |
| `/auto`               | EXPERIMENTAL! Runs pending tasks and queued resumes hands-free, relaying questions      |
| `/auto-stop`          | Stops the running `/auto` loop at the next step boundary (current task stays resumable) |

`/auto` runs as a foreground loop: type `/auto-stop` (works even while the loop is waiting) to end it gracefully after the current step — the running task is left suspended/current and can be resumed with `/resume-task` or by re-running `/auto`. Esc meanwhile interrupts the currently streaming agent turn, which also ends the loop.

If `[model]` is passed to `/start-task`, the model switches before the task prompt is sent. On `/finish-task`, `/abort-task`, or `/suspend-task`, the original model is restored.

### Footer status

The status bar shows the current task state at a glance: `pending task: <title>` (accent, queued but not started), `pending resume: <title>` (accent, queued resume), `current task: <title>` (warning, you are inside the task branch), `awaiting answer: <title>` (muted, suspended on a task question), and `suspended: <title>` (muted, resumable with `/resume-task`). Normally it stays empty — no task state to report.

### `push-task` tool

Queues a task with `title` and `prompt`. By default tasks start from fresh context. The task sits pending — nothing runs until you start it.

With `fork: true` the task starts **from the current context** instead: `/start-task` does not navigate away, it forks a branch right at the current leaf. Use this for implementation tasks whose prompt depends on the discussion you just had — the fork prompt may reference the current conversation ("the plan above") instead of repeating it. Fresh-task prompts must stay fully self-contained.

The model is prompted to split work into tasks (one goal per task) and to pick one of three task roles per task, referenced in the prompt as `/skill:task-review`, `/skill:task-research`, or `/skill:task-implement`. When the task starts, each referenced role skill's `SKILL.md` is inlined into the branch's first message (deterministic loading — no dependence on the model reading file paths), shaping how the branch runs and reports:

- **review** (fresh by default; fork when the review target exists only in the discussion) — independent review of code or a plan without author bias; reports findings with `file:line` and a verdict.
- **research** (always fresh) — self-contained investigation; the report is the only deliverable that returns to the mainline.
- **implement** (fork by default; fresh when the plan fits in the prompt and the mainline context is long) — builds from the plan just discussed; reports the change list, verification, and deviations.

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
- Context-management ideas were inspired by [gsd-build/gsd-2](https://github.com/gsd-build/gsd-2).

## License

MIT. See [LICENSE](./LICENSE).
