# 执行 Bot 按计划完成晋级 Implementation Plan

> 执行方式：主 Agent 内联实现、验证与最终验收，子 Agent 仅辅助审查。

**Goal:** 按用户指定，执行 Bot 普通升优良阶段每个成功完成计划 +0.1，优良升精品阶段每个成功完成计划 +0.01。
**Architecture:** 在既有调度器 finishPlan 事务中按群、计划、执行 Bot 去重奖励。bot_rewards 增加整数百分级 points，旧记录保留每条 10 points；等级由 SUM(points)/100 得出，避免浮点累加与历史降级。
**Tech Stack:** JavaScript / Node SQLite / 现有 DS Bot 原生工具与任务流组件。

## 已确定范围

- 现有门槛不改：普通 <16、优良 >=16 且 <27、精品 >=27；精品后继续沿用 +0.01。
- 整个计划通过 finishPlan 的可信快照与验收后才奖励；单卡验收、失败、取消、未完成计划不产生新奖励。
- 同一执行 Bot 在一个计划承担多张卡只计一次；主理不因管理身份获奖，未参与执行的成员不获奖。
- 老记录每条保留原 +0.1，不追溯按新规则重算；已计分旧计划不重复奖励。只读旧库不迁移。
- 客户端显示两位小数并更新提示、工具描述、模型指引及相关现行计划。
- 保留主理普通群回复缺失修复为独立未完成项；本变更不将其标为已解决。

## 实施与验收

1. [x] 先加入并运行失败回归：完成时机、同计划多卡、16/27 门槛、0.01 显示、取消、历史保值、只读与重启。补充已打开旧只读连接在写入者迁移后持续读取的回归，先红后绿。
2. [x] 修改 scheduler.js 的 schema/migration、finishPlan 和 botLevel，移除 acceptResult 的奖励写入。
3. [x] 同步客户端等级精度、工具描述、技能指引及现行规划。
4. [x] 运行新回归、既有 scheduler/plugin/panel、lint/build/client check，完整 npm test 退出 0：2073 通过、3 跳过、0 失败，12 份原生汇总、444 输入无漂移；完整 wrapper 既有环境阻塞单列。
5. [x] 基于准确已安装单实体包制作最小候选，保留运行版较新能力；候选 0.3.27-levels.1 仅改 7 个发布文件，66 项候选回归通过，253 个压缩包文件逐项匹配，回滚包同数校验通过，不覆盖整棵源码树。
6. [x] 安装前确认目标进程归零，实际替换唯一实体包并核对 253 文件、profile junction；启动原 DSH，取得 lq-create 有效窗口截图。实际积分列已由宿主迁移，26 条原奖励及其总积分摘要未变，两库 integrity=ok。
7. [ ] 等待真实新计划自然完成的奖励与等级标签验收；不为制造验收数据创建计划、群消息或计费调用。两位小数与各阶段递增已有候选回归，不替代本项。

## 当前验证边界

- 构建、lint、client --check 与伴随 app 10 项契约通过；现有 lint 警告保留，本轮测试引入的警告已消除。
- 首次完整测试因诊断报告断言不接受预发布版本失败；改为校验真实包版本，20 项诊断回归通过。更新冻结输入后的新完整测试 proc_c777b5d06e45 已退出 0，日志 levels-full-test-final.log；完整汇总与源摘要核验见 levels-full-verification.json。
- 独立初审唯一阻塞是旧只读实例缓存计分列；主 Agent 已先红后修、移除缓存，源码与候选均确认使用实时 schema 检查。初审 REQUEST_CHANGES 与修复证据保存在 levels-independent-review-initial.json；补充复审 deleg_7d5bfeb5 已返回 APPROVE、findings=[]，回执 levels-independent-review.json；范围为静态复审，不是部署验证。
- 当前 hermes verify 检测无 start/readiness 命令；check 的 Linux bench 依赖 pnpm、setsid、xvfb-run、Xvfb 均缺失，默认 checkout 位置也不存在。完整 wrapper 未验证，不以直接单元门禁替代。
- 正式单实体包已安装 0.3.27-levels.1 并重启，实际账本迁移与保值已核验；真实新计划奖励及等级标签尚未验收。主理普通群回复缺失仍是独立未解决项。详情见 ds-bot/.tmp-verify/levels-delivery-status.json。
