# CAI.Tools 自有更新验证记录（2026-10-16）

状态：代码实现与源码验证完成；真实 Windows NSIS A→B 升级验收尚未完成，不能据此宣称最终验收通过。用户已授权提交、推送、发布 local.4 / local.5；本记录将随实际发布结果更新。

审计与实施计划：`docs/superpowers/plans/2026-10-16-cai-tools-auto-update.md`。

## 已实现的链路

`关于 → 检查 CAI.Tools 更新 → UpdaterAPI → WindowsPlatformUpdater → ElectronUpdaterService → 公开 GitHub Releases → NSIS`。

- 更新器固定使用 `Caicy/CAI.Tools`、公开 GitHub provider、`local` 通道；关闭降级，不接受替代 generic feed。上游研究提醒独立保留，不参与下载、安装或后台检查。
- 启动及每 30 分钟检查一次（可关闭）；仅安装版后台检查，源码测试不后台联网。发现更新显示窗口，用户点击后下载并启动安装，不在退出时静默安装。
- 关于页将自动检查偏好写入宿主 `ZTOOLS/settings-general`，不是 setting 插件的私有命名空间。
- 复用 electron-updater 的下载进度、取消、缓存、SHA512 校验和差分失败后完整下载；下载失败可重试、取消后不安装。并发检查合并，下载或安装期间不覆盖当前状态。
- 安装启动抛错或更新器发出安装错误时，恢复退出标志、保留已下载状态供重试；初始化失败显式报错。
- 保持 `appId=tools.cai.local`、`productName=CAI.Tools`、默认数据根 `~/.cai-tools`、原设备与账户 LMDB 和插件目录。只修正打包安装标记内残留的上游 appId，没有更换应用身份。
- NSIS 保留 `deleteAppDataOnUninstall: false`，安装使用现有安装目录。退出仍按原合同关闭 LMDB。本次没有数据库迁移、用户数据清理或插件迁移操作。
- Windows ZIP 保持手动安装边界，不能直接在软件内覆盖便携目录。macOS 来源识别也已统一到自有仓库，但未运行 macOS 更新验收。

## 发布合同

`.github/workflows/build.yml` 增加单元测试及制品验证；保留现有 pnpm 双 workspace 的打包规避逻辑。

1. 仅允许本仓库、匹配源码的 `local.x` 版本和 `prerelease=true`，拒绝复用已有标签。
2. 构建 NSIS + ZIP，生成并验证 `local.yml`、EXE blockmap、打包后的 `app-update.yml` 和本地身份标记。
3. 重新计算真实 EXE 的 SHA512、大小并比对 YAML；必要文件、版本、身份、来源任一不匹配即停止。
4. 上传 EXE、ZIP、`local.yml`、EXE blockmap、SHA256SUMS。先创建草稿并完成上传，再公开预发布版本，避免客户端看见半成品。
5. GitHub 凭据只由 Actions 提供；客户端不含 GitHub Token，也不需要用户配置 Token。

以上为实现与夹具测试结果，尚未在真实 Actions 运行中验证新工作流或生成新的安装制品。

## 验证证据

| 检查                         | 结果                                           | 证据与边界                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整单元测试 `pnpm test`     | 92 文件、798 项通过                            | `test-results/updater/final-unit.log`                                                                                                                                                                                  |
| 完整源码 E2E `pnpm test:e2e` | 7 通过、4 跳过                                 | `test-results/updater/test-results-update-e2e-full.log`；3 个旧账号用例不适用，1 个字符串工具用例因桌面剪贴板写入回读不可用而跳过                                                                                      |
| 更新专项 E2E                 | 真实源码窗口与 IPC、开发安装拦截、重启回读通过 | `tests/e2e/auto-update.spec.ts`；外部版本检查使用受控替身，没有下载或运行安装器                                                                                                                                        |
| 主项目 `pnpm typecheck`      | 通过                                           | `test-results/updater/test-results-update-typecheck-final.log`                                                                                                                                                         |
| 源码 `pnpm build`            | 通过                                           | `test-results/updater/test-results-update-build.log`；没有执行 electron-builder 或应用打包                                                                                                                             |
| 变更文件 ESLint              | 通过，无诊断                                   | `test-results/updater/final-lint.log`                                                                                                                                                                                  |
| 设置插件显式完整类型检查     | 22 个错误，未通过                              | `vue-tsc --noEmit -p tsconfig.web.json`；诊断位于本次未修改的 ShortcutEditor、AI 模型、指令与供应商等文件，见 `test-results/updater/test-results-update-setting-typecheck.log`。常规 `pnpm build` 不等同于这个显式检查 |

