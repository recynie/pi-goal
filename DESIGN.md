# Pi Goal 模式设计

## 1. 设计目标

本项目以 `references/narumitw-pi-goal/` 为主要参考，在其 session-scoped state、agent loop、pause/resume 和 continuation 机制上增加 Goal 细化与独立 verifier。`references/misunders2d-pi-goal/` 只用于理解需求对齐和独立验收问题，不作为代码架构或实现来源。

核心流程是：

```text
用户提出主目标
    ↓
主 agent 与用户讨论并细化为可验证子任务
    ↓
用户确认 Goal
    ↓
主 agent 在原 session 中持续执行
    ↓
主 agent 通过 `goal_submit({ result })` 提交最终结果
    ↓
同一 result 展示给用户并交给 fresh verifier 独立验收
    ├─ 通过 → complete
    └─ 失败 → 把结果交给主 agent，继续执行循环
```

设计重点：

- Goal 的内容在执行前由用户和 agent 共同确定；
- 只有用户可以发起 Goal 修改；
- verifier 与主 agent 使用独立 context；
- verifier 使用工具观察 workspace，并根据已批准的 Goal 判断当前状态是否符合标准；
- verifier 获得与用户看到的完全相同的 worker result，但不依赖 worker 选择的 evidence 或其余 conversation；
- verifier 通过结果工具报告成功或失败；
- 每个 session branch 只维护一个当前 Goal，不建立 Goal 列表、队列或并行调度；
- 运行期间产生的状态转换在 settled boundary 串行提交，用户操作优先于 agent intent 和下一次 continuation。

## 2. 关键术语

### 2.1 Goal

Goal 是用户批准的、执行期间保持稳定的规范：

```ts
interface GoalSpec {
  mainGoal: string;
  subtasks: string[];
  details: string[];
}
```

- `mainGoal`：整体上需要达到的结果；
- `subtasks`：主目标拆解出的可验证子目标；
- `details`：约束、假设、范围和其他会影响执行或验收的补充信息。

Prompt 要求 agent 把每个 subtask 写成具体、结果导向且能够验证的目标，避免只记录模糊的执行步骤。例如：

```text
较弱：实现配置解析器
较好：CLI 能读取 --config 指定的 JSON 文件，并将其中的配置应用到运行结果
```

主 agent 和 verifier 使用同一组 main goal、subtasks 和 details。Prompt 引导 agent 将必要的约束、假设和其他补充信息写入 details，不为这些内容增加独立字段。

### 2.2 执行计划

执行计划由主 agent 在工作过程中自行形成和调整。它不是 Goal 的一部分，也不会提供给 verifier。

Goal 描述“需要达到什么状态”；执行计划描述“主 agent 打算怎么做”。两者分离后，用户修改的是目标规范，agent 可以自由调整实现路线。

### 2.3 验收判断

Verifier 不负责重新定义验收标准，也不需要生成、提交或持久化一份“验证方案”。它收到已经批准的 `mainGoal`、`subtasks` 和 Goal details，并按照 prompt 使用可用工具检查 workspace，判断当前状态是否符合这些标准。

Verifier 在推理过程中自然会选择需要的读取、测试或运行操作。这属于 agent 的内部工作过程，不进入 Goal 数据模型或扩展协议。扩展只关心 verifier 最终通过结果工具提交的成功/失败和结论详情。

## 3. Goal 生命周期

### 3.1 状态机

```text
empty
  └─ 用户 /goal <main goal> → refining

refining
  ├─ agent 提交或更新 Goal 草案 → refining
  ├─ 用户 Start → active
  ├─ 用户要求继续修改 → refining
  └─ 用户取消 → cancelled

active
  ├─ 主 agent 调用 goal_submit(result) → verifying
  ├─ 用户暂停 → paused
  ├─ 主 agent 调用 goal_pause(reason) → paused
  ├─ Pi 自动暂停(reason) → paused
  ├─ 用户发起修改 → refining
  └─ 用户取消 → cancelled

paused
  ├─ 用户 resume → active
  ├─ agent 调用 goal_resume() → active
  ├─ 用户发起修改 → refining
  └─ 用户取消 → cancelled

verifying
  ├─ verifier pass → complete
  ├─ verifier fail → active
  ├─ verifier/Pi 运行故障(reason) → paused
  ├─ 用户暂停 → paused
  ├─ 用户发起修改 → refining
  └─ 用户取消 → cancelled
```

`complete`、`cancelled` 是终止状态。`paused` 保留 Goal 和已有进度，可由用户通过 `/goal resume` 恢复，也可由 agent 在后续 turn 中调用 `goal_resume()` 恢复。

