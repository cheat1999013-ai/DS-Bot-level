# 主理人普通回复恢复聊天样式

用户要求：主理人/当前群管理员回复用户时不应以任务卡或群内汇报卡发布；正式任务事件继续使用真实任务卡。

当前状态（.38 已安装）：两项实际回退原因已修复并安装 `0.3.38-card-navigation.1`。完整门禁 `proc_aebf895b7fd0` 四阶段全0、包装进程退出0，475冻结输入无漂移；最终审查 `deleg_b6d13af2` APPROVE绑定当前87fc清单。真实窗口已执行 lq-create → Chief私聊 → 程序开发 → lq-create，任务包装器未退位、运行时无crash，可见执行者为汇报卡、有效主理为管理员普通气泡。更早七条正式任务卡的逐条像素验收仍未完成，不能把下面通过项推广为全部历史/全部新群通过。

- [x] 当前 manifest SHA256 `87fc7dac3d71fc905e58a3b4a7cae178ede2678111e863d7e9c1caadf8618b02`，259文件，仅 client.js/package.json/cells.js/i18n.js/task-message.js 五变更。安装/归档/回滚259逐项hash一致，profile junction保留；没有更改DSH本体或Host数据。
- [x] 审查P1已用真实worker TriggerCell→GroupMessage→GroupPostCard(body=Bubbles)契约先红后绿锁定。cells旧不完整mdLabels删除，改import task-message共享完整copy/copied/toolbar/footnotes工厂；所有3任务正文、原Bubbles、历史正文均覆盖。两个新增中文键只向安装字典叠加，不覆盖并行翻译。
- [x] 最新源码关联73/73、精确候选5/5，真实SDK九场景导航green4且代码块/脚注完整。完整canonical4 build/npm test/lint/bundle-check全0；此前canonical1时间/反应回归和canonical2中文缺键失败均保留；canonical3因P1修改前主动停止，不算通过。
- [x] 最终审查deleg_b6d13af2明确闭合唯一P1、保留Bubbles反应/复制下载/折叠/whole-reader/time/duration及稳定主理身份规则。旧0708/7c5e/916a快照的审查均不替代87fc当前批准。
- [x] 正常close仍只隐藏，已按用户授权精确强停5目标进程、确认0后安装同EXE重启，PID32648/HWND2753768。最终安装读回259无漂移，native/runtime trace无crash，未新增host crash。正式回执card-navigation-full-verification-1.json、card-navigation-final-review-1.json、card-navigation-live-install-1.json。
- [x] 真实跨视图切换的每次目标由当前Document标题和截图读回，运行日志观测mainIsRoom→mainIsBot→mainIsRoom，wrapper priority=-101持续生效；返回lq-create后截图2ae4/fbfe中lq-score/lq-review为边框群内汇报卡，lq-operation为带管理员标识普通气泡，无可见“收到执行请求”。这次已不是隔离private placeholder证据。
- [x] 返回群后原生UIA精确读回正式“任务派发”6项、“结果已提交”5项、“收到执行请求”0项，正式项仍在可访问树但均offscreen。该证据不等于已看到旧卡像素。
- [ ] 用户明确授权前台滚动；新鲜capture曾0×0后停输入，用户恢复窗口后有效1280×819再发一次SendInput wheel，原生loadEarlier.y仍-13812无位移。用户再确认手动滚动后新截图fbfe和UIA位置仍未变，已停止所有进一步输入、未绕过原始输入/强制恢复。工具未可靠把旧正式卡滚进可见区，故更早七条及新群全量现场验收保留未完成，不再重复要求用户操作。

候选迭代记录：

