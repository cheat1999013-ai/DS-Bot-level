# DS Bot 单实体包与 D 盘手工技能目录

本轮维护已获用户授权；用户确认正常退出后执行。临时子主理／验收代理方案已放弃，不属于此范围。

- [x] 确认实际 DSH 安装进程为零，删除前脚本再次检查。
- [x] profile 中原独立 DS Bot 副本共 2933 文件，完整回滚 ZIP 的文件数、CRC 和逐文件 SHA256 校验通过。
- [x] 保留 `<DSH 桌面安装目录>\resources\app\dsh\node_modules\ds-bot`，版本 `0.3.26-taskflow.1`。253 个发布文件未变。
- [x] 删除 profile 的冗余实体包，原入口改为指向保留包的 Windows junction。公开 resolveBundleDir 和 Node profile fallback 均解析到同一实体。profile package.json 未变。
- [x] 复用已安装的 playwright-core 目录链接，保留原浏览器依赖能力。保留包所有 9 项声明依赖逐项实际 import 通过；未下载依赖。
- [x] 创建 `D:\Documents\deepseek-harness\area skill\skills`，人工技能格式为 `<技能名>\SKILL.md`。
- [x] 官方 Desktop profile 配置追加并启用宿主级 skill-filesystem；提供方名 ds-bot-manual-d，includeDefaultRoots=false，customSkillDirs 仅含该 D 盘目录，watch=true。不改变进程 DSH_HOME、Bot 数据、各 Agent preset 或已配置的 taskflowHome。
- [x] 静态核对实际安装版的 29 层可读取 bundle 配置，重现 Web 层 disabled=true 阻止仅 dshHome 覆盖生效的问题；修正为显式启用独立命名提供方。比较所有其他组合条目未变。未使用会自动迁移 manifest 的 loadProfileDirectory；未修改不可解析的既有 bundle。
- [x] 官方文件系统提供方在项目盘隔离夹具中发现目录技能并读回完整正文。隔离技能未放入正式技能库。
- [x] 重新启动原 DSH EXE，保留包 253 文件再次匹配，未发现本次启动后新增 crash/fatal/dump 文件。
- [x] 只读 Windows 句柄核查：5 个目标进程中，1 个 DSH 进程持有 1 个上述 D 盘目录监视句柄；扫描目标文件句柄 336 个。证明实际运行后端正在监视此目录。
- [x] 新窗口按实际 PID/HWND 读取获得 1280×819 截图，lq-create 会话可见；本轮没有输入或发送群消息。
- [ ] 正式手工技能正文加载：当前 D 盘目录没有手工技能，不编造正式技能或模型调用记录。用户放入技能后，可按真实技能工具调用核验。该待验不否定目录配置与实际监视已生效。

## 证据

项目 ds-bot/.tmp-verify/ 下：

- ds-bot-single-copy-applied.json
- ds-bot-profile-full-before-single-copy.zip（完整副本回滚归档，非第二份已安装包）
- manual-skills-d-drive-active-applied.json
- single-package-and-d-skills-delivery.json
- consolidate-ds-bot-copy.py
- activate-manual-skills-d-drive.mjs
- manual-skill-directory-handles.ps1

第一次仅改 dshHome 的配置未激活 Web 宿主提供方，已由本轮显式启用的配置取代；不要使用旧 candidateOnly 或 pending restart 回执描述当前状态。本轮没有修改产品源码，沿用既有产品门禁，不重复运行未变的完整测试。API 只读尝试返回 401 后停止，未提取或复制凭据。