上图表示状态转换的最终结果。若主 agent 或 verifier 正在运行，用户命令和 agent 工具只登记 transition intent，不立即改变状态。当前 run 到达 settled boundary 后，controller 先处理用户 intent，再处理 agent/verifier intent，最后才允许发送下一次 continuation。这里的 settled boundary 指当前一轮 agent run 到达 `agent_settled` dispatch，或 fresh verifier session 完全 settled；它不是整个 Goal 自动循环结束。若该 dispatch 启动 fresh verifier，extension handler 会持续等待 verifier 完全 settled，因此主 session 不会在验收期间对外发布成功 run 的最终 `agent_settled`。

### 3.2 状态含义

- `refining`：用户与 agent 正在讨论或等待用户确认 Goal 草案；
- `active`：主 agent 正在执行自动循环；
- `paused`：用户、agent 或 Pi 已停止自动执行；agent 和 Pi 触发时需要记录并展示原因；
- `verifying`：主 agent 已提交用户可见的最终 result，主循环停止，fresh verifier 正在验收；该验收仍属于当前 Goal run 的运行阶段；
- `complete`：verifier 已确认主目标和全部子任务完成。

## 4. Goal 的产生

### 4.1 用户提出主目标

用户输入：

```text
/goal <main goal>
```

这段文字是 Goal 的初始提案，不会立即开始长程执行。状态进入 `refining`。

### 4.2 Agent 与用户共同细化

主 agent 在当前 conversation 中采用按重要不确定性驱动、与 Goal 风险成比例的 refinement：

1. 先明确理解用户想实现的结果；
2. 识别并列出自己尚不理解的重要事项；不同答案会实质改变交付物、范围、行为、约束或完成判定时，该事项才属于重要不确定性；
3. workspace、文档或工具能够查明的事实由 agent 自行调查，用户意图、偏好、优先级和取舍才交给用户决定；
4. 将当前可回答的重要不确定性组织成一轮简洁的编号问题；只有前序答案揭示或解锁新的重要不确定性时才进入下一轮；
5. 不静默选择会产生实质差异的解释，也不穷举所有理论方面；上下文明确的低风险事项可以推断，重要假设和边界写入 details；
6. 将主目标细化为多个结果导向、可验证的子任务；
7. 当剩余不确定性已经不会实质改变执行或验收时，提交完整 Goal 草案。

Prompt 要求 agent 把每个 subtask 写到能够独立判断是否完成的程度。Agent 可以使用 workspace 工具帮助理解项目。扩展不建立 setup 阶段的工具权限系统。Goal 被批准前，agent 专注于调查和讨论，不提前实施任务。

### 4.3 Control Panel 中的确认

Agent 调用 `goal_propose` 后，tool handler 只登记完整草案。当前 refinement run settled 后，controller 才把草案写入 `draft`。新草案首次形成或发生更新时，Pi 在没有 pending message 的 idle boundary 自动打开一次 Goal Control Panel。

`goal_propose` 使用自定义 tool rendering：折叠状态只突出显示 proposed main goal；展开状态显示 main goal、全部 subtasks 和 details。固定的“已记录、settled 后 review”信息仅作为末尾 dim 辅助文本，不取代 Goal 内容。

用户在面板中查看：

```text
Main goal
Subtasks
Details
```

然后选择：

- `Start`：固定 Goal，并从 `refining` 进入 `active`；
- `Edit`：直接在 Pi 配置的 external editor 中打开 GoalSpec JSON；editor 正常退出且 JSON 有效时保存并返回更新后的 review popup；
- `Refine with agent`：保持 `refining`，关闭面板并回到当前 conversation 继续讨论。

Draft review 不提供 Cancel 或独立 Close control。用户按 `Esc` 时执行与 `Refine with agent` 完全相同的 action：保留 draft 和 `refining` 状态，退出面板，将焦点交还主 agent 聊天界面。取消整个 Goal 只能显式运行 `/goal cancel`。

TUI refinement 不提供 inline JSON editor。`Edit` 直接暂停 TUI，并按 `externalEditor`、`$VISUAL`、`$EDITOR` 和 Pi 平台默认值的优先级启动 external editor；该 command 必须对应当前 Pi process 可执行的程序。External editor 正常退出后，扩展读取并校验 JSON：有效内容更新 draft 并返回 Control Panel；无效内容显示错误并带着当前内容重新打开 external editor；启动失败或非零退出则保留原 draft、报告失败并返回 Control Panel。非 TUI UI 仍使用 Pi 的 extension editor dialog 作为兼容路径。

Goal 草案形成和等待用户 Start 都属于 `refining`，不增加单独状态。Agent 可以提出草案，用户拥有最终决定权。未获确认的草案不能驱动自动执行。用户返回聊天界面后可通过 bare `/goal` 重建并重新进入；同一次 draft 提交不会仅因后续 `agent_settled` 再次自动弹出。

