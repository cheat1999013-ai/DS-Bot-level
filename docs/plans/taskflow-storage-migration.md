# 任务流技能、心得数据目录迁移

## 本轮范围

用户选择新增程序配置，直接使用 `D:\Documents\deepseek-harness\area skill`，不使用目录链接。仅改变当前 DSH Desktop 的任务流数据目录，不改变整个 DSH_HOME 或 Bot 身份、会话和账号存储。

## 实现与验收

- [x] 为 DS Bot `createRuntime` 增加独立 `taskflowHome` 配置，未配置保留原默认值；显式配置无效时拒绝启动，不静默回退 C 盘。
- [x] 验证默认目录、含空格的绝对路径、相对/空白路径拒绝，以及真实运行时协调库、知识库和导出文件使用同一配置目录（隔离真实 createRuntime／两个 SQLite 与导出文件的重启回归）。
- [x] 通过现有官方 profile 配置持久化机制设置当前 Desktop，官方 SDK 组合有效配置读回准确字段；不修改 DSH 源码。
- [x] DS Bot 和伴随 app 版本为 0.3.19；首轮完整单元门禁 1978 通过、3 跳过、0 失败，后续目录保护修复后的最终门禁见下一项；安装专项 11 项、构建、lint、app 版本契约通过，安装包 128 个文件已逐一匹配。
- [x] 独立审查发现 TS-001 至 TS-004 后全部先红后绿修复；闭环报告 `taskflow-storage-0.3.19-review-closure.json` 无阻塞。最终完整单元门禁 1979 通过、3 跳过、0 失败，407 输入无漂移；增加目录保护后 build/lint 再通过。
- [x] 停止已识别的 DSH 进程后复制现有数据，5 个持久文件摘要和两库完整性、schema/全表行内容摘要相同，原数据归档到 D 盘项目备份；目标路径非空会拒绝覆盖。迁移时持有源文件禁止写入句柄直到归档完成。
- [x] 安装并两次启动后核实新配置、两次新的实际 DSH 后端均打开 D 盘两个账本、心得文件仍可读取且摘要不变，旧默认目录不重建；不创建虚构技能或心得。两次实时快照与迁前全表内容一致，均检查两库 integrity=ok，无新增 crash 文件。

## 路径

- 现有数据：`%USERPROFILE%\.dsh\plugin-data\hermes-bot-taskflow`
- 用户指定新目录：`D:\Documents\deepseek-harness\area skill`
- 新目录内继续使用 `coordination.sqlite`、`knowledge.sqlite`、`library\groups`、`library\shared` 的现有布局。
- 用户指定目标目录已检查为空，无目录链接。

## 证据边界

源码/隔离测试、正式安装、配置持久化、实际数据目录生效分别验收。已知完整 smoke/web/desktop 配方缺 Harness 源码及启动/readiness 命令，不将直接单元门禁冒充完整配方通过。测试和迁移探针位于项目 D 盘目录，不向真实群发送消息或调用模型。

当前已实装 0.3.19，128 个发布文件核对匹配；原 0.3.18 插件包 2760 文件已备份。真实数据已迁至指定 D 盘目录；首次启动实际 DSH 后端已同时占用新目录两个账本，原 C 盘默认目录不存在，两库全表内容及 library 文件摘要与迁前一致，见 `taskflow-storage-live-first.json`。官方 SDK 组合确认有效 bot 配置只有 taskflowHome；写入时保留旧补丁字节，宿主运行后文件字节曾变化，原始前缀摘要不再相同，该差异单独记录，不以整份文件字节不变代替有效配置验证。

隔离 Node 配置脚本验证 7 项、Python 数据迁移验证 6 项通过（含真实源文件写入拒绝、EXDEV 跨盘归档分支、安装根外占用者检测）；这些属于临时脚本验证，不计入正式 1979 项。最后两个 Node 路径负例为单独调用，之前 5 项函数未变。

原始数据备份：`.tmp-verify/taskflow-storage-original-20261111-014431-727975`。迁移、配置、两次实机及最终凭据分别为 `taskflow-storage-migration-receipt.json`、`taskflow-storage-profile-receipt.json`、`taskflow-storage-live-first.json`、`taskflow-storage-live-restart.json`、`taskflow-storage-installed-0.3.19.json`。第二次退出曾超时，精确核实并停止原进程树、再次读回为空后才启动；已完成第二次读取确认。

Windows Restart Manager 的只读资源查询分别确认迁前 C 盘和迁后两次启动 D 盘两个账本的实际 DSH 后端占用，而非仅看配置字符串或文件存在。实际配置使用 `desktop/cordis.patch.yml` 的 `bot.config.taskflowHome`，准确保持用户提供的路径和空格。当前有 1 份真实心得、0 个晋升技能；心得位于新目录 `library/groups/ed9c65d6b18e62777ef0808c/insights/d9fd5dc430ece794dd7e2e1c/INSIGHT.md`。
