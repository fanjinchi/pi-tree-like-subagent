# pi-tree-like-subagent

Minimal task automation for [Pi](https://pi.dev) without subagents, using the Pi session tree. Fork of [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd).

## 为什么有这个分叉 / Why this fork

**中文**

用 Pi 的 session tree 来实现"类 subagent"的任务分支，这个想法很棒。但实际使用中我发现它每次任务都从一个干净的上下文开始，于是补上了几块拼图：

- **fork 启动**：任务可以直接从当前会话分叉出去执行，实现代码时不再丢失前面计划阶段的讨论上下文。
- **resume**：后续 review 发现问题时，带着意见回到当初实现代码的那个 session 分支继续修复，上下文一点不丢。
- **RPC 可靠完成信号**：通过 RPC 驱动 pi 时，`agent_settled` 只在任务队列真正排空后发出——任务在 `agent_before_settle` 边界内联排空（不导航），中途不产生任何假 settle。

另一个灵感来源是 [ttttmr/pi-context](https://github.com/ttttmr/pi-context)：它自称受 Kimi 的 d-mail 启发，让 AI 自己管理上下文、自己决定跳转到哪里——思路很有意思，但不知是不是我的使用场景问题，实际很少触发（我日常压缩上下文用的是 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)）。不过这个思路值得借鉴：本项目既然已经用 tree 来代替 subagent，task 目的明确、分支清晰，天然契合"沿 tree 跳转上下文"的想法——resume/suspend 就是把这种跳转做成了带语义的、看得见的操作。

做着做着我也有点心虚：这不是越来越像"风味 subagent"了吗？最近还看到别人的 interactive-subagent 已经能实时监控任务执行，一度怀疑自己是不是造了个多余的轮子。但那个方案要手动配置开启插件工具，嫌麻烦，还是继续用这个了。

对比 fork 来源 [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd)，本项目的改动：

- 修复了 `/finish-task` 有时不唤醒 AI 的问题；
- 新增上面说的 fork（从当前上下文开始任务）、resume（带消息回到旧任务分支）、RPC 边界排空（`agent_settled` 成为可靠的队列排空信号）；
- 删除了打包自 Superpowers 的 `brainstorming`、`executing-plans`、`finishing-a-development-branch`、`writing-plans`、`writing-roadmaps` 技能——我自己在用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 做工作流，感觉不再需要 Superpowers 的 plan 流程（也不知道哪个更好，详见下文 _Differences from upstream_）。

**English**

Using Pi's session tree to implement "subagent-like" task branches is a great idea. But in daily use I found that every task started from a clean context, so this fork adds a few missing pieces:

- **Forked starts**: a task can branch off the current session, so implementing code no longer loses the planning-phase discussion context.
- **resume**: when a later review finds problems, you can send the findings back into the very session branch that wrote the code and fix it there, with full context intact.
- **A reliable RPC completion signal**: when pi is driven over RPC, `agent_settled` fires only after the task queue is truly drained — tasks drain inline at the `agent_before_settle` boundary (no navigation), so no spurious settles leak out mid-queue.

Another inspiration is [ttttmr/pi-context](https://github.com/ttttmr/pi-context), which — inspired by Kimi's d-mail — lets the AI manage its own context and decide where to jump. An interesting idea, though in my scenarios it rarely triggered (for context compression I use [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)). Still, the idea is worth borrowing: since this project already uses the tree instead of subagents, and tasks have clear purposes with explicit branches, it fits naturally with "jumping along the tree" — resume/suspend turns those jumps into semantic, visible operations.

Honestly, the further this goes, the more it feels like a "flavored subagent". I also noticed someone else's interactive-subagent can already monitor task execution in real time, and for a moment I wondered whether this project was redundant. But that one needs manual plugin/tool configuration — too much hassle, so I'm sticking with this.

Compared with the fork source [pi-supergsd](https://github.com/skhoroshavin/pi-supergsd):

- fixed a bug where `/finish-task` sometimes failed to wake the AI;
- added the fork / resume features described above, plus the RPC boundary drain (`agent_settled` is a reliable queue-drained signal);
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

This extension adds a minimal task system that keeps those principles: minimal, in your control, nothing hidden. It introduces a few tools (`push-task`, `list-tasks`, `resume-task`) and commands. No background processes, no parallel agents — one foreground serial loop supervises task work in the TUI (the `/auto` loop), and outside the TUI a settle-boundary handler drains queued tasks inline so RPC clients get exactly one honest `agent_settled`. The loop parks when it has nothing to do (no timers, no polling), and `/auto-stop` turns it off. In the TUI a task runs as a branch in the session tree, so standard Pi tools work as expected, and every state transition is a visible entry you can navigate to. Start a fresh-context review, check the results, bring them back. Fork an implementation task with the current discussion as its context. Resume a finished task with review findings. Or queue tasks and run them hands-free with `/auto`, while still seeing everything that's happening and able to stop, reprompt, and continue at any point.

This extension also bundles the task role skills (`task-implement`, `task-research`, `task-review`) that `push-task` inlines into task prompts.

## Differences from upstream (pi-supergsd)

This fork trims pi-supergsd to its task-automation core. Planning is left to dedicated tools: [pi-plan-mode](https://github.com/fanjinchi/pi-plan-mode) for read-only exploration and plan files, and [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven proposal → design → tasks workflows.

Removed plan-era skills (with their updater definitions):

- `writing-plans`, `executing-plans`, `finishing-a-development-branch`
- `brainstorming`, `writing-roadmaps`

The upstream-sync updater has been removed entirely; all Superpowers-derived skills are gone from the bundle.

Remaining skills:

- `task-implement`, `task-research`, `task-review` — task role skills inlined by `push-task` (see [`/skill:` references in task prompts](#skill-references-in-task-prompts))

## Tools and commands reference

| Command               | Action                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `/start-task [model]` | Saves a checkpoint and starts the pending task in a new branch (TUI only)               |
| `/finish-task`        | Returns from task branch to saved checkpoint with the assistant response as a result (TUI only) |
| `/abort-task`         | Returns from task branch to saved checkpoint without attaching any result — the queue head stays pending (TUI only) |
| `/discard-task`       | Discards a pending task without executing it (TUI only)                                  |
| `/resume-task [text]` | Resumes the most recently suspended task branch, or a queued resume-task request (TUI only) |
| `/suspend-task`       | Suspends the current task and returns to the mainline, keeping it resumable (TUI only)   |
| `/auto`               | Runs pending tasks and queued resumes hands-free — **on by default in RPC mode**, off with `/auto-stop` |
| `/auto-stop`          | Stops the running `/auto` supervision (the current task stays resumable)                 |

The tree-navigation commands are TUI-only: outside the TUI they throw, because there is no branch to navigate. RPC runs don't need them — queued tasks drain automatically at the settle boundary (see _Non-TUI flat drain_ below). json/print runs are **not** supervised by default: pass `/auto` as a leading positional message (`pi -p "/auto" "…"`) so the same one-settle drain applies while it stays armed.

`/auto` is on by default in RPC mode: a `pi --mode rpc` session arms it at `session_start`, whatever the frame's reason (a plain launch, a `--session` restore, `/new`, a fork or a reload), so pushed tasks just run — the first one starts as soon as the current turn ends. RPC clients have no interactive surface where a human confirms each step: with the supervisor unarmed the queue would never drain and the client would still get its `agent_settled`, i.e. "done" with the task quietly parked. `/auto-stop` turns it off for that session; supervisor state is in-memory, so the next RPC session arms again. TUI sessions keep the manual model — auto stays off until you type `/auto`, because tree navigation is a human-confirmed workflow. `/auto` runs as a foreground loop: type `/auto-stop` (works even while the loop is waiting) to end it gracefully after the current step — the running task is left suspended/current and can be resumed with `/resume-task` or by re-running `/auto`. Esc meanwhile interrupts the currently streaming agent turn, which also ends the loop. When both kinds of work are queued, `/auto` finishes the task queue first and only then runs queued resume requests.

If `[model]` is passed to `/start-task`, the model switches before the task prompt is sent. On `/finish-task`, `/abort-task`, or `/suspend-task`, the original model is restored.

### Non-TUI flat drain (RPC/json/print)

When pi runs outside the TUI — driven over RPC, or in print/json mode — `agent_settled` is the client's only completion signal, and tree navigation is impossible inside the settle window. So instead of branches, an `agent_before_settle` boundary handler drains queued work **inline on the current branch**, one supervisor action per settle boundary (finish the open task → deliver its result → start the next queued task → …). While anything is pending the handler keeps the run alive, so the RPC client sees **no `agent_settled` at all** until the queue is truly drained — the first settle it receives *is* the real "all work done" signal. The handler only engages while auto is armed, which in RPC mode it is by default (json/print need an explicit `/auto`).

Details worth knowing:

- Fresh tasks stay fresh: a self-retaining compaction entry hides the mainline history for the task's duration, and a restore compaction at finish brings it back (only the newest compaction projects).
- Context stays lean: at finish, the task's working transcript (its assistant/tool calls) is masked out of the following context via context-edit entries; the result message and delivered prompts stay.
- `resume-task` works without navigation: the task's checkpoint is re-injected together with your message, so a review-fix loop still works in RPC automation. The checkpoint is the text on the newest `task-suspended` anchor on the branch (written by the TUI suspend/finish paths and by the flat interrupt/abort closures below), falling back to the newest `task-done` checkpoint.
- Aborting mid-task closes the task epoch at the boundary (`task-done{reason:"aborted"}`) and settles honestly — a later prompt does not trip over the half-finished task. The closure also writes a `task-suspended` anchor (`reason:"aborted"`) carrying the epoch's newest text, so an aborted run stays resumable in RPC too.
- Interrupted tasks report instead of going silent: when a task's last turn is cut off (retries exhausted after an API error, or a cancelled turn) the epoch still closes — but with an interruption report instead of the empty result that used to reach the mainline. It names the cause, carries whatever text the branch produced before the cut, and ends with a conditional hint: if the user asks for the task to continue, the mainline can call `resume-task` to reopen it at that point (it is not told to retry on its own). The same text becomes the checkpoint — in the TUI the task is suspended, in the flat drain it is written to a `task-suspended` anchor — so the task stays resumable either way. Here the run then continues, so you still receive a real answer about the interrupted task; in the TUI auto stops instead and leaves the rest of the queue pending.

### Footer status

The status bar shows the current task state at a glance: `pending task: <title>` (accent, queued but not started; a deeper queue appends the count: `pending task: <title> (+N queued)`), `pending resume: <title>` (accent, queued resume), `current task: <title>` (warning, you are inside the task branch), and `suspended: <title>` (muted, resumable with `/resume-task`). Normally it stays empty — no task state to report.

### `push-task` tool

Queues a task with `title` and `prompt`. By default tasks start from fresh context. The task sits pending — nothing runs until you start it.

Tasks queue in enqueue order (oldest first): `/start-task`, `/discard-task`, and `/auto` always act on the queue head, so the first task you push is the first to run — even if you push more before starting it. Queue independent tasks together in one reply (every push-task call in the same message is queued before the turn ends; with `/auto` on the first starts as soon as the turn ends, so cross-turn pushes only accumulate while `/auto` is off); queue dependent stages one per turn, after the previous stage's result arrived. Each tool result is the receipt — it reports the queue position, e.g. `Task stored. 3 tasks queued - /start-task or /auto runs them oldest first.` — and `push-task` ends the turn and notifies the user itself.

With `fork: true` the task starts **from the current context** instead: `/start-task` does not navigate away, it forks a branch right at the current leaf. Use this for implementation tasks whose prompt depends on the discussion you just had — the fork prompt may reference the current conversation ("the plan above") instead of repeating it. Fresh-task prompts must stay fully self-contained.

When a task starts, its branch receives the task text as a single message prefixed with `[task-start: <title>]` plus a short framing paragraph stating that the task is already running — on a fork that sentence also says the `push-task` receipt above it only queued the task, so the branch does not read it as "not started yet". A resume is delivered the same way under `[task-resume: <title>]`. Inside the branch the system prompt additionally carries a short "you are inside a queued task branch" block (the mainline prompt is unchanged), and mode rules such as plan mode stay in force there — a plan-mode implement task reports the conflict instead of editing files.

The model is prompted to split work into tasks (one goal per task) and to pick one of three task roles per task, referenced in the prompt as `/skill:task-review`, `/skill:task-research`, or `/skill:task-implement`. When the task starts, each referenced role skill's `SKILL.md` is inlined into the branch's first message (deterministic loading — no dependence on the model reading file paths; any other resolvable skill can be seeded the same way, with a `/skill:<name>` token in the task prompt), shaping how the branch runs and reports:

- **review** (fresh by default; fork when the review target exists only in the discussion) — independent review of code or a plan without author bias; reports findings with `file:line` and a verdict.
- **research** (always fresh) — self-contained investigation; the report returns to the mainline, with an optional Markdown doc as the durable carrier when the findings must outlive the transcript or the prompt asks for one.
- **implement** (fork by default; fresh when the plan fits in the prompt and the mainline context is long) — builds from the plan just discussed; reports the change list, verification, and deviations.

### `/skill:` references in task prompts

A `/skill:<name>` token in a task `prompt` is resolved when the task is pushed: the token is rewritten to the skill's absolute `SKILL.md` path in the stored prompt, and the file's content is inlined into the branch's first message under a `==== Task role skill: <name> ====` header. This is deterministic — the branch receives the skill's contract without having to find and read it — and it applies to fresh and forked tasks alike. Any resolvable skill can be seeded this way; it is not limited to the three task roles.

- **Name syntax** — lowercase letters and digits, at least two characters, single hyphens as separators; the match must end at a name boundary, so a longer token such as `/skill:ab--c` is left untouched instead of being rewritten into a path with a tail glued to it. A one-character ref such as `/skill:a` is not recognised, and not reported either.
- **Fenced code blocks are documentation, not refs** — a `/skill:` token inside a fence is neither rewritten nor inlined nor noted. This is how a role card can mention a skill by name, or show an example, without seeding it; a bare skill name without the `/skill:` prefix is never a ref at all.
- **Resolution is transitive** — a role skill may reference further skills, and their bodies are inlined as additional sections, up to `MAX_INLINED_ROLE_SKILLS = 4`; a skill referenced several times is inlined once.
- **Paths survive nested refs** — Pi expands `/skill:` in user input only, never inside a delivered prompt, so inlined bodies carry already-rewritten absolute paths.

Whatever could not be inlined is reported in the delivered prompt — nothing is dropped silently:

| Situation                               | Trailing note in the branch prompt                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Nested ref that resolves to nothing     | `Note: /skill:<name> (referenced by <referrer>) was not found.`                         |
| Resolved, but its `SKILL.md` unreadable | `Note: /skill:<name> could not be read (<path>).`                                       |
| Left over by the inlining cap           | `Note: /skill:<name> was not inlined (MAX_INLINED_ROLE_SKILLS=4 reached); read <path>.` |

Two asymmetries are deliberate:

- A **top-level** ref that resolves to nothing is reported to the **mainline** at push time (`Warning: /skill:<name> were not resolved.`) and stays in the stored prompt as a literal token. The author is still here and can fix it, so the branch gets no note for it.
- A resolved ref whose file vanished since push falls back to the extension's own bundled `skills/<name>/SKILL.md`; only if both fail is it unreadable — and then the path reference already in the prompt lets the branch read the file itself.

### `list-tasks` tool

The read-only query over the task bookkeeping: the mainline gets `[task-result: <title>]` messages, but the `task` / `task-start` / `task-done` / `task-suspended` entries themselves are model-invisible, and a finished epoch's transcript is masked — after a few rounds nothing in the conversation tells the model which tasks it started or which one can be reopened. `list-tasks` (no parameters) prints the session's tasks newest first, one row per task however many times it was resumed, capped at the newest 20 (older ones are counted in the header):

```
Tasks in this session: 2 (newest first)

- "repair the importer" - finished, resumable
  checkpoint: Fixed the csv parser and added a regression test.
  resume with resume-task(title: "repair the importer", message: ...)
- "probe the API" - interrupted, resumable
  checkpoint: Halfway through the probe...
  resume with resume-task(title: "probe the API", message: ...)
```

Status is a fixed lowercase vocabulary: `running` (open branch), `queued` (still in the queue — an aborted TUI branch re-queues its task), `interrupted` (last turn cut off), `aborted` (closed without a result), `finished`, `discarded` (`/discard-task`). `resumable` means a real checkpoint exists (a `task-suspended` anchor, or the `task-done.content` a flat run leaves), i.e. `resume-task` can reopen it; the quoted title is exactly what `resume-task` matches (title matching already normalizes whitespace and marker characters). It writes nothing, changes no status, never notifies — the answer is the tool result, so querying is safe inside any turn.

### `resume-task` tool

Queues a resume of a finished, aborted, or suspended task branch, carrying a `message` (review findings, answers, corrections) back into the task context. Optionally takes a `title` to pick a specific task (defaults to the most recent). Nothing runs until `/resume-task` or `/auto` executes the request. In the TUI the session navigates to the recorded branch leaf and the message is injected as a new user turn — the task AI continues with its full branch context intact. Outside the TUI (flat drain) there is no navigation: the task's checkpoint is re-injected together with the message, so the review-fix loop keeps working in RPC automation. An interrupted or aborted run leaves such a checkpoint behind (a `task-suspended` anchor), so its last partial output is what a flat resume starts from. When the model no longer knows which task it wants, `list-tasks` supplies both the title and whether the task is resumable.

### Tool visibility is branch-scoped

`push-task`, `list-tasks`, and `resume-task` only appear outside task branches (session-level, not persisted; execute-time guards back it up). Note this means a task branch cannot queue nested tasks — orchestration stays on the mainline. If you disabled any of these tools via `/tools`, the visibility sync will re-enable them when the matching branch state applies.

A task that hits a decision it can't make should **say so in its report** — its final assistant message is the deliverable that returns to the mainline, which can answer and send a `resume-task` with the decision. Inside a TUI task branch the AI can also use a user-question plugin (such as `ask_user_question`) directly.

## Use cases

### Review with fresh context

The LLM queues a review after implementation. You start it manually, correct review right in the branch, and then merge findings back.

```
LLM:     Implementation done. Let me queue a fresh review.

LLM:     [calls push-task({ title: "Review implementation", prompt: "Review the implementation
         against the plan. Check correctness, edge cases,
         and test coverage."})]

LLM:     Task stored. Start it with /start-task or /auto.

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

### Batch implementation with /auto

You prepared a detailed multi-phase plan for implementing a feature, and run it hands-free. Each stage is pushed only after the previous one's report arrived; the queue itself runs in enqueue order (oldest first).

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
