# 技能调用与群回复缺失修复

## 当前有效阶段：独立群回复节点

- 运行包保持 `0.3.27-levels.1`，本轮尚未替换。以下旧版安装/测试记录属于历史，不作为当前待办。
- 真实目标仍为 `lq-create` 的 turn 343/344：账本 seq 684/686 有普通主理正文，relay 成功且未被隐藏回合规则过滤。
- 实际安装 SDK 的只读会话投影回放中，两个 relay 都成为 process group 内的 tool-call；collapsed 策略会请求隐藏其 body。直接叶组件与 ToolCell 父夹具通过，不能把此前“父 shadow 必为根因”审查当成实测结论。
- 本轮通过公开 Conversation event registry 生成 `ds-bot-group-reply` 独立 exchange 节点，沿原 groupRows/气泡组件读取；启用后旧 ToolCell/native leaf 不重复绘制。覆盖直接调用、PTC 子调用和只有完成事件的 PTC。
- [x] 新原生投影回归先红（独立回复节点为 0），修复后开发/安装 SDK 验证通过。
- [x] 候选 `0.3.28-replies.1` 基于精确运行包，254 个发布文件，只有 client.js/package.json/三个 client 源文件变化；全部 Host 保留。实际 tgz 与候选逐文件 SHA256 一致。
- [x] 候选投影/渲染 17 项通过；app 契约 10 项通过；源码 build、lint（警告保留）、client check 通过。
- [x] 隐藏隔离 Electron 实际组件预览：900/440 宽度均为用户消息 1、正式卡 1、可见主理普通回复 2、读取 2、无横向溢出。此为明确示例，非真实群验收。
- [x] 最终完整 Windows 源码配方 `hermes verify --json --timeout 1800` 退出 0：build、完整 npm test、lint、bundle check 全部通过；451 个冻结输入无漂移，readiness=null，未证明宿主启动。
- [ ] 当前最终候选完整审查（deleg_4ecc6b87）回传及逐项处理。上轮 deleg_d1bb30e0 已完成并 APPROVE，但恢复的正文截断且早于 PTC 增量，保留为历史审查、不当作本候选最终批准；此前静态父 shadow 结论同样不能替代本增量审查。
- [ ] 正常退出后安装、逐文件核对、新客户端模块加载及同一群窗口的真实回复显示验收。
- 技能强制加载模块仍未进入运行包；本轮群显示修复不夹带该尚待交付的 Host 改动。Windows 宿主启动/readiness 完整配方仍另列未完成。

## 范围与已确认事实

- 当前 `lq-create` 的主理为 `lq-operation`。截图对应的回复已生成且存于群组账本；不能归因为未生成或丢失。
- 运行版 `group_relay` 返回 `{from, anchor}`，通过 `group-rows` 获取异步正文；运行版客户端已经支持这个协议。定位之初工作树仍是旧的内嵌 `replies` 协议，当时同为 0.3.25 的两份代码有 117 个源文件不同；后续已补客户端兼容，但仍禁止直接以整个工作树覆盖运行包。
- 截图中的普通工具卡说明 DS Bot 的 ToolCell 未成为该处的有效渲染器。还需取得窗口实际的注册/弃权/模块身份；不能以旧工作树游标回归冒充实机根因闭环。
- 已分配技能已进入相关 Bot 目录；这不等于加载正文。保留的单聊中有成功加载，相关群会话未加载那些内容技能。

## 用户选择的技能规则

用户明确选择：**按任务选择相关技能，但必须先加载相关技能再执行**。

采用真实的 `prepare_bot_skills` 选择/加载工具：只接受该 Bot 当前分配、当前作用域可见的精确技能名；可声明没有适用技能并给出原因。通过原生 SkillRegistry 加载正文，保留真实工具调用，不伪造原生 `skill` 记录。选择后的正文进入 required PromptContext。任务工具执行与正式提交在完成选择/加载之前拒绝；同一步 PTC 程序不能在返回正文让模型读取之前顺带执行任务动作。新回合、工作输入改变、分配或正文改变使旧选择失效。不自动加载全部技能，不创建额外的计费选择模型调用。

## 验收

- [x] 原版回归证明：仅分配技能仍放行任务动作（`assigned-skills-red.log`）。
- [ ] 任务技能选择、真实正文加载、执行前门禁、同一步组合调用、无适用原因、作用域与变更失效回归。
- [x] 旧客户端游标回归先红，隔离副本读取并接收主理正文后转绿（ad-hoc；不代表运行窗口）。
- [ ] 活动客户端 ToolCell 注册/弃权/缓存身份核验及对应最小修复。
- [ ] 群消息实际渲染验收；未经授权不向真实群发送测试消息或调用计费模型。
- [ ] 以正确运行源码基线制作版本不同的新候选，保留现有较新群账本能力及尚未发布的群定时改动。

## 已有验证的适用边界

