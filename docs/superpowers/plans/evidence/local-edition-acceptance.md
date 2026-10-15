# CAI.Tools 免登录本地版实际证据

日期：2026-10-15。分支：codex/cai-tools-local-edition。基线：6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c。

只记录实际运行结果。计划 A（A0–A6）的实施、规格/质量审查与本机运行验收已于 2026-10-15 05:51 收尾；以下保留历次失败、修复与验证边界，不表示所有检查均无错误或 G01–G16 全部完成。计划 B 未开始，改动保留在 worktree，未提交、推送、打包或发布。

## 最终结果

| 验证项                | 实际结果与范围                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根类型检查            | `pnpm typecheck` 退出 0。                                                                                                                                      |
| 全量单测              | `pnpm test` 退出 0；85 文件、687 用例通过。                                                                                                                    |
| 源码 Electron E2E     | `pnpm test:e2e` 退出 0；5 通过，3 个原版账号/私有同步流程明确不适用跳过，原因和替代边界测试映射保留。                                                          |
| 完整设置页面类型检查  | 退出 2；22 项错误与纯 HEAD 基线的文件/行/列/错误码一致，不计为通过。默认空根项目 `vue-tsc --noEmit` 的退出 0 不替代完整页面检查。                              |
| 普通运行网络观察      | 不设 `ZTOOLS_E2E`；05:15:08.910–05:50:08.928（UTC+8），2100.018 秒；启动、通用设置页和静置阶段非本机请求为 0。8 类通道及新 Session 自检通过。                  |
| 匿名市场              | 返回 237 条目录记录；真实下载、安装并打开 code-snippets 1.2.0，已核对插件正文截图。仅证明该样本安装打开，不代表全部插件兼容或 Git 数据适配。                   |
| 主动上游检查          | 真实 IPC 返回 `unavailable`，提示 HTTP 403；失败响应已验证，未确认上游最新版本。                                                                               |
| 真实 `.ztools` 元数据 | 正式观察前后各 150 项，存在性、路径、类型、size、mtime 无差异。采集不读文件内容、不跟随 reparse point；不证明没有读取或同尺寸内容从未变化。A0 越界事实仍保留。 |
| 清理与产物一致性      | 最终观察前后主程序两份 JS 哈希一致；本次临时目录已清理，自有进程已退出，15177 无监听。此前被拦截的旧临时目录保留。                                             |

最终日志：`test-results/a6-typecheck-final.log`、`a6-unit-tests-final.log`、`a6-e2e-final.log`、`a6-setting-page-typecheck.log`；普通运行 `test-results/local-runtime/local-runtime-1792012494966/{status.json,network.jsonl,verification.json}`，命令退出 0；元数据对比 `test-results/upstream-metadata-comparison.json`。截图 `test-results/playwright/local-runtime-1792012494966/market-plugin.png`，等待“暂无模板，点击新建添加”后直接截取插件 WebContentsView 当前可见区域，已人工回读正文。

自配 AI 的 E2E 使用真实插件和本地模拟 OpenAI Chat/Responses/Anthropic 服务，未验证真实付费服务或 Gemini。网络证据限于本轮主进程与 Electron Session 可见通道，不是操作系统级抓包，不能推定未安装插件或原生子进程的联网行为。

