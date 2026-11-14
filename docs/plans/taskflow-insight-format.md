# 心得四段式 Implementation Plan

**Goal:** 将执行者心得及主理合并心得统一为用户指定的四段式，并保留历史原文及当前 D 盘数据配置。
**Architecture:** 沿用现有 text 字段和 Markdown 展示/导出；工具参数描述及正式 taskflow 指引给出同一格式，TaskflowService 在任何心得写入及合并暂存之前检查四段顺序和非空正文。旧数据库不做内容迁移，历史检索原样返回。
**Tech Stack:** Node.js、现有 SQLite Scheduler/Knowledge、DSH 工具注册与技能指引。

## 约定

依次使用以下四个 Markdown 二级标题：

1. 做了什么
2. 为什么这么做
3. 里面的错误怎么避免
4. 要在下次任务中做的更好我需要什么

第一段写实际操作、结果及依据；第二段写选择原因；第三段写实际错误、成因和可执行预防措施，未发现错误时如实说明并写检查点；第四段写下次需要的信息、工具、权限、技能或流程支持及取得方式，没有新增需求时写可复用步骤。不得编造错误、证据或需求。四段均不能为空，缺段、重复或错序在写入前拒绝。合并按这四段分别去重，不混淆不同执行者的事实和需求。

## 执行步骤与接受条件

- [x] 新增 insight-format.test.mjs 先观察旧实现接受不完整心得和合并的预期失败，再验证缺段/空段/重复/错序拒绝；无笔记、事件、来源暂存、长期知识或草稿消费副作用。
- [x] 修改 tools.js 的两项工具描述、text 参数指引及服务入口校验；修改 src/host/skills/taskflow/SKILL.md 指引。真实 DSH 请求装配回归确认四段模板进入正式上下文。
- [x] 验证新心得完整经过 note→consolidate→数据库→INSIGHT.md；恢复、归档后正文保留四段。隐藏关键词和来源文本不丢失，历史非四段原文仍可读取。5 个相关文件共 27 项专项通过。
- [x] 同步插件及伴随 app 版本 0.3.20、锁文件和文档；构建/lint、app 版本契约通过。最终完整单元门禁 1983 通过、3 跳过、0 失败；408 个输入无漂移。独立复审 insight-format-0.3.20-review.json 无阻塞。
- [x] 备份并实装 0.3.20 到当前 DSH，128 个发布文件核验一致；已安装模块的真实 note/consolidate/导出、工具参数和知识上下文在项目盘隔离账本中验证通过。实际 Desktop 已重启，官方 SDK 读回 taskflowHome 仍为 D:\Documents\deepseek-harness\area skill；历史心得和 library 摘要未变、两库 integrity=ok，无新增崩溃文件。

## 边界

不新增心得页面、不改变既有 UI 骨架、不重写历史真实心得、不产生测试群消息或计费调用。上一轮0.3.19完整 verify 尚未返回最终回执时因新需求更改输入而停止，记录为中断，不能当作通过。既有 smoke/web/desktop 缺 Harness 源码及启动/readiness 前置保留未通过，不重复运行未变的阻塞配方来制造进度。

## 安装及备份凭据

- 最终单元日志：`.tmp-verify/insight-format-0.3.20-full.log`，摘要基线 `.tmp-verify/insight-format-0.3.20-inputs.json`。
- 安装文件及真实数据只读核验：`.tmp-verify/insight-format-installed-0.3.20.json`。
- 已安装发布模块隔离行为核验：`.tmp-verify/insight-format-installed-isolated-0.3.20.json`；此证据不等于真实群 Bot 已调用写心得，真实群未发送测试消息、未提交新心得，skill_loads 仍为 0。
- 原 0.3.19 插件备份：`.tmp-verify/ds-bot-0.3.19-dsh-app-verified.zip`，2760 文件逐一校验；之前超时产生的不完整 zip 未使用、未删除。
- 两库一致备份：`.tmp-verify/taskflow-data-before-0.3.20-20261111-104914`，两库完整性通过。
- 退出脚本曾报告未停止；随后重新发现精确安装根下进程集合为空，安装器也独立确认 0 进程后才替换文件。未将停止请求回执当作退出成功。