`skill-diagnostic-canonical-verify.json`：bootstrap/build/npm test 通过，嵌套 check 的 unit/build/lint 通过；smoke/web/desktop 在 checkout 发现阶段失败，readiness 为 null，440 输入在退出后未变。它不覆盖本计划之后的新增技能门禁与隔离 UI 修改。此前单 Bot 定时卡开关、临时主理代理仍是待实现需求；没有标为完成。

## 当前优先：主理普通回复与任务卡同时显示

用户再次纠正的验收边界：群组日常可见内容是**用户消息 + 当前管理员／主理人 Bot 的普通回复 + 正式任务卡**。其他执行 Bot 的任务派发、进展、结果及心得尽量沿正式任务卡向当前主理汇报，不扩成所有 Bot 在群里普通聊天。执行者的任务静默逻辑不能误伤主理正文，也不能把主理的沟通回复全部变成任务卡。本轮修复目标仅为恢复主理普通回复，并保留用户消息与现有任务卡；不批量删除或改写旧消息。

- 用户再次明确：问题是主理人在群里没有普通回复，只剩任务卡；停止继续操作开发者工具。
- 新截图对应 relay 从 seq 386 开始，seq 387 是主理 `lq-operation` 的 260 字普通回复，`session=false`；真实主理没有执行者静音标记。证据：`current-principal-replies-evidence.json`，只读，无消息或模型调用。
- [x] 原生 `tool.call.toolview` 的 `group_relay` 回归先红，证明没有该定向回复视图时只剩通用工具卡。
- [x] 在公开工具子视图注册回复组件，保留原生 ToolCallTree owner/children；与旧 Bot ToolCell 共用气泡，随 Agent/plain 会话撤销。
- [x] 开放账本范围在 `active=false` 时继续读取晚到回复；读取失败可见并重试，切换游标隔离旧内容，保留旧 inline 记录。
- [x] 从运行包 252 个静态文件创建 `0.3.26-principal.1` 候选，仅三个 client 源文件、生成 client 与 package 元数据变化；全部 Host 文件原样保留。主线尚未发布的其他改动不用于覆盖运行包。
- [x] 候选 6 项定向回归通过；安装版 SDK 的实际 ToolCallTree 在隐藏隔离 Electron 中从 0 条普通回复变为 1 条，任务卡仍为 1 张；900/440 宽度无横向溢出。API 和文字均为显式示例，不是真实群验收。
- [ ] 独立审查与关联门禁完成；默认审查失败不视为通过。
- [ ] 正常退出确认、备份、替换和逐文件核对；当前仅候选，未修改运行包。
- [ ] 同一实际群聊窗口显示历史普通主理正文与任务卡；不得用隔离截图或落盘证据代替。

## 最新验证、包与部署预检

- 主树关联 80 项回归、build、lint 和 client check 已通过；候选 6 项定向回归及安装版 SDK 隐藏预览的适用边界仍按上节记录。
- 首次新全量在工作目录夹具中失败：新增技能监听器后，测试按最后一个 `agent/pre-step` 取错了回调。为现有 parts 回调命名 `checkBotPart`，四份相关夹具改为按名称选择并断言存在；该组 136 项通过、1 项 Windows 条件跳过。
- 随后的完整 `npm test` 已结束，11 份原生汇总合计 1936 项：1932 通过、1 失败、3 跳过，退出码 1。剩余失败是定时任务权限夹具按首个 `tools/pre-execute` 取错了回调。为原保护回调命名 `checkOwnSchedules` 并修正该夹具后，整份 schedules 文件 7 项通过，lint 通过。两处回调仅命名，保护逻辑未改。
- 全量后仅 `src/host/schedules.js` 和 `test/schedules.test.js` 的冻结摘要变化；已保存 `principal-full-delta-evidence.json`。保留其他未变部分的证据，**尚未声称最后修改后的完整 npm test 退出 0，也未声称 canonical/readiness 通过**。这些主树夹具修复没有写入客户端候选的 Host。
- [x] 实际生成 `ds-bot-0.3.26-principal.1.tgz`，不是 dry-run。包内 253 个文件与候选逐文件 SHA256 完全一致，包版本正确；见 `principal-candidate-package-verified.json`。
- 公开 SDK `resolveBundleDir` 命中共享安装包；profile 的 Node 解析命中另一份实体副本。profile 的 `link:` 声明不等于目录 junction；两处现有 252 个发布文件均与冻结的运行基线完全一致。
- [x] 为两份副本分别制作并校验 252 个现有发布文件的回滚 ZIP；包括全部将被替换的旧文件，依赖目录不替换。最初全目录备份预检超时，确认脚本已结束后改用发布文件范围；旧归档保留，不用于此次回滚。
- 预检 `principal-native-stage.json`：两处各改变同样的 6 个文件（3 个 client 源文件、client.js、package.json、新增 build 脚本），Host 不变；5 个目标安装进程仍在运行，`installed=false`。未正常退出、未替换文件、未重启。
- 独立审查通过备用审查通道重新发起，要求直接返回完整 JSON；未收到结论前不标通过。后续仍需独立审查闭环、正常退出授权与零进程确认、安装逐文件核验，以及真实 `lq-create` 窗口验收。
