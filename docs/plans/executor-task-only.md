# 执行者仅通过正式任务向主理人提交

当前需求：用户明确要求除当前群主理 Bot 外，其他 Bot 不要出现“群内汇报”，应以任务形式提交给主理 Bot。此规则替代 principal-ordinary-replies.md 中将执行者普通消息转换为 GroupPostCard 的策略；.38 的 Markdown 完整 labels 与导航退位修复必须保留。当前安装仍为 .38，开发及精确候选为 `0.3.39-task-only.1`；新规则尚未发布。

适用于全部已有群和未来新群，不按群名或群 ID 特判。主理身份依当前群有效 admin、成员关系与稳定 Bot ID 判断。用户消息不受影响。

实现边界：

- 保留真实 taskflowEvent 的正式派发、提交、失败和心得卡，优先于普通回复分流。
- 结果仍由现有 taskflow_submit 写入真实账本，投递给当前主理并唤醒其验收；心得仍走 taskflow_sleep_note。不得用“群内汇报”改标题或凭空造 plan/card 身份代替提交。
- 执行者普通文本的实时步骤、回合结束、延迟回复和 post_to_group 不再产生群内普通汇报；模型任务提示明确要求使用正式工具。
- 历史非主理普通汇报在群界面不再渲染，原记录/执行者私有转录保留，不迁移或删除生产记录。已有正式提交正常可读。
- 没有真实分配卡时，不自动建假卡、不把文本视为已提交或已验收；拒绝普通发群路径并引导使用正式任务。
- 主理普通消息保留既有管理员气泡。保持 .38 的完整共享 Markdown 标签、用户/native 消息边界和正式任务身份优先。

验收清单：

- [x] 当前源代码及实际安装 .38 的真实链路和精确差异检查；installed Host 与开发有大幅并行分叉，尤其 roomPrompt 的 finished 参数、quietKey 和历史投影，候选不得整源覆盖。
- [ ] 红测：执行者普通回复和 post_to_group 被阻止；正式结果/心得仍持久化、投递并唤醒主理；管理员切换/跨群/新群一致。
- [x] Host 最小修复和客户端历史/实时普通汇报分支清除；GroupPostCard 已移除，普通 worker 及其普通附件不进入群展示，formal 身份优先。message_bot 的群内未跟踪委派明确拒绝，避免 quiet 后仍谎报 Called；私聊路径保留。
- [x] 精确候选从实际安装基线最小叠加，保留并行修改，插件/app/lock 根与链接项同步到 .39。scripts/stage-task-only.mjs 验证259基线文件，仅client.js/package/cells/task-message/host groups/host tools六变更；Host补丁必须唯一匹配，静态并行内容保留。
- [ ] 关联回归、隔离真实 SDK Host 和客户端导航验证；独立审查闭合所有发现后冻结。
- [ ] 完整检查只运行一轮当前冻结输入，不因回执变化重复。
- [ ] 已授权安装、同 EXE 重启、实际文件读回和可见区域核验。

生产数据只读；本轮不发送未经授权的真实群消息、不调用计费模型。隔离提交链路不能冒称真实账号新任务验收。桌面输入不可靠时立即停止，不重复要求用户操作。

当前验证证据：

