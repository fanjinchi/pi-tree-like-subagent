# 任务分支状态栏提醒（footer status 增强）

## Summary

用户诉求（原话）："用户有点时候会分不清或忘记自己是否已经在某个task的分支状态中，能否加个ui提醒？"

已与用户确认的两个决策：
1. **仅增强底部状态栏**（不用 setWidget 横幅）——用户选定，改动最小。
2. **覆盖全部四种状态**——分支中 current task、待执行 pending task、待恢复 pending resume、挂起可恢复 suspended（后两者现状完全无提示，本次补齐）。

现状：`updateTaskStatus`（src/index.ts:467-530）把四种可显示状态全部渲染成 `theme.fg("dim", ...)` 灰色，且挂起状态（/finish、/suspend-task 之后）什么都不显示。本方案只改颜色与补一个挂起分支：**不改任何状态文案、不改 entry 类型、不加 model-visible 内容、不动系统提示词**（缓存稳定性约束零触碰）。

## Key Changes

### 1. src/index.ts — `updateTaskStatus`（约 467-530 行）

- pending task：`fg("dim", …)` → `fg("accent", …)`，文案不变（`pending task: <title>`）
- pending resume：`fg("dim", …)` → `fg("accent", …)`，文案不变（`pending resume[: <title>]`）
- current task：`fg("dim", …)` → `fg("warning", …)`，文案不变（`current task: <title>`）← 用户最需要的"在分支中"提醒，warning 色最醒目
- **新增分支**（在 currentTask 检查之后、`setStatus("task", undefined)` 之前），复用现有 `latestSuspendedTask(session)`（src/index.ts:1215，泛型扫描最后一个 task-suspended）：
  - `reason === "ask"` → `awaiting answer: <title>`
  - 其余（finish/manual/abort）→ `suspended: <title>`
  - 样式 `theme.fg("muted", …)`
- abort 场景无需额外代码：abort 不消费 task entry（src/index.ts:902-908），`pendingTask` 已走 #1 分支显示 `pending task: <title>`
- `options.prefix`（`[auto] `）行为不变，prefix 保持无色

最终优先级：pending task → pending resume → current task → suspended → 清空。

### 2. src/test-helpers/test-ui.ts — 原始状态捕获

`TestUi.setStatus`（test-ui.ts:16-19）目前先 `normalizeText`（stripVTControlCharacters）再存 `#lastStatus`。新增 `#lastStatusRaw` + `lastStatusRaw` getter，在归一化前捕获原始值，供"样式确实生效"的测试用。`lastStatus`/`assertStatus` 语义不变。

### 3. 现有测试断言更新（finish/suspend 之后的 `assertStatus()` → 新期望）

仅更新**紧跟在 /finish-task 或 /suspend-task 之后**的空断言；在分支中的 `current task: X`、`pending task: X`、`pending resume: X`、以及无任务历史主线的空断言全部不变。逐处映射（实现时按实际流程核对，测试运行器会兜底）：

| 文件:行 | 新期望 |
|---|---|
| auto.test.ts:37 | `suspended: quick fix` |
| auto.test.ts:75 | `suspended: x` |
| auto.test.ts:124 | `suspended: x` |
| auto.test.ts:157 | `suspended: quick fix` |
| resume.test.ts:57,87,119,155,277,301 | `suspended: AAA`/`BBB`（按各流程任务标题） |
| task-ask.test.ts:140 | `awaiting answer: AAA` |
| task-ask.test.ts:161,194,214,232 | `suspended: AAA` |
| manual.test.ts:134,203 | `suspended: AAA`（按流程标题） |
| model-switch.test.ts:57,230,274 | `suspended: AAA` |
| model-switch.test.ts:176 | `suspended: BBB` |
| fork.test.ts:52 | `suspended: implement` |
| legacy-session.test.ts:18 | `suspended: untitled` |

### 4. 新增 src/status.test.ts（三个测试）

1. 状态闭环：push → start → `current task: AAA` → finish → `suspended: AAA` → resume → `current task: AAA` → abort → `pending task: AAA`
2. ask 挂起：task-ask → /suspend-task → `awaiting answer: AAA` → /resume-task 带答案 → `current task: AAA`
3. 样式生效：`h.testUi.lastStatusRaw` 含 `\x1b[` 转义序列（证明非明文灰色），同时 `lastStatus` 为清洗后的纯文本

### 5. README.md（可选一行）

在命令表后补一句 footer 提示说明（四种状态的颜色与文案）。

## Test Plan

本次改动不涉及 skills/updater（无 skill 定义变更），验证范围只覆盖代码与测试：

1. `npm run fix`（prettier + eslint autofix）
2. `npx tsc --noEmit`（类型检查）
3. `npm test`（node:test，含新增 status.test.ts）
4. `npx prettier --check src index.ts README.md`（格式门禁）
5. 若个别旧断言期望与上表不符，以实际测试输出为准修正（MockLLM 无进度循环会快速暴露规则错误）

不跑 `npm run updater` / updater 相关验证：该步骤只影响 `skills/` 生成产物，与本次 UI 改动无关。

## Assumptions

- 现有三种状态的**文案字节不变**，可见性靠颜色提升（dim→accent/warning）；测试断言走 stripVTControlCharacters 后的纯文本，因此旧断言除上表外全部继续通过
- /finish-task 之后持续显示 `suspended: <title>`（任务确实可 /resume-task 续跑）；discard 不清除挂起标记，属既有语义
- 颜色方案：pending=accent、current=warning、suspended/awaiting=muted；`[auto] ` prefix 无色
- 不改 entry 类型、不加 model-visible 消息、不改工具可见性 → 两条字节稳定系统提示词与缓存约束不受影响