### 4.4 统一 Goal Control Panel

Bare `/goal` 是控制面板的固定入口。面板根据当前状态显示：

- lifecycle status，以及 `refining` 下的 discussing 或 draft-ready 描述；
- 当前 draft 或 approved Goal 的 main goal、subtasks 和 details；
- agent running/idle、已 settled execution round 和 automatic turn 信息；
- pending user action 及其等待状态；
- pause source/reason、当前 submitted result、verification attempts 和最新 verifier details；
- 与状态相符的 Start、Edit、Refine、Pause 和 Resume controls。

Control Panel 在任何状态都不提供 Cancel control；取消整个 Goal 只通过 `/goal cancel`。在 `refining` draft review 中，`Esc` 等同于 Refine，返回主 agent conversation。在其他状态中，`Esc` 只关闭只读或管理面板，不改变 Goal state。

执行期间没有权威的逐 subtask 进度，因此面板只展示 subtask 文本，不根据主 agent 的叙述推断完成标记。Verifier pass 后才可把全部标准显示为已通过。

`active` 和 `verifying` 状态下，面板中的 GoalSpec 是只读的，不提供 Edit control。用户只能通过显式 `/goal edit` 请求修改。`refining` 下可以直接编辑 draft；`paused` 下没有正在运行的 owner，也可以从面板进入 edit/refine。Pause 等状态 control 即使由面板触发，也必须进入与同名命令相同的串行 transition dispatcher，不能在 UI callback 中直接改写状态。

Control Panel 使用居中的 `ctx.ui.custom(..., { overlay: true })` popup。内容区域具有固定 viewport，支持 `↑`/`↓` 逐行滚动和 `PageUp`/`PageDown` 翻页；Start、Edit、Refine、Pause 和 Resume 使用固定 footer 中的快捷键，避免与滚动按键冲突。

面板退出不改变 Goal 数据。扩展不在输入框上方保留 Goal widget，只使用简短 statusline：`Goal <status>`；至少一个 worker execution round settled 后追加 `#N`。Statusline 不展示 pending action 或其他详细信息。

## 5. Goal 的暂停与恢复

所有停止自动执行但保留 Goal 的情况统一进入 `paused`。暂停来源记录为 `user`、`agent` 或 `pi`。每次状态转换为 `paused` 时，扩展都在 transcript 中追加醒目的 warning：agent 和 Pi 暂停显示 `Goal paused — <reason>`，用户主动暂停显示 `Goal paused by user.`。该提示补充 statusline，并让网络重试耗尽等 run error 后的暂停状态和原因立即可见。

### 5.1 用户暂停

用户通过 `/goal pause` 请求暂停。若当前没有 goal-owned run，controller 立即进入 `paused`。若主 agent 或 verifier 正在运行：

1. 持久化 `pendingUserAction: pause`；
2. 保持当前状态，让当前 run 到达 settled boundary；
3. 禁止在该 boundary 发送新的 continuation 或启动新的 verifier；
4. 保留 Goal 和已有 workspace 进度并进入 `paused`。

用户主动暂停不要求填写原因。Control Panel 的 Pause control 复用同一流程。用户需要提前终止长时间运行的 turn 时可以使用 Pi 的 interrupt；状态转换仍在随后到达的 settled boundary 提交。

### 5.2 Agent 暂停

主 agent 可以调用 `goal_pause({ reason })`。`reason` 必须具体说明为什么当前无法继续，并展示给用户。适用情况例如：

- 需要用户提供凭据或决定；
- 必需的外部服务不可用；
- 多次尝试后仍需要外部动作；
- Goal 的要求存在矛盾，需要用户修改 Goal。

Tool handler 只登记 pause intent 并结束当前 tool batch。当前 agent run settled 后，如果没有优先级更高的用户 action，controller 才进入 `paused` 并停止自动循环。普通困难、单次命令失败或仍有其他可行路线时，agent 应继续工作。

### 5.3 Pi 自动暂停

Pi 在运行层面的硬性问题或安全边界触发时暂停 Goal，例如：

- provider/network retry 已耗尽；
- provider quota 或认证问题；
- compaction/retry 无法恢复；
- 必需工具失效；
- 自动轮次或无进展安全上限触发。

可重试错误先交给 Pi 原有 retry 机制。确认无法恢复后，Pi 在相关 run settled 后进入 `paused`，记录并向用户展示原因。

### 5.4 Resume

用户运行 `/goal resume` 时 Goal 已经没有运行中的 owner，因此可以立即恢复。Agent 在任意来源的 `paused` Goal 可以继续执行时，应调用 `goal_resume()`，无需区分暂停来自用户、agent 或 Pi。该工具登记 transient resume intent，并在调用它的 agent turn 到达 settled boundary 后恢复；若同时存在 pending user action，仍先执行用户 action。

