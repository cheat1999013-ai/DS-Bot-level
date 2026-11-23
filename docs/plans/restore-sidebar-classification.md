# 恢复原生侧栏群组分类（0.3.23）

## 当前范围

用户要求恢复丢失的 DS Bot 群组分类。真实原实现位于相关旧插件 `patches/client-edits.mjs`，其最终有效侧栏契约为原生 TeamSidebar 自动分段；`bundle-a-sidebar-folders/README.md` 明确 v1 文件夹/拖放/管理面板已被用户否决。当前源码与已安装0.3.22只按置顶和最近活动混排，未包含分段、职责/能力摘要或原浏览器折叠状态。

恢复形态：保留顶部主Bot及现有原生条目，列表原位分为 Bot、Bot群组、未分类；普通Bot条目显示真实role和已挂载capabilities（最多六个并显示余量）；保持组内置顶和时间排序。各段支持折叠/展开，条目支持临时收起，段级恢复和全部恢复；沿用旧浏览器localStorage键及collapsed/hidden结构，不写Bot/team状态，不触发群消息或模型调用。不恢复已作废的文件夹、拖放、独立管理界面或外挂侧栏。

## 实现与验收

- [x] 将旧折叠状态格式原生接入一个客户端状态模块，兼容重载、损坏/不可用localStorage和其他窗口的storage事件。
- [x] 在src/client/sidebar.js恢复固定分类、原位标题与收起/恢复控件，保持主Bot、原生头像、未读/工作状态、搜索/打开会话、折叠轨道和只读团队行为。
- [x] 迁移原有浏览器偏好，不读取或修改废弃folders.json；未知kind归入未分类，不推断Bot职责或能力。
- [x] 先用聚焦行为回归证明缺失，再验证真实TeamSidebar的分段、排序、职责/能力、折叠/恢复与持久化。用隔离示例渲染宽/窄组件，检查溢出和真实交互。
- [x] 同步插件/app与lock版本0.3.23，重建client.js，检查完整单元、lint、包契约与独立审查；保持已知完整配方环境阻塞单列。
- [x] 备份后部署至现有DSH安装，129个发布文件与源码/0.3.23包一致，官方入口启动且响应正常，无新增host崩溃日志；未修改Harness本体、真实群消息或账号信息。
- [ ] 正式窗口收起/恢复交互验收：初次1280×819截图及原生UIA读到Bot/Bot群组；后台点击后Expanded状态未变。用户另行批准前台验收后，首次重新捕获返回0×0、UIA根边界无效，已按约定停止输入，未执行前台点击；此项保留未完成。

## 证据边界

临时收起沿用旧v2：只隐藏当前浏览器中的条目，不关闭已打开会话、不写原生bot.hidden/room.hidden或团队状态，当前会话也可临时收起并恢复。原生hidden行仍由BotRow/RoomRow按retainedBy.mainView保持现有可见性；两类控制不共用数据语义。主Bot始终常驻，不提供无效的收起按钮。

分类来源为现有roster.kind/role/capabilities，不是技能评分标签。旧外部插件仅作恢复依据，不重新运行编译产物补丁，也不回滚现有任务流、五天评分、精品保护或profiles功能。实机窗口捕获若再次返回0×0或后台输入无法验证，停止桌面输入，保留界面验收未完成。

## 最终源码与安装证据

- `npm test`：2013项中2010通过、3跳过、0失败，日志为`ds-bot/.tmp-verify/sidebar-classification-full-reviewed.log`；新增晚段用例均出现，426个验证输入无漂移。
- 聚焦回归54通过；插件构建、client --check、lint、桌面前端构建通过；app包契约6通过。独立复审`sidebar-classification-review-closure.json`为pass，blocker_count=0，SC-001至SC-004已逐项关闭。
- 真实React组件在隔离示例数据/隐藏Electron中验证264px、320px宽侧栏及88px轨道，5个操作回调及重载正常；轨道各原生行56px且列表无横向滚动。此证据不替代正式窗口交互验收。
- 安装`0.3.23`只替换`client.js`、`package.json`，129个发布文件全部匹配；回退归档保留2761个旧安装文件并校验。安装记录`sidebar-classification-install.json`，总证据`sidebar-classification-verification.json`。
- 完整`hermes verify`配方仍未通过：当前只读预检确认官方Harness源码存在，但源码tsx运行依赖未准备，当前PATH缺pnpm、setsid、xvfb-run；历史完整配方在嵌套npm run check失败，boot/readiness未验证。本次没有重复运行同一已阻塞配方，也未把直接全量测试等同于完整配方成功。
