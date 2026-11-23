# 同群每个 Bot 保留一个任务 UI

用户确认：“一个bot就留一个这个UI”。当前目标是消除任务流中同一 Bot 的多处卡片，不删不同任务或账本历史。

- [x] 以 room + 稳定 Bot ID 汇总正式任务、群内派工及历史任务；不同 plan/card/room 身份保留为子任务。
- [x] 同一行仅一次头像、等级、模型和能力栏；当前工作优先显示，其他任务、结果、证据、失败与重试在“任务与历史”展开。
- [x] 移除概览中的执行 Bot 重复预览，保留主理与计划心得；不再在独立时间线重复 Bot UI。
- [x] 旧运行组件回归出现 2 卡而非 1 卡的真实失败，新源码与候选关联回归通过；原始数据不变、不同群和同名 Bot 不合并、观察到回复不冒充验收。
- [x] 精确运行基线候选 0.3.30-bot-rows.1，仅更改 package/client bundle/dashboard/i18n 四文件，255 发布文件；保留启动与群回复修复、审批与技能能力。
- [x] 真实 React 组件隔离 Electron 440/760 宽：3 执行 Bot 各 1 卡，审校的正式复核/群心得共 2 子任务，展开动作生效，失败原因保留，模型栏不重复，无横溢。此为示例，不是实机验收。
- [ ] 独立静态审查闭环、457 冻结输入的完整 Windows 源码门禁通过。
- [ ] 核对目标进程、退出，安装逐哈希匹配，重启并在真实 lq-create 任务流验收。捕获异常立即停输入，不发送消息或计费请求制造数据。

证据：ds-bot/.tmp-verify/bot-row-baseline-red.log、bot-row-final-focused.log、bot-row-candidate-tests.log、bot-row-render.json、bot-row-candidate-manifest.json。
