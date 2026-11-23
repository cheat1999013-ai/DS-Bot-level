# 执行 Bot 身份重复：发布遗漏修复

用户截图：同一群、同一计划中，lq 的 draft/fix 任务及 lq-review 的 review/verify 任务各重复渲染完整 Bot 身份。保持现有面板，按 `(roomId, stableBotId)` 仅显示一个执行者，展开后保留各 `(roomId, planId, cardId, executorId)` 子任务、结果、验收和历史。

## 证据与归因

- 已安装 .42 的 `src/client/taskflow-dashboard.js` 无 `executorRows`，仍对每张 card 显示完整身份；源码同文件已有按 Bot 聚合实现。新原生任务通道发布时继承旧面板，遗漏了既有聚合功能。
- 对实际安装 .42 执行现有单 Bot/跨群聚合回归失败：`.tmp-verify/executor-rows-installed-red-1.log`。实际窗口也重现了重复条目。
- 修复采用 .42 精确基线叠加聚合面板、一个中文键、两个 `membersByRoom` DTO 输出，以及重建客户端与版本号；不合并 Bot、删除任务或改变正式账本。

## 验收清单

- [x] .43 精确候选构建：262 文件，仅 5 个发布文件变化；保留 .42 原生消息和独立检查器。
- [x] 候选面板 27 项测试通过；候选 Host 合同回归通过。
- [x] 实际 React 离屏组件 440/760 宽度：3 个执行者身份、5 项任务记录、无横向溢出，展开后保留失败原因与反思。示例图不能代替真实群验收。
- [x] .43 全量门禁与精确候选独立复审通过。
- [x] .43 授权目标停机替换、262 文件读回、启动。
- [ ] 用户截图对应群现场核验：lq 与 lq-review 各一个执行者入口；展开各自不同任务，状态及历史不丢失。

.43 已安装；门禁 `proc_d6fea968d73c` exit 0，审查 `deleg_13382773` APPROVE。现场确认执行者已聚合，但用户指出竖线丢失，整体视觉验收失败。

## 竖线回归修复（.44）

- 根因：Flow 按同一 owner 的至少两个点生成竖线；每 Bot 聚合后只剩头像点，导致竖向 rail 为零。
- 最小修复：每个 Bot 分组卡追加同 owner/同 lane 的装饰终点，延伸到本条目底部；终点不生成额外横臂、不表示新任务或新 Bot。既有 ResizeObserver 在展开/收起后重画轨道。
- [x] 真实 Electron 离屏回归先在已安装 .43 复现 0 条轨道，再对 .44 候选验证：440/760 宽度均 3 个 Bot、5 项任务、3 条竖向虚线；展开历史后对应轨道实际延伸。
- [x] 候选面板 28 项测试、构建、lint 通过。
- [x] .44 完整门禁与独立审查：exit 0，491 输入无漂移；`deleg_07d69ce3` APPROVE，0 blocker，3 info。
- [x] .44 安装并启动，262 文件读回与审查候选一致，无新增 Host crash。
- [x] 实际 `lq-create` 面板新截图确认 lq / lq-score / lq-review 各一个身份入口，三条独立竖向虚线与横向连接可见。截图 `.tmp-verify/executor-rails-live-panel-1.png`。
- [ ] .44 安装后在实际窗口同时验收“身份不重复 + 竖线保留 + 子任务/历史可展开”。

候选 `0.3.44-executor-rails.1`，只改变面板源码、重建 client.js、版本元数据三个发布文件。门禁 `proc_f773ddc38c88`；审查 `deleg_07d69ce3`。

当前实装为 .44。现场展开入口点击返回 `timeout_outcome_unknown`，随后同 PID/HWND 新截图 0×0；遵守桌面停止边界，不重试输入。竖线/身份的实际可见状态已验收，现场展开交互未验收；组件展开、结果及历史保留已在隔离真实组件中通过。完整回执 `.tmp-verify/executor-rails-delivery-1.json`，`liveAcceptanceComplete:false`。