两种恢复入口执行相同的状态转换：

- 保留原 Goal 与 workspace 进度；
- 清除暂停原因；
- 重置本轮自动执行安全计数；
- 恢复 `active` 和正常 agent loop。

`goal_resume()` 不主动唤醒 paused 状态下的 agent。它只能由后续已经开始的 agent turn 调用，调用并提交后才重新启动 automatic continuation。

## 6. Goal 的修改

### 6.1 只有用户能发起修改

主 agent 不能自主改变：

- `mainGoal`；
- subtasks；
- details。

Agent 如果发现 Goal 不合理、矛盾或无法完成，可以解释问题、建议如何修改，并通过带原因的 pause 等待用户。它不能为了让任务容易通过而自行降低标准。

### 6.2 修改流程

`active` 和 `verifying` 状态下，用户只能通过 `/goal edit` 发起修改，Control Panel 不提供直接编辑入口。若当前 run 尚未 settled：

1. 持久化 `pendingUserAction: edit`，暂不改变 GoalSpec 或 status；
2. 当前 worker 或 verifier 继续到 settled boundary；
3. controller 在该 boundary 丢弃尚未提交的 continuation、submission 或 verification intent；
4. 状态进入 `refining`；
5. 当前 approved Goal 复制为新 draft；
6. 打开 Control Panel 的编辑流程，或回到 conversation 与 agent 讨论修改；
7. agent 提交一份完整的新 Goal 草案；
8. 用户重新 Start 后进入 `active`。

如果调用 `/goal edit` 时没有运行中的 owner，前述 transition 可以立即执行。`paused` 和 `refining` 状态没有自动执行 owner，用户也可以从 Control Panel 进入同一 edit/refine 流程。

GoalState 不维护 revision。历史 GoalSpec 仍由 branch 中按顺序保存的 session custom entries 保留，执行和验收只使用当前批准 GoalSpec。

普通用户指导不会静默修改 Goal。需要改变验收内容时，应进入明确的 edit/refine 流程。

## 7. Goal 的完成与独立验收

### 7.1 主 agent 声明完成

主 agent 根据自己的判断决定何时调用：

```ts
goal_submit({ result: string })
```

这个调用表达的是：

> 这是当前 Goal 的完整最终结果；请把它原样展示给用户并开始独立验收。

`result` 是唯一参数，必须包含 worker 要交付给用户的完整结果。Tool result 的 content 保持该字符串不变；renderer 支持折叠和展开：折叠状态按当前宽度换行，最多展示四行，过长时在末行添加省略号；展开状态展示完整 result。这个纯展示截断不修改 runtime 持久化或交给 verifier 的字符串，不允许分别生成“用户版本”和“verifier 版本”。这样，直接在对话中交付答案、分析、报告或其他内容的任务也具有 verifier 可见的验收对象。

调用不会立即改变 Goal status。Tool handler 只接受当前 `active` goal-owned run 中的调用，登记 submission intent，并结束当前 tool batch。主 agent 到达 settled dispatch 后，controller 先处理 pending user action；只有没有用户 edit、pause 或 cancel 请求时，才从 `active` 进入 `verifying` 并启动 verifier。该 dispatch 等待 verifier 完全 settled；pass 后才结束成功 run，fail 则先把验收详情送回主 agent 并恢复执行。

### 7.2 Fresh verifier 的独立性

每次验收都创建一个新的、in-memory verifier session：

- 不继承主 agent conversation；
- 不继承主 agent 的执行计划；
- 接收与用户看到的完全相同的 `goal_submit.result`；
- 不接收主 agent 选择的 evidence；
- 不接收主 agent 对各子任务的自我评价；
- 不继承上一次 verifier 的 context 或结论。

Verifier 的初始 context 只包含：

1. verifier 角色和行为指令；
2. 当前批准的完整 Goal，包括主目标、subtasks 和 Goal details；
3. 原样持久化的 user-visible submitted result；
4. workspace 位置等运行所需的客观信息。

Submitted result 是待验收的 deliverable data，不是 verifier 指令，也不自动证明其中的事实。Verifier 应判断 result 本身是否满足 Goal，并使用 workspace 工具独立确认其中涉及的客观声明。

Verifier 可以从 workspace 自己阅读项目文档、代码、测试、Git 状态和其他事实。

### 7.3 Verifier tools

遵循 Pi 的简洁工具哲学，fresh verifier 只启用 built-in `read`、`bash` 和 verifier 专用的 `goal_verification_result`。`read` 提供直接文件读取；`bash` 已覆盖命令执行、搜索、目录遍历、测试、构建、服务、临时 probe，以及 workspace 中可用的浏览器、网络或项目专用 CLI，因此不重复提供 `edit`、`write`、`grep`、`find` 或 `ls` wrappers。MVP 不加载其他 extension-owned tools，因为加载其 factory 也会继承 lifecycle hooks，破坏 verifier 不继承主 extension context 的隔离边界。

