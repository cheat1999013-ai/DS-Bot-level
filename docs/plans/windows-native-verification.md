# DS Bot 原生 Windows 验证计划

## 当前平台决定

用户明确：主要使用 Windows；Linux 相关验证、环境补齐及 CI 路线暂时挂起，只有用户后续重新提出 Linux 需求才恢复。保留已有 Linux 脚本和历史结果，不删除、不安装 WSL、不为当前工作安装 Linux 依赖。

## 已核实的现状

- ds-bot 的自动配方缺少 start；插件需要由 DSH 宿主加载，不能作为独立 Node Web 应用启动。
- app 的自动配方被识别为 Vite，但其 start 实际运行 Electron；默认 HTTP 探测并不能代表桌面就绪。
- Hermes 支持项目级 .hermes/environment.json，已保存配方优先于自动检测。
- 当前 Hermes HTTP 就绪实现把 4xx/5xx 也视为已响应。因此新的 Windows 入口必须自行检查业务就绪，并在通过之前不开放成功探测端点。
- DSH 公开 runProfile 与 app-boot API 已用于现有桌面宿主，可作为隔离验证入口；不修改 Harness 本体。

## 当前 Windows 范围与实施顺序

1. [x] 为 ds-bot 明确项目级 Windows 源码检查配方 `.hermes/environment.json`；构建、完整 npm test、lint、生成 bundle 一致性均保留，不调用 dev/check.sh 的 Linux 路线。配方明确 `start: null`，宿主启动尚未配置；源码检查通过也不能作为启动验收。
2. [ ] 实现原生 Windows 隔离宿主启动与就绪检查，使用项目盘专用 DSH_HOME/profile 和 mock 模型；证明加载的是待测 DS Bot，而不是相邻或已安装的旧副本。
3. [ ] 验证实际宿主服务、插件客户端模块、任务流工具注册及必要 API；失败非零退出，不能用一个独立返回成功的 HTTP 页面代替真实启动。
4. [ ] 覆盖初始化失败、业务接口失败、就绪超时和正常关闭；核实测试宿主与其子进程退出。只管理本轮测试进程，不操作用户运行中的 DSH。
5. [ ] 先执行 Windows 启动专项，再执行新配方完整 hermes verify --json，保存实际退出码、各阶段与输入摘要。
6. [ ] 桌面 UI 目标区域及真实群行为分别验收。Windows 宿主/API 通过不等于主理普通回复显示已修复。

## 状态口径

- 旧 Linux 配方失败保留为历史证据，状态为挂起，不再列为当前 Windows 交付的必需依赖。
- 当前 Windows 完整配方仍待实现与实跑，不能因挂起 Linux 就改报完整验证通过。
- 既有计分更新 0.3.27-levels.1 已安装及重启、实际积分迁移和历史保值已核验；其既有通过结果继续适用，不为本次平台范围决定重跑产品测试。
- 主理普通群回复缺失仍为独立未完成项；群消息验收边界是用户消息、当前主理普通回复及正式任务卡，执行 Bot 尽量沿任务卡汇报。