Linear 已写入并回读：[CAI-25](https://linear.app/caixfish/issue/CAI-25/a6源码-electron-与普通运行验收) 为 Done，计划 A 里程碑 100%；项目保留 In Progress，计划 B 为 0%，尚未开始。原任务计划正文仍保留，顶部实际进度已更新。

## 分阶段实施与历史记录

## A0 开发准备

- 使用独立托管 worktree；原工作区未提交方案保留，开发工作区复制四份交接文件。未提交、推送或发布。
- 子模块初始化成功：ztools-api-types=1440d4b7ebbdf32e1ddacf6f90846a097ee212d8，ztools-plugin-cli=f9936d5f9abf22357e89126531d8e95432f8fec0，两者 package.json 存在。
- workspace 保留双 lockfile，逐项允许 electron/esbuild/lmdb/msgpackr-extract/uiohook-napi/less；删除失效 onlyBuiltDependencies。
- pnpm install --frozen-lockfile：退出 0，两 lockfile 无改动。首次 Electron 检查缺二进制；pnpm rebuild electron esbuild lmdb msgpackr-extract uiohook-napi less：退出 0。
- 重建后 pnpm exec electron --version：v41.4.0，退出 0。
- pnpm typecheck：退出 0；pnpm --dir internal-plugins/setting exec vue-tsc --noEmit：退出 0；规格审查代理独立复跑两者均退出 0。
- 改产品源码前 pnpm test：退出 1；79 测试文件中 73 通过、6 失败；557 条已收集测试中 548 通过、9 失败，另 3 个套件导入失败。
- 基线失败：pluginDevelopmentRegistry（Windows 路径预期）、windowsLauncherWorkingDirectory（bare exe 启动预期）、windowsScanner（旧 parseUrlFile 导出）、common/terminalLauncher（原生 .node?asset 导入）、settingsOptimizedShortcutFallback（app.on 替身缺项）。完整输出为被忽略的 a0-baseline-test.log。A6 区分基线问题与本次回归。
- 验证越界记录：主代理首次执行基线单测时未强制设置隔离环境变量；日志两次显示旧用例通过 lmdbInstance 初始化真实用户的 `.ztools/lmdb/device` 与 default 路径。无法据此判定业务数据是否被改写，因此不能声称未触碰真实目录。发现后停止此类运行，不读取、删除或试图还原真实目录。后续所有单测与 Electron 验证必须强制隔离数据根和旧数据目录；Vitest 统一隔离列为 A6 必修项。该记录不因后续测试通过而撤销。

## A1 本地身份和独立数据根

- 已落地 CAI.Tools / tools.cai.local / 3.2.0-local.1，默认 `.cai-tools`；保留显式测试路径覆盖，固定 default 业务空间，拒绝非空官方 uid 切换。
- 已移除原版默认目录探测与持久化 uid 恢复；产品常量、builder 元信息及专项测试均存在。此处仅记录实现范围，不等于 A 阶段整体通过。
- 交接记录：上一轮隔离 TEMP/home 下四文件 24/24 通过；node 类型检查退出 0，web 检查当时因沙箱 EPERM 中断。
- 本轮权限重试：worktree 内唯一探测文件写入、回读、删除成功。使用普通工具直接写入现有分支，没有修改权限配置或绕过审批。
- 本轮 `pnpm typecheck` 及设置插件 `vue-tsc --noEmit` 均退出 0，先前 web 类型检查的权限阻塞不再复现。
- 本轮为四文件专项强制设置外部隔离数据根后，首次 24 条中 17 通过、7 失败。已定位旧测试未覆盖环境变量优先级，部分用例共享临时数据根并相互污染；已改为逐用例临时目录，默认目录检查使用模拟 home。所有该轮外部数据根均为临时目录。
- 修复后主代理独立复跑 A1 四文件、localCapabilities 和 runtimeCompatibility：6 文件 36/36 通过，退出 0（02:35 本地时间）；其中 A1 四文件为 24/24。

## A2 启动与官方能力边界

- 注册 43 个原 account/sync 请求入口：会话返回 null，其余返回明确不可用；插件 getUser 同步返回 null，令牌与支付保持异步失败语义。
- 启动链移除活动心跳、官方同步、用户/支付、通知、原版更新器、旧数据导入模块；内部通知和更新兼容入口保留调用者校验。运行不兼容提示已改为本地版源码重建说明。
- 本机数据库写入和读取、旧迁移拒绝、通知权限以及传递导入图专项已通过。该图检查不是普通运行网络审计；A3 的市场和 AI 官方依赖仍待清理，A4 将替换临时更新失败响应。
- 实施代理记录红测 5/5 失败后完成实现；主代理独立复跑上述 6 文件 36/36 通过。独立规格审查复跑六文件 36/36、node typecheck 和 diff check 均退出 0；随后独立质量审查批准，无需跟进的问题。

## A3 匿名市场与自配 AI

- 市场移除官方会话读取、刷新和保存；剥离所有大小写的 Authorization，依赖账号的操作联网前失败。匿名请求最多等待 15 秒，可由调用方缩短。
- HTTP 封装增加可选超时与 abort/结算清理；插件模型发现与调用只使用自配供应商。官方 AI 查询在 renderer 与内部插件入口均返回明确失败，保留调用者校验。
- 实施记录红测 24 失败/8 通过；主代理独立复跑 pluginMarketConfig、pluginMarketLatest、localAiCapabilities、aiProviderService：4 文件 48/48 通过，退出 0（02:51 本地时间）。独立规格审查再次复跑 48/48，node 类型检查与 diff check 退出 0。
- 测试运行真实 HTTP 封装、插件 IPC、提供商和协议适配器，Electron 网络与外部 SDK 使用替身。不能据此宣称原生联网或真实 AI 服务已验证。
- 本轮匿名只读接口实际获取 code-snippets 1.2.0 的 latest 与下载元数据成功；实际插件包安装与打开仍待 A6。
- 补充修复目录、推荐、排行榜绕过超时入口的问题：统一走匿名请求并保留缓存降级。主代理独立复跑最终四文件 55/55 通过（02:59 本地时间）。新增超时上限及入口/降级边界，规格与质量审查均批准补充增量，最终无待跟进问题。

## A4 主动上游提醒

- 新的上游检查只访问固定 GitHub latest API，10 秒超时且禁止重定向；使用严格稳定版本比较和固定发布页白名单，不取得更新包。
- localUpdater 接替 APIManager、退出清理和 internal 更新入口；保持旧通道兼容，自动检查恒关闭，下载状态为 idle。共享本地信息与提醒类型已落地，供 A5 界面使用。
- 主代理在隔离路径复跑 upstreamUpdateNotice、localCapabilities、localAiCapabilities：3 文件 60/60 通过，退出 0（03:09 本地时间）。实现代理 node 类型检查通过，独立审查进行中。
- 此处请求和打开外部页面为替身测试，不代表原生网络或普通运行已验收。
- 规格审查指出旧事件监听器的 return 并非 IPC 响应，已修正四个 on 入口设置 event.returnValue；测试区分 handle/on 并核对实际事件字段。普通 send 本就不提供回应，此处只保证不执行安装、下载或窗口操作。
- 唯一规格缺项修复后复审通过；独立质量审查再次跑 A4+A2 两文件 48/48、node 类型检查退出 0，并批准本任务。

## A5 本地设置界面

- 已实施本地工作台身份、账号/通知/同步入口清理、评论点赞入口清理、自配 AI 和手动上游提醒；实际 Electron 页面与截图仍待 A6。
- 根 `pnpm typecheck`、设置 `vite build` 退出 0；设置构建有两条既有桶导出循环分块警告。
- 校正验证深度：默认设置 `vue-tsc --noEmit` 的根配置为 files:[] + references，退出 0 不能证明设置页面完整类型检查通过。此限制也适用于前文相同命令的记录。
- 完整检查 `pnpm --dir internal-plugins/setting exec vue-tsc --noEmit -p tsconfig.web.json --composite false` 退出 2，剩余 22 处错误。使用 git archive HEAD 的纯基线副本与同一依赖运行相同检查，22 处报错的文件与行位置全部一致（baseline:22,current:22,differences:[]）。本轮引入的 LeftMenu 两处错误已修复；不把基线问题记作通过。
- 基线日志：`test-results/a5-baseline-types-228b01a9101545fb9e3adcefa23803f9/typecheck.log`；当前日志：`%TEMP%/cai-a5-setting-page-typecheck.log`。基线副本含依赖 Junction，保留在忽略目录，不递归删除。
- 独立规格审查发现可达 DataSetting 页面仍订阅账号变化和同步存储事件；已移除这些监听及专用状态/处理函数，保留本机数据加载、键盘交互和下载进度。增量规格复审通过。修正后根类型检查退出 0，完整设置页面错误日志仍逐行一致（22 处基线错误）。质量审查进行中。
- 主代理独立复跑根 `pnpm typecheck` 与设置 `vite build` 均退出 0；本项不替代完整页面类型检查和 Electron 实测。
- 独立质量审查批准 A5，无新增需修复问题；A5 diff 检查、preload 语法检查通过。Linear CAI-24 已完成，CAI-25 已开始。此前“质量审查进行中”为修正时记录，现已完成。

## A6 运行验收（已收尾，保留过程记录）

- Vitest 全局 setup 已在每测试文件业务导入前分配唯一临时数据根和旧数据目录；用例可进一步细分隔离路径，unstubAllEnvs 回到临时基线。持有 LMDB 单例的目录保留给系统临时目录清理，避免删除活动数据库。
- 首轮全量 `pnpm test`：退出 1；83 文件中 74 通过、9 失败；642 例中 630 通过、12 失败，另有 3 个导入失败套件。日志 `test-results/a6-unit-tests.log`。其中原基线问题仍在，另有三个 5 秒超时。
- 单变量复跑 `pnpm test --maxWorkers=4`：退出 1；83 文件中 77 通过、6 失败；642 例中 633 通过、9 失败。三个超时均消失，剩余失败与 A0 已记录基线一致。日志 `test-results/a6-unit-tests-bounded.log`。后续处理测试基线与运行验收，不把此轮记为全量通过。
- 修复基线测试的 Windows 路径、已迁移原生扫描接口、原生启动回退和 mock 边界；未删除或跳过这些单元测试。固定最多 4 个 worker 后，主代理重新运行 `pnpm test`：退出 0，84 文件、683 用例全部通过（04:09 本地时间），日志 `test-results/a6-unit-tests-final.log`。
- 首轮 `pnpm test:e2e` 已执行源码构建与真实 Electron：2 项通过、3 项失败、3 项上游账号流程明确不适用跳过，日志 `test-results/a6-e2e.log`。真实自配 AI 流式调用和 ESC 行为已通过；支付测试参数、窗口显示等待与 Windows 分离窗口尺寸断言正在修正复跑，尚不记为全套通过。
- 修正合法支付回调参数、原生窗口就绪轮询，以及 Windows DPR=2 时内容边界报告与外框相差 2px 的精确布局契约后，全套源码 E2E 已有一次退出 0：5 通过、3 项不适用跳过。规格复查要求恢复切换前后宽度相同断言，并发现翻译资源仍硬编码原版目录；两者已修复，最终产物正在重新验收。
- 翻译资源改为使用统一 getZToolsRoot；新增回归测试修前失败、修后通过，模拟下载/WASM，保留 7 份资源的真实目录创建、补丁与模型文件读取。临时 home 中的原版哨兵目录未被产品访问。独立规格审查中，不把此测试视为真实翻译模型或联网能力验收。
- 最终宽度与保存修复同时覆盖同步/迟到 resize、四次往返切换、真实用户改变尺寸及升级期间抑制；保留精确宽度断言。实现使用同次窗口尺寸的正文快照，实际持久化方法到数据库替身的参数/次数已验证；规格与质量增量复审均批准。
- 最新最终产物：根 `pnpm typecheck` 退出 0；`pnpm test` 85 文件、687 用例全通过；`pnpm test:e2e` 退出 0，5 项通过、3 项明确不适用跳过（05:12–05:15 本地时间）。对应 `test-results/a6-typecheck-final.log`、`a6-unit-tests-final.log`、`a6-e2e-final.log`。
- 完整设置页面检查仍退出 2：22 项报错的文件/行/列/错误码均与纯 HEAD 基线相同；诊断正文中扩展后的接口类型描述有差异，不影响错误身份对比。`a6-setting-page-typecheck.log` 保留此限制，默认空项目检查退出 0 不替代它。
- 为修复质量审查发现的问题，曾中止第一轮普通运行观察（`test-results/local-runtime/local-runtime-1792010868471/status.json`），不计为通过。仅终止本轮脚本进程树。自动审批拦截递归清理且未给具体原因，临时目录 `cai-runtime-audit-J8qHRJ` 保留，没有换其它方式重试清理。
- 最终 35 分钟普通观察于 05:15:08 本地时间开始，目录 `test-results/local-runtime/local-runtime-1792012494966`。已验证不设 ZTOOLS_E2E、hook 早于业务加载、实际 userData/两个环境变量在独立临时目录、8 通道与新会话自检均通过。开始前只读获取真实 `.ztools` 的 150 项元数据，不读内容、不跟随 reparse point；观察完成及前后比较仍待记录。
- 最终整体代码审查批准计划 A，未发现跨功能待修问题；审查完成时普通运行观察尚在进行，最终结果见本文顶部，代码审查不替代运行证据。

## 最终验收边界

- A5 实现与代码审查：已完成，实际 UI 检查由 A6 覆盖。
- A6 根类型检查、单元测试、源码 Electron E2E：已执行并通过；完整设置页面仍有 22 项已复现的基线错误。
- 不带 ZTOOLS_E2E 的普通源码运行网络审计：最终一轮 2100.018 秒，通过；完整过程退出 0，`passed=true`、`fullDuration=true`、`passiveExternalRequests=[]`。
- 最终产物匿名市场样本已再次安装并打开，稳定正文截图已回读；GitHub 主动查询返回 HTTP 403 / unavailable，仅完成失败响应验证。
- 正式观察前后真实 `.ztools` 的 150 项元数据一致；不撤销 A0 未隔离单测触及真实目录的记录。
- 两台真实 Windows、真实 Git 和插件适配迁移：计划 B 单独验收。

## G01–G16

G01 的本机免登录部分已有源码 E2E 证据；G02 仅完成本机数据根独立，Git 同步目录部分属于 B。G15 本机普通运行观察通过。G16 匿名安装打开通过，主动提醒已验证 HTTP 403 时明确返回 unavailable，最新版本查询成功场景仅有替身测试；不记作真实查得最新版本。G03–G14 及跨机器、Git、插件适配迁移仍属未授权的计划 B，不计作完成。