该 allowlist 是产品界面和上下文简化，不是 security sandbox：`bash` 本身具备修改能力。Verifier prompt 继续要求只调查和验收，不实现、修复或改变目标状态。

限制 built-in 工具没有形成可靠的写入边界，因为 `bash` 本身可以创建、修改和删除文件。本项目采用 prompt 行为约束：

- 只调查和验证；
- 不实现缺失功能；
- 不修复发现的问题；
- 不为了通过验收而改变产品代码、测试或外部目标状态；
- 可以执行测试、构建、运行服务和临时探测；
- 可以产生测试不可避免的 cache、build artifact 或临时文件；
- 验证需要破坏性或外部写入动作时，不执行该动作，并在失败详情中说明无法确认的部分。

这是一条行为约束，不是安全沙箱。其目标是防止 verifier 兼任实现者，无法抵御恶意模型通过 `bash` 主动修改 workspace。

Goal 生命周期工具不属于 operational capability。Verifier 使用专用的 terminal result tool 返回结论，不参与主 Goal 的 pause、edit 或 complete 控制。

### 7.4 Verifier 工作要求

Verifier prompt 只规定职责和结束协议：

1. 根据完整 Goal 判断 submitted result 及相关 workspace 状态是否符合主目标和所有可验证子任务；
2. 按需使用任意可用工具获取足够事实；
3. 只进行调查和验收，不修改或修复任务结果；
4. 无法确认完成时应判定失败，并在 `details` 中解释原因；
5. 最终必须调用结果工具。普通 assistant 文本、包含 `complete` 的自然语言或 session 的最后一条回复都不能改变 Goal 状态。

扩展不要求 verifier 先输出验证计划，不建立 verification plan、逐项 evidence 或 observation 协议。

### 7.5 结果工具

Verifier 通过专用工具结束验收：

```ts
goal_verification_result({
  result: "pass" | "fail",
  details: string,
})
```

- `result` 是唯一的成功/失败信号；
- `details` 是 verifier 的结论说明；失败时必须说明不通过或无法确认的原因；
- tool handler 捕获结构化参数作为 verifier result intent，并终止 verifier run；
- runtime 不解析 assistant 自然语言，也不判断返回文本中是否出现 `complete`；
- tool handler 应拒绝空 `details`、重复调用以及来自当前 verifier run 之外的调用；
- verifier session settled 后，controller 先处理 pending user action，再决定是否提交该 result intent。

Runtime 只处理协议正确性和串行状态转换。是否符合 Goal 由独立 verifier 根据 prompt、Goal 和工具观察判断。

### 7.6 验收过程 UI

Controller 启动 fresh verifier 时，在主 session transcript 中追加一个 TUI-only `goal-verification-ui-v1` custom entry 作为稳定显示锚点。该 entry 使用类似 tool result 的自定义 renderer：

- card 使用 built-in tool call 的 title 与 outcome background 样式；验收运行期间以 `[-]`、`[\]`、`[|]`、`[/]` bracketed ASCII spinner 作为粗体 `Verifying` title 的 dim、非粗体后缀，使用 `toolPendingBg`；spinner 在验收 settled 或 session shutdown 时停止；
- 验收运行期间，折叠状态直接使用最多四行的 viewport 滚动展示最新一条 trace；
- 验收运行期间，展开状态显示完整的有界 verifier trace，包括 request、已经 finalized 的 thinking/assistant 内容、tool calls 和 tool results；所有 trace label 和正文都使用普通 `toolOutput` 正文样式，不对 `bash`、`read` 等 label 使用蓝色或粗体；
- verifier settled 后，同一个锚点重新渲染，title 变为 `Verification pass`、`Verification fail` 或 `Verification error`；pass 使用 `toolSuccessBg`，fail/error 使用与失败 tool call 相同的红色 `toolErrorBg`；
- 折叠状态显示按当前宽度换行、最多三行的 `details` 摘要，超出部分以省略号截断；展开状态显示完整 `details` 或运行错误原因；完成后，折叠和展开状态都不再显示 verifier trace。

Pi session entries 是 append-only。UI 使用首条 start entry 作为动态 renderer anchor；运行中的 finalized interactions 更新内存 projection，并通过 statusline render request 刷新 anchor，不向 transcript 追加重复行。Settled 时追加一条不可见 final snapshot，保存有界 transcript 和 details；session 恢复时从当前 branch 的 start/final entries 重建 anchor projection。最多保留 80 条 interaction，每条文本最多 8,000 字符，防止验证输出无限扩张。

