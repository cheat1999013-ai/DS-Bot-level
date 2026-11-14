# 团队就绪与群回复恢复

当前范围：修复已安装 DS Bot 启动未就绪、群回复读取失败；保留群内审批卡、实际技能展示和主理普通回复修复。模型限流独立处理，不通过额外计费调用制造验收。

- [x] 在原安装 SDK 的隔离宿主中复现：`skill-index.js` 直接访问未声明注入的 `ctx.webServer` 抛错，Bot 插件未激活；正常隔离浏览器认证后 `state` 实际返回 404。宿主窗口可打开不代表 Bot 业务就绪。
- [x] 最小修复：使用公开 `ctx.get('webServer')` 查询可选服务，避免未注入 getter；工具与路由权限守卫保持。收纳运行版模块及接线到源码，避免只改安装目录。
- [x] 保护 getter 回归先红后绿：可选服务有/无两种场景均安装成功，四工具保留；源码安装/插件关联测试与 lint 通过。
- [x] 实际 SDK + HTTP 非空群回复验收：`state` 200/ok，隔离 fixture 群账本的主理回复经 `group-rows` 200/ok 完整返回（1 行）。隔离 fixture 不是真实群发送或真实业务验收。
- [x] 候选 `readiness-candidate-1` 为精确当前运行基线叠最小增量，版本 `0.3.29-group-controls.2`，255 发布文件，变更仅 package.json、src/host/skill-index.js。
- [x] 独立补审 `deleg_d1f410a4` APPROVE，无阻断；完整源码门禁 `proc_514ffb28b9f0` 退出 0、ok=true，build/test/lint/bundle 全通过，456 冻结输入无漂移，末段 taskflow suite 149/149。
- [x] 目标进程归零后安装 `0.3.29-group-controls.2`；255 发布文件逐哈希一致，profile junction 同一实体，旧版回滚 ZIP 校验通过。原 EXE 重启，新主进程 27408，无新增 crash log。
- [x] 实机团队列表恢复 Chief 与三个群组，启动失败提示在展开窗口截图中消失；`lq-create` 历史普通回复与任务卡真实载入。用户手动切换“程序开发”后，原生树确认该群标题、Chief 普通回复及六个任务派发/结果标签，提供内容已加载的正向证据。
- [ ] “程序开发”完整像素验收：用户切群后的新捕获为 0×0/最小化，按桌面边界停止输入；不以有界 AX 树的缺项证明全部错误消失。此前后台点击未切换，未重复强行输入。旧的模型限流历史仍可见，本轮未发送群消息、计费请求或重试模型，不声称限流已修复。
- [ ] 群内审批和技能栏的现场动作验收仍独立保留，当前修复不改相关客户端字节。

交付记录：`ds-bot/.tmp-verify/readiness-delivery-status.json`。

证据：`ds-bot/.tmp-verify/readiness-host-red.log`、`readiness-host-green.log`、`readiness-host-nonempty.log`、`readiness-source-focused-final.log`、`readiness-final-inputs.json`。隔离数据和临时脚本在项目 D 盘；不读取真实认证信息，不写真实群消息、任务或数据库来制造验证数据。