- [x] 新真实日志：任务包装器 priority=-101 与 TriggerCell priority=-100 先后 undefined.code 并 abdicated=true，最终 TurnTriggerNodeView priority=0 接管。准确栈 QW173:1553/Zp173:711 映射到实际 shell 的 Markdown code-fence renderer r.labels.code，并非原生 turn-error。不能再用“没有观察到”解释用户切换后的真实故障。
- [x] 使用实际安装 shell 的 qJ 静态平台（真实 React/SlotCore/MarkdownText，不用纯文本替身），在隔离隐藏 Electron 中执行旧 installed .37：历史 workerCards=0/workerInOrdinaryBubble=true；切 A→private→B代码块时两个渲染器退位，返回A也全native，命令退出1。证据 markdown-navigation-production-red-2.json。首次支架缺 user 子槽位另记为 setup 错误，不算产品红。
- [x] 修复 TaskMessage 正式／坏历史及 GroupPostCard 三个正文分支，补齐 public MarkdownLabels code copy/toolbar/footnotes。GroupMessage 统一按当前 room.admin + member + stable resolved Bot 分流：仅有效主理为原普通气泡，其余为已有汇报卡；whole 文件全量读取仍使用原 Bubbles，正式任务在此前仍优先真实 TaskMessage。
- [x] 精确 .38 候选从当前实际 installed .37 的259文件建立，仅 client.js/package.json/cells.js/task-message.js 四变更；cells 只导入 GroupPostCard + 新无hooks身份分流包装 + 原 GroupMessage 改名，未覆盖并行 cells/index/Host 变更。首版 manifest 0708273c87ca868a58b0537f490803ee5fff60d4a141bc198b25f53c03f5e685 经回归修正后已失效；当前 manifest SHA256 7c5e95b66d842a62f817cefcf3c52d33d29f1bb82c70b3e41828db7bab141f22。
- [x] 同一真实 SDK 隐藏导航回归绿色：九个 A/private/B 场景稳定，无退位或 native fallback，B正式卡1/worker卡1/主理气泡1/代码块2/脚注2；history workerCards1/主理气泡1/worker普通气泡false；坏历史正文代码块保留。证据 markdown-navigation-candidate-green-1.json。这是原生组件+真实SlotCore的隔离行为验收，private是树卸载占位，不冒称真实 Host 导航。
- [x] 源码关联测试16/16、精确候选标签/历史回归4/4、build/lint通过，归档与回滚259hash核对通过。475输入冻结（含实际消费的3个隔离导航脚本），完整门禁与绑定审查等待最终结果；产品现场显示仍未验收。

历史状态（.37）：取证版本已安装并重启，用户18:09截图指出的跨群原生回退仍未完成现场验收。不得用以下诊断安装或门禁通过关闭问题。

- [x] 用户18:09两图合计7条“收到执行请求”仍是失败证据；只读journal核对身份/正文/source/同群完整，无turn/error，不能再用classifier/API绿判断修复。
- [x] 原生turn-error缺data及retry缺failure只是undefined.code候选；静态匹配没有证明实际出错组件。完整renderer委派deleg_2003f572最后支架不完整，不构成通过。
- [x] .37-slot-trace.1从实际安装.36最小叠加，只变更client.js/package.json/src/client/index.js及新slot-trace.js；259文件，manifest SHA256 845e1524737a1b09c65fb6b2090e4b5096e13c3819b2bf17d94fbb9fc9ac3864。公共onEntryError、entries/entriesOfSlot只读观测，不改DSH、不重挂/退让/恢复，不记录消息正文、凭据或URL。
- [x] 独立审查deleg_901f7064四项REQUEST_CHANGES已修正，经deleg_c9d58fcf重新APPROVE；四项诊断测试4/4，构建lint通过。修正后完整门禁proc_d63281106034退出0、四阶段0，470冻结输入无漂移、readiness=null。旧proc_2eda9bc857e4结果不得替代修正后的验证。
- [x] 第一次停止时进程树变更，身份校验中止，未换包；重新核对新树后正常close仍只隐藏，按既有授权精确强停5目标进程并确认归零，才安装.37。259安装hash、258回滚hash、profile junction通过。同EXE已重启PID13512/HWND1641312，无新增host crash。
- [x] runtime-slot-trace-console-1.log已出现mount/change诊断，证明真实页面加载；群界面ready=true/plain=false/mainIsRoom=true，turn-trigger winner为DS Bot包装器priority=-101，raw后备含TriggerCell(-100)/native TurnTriggerNodeView(0)。当前采样没有slot crash；不推断旧错误已消失。
- [x] 一次fresh1280×819截图computer_use_c9a6c62aed364c02b8ca6c86bf59cbf0.png中可见lq-create正式“任务派发”卡，只证明当前可见区。随后SOM capture再次0×0且坐标失效，已停止所有界面输入，没有切群或滚动，没有走其他API恢复。
- [ ] 用户点名的程序开发5条与lq-create 16:47两条在真实窗口复核；全局任务卡、主理普通气泡、执行者汇报卡及未来新群显示验收仍未通过。当前桌面阻塞需恢复同一DSH窗口并重新取得有效capture；不得盲用旧坐标。