每次 verifier display operation 在 observational entry 内使用一个内部 `operationId`，防止不同 Goal 都从 verification attempt #1 开始时历史 card 与当前 card 错误共享 projection。它不是 Goal/run identity，不进入 GoalState、prompt、tool 参数、statusline 或 Control Panel。

这些 entries 只用于用户观察和恢复显示，不进入 LLM context，不属于 GoalState，也不影响 pass/fail 的 settled ordering。主 controller 仍只接受 `goal_verification_result` 作为验收结论。

### 7.7 验收通过

Verifier session settled 后，如果存在有效 pass intent 且没有 pending user action：

- 状态进入 `complete`；
- 停止所有 Goal continuation；
- 持久化简洁验收报告；
- 向用户显示 verifier 的 `details`；
- Goal 生命周期结束。

### 7.8 验收失败

Verifier session settled 后，如果存在有效 fail intent 且没有 pending user action：

1. 持久化验收报告；
2. 状态从 `verifying` 返回 `active`；
3. 将 verifier 的失败结果作为 follow-up 交给主 agent；
4. 主 agent 按正常执行期间相同的 agent loop 继续修复；
5. 主 agent 再次认为完成时，重新调用 `goal_submit({ result })`；
6. 创建另一个 fresh verifier，从 Goal 和当前 workspace 独立开始验收。

如果 verifier 运行期间用户请求 edit、pause 或 cancel，用户 action 在 verifier settled 后优先执行，当前 result intent 不驱动状态转换。

新的 verifier 不读取上一次验收报告。上次报告用于指导主 agent 和向用户解释，不用于锚定下一位 verifier。

如果验收失败暴露的是 Goal 本身的问题，主 agent 不能修改 Goal。它应通过 `goal_pause({ reason })` 暂停并等待用户发起 edit。

### 7.9 Verifier 运行失败

模型、网络、工具或 verifier session 自身故障不等于 Goal 验收失败。Verifier session settled 后，如果没有 pending user action：

- 不产生 pass/fail；
- 保留 Goal 和工作状态；
- Pi 将状态置为 `paused` 并展示原因；
- 用户在环境恢复后 `/goal resume`，重新启动 fresh verifier 或返回 active 后重提。

## 8. 主 Agent Loop 与串行转换

Goal 进入 `active` 后，主 agent 在原 Pi session 中持续工作：

1. 每轮 `before_agent_start` 注入当前批准 Goal 和持续执行规则；
2. agent 使用自己的计划实现任务；
3. `goal_submit` 和 `goal_pause` 只登记 terminal intent，`goal_resume` 只登记 resume intent，tool handler 不直接转换状态；
4. 运行期间收到的 `/goal edit`、`/goal pause` 和 `/goal cancel` 只登记 pending user action；
5. `agent_end` 登记 continuation intent，不立即发送 continuation；
6. `agent_settled` 成为唯一的 main-run transition commit boundary；
7. controller 先处理 pending user action，再处理 agent proposal、pause、resume、submission intent 或 Pi pause，最后才考虑 continuation；
8. 只有 Goal 仍为 `active`、Pi idle 且没有 pending message 时，才发送一次 continuation。

用户 action 始终优先。Cancel、Edit 或 Pause 一旦被登记，本轮 settled 后就不会启动 verifier，也不会发送下一次 continuation。Tool result、UI callback 和异步消息发送的完成回调都不能绕过 controller 直接写 Goal status。

若命令到达时没有运行中的 owner，controller 可以把当前 idle 状态视为 settled boundary 并立即提交。Fresh verifier 使用同样的串行规则：result tool 只登记 verdict，verifier session settled 后才提交 pass/fail，期间登记的用户 action 优先。

采用 `narumitw-pi-goal` 的 intent → settled dispatch 模式，避免 transition 和 continuation 与 retry、compaction、steering、follow-up 交错。验收失败返回 `active` 后继续使用完全相同的 loop，不建立单独的 recovery state machine。

## 9. 单一当前 Goal 与持久化

每个 Pi session branch 最多维护一个当前非终止 Goal。MVP 不提供 Goal list、queue、并行 active Goal 或通过标识选择 Goal 的命令。存在当前 Goal 时，新的 `/goal <main goal>` 应提示用户使用 edit，或先 cancel 当前 Goal。相关工作应表达为 subtasks；互不相关的并行工作使用不同 Pi session。

Goal state 只保存在 Pi session custom entry 中。恢复时读取当前 branch 的最后一条 canonical state。`/tree` 导航后，controller 清理旧 branch 的 transient owner，并从新 branch 重建 canonical state 和 verifier display。`refining` 原样恢复；`active` 等待用户下一条消息，该轮 settled 后才恢复 automatic continuation；`verifying` 持久化为 Pi `paused` 并将遗留 verifier card 标记为中断；Goal 创建前的 branch 清空 statusline。Tree restore 不把旧 branch 的内存状态写到新 leaf，也不自动启动 worker 或 verifier。

