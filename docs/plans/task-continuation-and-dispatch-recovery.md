# 任务提前结束与派工链停滞

范围：用户报告所有群共用的执行链会提前停止，或任务卡没有派完。旧“单 Bot 一套 UI”候选仍暂停部署。本次最新反馈指出 .31 只显示恢复告警，没有下文；.32 已实际安装，真实主理恢复链已验收，截图对应原计划已正式 completed。

## 当前反馈：恢复告警之后没有下文

- [x] 截图对应原计划 6d1f3c74-2a8b-4de1-9f57-3c8e21b0d4a9/fix-ui；生产只读事件证实仅 recovery_attention，无提报或核验后续。
- [x] 根因：sweep 以当前 admin 发 progress 卡，无明确接收者；openingCall 又过滤 sender 自身，主理没有回合。仅增加 @admin 仍被自发言过滤。
- [x] 新投递链：recovery_wake_reserved 在发送前持久占位；明确 recovery task event 送当前主理，群接纳时原子 claim，核对群/计划/卡/attempt/当前主理/只读状态。只给该账本证明的事件一次自唤醒，不放宽普通自身提及。
- [x] 旧 attention 标记不抑制缺失的新投递；主理先读取 taskflow_results 与原执行/产物。unknown 不自动重派、不伪造完成，pending 在原审批/依赖条件内继续派工。
- [x] 真实 runtime/session/event 隔离回归红转绿：旧运行候选两项不醒主理，新候选能醒主理且读取原卡；pending 继续派出原 fix-ui。source 关联147/147，candidate focused17/17、lint及隔离SDK通过。完整旧开发group suite对运行契约存在多项既有失败，未称全候选suite绿；普通@all浮动另对新旧各单项通过。
- [x] 发布候选 .32 共257字节绑定文件，5项测试/loader及4项patch donor、实际123模块加载trace，tgz全文件hash一致；461源码验证输入冻结。
- [x] .32独立补审 deleg_28854e00 APPROVE，无阻断；完整源码门禁 proc_598e0e5a9d23 确认退出0，build/test/lint/bundle四阶段0，461输入无漂移。
- [x] .32已实际安装并重启同一EXE；257文件hash与shared唯一实体/profile junction一致。先请求正常关闭，未退出后按已批准范围精确强停；已保留256文件旧版回滚ZIP。
- [x] 真实主理恢复回合已验收：原账本新增 recovery_wake_reserved → claimed；真实native session日志记录 taskflow_status → ops_bash/读取图片核产物 → taskflow_retry → 新结果 → ops_bash核验 → taskflow_accept。fix-ui由unknown/1进入verified/2，依赖re-visual已真正派出running/1。原始业务继续执行，未伪造结果或直接改生产DB。
- [x] 原业务完整计划结束：截至2026-11-14 09:16:58只读核验，fix-ui verified/2、re-visual verified/1，总计划status=completed。真实主理native记录有第二次taskflow_accept与taskflow_finish；随后已正常进入新的taskflow_plan/dispatch。未将隔离fixture代作真实结果。
- [ ] 像素验收：新核对PID/HWND的capture返回0×0/最小化坐标，已停止桌面输入；真实回合与正式验收的证据来自只读账本、native session工具记录和群ledger，未声称看到了新像素画面。

证据：`ds-bot/.tmp-verify/recovery-principal-live-1.json`、`recovery-principal-install-1.json`、`recovery-principal-full-verification-1.json`、`recovery-principal-final-review-1.json`。当前安装运行版为0.3.32-principal-recovery.1。

## .31 的已交付证据与局限

- [x] 生产只读账本：程序开发 fix-ui 有 receipt_bound，后有 dispatch_recovered 进入 unknown；re-visual pending、attempts=0。这是一条已证实恢复阻塞，不能据此宣称所有群同根因。未改真实数据库、未自动重派。
- [x] 共用回合边界：用过工具的正式任务 completed/max-tokens 没有检查尚未提交的义务。原安装 turns 在同一 createRuntime/派工/Session事件 fixture 两项均不续执行；最小修复后续到原 exchange，提交后停止。
- [x] 新义务检查基于 open 计划、群稳定 Bot 与卡状态，区分待派工、待提交、待验收、待 finish；每阶段/attempt 最多两次续执行，达到上限保持未完成并提示阻塞。
- [x] abort/error/只读/审批等待/子任务等待不自动执行；unknown 不自动重派，恢复扫描发待核验提示并记录本次 attempt/principal 的提示标记。
- [x] 主Agent定向回归 144/144（群派工、执行者静默、follow-through、插件、续执行 helper）；精确候选3实际 SDK 依赖下 14/14。包含连续两次续执行、用户中止、持久额度、主理三阶段、普通追问无重复警告，以及 pending/unknown 发送后中断的恢复占位测试。未以模拟模型输出作为真实业务成果。
- [x] 独立候选 0.3.31-task-continuation.1，256 发布文件；仅 package.json、taskflow.js、turns.js、新 continuation.js。turns 使用准确运行基线叠一个局部块，保留原输出上限诊断，不带旧 UI 更新。
- [x] 候选3绑定审计：实际加载122个候选模块的字节与 manifest 一致，tgz全部256文件一致；5项测试/loader输入和3项开发patch donor单列，459验证输入冻结。开发整文件与发布整文件不混称同一字节。
- [x] 隔离实际 SDK 启动：state/group-rows HTTP 200，群回复 fixture 非空且匹配。这不是生产任务验收。
- [x] 候选3补审 APPROVE，无新增发现；最终进程 proc_39327cd11149 exit 0。build、npm test、lint、bundle --check 四阶段均为0；459输入无漂移，回执 continuation-full-verification-3.json 与 continuation-final-review-3.json 已生成并绑定候选。
- [x] 已安装并重启 0.3.31-task-continuation.1，实际256文件hash全部一致，保留单实体与junction。正常关闭未完全退出，随后按明确批准范围结束5个已核对进程；安装器替换前再次确认归零，255文件回滚ZIP保留。
- [x] 新程序窗口与团队/群历史载入正向像素证据；新增退出日志指向旧shell PID，不能说没有新日志，也不能将其当成新shell启动失败。真实宿主自然扫描后，SQLite recovery_attention=1，群消息账本存在1条送达不明恢复任务通知。
- [ ] 新计费模型任务的自动续执行→提交→主理验收闭环尚未真实调用，liveTaskContinuationAccepted=false。fix-ui 仍 unknown/attempt1、re-visual 仍 pending/attempt0，未自动重派或伪造完成；需先核实已有执行结果，再决定正式处置。此前旧 UI 候选明确拒绝的操作仍未重试。

证据位于 ds-bot/.tmp-verify：stalled-task-snapshot.log、taskflow-turn-continuation-baseline-red.log、continuation-interruption-candidate-2-red.log、taskflow-continuation-regression-3-final.log、continuation-candidate-3-focused.log、continuation-candidate-manifest-3.json、continuation-candidate-3-module-trace.jsonl、continuation-binding-audit-3.json。
