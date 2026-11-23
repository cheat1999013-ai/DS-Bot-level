# 群消息误显示为执行请求

范围：lq-create 群 09:09 的 lq-operation 普通汇报显示为宿主“收到执行请求”，内部 `[Group post from …]` 暴露。恢复消息卡片，不合并暂停的“一 Bot 一套 UI”候选。

- [x] 真实只读证据：群消息 seq 1171、原始 Session user/message seq 5726；source=bot/relay/post，同群、具名 sender，纯文本、无正式任务事件。
- [x] 原因：安装版 SDK 使用 `conversation.chat.node` 的 `turn-trigger`，旧 DS Bot 接线仅覆盖 user/steering。
- [x] 修复：接管 turn-trigger 的已存在公共 slot；可信同群 Bot 文本显示原卡片样式、Bot 名称/群内汇报/时间/Markdown；正式任务保留编号、路由与提报状态。普通用户、外部插件、跨群或含附件消息保留 native fallback。
- [x] 原生 user slot 所有权、locale、原 inject 和非目标 trigger fallback 保持；无 Host/发送/账本改动。
- [x] 新回归先红后绿；源码任务消息与精确候选各10/10。关联回归真实文件为 user-bubble.test.js、view-reply.test.js、group-reply-projection.test.mjs，另单独通过。原误写不存在的两个文件未提供关联覆盖，不作为证据。
- [x] 实际候选组件的440/1000宽隐藏渲染：两卡分别Bot汇报1/正式任务1，无rawheader、overflow、fallback或console错误；中文截图核对通过。预览wrapper曾超时，报告及截图完整且其dev Electron进程归零，不称wrapper退出0。
- [x] .33候选从已安装.32的257个文件按hash拼接，仅client.js/package.json/i18n.js/task-inputs.js/task-message.js变更；原多语言和其他运行增量保留。tgz全文件hash及回滚ZIP已核对。
- [x] 独立审查 deleg_f18379e6 APPROVE，零阻断，绑定manifest SHA256 91687c9f1428a3349358191ec2ae035ce600487390e44743c5359be492fbcf56。
- [x] 冻结462个输入的完整Windows源码门禁 proc_21fc0ad19826：build/test/lint/bundle-check四阶段退出0，无输入漂移。
- [x] 安装后按提醒补跑 proc_215bf1222e6d：完整四阶段退出0；重新读取实际安装0.3.33，257文件无hash差异，重启后无新增crash日志。readiness仍为null，真实窗口依旧Loading plugins，不能将此门禁计作业务启动通过。
- [x] 已授权安装0.3.33-group-post-cards.1；257文件逐项hash匹配，profile junction同一实体，回滚ZIP已验证。正常关闭后采用授权范围内精确强停；停止脚本即时检查失败后，新枚举确认目标进程为零，再执行安装。
- [x] 重启同一EXE，主进程16796/窗口10227152；新窗口可抓取，但目前仍为Loading plugins。
- [ ] 实际加载新client并核对截图所指的历史消息卡片；不把加载页或安装hash当作真实消息验收。

本节为.33群汇报样式修复的历史记录；当前安装版本已更新为下节的0.3.34-empty-post-guard.1。.33启动初期的Loading plugins后来已过去，并通过真实lq-create截图确认群汇报卡生效。crash-2026-11-14T02-44-45-368Z-host.log发生于停止旧程序期间，不能当作.33新启动崩溃。当前实现、独立渲染、实际安装和真实窗口验收分别登记，不互相代替。

## 10:47 空白群汇报卡后续修复

- [x] 用户新截图指向 lq-create 10:47 的 lq-operation 空白汇报。原生只读 user/message seq5972/time1794624420969，唯一text恰为 `[Group post from lq-operation]\n`；去转发头后无正文，无正式taskflowEvent。
- [x] 使用真实SlotCore turn-trigger路径和原始文本先红；新增空白/CRLF/空数组、保留非空缩进、正式任务及仅附件fallback覆盖，源码与精确候选11/11绿。
- [x] 最小修复仅普通同群Bot纯文本分支：去转发头后 `text.trim()` 为空则不生成卡片；原始记录保留，正式任务身份与附件原生呈现保持。
- [x] .34-empty-post-guard.1候选来自当前安装.33，257文件，仅client.js/package.json/src/client/task-message.js三项改变；tgz与回滚全hash通过。
- [x] 实际候选组件440/1000宽预览：三条输入仅生成有正文群汇报1/正式结果1，10:47空消息无卡，无横向溢出/原始header/console错误，预览wrapper退出0。
- [x] 新鲜抓取真实窗口已进入lq-create，可见.33群汇报及原空卡；此前Loading plugins已过去。当前消息空卡修复尚未安装。
- [x] 独立静态审查 deleg_5faf44fa 首轮按上游描述认可逻辑；实际候选补审以deleg_b2e3ec1b为准。
- [x] 当前.34完整Windows门禁 proc_f8b67b5f00b4 退出0，463冻结输入无漂移，build/test/lint/bundle-check四阶段通过；readiness=null不作运行验收。
- [x] 候选文件补审 deleg_b2e3ec1b APPROVE，实际读取候选/旧基线/测试/stage/构建产物；主Agent独立核对全部257个文件hash及精确三文件diff，manifest绑定1830ad690561e3e1b43952dba96e0f582e06f99fc8974616d97ddca5b568c5c0。
- [x] 收尾全门禁proc_d1f64b5f91f5退出0，四阶段通过，463输入无漂移；无重复运行中的gate。
- [x] 2026-11-14 11:27实际安装.34并重启同EXE。正常关闭未退出后，已授权精确强停5个已核对进程、确认0进程再换包；257个安装文件hash及单实体junction回读通过，回滚ZIP已验证。
- [ ] 原10:47历史消息现场复核：新PID13620/HWND4131848的新鲜capture为0×0且最小化坐标，已停止桌面输入。installedMessageCardAccepted=false/pixelCaptureAccepted=false；不得将安装完成写成现场已验收。

证据：ds-bot/.tmp-verify/empty-group-post-manifest-1.json、empty-group-post-red-1.log、empty-group-post-focused-1.log、empty-group-post-candidate-focused-1.log、empty-group-post-preview-report.json、empty-group-post-preflight-1.json。

证据：ds-bot/.tmp-verify/group-post-manifest-1.json、group-post-candidate-focused-1.log、group-post-adjacent-regression-1.log、group-post-preview-report.json、group-post-preflight-1.json、group-post-final-review-1.json。
