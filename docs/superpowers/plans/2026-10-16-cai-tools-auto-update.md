# CAI.Tools 自动更新审计与实施计划

**Goal:** 首次安装启用更新的 Windows NSIS 版本后，通过软件内检查、下载和安装后续 `3.2.0-local.x` 版本。

**Architecture:** 复用 `UpdaterAPI → WindowsPlatformUpdater → ElectronUpdaterService → electron-updater` 与原有更新窗口；检查和下载只使用公开的 `Caicy/CAI.Tools` GitHub Releases。自动检查不自动下载，下载后显式启动 NSIS 安装。

**Tech Stack:** Electron 41.4.0、electron-builder 26.0.12、electron-updater 6.8.9、Vue、Vitest、Playwright Electron。

## 现状审计（修改代码前）

- `package.json` 为 `3.2.0-local.3`；`electron-builder.yml` 身份为 `tools.cai.local` / `CAI.Tools`，`publish: null`，NSIS 保留数据。
- `APIManager`、设置插件与退出清理连接 `localUpdater.ts`；所有旧下载、安装、更新窗口入口明确拒绝执行。关于页面仅检查上游。
- 历史 `updater.ts` 仍请求 `serverUpdateCatalog`；不能原样恢复，避免恢复原版更新服务。
- `electronUpdater.ts` 已有差分下载、完整包回退、取消和 NSIS 安装，但可接受任意 generic feed，错误状态、并发检查和安装失败恢复需要加固。
- `windowsInstallCompatibility.ts` 与 `afterPack.js` 安装标记仍使用 `top.z-tools`，feed 校验仍识别 ZToolsCenter/ZTools。
- `.github/workflows/build.yml` 只发布 EXE、ZIP、SHA256SUMS，没有 YAML 与 blockmap。工作流已有 pnpm 双 workspace 打包规避逻辑，应保留。
- `build/installer.nsh` 只清理安装目录内旧 updater，`deleteAppDataOnUninstall: false`；本地根为 `~/.cai-tools`，设备与账户 LMDB、插件目录均在此，升级不迁移、不删除这些路径。
- 本地依赖 GitHubProvider 源码确认：custom prerelease `local` 读取同通道版本与 `local.yml`；SemVer 数字段比较由 electron-updater 实现。配置 channel 后显式关闭 allowDowngrade。
- 工作区已有 string-tools 未提交改动，保留；本任务不提交、不推送、不发布远程版本。

## 实施步骤

### 1. 自有更新源与发布合同

- [x] 修改 `src/shared/updateSource.ts`、`dev-app-update.yml`、`electron-builder.yml`：GitHub owner=Caicy / repo=CAI.Tools，local 通道，保留身份与路径。
- [x] 修改 `build/afterPack.js` 和 `src/main/api/windowsInstallCompatibility.ts` 使用本地 appId 与自有 feed；不信任上游安装标记。
- [x] 更新 `package.json` 项目链接；不升级现有版本号、不添加客户端 Token。
- [x] 添加 `scripts/verify-windows-update.mjs` 与对应测试：发布前核对 local.yml 版本、唯一 NSIS 文件、SHA512、大小、blockmap、打包 app-update.yml 与安装身份，缺失即失败。
- [x] 修改 `.github/workflows/build.yml`：约束本仓库与 prerelease 选项、发布 YAML/blockmap、校验后发布，保留构建和 pnpm 规避逻辑；发布文案不再引用过期测试数量。

### 2. 接通更新运行链并处理异常

- [x] `src/main/api/updater.ts` 改用平台检查结果，移除 serverUpdateCatalog 导入；源码环境禁用后台请求与安装；合并并发、避免检查覆盖下载状态。
- [x] `ElectronUpdaterService` 固定公开 GitHub provider / local 通道、禁止降级与 generic feed；下载失败可重试、取消不安装、安装异常恢复退出状态，清理监听器。
- [x] `platformUpdater/types.ts` 与 `windows.ts` 补齐安装失败恢复与清理；其他平台不声明 Windows 安装验收。
- [x] `api/index.ts`、`plugin/internal.ts`、`appMain.ts` 连接自有 updater；保留账户、支付、云同步禁用边界。
- [x] `localUpdater.ts` 仅提供独立的本地产品信息与手动上游研究提醒，不注册自有更新 IPC。