- 源码关联 task-inputs/tool-cells/taskflow plugin 等85项已通过；后新增8个运行边界用例覆盖真实账本提交/心得通知、普通发群拒绝、progress/late final quiet、管理员切换、启动后新群与私聊保留。
- 精确候选用实际安装依赖闭包解析缺失裸依赖（不提供stub），executor-task-only 与 Markdown 契约通过；不得以开发工作树结果代替此候选结果。
- task-only-navigation-candidate-1.json 使用实际安装 React/SlotCore/MarkdownText，9场景通过；历史/实时 workerCards=0、worker普通气泡=false，主理气泡保留，正式结果卡及代码块/脚注完整，无crash。private仍为隔离树卸载占位，不是生产窗口验收。
- 正式 Windows 源码检查 `proc_7b646c8b8236` 已完成：build 退出0；npm test 退出1，报告 executor-task-only-canonical-1.json；lint/bundle-check 未执行，readiness=null。不能以此前 .38 或定向结果代替 .39 完整通过。
- `deleg_a3d75cb7` 和 `deleg_ffe11cc4` 的逐项只读分类已收到；groups.test.js 六项原本通过。16个普通机制夹具按当前群主理迁移后定向通过；长文/附件/@all/自提及/report_back/global Main越权及群内message_bot保留拒绝覆盖，活动回合拒绝回归已通过。
- 用户无任务卡直接 @执行者改为投递当前群主理，由主理创建真实卡；定向回归通过。初次四文件诊断 executor-task-only-host-related-3.log 发现 rounds.test.js 仍有旧多人普通回复断言；该诊断进程因未退出已精确停止，日志无最终汇总，不算完整结果。
- 新正式 busy/parallel 迁移发现真实回归：worker提交被旧registerBatch记为主理普通工作的asker，主理验收后又反向唤醒worker，原round无法结束。registerBatch现仅允许当前有效主理建立普通委派批次；两个红测在修复后退出0（executor-task-only-formal-migration-4.log）。测试继续检查正式结果入账、主理续跑、排队提交通知及不反叫worker；后续断言和提示词变更由新回归覆盖。
- 删除矛盾提示：不再指导执行者普通 @ 下一个成员形成委派链，统一明确plan/dispatch/submit/sleep_note。精确候选脚本同步唯一seam；group-work 原90项89通过1测试准备失败，该项补齐真实消费/验收后定向通过。后续关联四文件141项139通过2夹具失败，两项（私聊steer接口、忙碌成员未读）保持原断言定向通过。
- 第二轮正式检查 proc_69a64699759d 已退出1：build通过，npm test失败，报告executor-task-only-canonical-2.json；475输入无漂移。尾部失败定位group-goal/request-id，定向46项40通过6失败，迁移及修复后46项全通过，保留全部用例。
- group_goal 的目标任务原依赖worker普通回复变成reported；改成真实plan/dispatch/submit后两项红测确认兼容缺口。groups.js通过现有onRoomLine监听已记入群记录的真实submitted任务事件，复用goalTaskReported，仅标记已汇报，不代替主理验收。新增生命周期回调由ctx.effect清理；开发及精确候选定向通过，先完成的卡可推进目标而同批未提交成员仍working。stage仍只叠加6个产品文件。
- 当前实装版本为0.3.39-task-only.1，manifest为c21756c0e4c9616a911d84580c2fdd60ad7a4523e1cd101adcf977a5b963174a，259文件。发布包位于task-only-release-3，归档SHA-256为2fb223540af9dfb05989703b7e04b2d09dccef346de6b25d32c9ec4715d1b9dd。相对1184e85a候选，全部产品文件及发布包字节不变，仅reviewInputs中的rounds.test.js移除两个未用的answer解构变量，未删除用例或断言。完整基础审查与最终增量审查已合并，现场行为仍须独立验收。
- 第四轮正式检查proc_97e2fedaa9e3已结束：build退出0，完整npm test退出0，lint退出1，bundle-check未执行。完整lint日志只含两项error，均为上述未使用answer；修复后两项失败/配额用例定向通过、完整lint退出0、bundle-check退出0。保留该轮原始失败报告，不将修复后的分项通过伪称原wrapper通过。
- 第五轮正式检查proc_c858063d3353已结束，wrapper退出0；build、完整npm test、lint、bundle-check四阶段均退出0，readiness=null。475输入无漂移；task-only-full-verification-1.json已绑定当前c21756c0候选并登记完整阶段结果。该通过为源码门禁，不冒称安装或生产窗口验收；不要因审查回执/本计划等未被测试消费的记录变化重复运行。
- 包含目标桥接的完整独立审查deleg_0aa266b5已APPROVE/0阻塞，报告task-only-full-review-6846.json绑定68464b72。最终增量审查deleg_9ec93aa0已APPROVE/0阻塞，完整报告task-only-delta-review-c217.json已恢复；验证259产品文件、18项审查/补丁输入以及rounds内存还原哈希，覆盖当前c21756c0快照。task-only-final-review-1.json已登记releaseApproved=true，并与完整验证回执绑定。
- 已完成安装和重启：正常关闭只隐藏窗口，精确进程树复核仍有5个原进程；经工具审批通过后仅停止该树，记录normal close then scoped authorized force stop，非正常退出。安装器确认0目标进程后仅写6个变化文件，259文件全部读回一致，profile junction保持同一物理目录。同一EXE以不激活窗口方式启动，新PID1472/窗口23398532已核验，启动前后前台窗口不变，未新增Host崩溃日志。
- 现场验收仍未完成：重启后的lq-create窗口能抓图，但AX正文仅返回原生窗口按钮；已授权的短暂前台滚动返回effect=unverifiable，随后新截图消息区变化像素为0。已停止进一步输入，未尝试其他窗口或输入绕行。七卡逐条像素、跨群导航与普通worker历史隐藏均保持未验收；不以静态截图或缺少异常日志替代。当前交付回执为task-only-delivery-1.json，明确installed=true、liveAcceptanceComplete=false；未主动发送新生产任务或模型请求。
- 首次后台Node仅报stdin is not a tty，未收集测试，不算产品失败；显式Windows node.exe的Host相关整组收集109项、61通过48失败。多数失败预期为被新规则取消的普通worker发群/mention互唤，完整日志executor-task-only-host-related-2.log保留；独立审查deleg_a3d75cb7逐项分类，不允许跳过失败冒充通过。
- 其中两项已迁移并定向通过：审批reportBack用例将fixture发言者设为当前群主理，保留审批名单报告；跨grace用例改为正式plan/dispatch/submit，实际唤醒ga后由其读取results.result.text、accept、finish，原时序保护仍保留。整组剩余结果尚未重新汇总。
- 独立分析deleg_61408280关于“保留普通GroupPostCard分支”的建议不采用，因为与用户要求及已观察历史汇报卡冲突；复用真实提交链路的建议已落实。其提到的通知catch仅warn已用隔离故障注入确认：结果入账但正式通知未送达；这是未改动TaskflowService的既有边界，记录task-only-notification-failure-diagnostic.json，不当作送达成功或引入本轮未要求的持久化重试系统。