依赖测试直接使用已安装 electron-updater 6.8.9 的 GitHubProvider 和 NSIS 版本策略，验证 `local.9 → local.10`、相同版本与降级拒绝、跳过其他通道、从自有仓库读取 `local.yml`。其传输为测试替身，不是线上 GitHub 下载测试。

发布校验测试使用临时文件实际计算 SHA512，覆盖文件损坏、错误版本、缺失 blockmap、上游源、凭据字段与错误身份；测试文件不是可执行安装器。服务层下载校验错误用例验证的是收到底层错误后的处理，不冒充真实网络校验失败。

E2E 使用临时数据根及旧数据目录，重启后回读宿主自动检查偏好、setting 插件私有 LMDB 文档、插件清单与目录哨兵，并确认旧目录不变。此证据不等于安装器替换应用后的数据保留。

初次在沙箱执行时出现 Electron `Target crashed` 与路径 `realpath EPERM`；在常规进程权限下重新运行通过。没有放宽产品代码的路径安全检查。

## 真实 Windows 升级验收（待执行）

用户已于本任务授权公开发布。当前发布候选源码为 `3.2.0-local.5`，工作流会拒绝覆盖已存在的标签。计划发布 `3.2.0-local.4` 作为首次安装基线，再发布 `3.2.0-local.5` 验证升级；两版均须包含本次实现，且发布前分别更新 package.json 和工作流默认版本。B 版安装包不能仅修改远端 YAML 伪造版本。

- [ ] 在独立 Windows 测试用户/虚拟机安装 A（local.4），记录安装目录、实际版本、设置、第三方插件及插件数据、宿主/插件 LMDB 文档与附件的摘要。
- [ ] 核对 A 的 tag SHA、Actions SHA、release target_commitish 和制品摘要一致；确认最终资源包含自有 app-update.yml 与正确标记。
- [ ] 发布 B（local.5），验证 GitHub 匿名获取 Atom feed、local.yml、blockmap、EXE；确认不请求 ZToolsCenter/ZTools 的更新源。
- [ ] A 内手动检查与自动检查发现 B；下载显示进度；取消后保留 A，再次下载可完成；无需重新访问 GitHub。
- [ ] 由软件内启动安装，确认应用退出、安装到原目录、重启后显示 B，随后再次检查不再提示同版本。
- [ ] 对照基线回读全部设置、已安装插件、插件数据与 LMDB 文档/附件；确认没有新建另一套用户数据目录。
- [ ] 断网、GitHub 限流/不可达、缺失元数据、损坏包、安装启动失败均不导致误安装；验证错误提示与重试。
- [ ] 现场验证系统拦截、提权取消、安装中断与再次启动；记录 NSIS 真实行为。应用退出后的安装失败无法由已退出的旧进程保证展示，也未实现自动回滚。

旧 local.1～local.3 的安装版未启用应用内下载安装，不能凭新增 Release 获得本次修复，必须先手动安装启用更新的基线版本。

## 剩余风险

- 最终验收仍依赖真实 GitHub 发布与 Windows 安装器流程，包含系统签名/SmartScreen、安装权限、杀软、自动重启和实际数据保留；这些尚未验证。
- GitHub 下载可达性依赖用户网络；本次未新增付费源或镜像。
- 当前只接收 `local` 通道，正式版通道切换需另行设计，不能把上游稳定版作为本地版更新。
- macOS/Linux 没有本次 Windows 现场验收证据。
- 草稿上传失败时不会公开半成品；若已产生标签，重跑会因标签保护被拒绝，需要显式处理失败草稿/标签或增加版本，不能无审查覆盖已发布版本。

参考：[electron-builder v26 自动更新](https://www.electron.build/v26/docs/features/auto-update/)、[通道说明](https://www.electron.build/docs/tutorials/release-using-channels/)、[action-gh-release 输出与草稿选项](https://github.com/softprops/action-gh-release#outputs)。实际版本选择同时以本地已安装依赖源码及测试为证据。

## 已授权发布进度

- local.4 已公开预发布：<https://github.com/Caicy/CAI.Tools/releases/tag/v3.2.0-local.4>。
- 成功工作流：<https://github.com/Caicy/CAI.Tools/actions/runs/38843962804>；tag、工作流与 release target_commitish 均为 `05e6c9045e1e0e562cc4441700e6a46e576f5f5c`。五个更新制品完整，发布前校验实际安装包 SHA512、大小、自有源和身份通过。
- 首次 CI 失败原因是缺失 Electron 安装结果及 RUNNER~1 临时路径别名；已通过显式准备 Electron 和规范临时目录修复，没有放宽产品路径边界。
- local.5 候选在准备中；真实安装验收将使用 GitHub 临时 Windows runner，下载安装已发布的 local.4，在应用内真实下载取消、重试并升级到 local.5，再回读设置、插件文档与附件。不会重新打包应用来代替源码 E2E。