### 3. 设置和更新窗口

- [x] 关于页面展示 CAI.Tools 检查入口、结果和自动检查开关；开关保存 settings-general。上游版权信息保持准确。
- [x] `UpdateWindow.vue` 标注 CAI.Tools，展示 GitHub 单一来源；错误可重试、取消可恢复。
- [x] 同步更新 `AGENTS.md` 中过时更新路径说明。

### 4. 验证与交付

- [x] 先补针对性失败测试，再实现并运行更新单测：local.9→local.10、拒绝上游 feed/降级、缺失元数据、断网/校验失败、取消重试、安装异常、下载中重复检查。
- [x] 使用真实已安装依赖的 GitHubProvider 与受控传输验证 custom local 通道，不将模拟视为线上下载证据。
- [x] `pnpm typecheck`、`pnpm test`、变更文件 lint；设置插件单独检查并区分原有问题。
- [x] `pnpm test:e2e`，源码 Electron + setting 开发服务器，全部使用隔离数据；新增更新窗口与持久化重启验证。遵循 AGENTS，不执行 electron-builder 或 build:unpack 做 E2E。
- [x] 报告中保留真实 Windows NSIS A→B 现场验收清单：需要两个含本实现的已发布版本与独立 Windows 测试安装，验证版本、安装目录、设置、插件、LMDB与异常恢复；未实际执行前不得标记完成。

## 发布与真实安装边界

旧 local.1～local.3 无法通过禁用的 updater 安装本次修复。必须先手动安装启用更新的首版，然后发布下一个更高 local 数字版本。当前请求授权本地实现与验证；公开发布前应展示具体版本、提交与制品并取得发布确认。源代码 E2E 不冒充 NSIS 完整升级验收；安装器退出后的错误不能保证由已退出的旧进程展示，需要真实安装测试。

官方参考：<https://www.electron.build/v26/docs/features/auto-update/>、<https://www.electron.build/docs/tutorials/release-using-channels/>。通道行为以仓库已安装 6.8.9 源码为准。

## 交付状态

实现与源码验证已完成，详细结果见 `docs/testing/2026-10-16-cai-tools-auto-update.md`。

- [ ] 经用户确认后发布两个启用更新的 local 版本，并执行真实 Windows NSIS A→B 现场验收；最终验收尚未通过。

## 已授权的发布与安装验收阶段

用户已授权提交、推送、发布 local.4 与 local.5。local.4 提交仅包含自动更新范围，现有 string-tools 工作区改动不纳入发布。

- [ ] 通过现有 Windows Build 工作流发布 local.4，核对标签、源码 SHA、更新元数据与制品摘要。
- [ ] 新增 `scripts/verify-windows-upgrade.cjs`：只允许 GitHub 托管的临时 Windows runner 执行，下载并校验已发布安装包，静默安装 A，使用真实安装版通过 GitHub 源下载和安装 B，再核对版本、安装目录、设置、插件文档与附件。此步骤是用户明确要求的已发布安装器验收，不用于代替源码 `pnpm test:e2e`，也不为此另行打包。
- [x] 扩展现有 `.github/workflows/build.yml` 增加 `validate_upgrade` 分支和独立安装验收 job，安装目录位于 RUNNER_TEMP，数据根使用一次性 VM 内全新账户的默认 `~/.cai-tools`，明确拒绝既存数据。原始源码 E2E 命令保持临时目录隔离方式。
- [ ] 发布 local.5 后触发验收 job，上传报告和必要截图；任何失败按真实结果修复并复验，不将模拟或文件版本变化当作完整安装成功。
- [ ] 更新验证记录、公开发布链接及剩余风险。桌面 SmartScreen/企业策略人工验收独立记录，不由无人值守测试推断。
