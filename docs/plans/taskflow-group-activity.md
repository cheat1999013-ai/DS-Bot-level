# 群内新派工与执行 Bot 进入任务流看板（候选 0.3.24）

## 当前问题与证据

用户确认问题发生在 lq-create。首次只读核对显示：主理 Bot 在群内直接 @ 执行 Bot 的巡检任务有真实派工和回复，但协调账本只保存了后续正式写稿计划及另一份旧计划。原有 taskflow-state 仅投影正式计划、卡和账本事件；普通派工与其他执行 Bot 不进入看板数据源。首次诊断正式写稿卡为 unknown，最新只读回放已读到 verified；不能沿用旧状态判断，更不能当作未发送自动重派。

- [x] 按群隔离核对真实群消息、协调账本和当前计划指针；只读诊断，不发送群消息、不运行计费模型。
- [x] 经真实 rt.taskflowView 写出最小回归：已有正式 Writer 计划时，主理直接 @ Scout 的新派工也必须可见。taskflow-group-activity-red.log 显示此断言失败，非环境导入失败。
- [x] 在只读投影增加 observedTasks，展示有明确派工原文、稳定执行 Bot 和源消息序号的群内任务；保留正式计划/卡/验收状态及指针，不伪造正式计划或将回复视为验收通过，不向真实协调库补写臆测任务。
- [x] 在现有任务摘要与时间线结构内展示群内派工来源、执行 Bot 与真实可用状态；无可信时间时明确未记录，不能用页面轮询时间冒充派工时间。排除已登记的任务流派工重复项，隔离群组，保留主理、头像、模型和原有视觉骨架。隔离真实组件440/760px渲染通过，不等于正式窗口验收。
- [x] 同scope乱序回归确认旧响应可覆盖新响应（taskflow-poll-race-red.log，old !== new），已加入generation同时保护成功与错误；与本次真实漏派工根因分别记录。
- [x] 覆盖主理派工、普通闲聊/自我介绍排除、失效成员、多个 @、已有正式卡不重复、只读宿主、重载与群切换；完整npm test为2020 pass/3 skipped/0 fail，新异步文件在cleanExit中且关键末尾用例确实出现；构建、lint、6项app包契约、真实组件渲染及独立审查闭环通过。hermes完整wrapper仍未通过，环境阻塞单列。
- [ ] 同步插件/app/locks 为 0.3.24，备份并部署，核对包和安装字节；通过正式只读数据链验证新派工/新 Bot 进入看板。真实窗口交互若捕获0×0则停止输入并保持对应验收未完成。

## 范围

当前证据：taskflow-activity-focused-green.log 为24 pass/0 fail，后续补主理离群/记录失效回归并纳入完整配方；8份规范reporter汇总为2020 pass/3 skipped/0 fail，关键新增用例全部存在。taskflow-activity-review-closure.json 为pass/0 blockers、GA-001关闭。taskflow-activity-render.json 为真实DashboardView的隔离示例，正文一份、同次派发事件一条、宽窄无横向溢出、焦点展开不重复正文。taskflow-activity-live-replay.json 为真实rt.taskflowView只读数据回放：正式卡1张（verified），群内派工2项（源序号137/189），额外执行者1位。原始日志仅保留最近60条（本次132–191），无窗口外补写。源码及插件/app/locks已提升0.3.24，130个包文件与源码匹配，2761个旧版备份文件校验通过，428项验证输入无漂移；正式安装仍0.3.23，部署与正式窗口验收待完成。

完整配方taskflow-activity-canonical-verify.json：bootstrap/build/npm test通过；npm run check内部unit/build/lint通过，smoke/web/desktop在前置检查即失败，readiness=null。实际Harness源码<本地 DSH 源码检出>存在，当前脚本发现路径及Windows/MSYS git参数路径不匹配；源码根无法解析tsx/cli，当前PATH无pnpm/setsid/xvfb-run。未改Harness本体、未启动WSL、未以fixture或直接测试替代boot/readiness。验证结果与失败日志已读，见taskflow-activity-verification.json。

新增截图缺陷：draft-dots 同一次执行的 card_claimed/receipt_bound 在时间线重复展开全文。仅将同一群、同一计划、同一卡且无中间状态事件的这两个阶段合为一个展示项；原始事件和不同重试保留。任务正文只在摘要展示，历史事件通过任务标识的 title 保留原文查询入口，失败原因继续可见；摘要展开不再重复正文。

群内派工仅从现存群日志作只读投影：需要当前主理稳定 botId、当前有效成员的显式 @ 和明确行动动词；引用、代码、普通问候、否定派工、正式 Taskflow 消息排除。当前日志保留窗口外的历史不猜测补齐，缺少稳定序号或时间分别不纳入或标未记录；回复只表示观察到该成员后续发言。按源群/序号/成员稳定定位，不向正式账本建卡或自动派发。

主 Agent 负责主线修改、测试和最终验收；子 Agent 只做独立源码诊断和审查。保留现有侧栏分类、任务流验收、心得、等级、技能五天评分及精品保护。用户当前授权包含修复和必要读取，不包含为制造验收而另发群消息、重派 unknown 卡或调用真实计费模型。完整 hermes verify 的既有源码依赖/平台前置条件阻塞单列，不用直接测试替代其 boot/readiness 结论。