```ts
interface GoalState {
  version: 1;
  status: GoalStatus;
  draft?: GoalSpec;
  approved?: GoalSpec;
  pause?:
    | { source: "user" }
    | { source: "agent" | "pi"; reason: string };
  pendingUserAction?: {
    kind: "edit" | "pause" | "cancel";
    requestedAt: number;
  };
  iteration: number;
  automaticTurns: number;
  noProgressTurns: number;
  lastAutomaticOutputFingerprint?: string;
  verificationAttempts: number;
  submissionResult?: string;
  lastVerification?: {
    result: "pass" | "fail";
    details: string;
  };
  createdAt: number;
  updatedAt: number;
}
```

GoalState 不包含 revision。`iteration` 统计已经 settled 的 worker execution rounds，statusline 只在该值大于零时把它显示为 `#N`。`submissionResult` 保存原样展示给用户并交给当前 verifier 的 result，使 verifying 状态能够在 reload 后以相同内容恢复；所有 `verifying` 状态都必须包含 `submissionResult`，加载时拒绝违反该不变量的 entry。`lastAutomaticOutputFingerprint` 只保存规范化 assistant 可见文本的 SHA-256，用于跨 reload 延续 no-progress 检测；它不是 Goal 或 run 身份。用户 command 被确认后持久化 `pendingUserAction`；session 恢复时，controller 必须先提交该 action，再决定是否恢复 worker 或 verifier。

Agent 和 verifier intent 属于产生它们的当前 run，只在对应 settled callback 中消费。Session shutdown、replacement 或 extension reload 通过 `AbortSignal`、controller disposal 和对象所有权停止未完成 callback。这些是通用异步资源管理，不进入 Goal state、prompt、tool 参数或 Control Panel。

除 `goal-state-v1` canonical entries 外，extension 还保存 `goal-verification-ui-v1` observational entries，用于重建用户可见的 verifier card；它们不参与 Goal 状态恢复或 LLM context。MVP 不创建磁盘 mirror、evidence database、通用 event journal、Goal queue、phase DAG 或 authority state。

## 10. 用户命令与 Agent 工具

### 10.1 用户命令

```text
/goal <main goal>  # 创建 Goal，进入讨论细化
/goal              # 打开统一 Goal Control Panel
/goal status       # 输出非交互式状态摘要
/goal pause
/goal resume
/goal edit
/goal cancel
```

当主 agent 或 verifier 正在运行时，`pause`、`edit` 和 `cancel` 命令只登记 pending user action，并在对应 settled boundary 提交。`/goal edit` 是 `active` 和 `verifying` 状态修改 GoalSpec 的唯一入口。Bare `/goal` 可以查看这些状态，但不能在面板中直接编辑它们。`/goal cancel` 是取消整个 Goal 的唯一用户入口，Control Panel 不提供等价按钮。

### 10.2 主 agent 工具

```text
goal_propose
  - 仅 refining 可用
  - 登记完整 Goal 草案，refinement run settled 后提交

goal_submit
  - 仅 active goal-owned run 可用
  - 唯一参数 `result` 是同时展示给用户和交给 verifier 的完整最终结果
  - 登记 submission intent，不直接改变 status

goal_pause
  - 仅 active goal-owned run 可用
  - reason 必填；登记 pause intent

goal_resume
  - 仅 paused 可用，不区分 pause source
  - 无参数；当 Goal 可以继续时登记 resume intent
  - 在当前 agent turn settled 后恢复 active 和 automatic continuation，不主动唤醒 agent
```

这些工具不接收 Goal 身份或运行代际参数。Runtime 在对应状态登记 intent，并在 settled boundary 提交；proposal、submission 和 pause 仍要求匹配当前串行 Goal run。Agent 没有修改已批准 Goal 的工具；修改只能由用户命令开启。

### 10.3 Verifier result tool

```text
goal_verification_result
  - 仅当前 fresh verifier session 使用
  - 参数为 result: "pass" | "fail" 和 details: string
  - 登记 result intent，details 保存并传递验收结论
  - 调用后结束 verifier session；状态在 verifier settled 后转换
```

## 11. 实现基础与参考边界

### 11.1 以 `narumitw-pi-goal` 为基础增加功能

本项目的实现路线是以 `references/narumitw-pi-goal/` 的代码和生命周期为基线，保留其已经解决的问题：

- session-scoped state；
- active/pause/resume；
- run ownership 与中断清理；
- compaction/reload 恢复；
- settled boundary continuation；
- provider 错误和安全上限处理；
- 简单 terminal tools。

在该基线上增加：