- [x] 真实只读身份核对：lq-create 的room.admin为lq-operation稳定ID，Bot存在、仍在room.members。11:04原生user/message seq6008/time1794625487018为bot/relay/post同群，senderSessionId与admin匹配，taskflowEvent不存在。不是DSH无法识别身份，而是.33/.34新增普通汇报渲染分支未使用已存在的管理员字段。
- [x] 最小回归先红；test/task-inputs.test.js使用真实SlotCore及indexRoster：当前/历史群part、sender part、同名Bot、管理员变更、globalMain非本群admin、管理员离群/缺失/metadata缺失、formal事件先行、空正文与跨群回退均覆盖。
- [x] 修复普通同群Bot纯文本分支：先正式任务身份、再空正文保护；当前有效admin转给原TriggerCell复用GroupMessage/头像/管理员标识/普通气泡；executor仍用既有汇报卡。原消息/seq/time不改，TriggerCell自己去内部header。
- [x] noncustom wrapper保留native locale/inject/hooks，以principalActions、principalUi、principalTurnClock隔离Bot聊天依赖；custom路径沿现有face。原fallback保持，生产parent明确传TriggerCell，避免退回“收到执行请求”。
- [x] 源码5文件关联回归34/34；精确.35候选的任务消息集合通过，空卡旧回归继承。build/lint通过。
- [x] .35候选基于当前安装.34的257个文件逐项hash核对，变更仅client.js/package/index.js/task-inputs/task-message；index在已安装基线上只改一行绑定，不覆盖并行Host/多语言修改。归档与回滚257文件全hash通过。
- [x] 440/1000宽真实SlotCore+实际TriggerCell预览：普通主理聊天1、执行者汇报卡1、正式任务卡1、空消息0；主理区没有任务卡或群内汇报标签，管理员标签存在，无rawheader、overflow或console错误。preview使用companion Markdown适配器，无关可选user附件exports有warning；不等于真实运行窗口验收。
- [x] 主Agent独立audit，manifest SHA256 5ecea23bdedc71041bde3d3fb2f07b455071a6c21ec36d6a772a79a374737ecf。
- [x] 独立候选静态审查deleg_d526aaa3，APPROVE。
- [x] .35两轮完整Windows门禁及安装重启（详见下方已安装记录）。
- [ ] 用户截图11:04消息及所有群的真实显示复核通过；当前现场复现失败。

## 其他群与新群范围核对

- [x] 用户追加“程序开发”群09:14–09:35截图。只读核对该群有有效管理员Chief，groupSession=room.id（无另sessionId），11条Bot原生消息全部bot/relay/post同room且纯text；其中6条真实taskflowEvent、4条Chief普通post、1条执行者普通post。不能因群名不同推断SDK识别不到。
- [x] 已装SDK真实ConversationNodeAssembler+实际SlotCore回放77个原生信封，11条均为turn-trigger；.34也能在隔离回放把这批分为任务卡/汇报卡，.35进一步将4条Chief普通post交既有聊天renderer。原群、另一群换代part、模拟新群三场景均通过，代码没有群名或群ID白名单。
- [ ] 用户实际截图仍native，说明仅验证classifier不够；当前运行窗口的slot选择/客户端激活/切群生命周期仍待证明。另独立静态诊断deleg_1725c0f4。
- [ ] 精确PID13620/HWND4131848新鲜抓取仍0×0且最小化坐标，已停止桌面输入，未绕过以其他API恢复窗口；无法把隔离回放算现场验收。

额外证据：ds-bot/.tmp-verify/program-group-replay-report.json（真实source/id/inbox封套，正文截短与task goal省略，非完整业务转录）。

当前实际安装为.35-principal-chat.1，257包内文件hash与候选相符、profile junction一致；两次完整Windows门禁均exit0（proc_7e0b58bcfd9e、proc_6acfab4d0bca），build/test/lint/bundle-check四阶段0，464冻结输入无漂移，readiness仍null。候选静态审查deleg_d526aaa3 APPROVE。旧的一Bot一UI聚合候选仍暂停，不在本轮范围。Linux暂停。

### .35安装后真实验收（未通过）

正常关闭未退，沿既有授权精确强停5个目标进程，归零后最小换包。同EXE重启PID33752/HWND2755518，2026-11-14T12:20:21+08:00。新窗口1280×819抓取有效、无新crash。后台点击程序开发后新截图和AX标题确认切换成功，但09:14–09:35仍native“收到执行请求”；切lq-create并加载历史后，10:37–11:30也全native，11:04普通主理回复仍错误。不得宣称已修好某个群或新群。

实证将未解决边界收敛到整个conversation surface的运行接线/父安装或生命周期，而非群名白名单或source协议。独立诊断deleg_1725c0f4确认正式task identity不依赖room.sessionId；进一步完整父安装/实际SDK诊断deleg_73ae9ea7进行中。应用菜单post-capture显示打开但fresh-capture消失，未继续菜单输入/DevTools，也不以其他API绕过。