1. `/goal` 启动后的讨论和细化阶段；
2. 主目标与可验证子任务的用户确认；
3. 统一 Goal Control Panel；
4. user-only Goal 修改与重新细化；
5. settled boundary 串行 transition dispatcher；
6. `goal_submit({ result })` 登记 user-visible submission intent；
7. 启用 `read`、`bash` 和专用 result tool 的 fresh verifier；
8. verifier result tool 登记 pass/fail intent；
9. fail 后返回既有 agent loop，pass 后进入 `complete`。

Narumitw 要求模型回传随机标识的 terminal-tool 协议不进入本项目的产品协议。实现应复用其 lifecycle、runtime 和 continuation 边界，将状态提交改造成单一当前 Goal 上的串行 dispatcher。通用 session/run cleanup 继续留在 runtime 内部。

实现时应优先复用或改造 narumitw 的 runtime、persistence、lifecycle、command 和 safety 结构，而不是先设计另一套大型状态机。

### 11.2 `misunders2d-pi-goal` 仅作为产品参考

`references/misunders2d-pi-goal/` 只帮助确认两个产品需求：Goal 开始前需要澄清，最终完成需要独立 context 验收。它的源码结构、状态、工具和审计协议不作为本项目的设计模板。

Goal 细化和独立 verifier 将直接针对 narumitw 的现有接口重新实现。实现依据是本文件确定的行为、narumitw 的 lifecycle/runtime 边界以及 Pi SDK，而不是复制 misunders2d 后再删减。发生架构选择时，应优先保持 narumitw 模型的一致性。

## 12. 建议模块划分

```text
src/
├── index.ts          # extension 组合
├── state.ts          # GoalState、纯 transition、session persistence
├── prompts.ts        # refining、execution、continuation、verifier prompt
├── commands.ts       # /goal 路由、Control Panel、pending user action
├── tools.ts          # propose、submit、pause、resume intent
├── lifecycle.ts      # session、compaction、settled transition dispatcher、错误处理
├── continuation.ts   # intent/delivery single-flight
├── verifier.ts       # fresh session、tool access、interaction observation、result intent
├── verification-ui.ts # verifier transcript projection、append-only UI entries、collapsed/expanded renderer
└── safety.ts         # turn limit、no-progress、provider error 分类
```

关键边界：

- `state.ts` 不依赖 UI 或模型；
- 所有 Goal status 写入由 main/verifier settled dispatcher 提交；
- `active` 和 `verifying` 的 Control Panel 不允许直接修改 GoalSpec；
- Control Panel 不提供 Cancel control，`refining` review 的 `Esc` 与 Refine 使用同一 action；
- `verifier.ts` 只能返回 result intent，主 controller 负责状态转换；
- prompt builder 使用纯函数；
- verifier fail 直接返回普通 agent loop，不创建额外 evaluator 层。

## 13. 实施顺序

1. 单一当前 GoalState、pending user action 与 session persistence；
2. `/goal` 创建、讨论、草案、Control Panel、确认，以及 Esc/Refine 和 slash-only cancel 交互；
3. active agent loop、settled transition dispatcher 与 continuation；
4. 统一 user/agent pause/resume 和 Pi error transition；
5. user-only edit/refine/reapprove，以及 active/verifying UI 只读约束；
6. `goal_submit({ result })` intent → settled → `verifying`；
7. full-built-in-tool fresh verifier、result intent 与 verifier settled commit；
8. fail → active loop、pass → complete；
9. compaction、reload、pending action precedence、late callback cleanup 和安全上限测试。

## 14. 结论

最终方案有三个固定边界：

1. **目标边界**：用户和主 agent 在开始前共同形成主目标与可验证子任务，只有用户能发起修改；
2. **转换边界**：每个 session branch 只有一个当前 Goal；运行期间的用户 action、agent lifecycle intent 和 verifier result 都在对应 settled boundary 串行提交；
3. **验收边界**：主 agent 通过 `goal_submit` 把同一份最终 result 同时交给用户和 fresh verifier；verifier 使用自己的 context、工具和观察确认该 result 及相关 workspace 状态是否真正满足 Goal。

`active` 和 `verifying` 状态的 Control Panel 只展示 GoalSpec；用户通过 `/goal edit` 把修改请求排到当前 run 之后。用户 action 优先于 submission、verification 和 continuation，因而新旧 Goal 内容不会并发驱动状态转换。

Verifier 不重新制定目标，也不依赖主 agent 的计划或 evidence。它获得批准后的 Goal、与用户看到的相同 submitted result 和 workspace tools，并通过 `goal_verification_result({ result, details })` 报告结论。只有在 verifier settled 后提交的 `pass` 才能使 Goal 进入 `complete`；`fail` 及其 details 返回主 agent，继续 narumitw 风格的既有执行循环。