当前真实截图：computer_use_27c3f5d8d8964007ab435d3ed6a61b79.png（程序开发）；computer_use_f2f0394826984a3b9a98ecd628c15334.png（lq-create）。位于Hermes cache/images。

## 运行错误与字段丢失修复（.36已安装，全局显示尚未完成验收）

- 实际日志runtime-client-console-1.log证明：conversation.chat.node反复报Cannot read properties of undefined (reading 'planId')，SDK在渲染异常后会让当前注册让位。此前仅分类、投影及静态挂载回放无法发现真实异步group-rows的坏行。
- 安装版groups.js:rowOf对于record.kind='task'走通用非notice返回，只保留kind/who/time，丢失text/taskflowEvent。只读账本核对程序开发32/32、lq-create261/261任务本来都保存完整身份与正文；不是历史任务丢失。未改账本。
- 生产rowOf精确提取最小复现task-row-production-red-1.log：有效task+body输入，输出两字段均缺失，exit1。候选同一入口修复后两字段保留exit0。
- 新源码shared/group-task-record.js统一保留任务身份/正文/发送者/时间；不具有效身份的task行只显示notice正文，不伪造任务编号。
- client/task-message.js对缺失或无效task身份保留可读正文而不画正式头，TaskSourceHeader缺matched返回null，避免历史坏行使整个共享槽位退回native。有效正式task仍画真实卡。
- 候选基于当前已装.35逐文件核对，仅5变更：client.js/package/client task-message/Host groups/新增shared helper。258文件；Hostgroups只插入import和唯一task分支，不覆盖开发源调度分叉。修复在源码helper及受控stage脚本中维护。
- 源码/候选14项focused均绿（含真实ReactDOM SSR坏历史+后续有效任务不崩）；实际GroupReplyCell异步groupRows预览440/1000均3卡、2真实taskref、1主理气泡、无错误/overflow/rawheader。预览useWork必须调用selector，fixture初错已修。
- manifest SHA256：00992967130eb777939f0108448165c95f200dc7c093adf86210b43eebc94369。归档258/回滚257hash通过。独立审查deleg_87be75be代码路径通过，命名阻断经deleg_ecb1089c复核APPROVE。
- .36完整门禁proc_a316e5b4bb0c确认exit0，467冻结输入无漂移，build/test/lint/bundle-check全0；readiness=null仍不等于真实宿主验收。验证回执审批两次超时未执行；用户再次“继续”后原命令获明确批准执行成功。
- 已安装.36并同EXE重启：258文件hash无漂移、profile junction正确、无新host crash。正常close只隐藏，沿已授权范围精确强停5个目标进程，确认归零后换包；不是正常退出。新PID8604/HWND723954。
- fresh 1280×819截图computer_use_fc1fd20841464ad2ade9720a5beae327.png显示lq-create主理lq-operation普通回复为头像/名称/管理员气泡，无任务头或群内汇报；执行者普通汇报仍卡片。只证明该可见区，不代表全群正式卡最终验收。
- 主修复为全局公共rowOf/TaskMessage路径，没有群名/群ID特判。实际SDK启动后通过create-room新建两个隔离群（随机新ID、不同中英文名称），greet=false、不调用模型，种入隔离任务fixture后正式group-rows API完整返回任务身份和正文，state读取确认新群。证据task-row-new-groups-api.log。没有在真实profile创建测试群或消息。
- 后续真实日志runtime-task-row-console-1.log没有观察到undefined.planId，但两次undefined.code和conversation.chat.node异常，准确来源未确定；仍需诊断，不把字段修复成功说成全局完成。独立只读诊断deleg_072a886c。
- 后台scroll工具报告background_unavailable，立即停输入；前台授权询问用户纠正要全局，未明确同意切前台，因此不进行前台滚动。后续只读fresh capture0×0，再停止桌面操作，不盲点/恢复窗口。保留全局正式任务卡、程序开发现场及新群真实窗口验收未完成。
- stage首次误写.35 manifest名字，已修输出路径，并重建核对旧manifest SHA256完全恢复为5ecea23bdedc71041bde3d3fb2f07b455071a6c21ec36d6a772a79a374737ecf，候选产品字节不变。正式.36manifest与baseline分开。

证据：ds-bot/.tmp-verify/principal-chat-red-1.log、principal-chat-focused-1.log、principal-chat-candidate-focused-1.log、principal-chat-preview-report.json、principal-chat-manifest-1.json、principal-chat-audit-1.json、principal-chat-preflight-1.json。
