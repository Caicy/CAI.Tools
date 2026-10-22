# CAI.Tools Branding Implementation Plan

**Goal:** 将当前产品展示、维护者、反馈和发布信息统一为 CAI.Tools / Caicy，在关于页保留原作者与明确致谢。

**Architecture:** 复用已有自有仓库和本地产品名称；只更新产品展示与打包元数据，不改插件协议、数据库命名空间、环境变量、上游依赖地址或历史账号服务。

**Tech Stack:** Electron、Vue 3、TypeScript、Playwright。

- [x] 更新 package.json 作者、electron-builder.yml 维护者和文件关联名称；保留 MIT 原版权并补充本地版修改署名。
- [x] 关于页展示 Caicy、项目源码和反馈入口；在独立致谢区保留 Zing / lzx8589561、ZToolsCenter、上游链接及 MIT 说明。
- [x] 替换窗口标题、托盘、系统通知、当前设置与内置指令的 ZTools 展示文字。保留技术兼容名称和明确标注的上游服务。
- [x] 更新 README 的当前版本与维护者说明、问题模板；同步依赖旧窗口标题的 E2E。
- [x] 添加品牌 E2E：从“关于 CAI.Tools”真实指令进入关于页，检查维护者、署名及链接；截取当前插件 WebContentsView。
- [x] 运行主项目与设置插件类型检查、相关单元测试、源码 Electron 品牌和更新专项 E2E，复核残留及 git diff --check。

## 新字母标识

用户明确选择新的 CAI.Tools 字母标识。原创矢量源在 `resources/branding/`，生成脚本为 `scripts/generate-brand-icons.cjs`，已更新应用、设置、托盘及 PNG/ICO/ICNS 安装图标。已实际解码所有图像并检查 ICO/ICNS 容器偏移，未进行应用打包或跨平台原生安装验证。

## 验证记录

- 主项目 `pnpm typecheck` 的 node、web 和 context-menu 检查通过。
- 设置插件独立类型检查仍报既有错误；已从 HEAD 创建只读源码副本至忽略目录 `test-results/branding-baseline`，复现同组错误（ShortcutEditor、AiModelEditor、usePluginCommandActions、ShortcutsSetting 等），关于页未新增类型错误。
- 全量单元测试：107 文件通过，3 文件失败；967 项通过，4 项失败。失败中的 3 项是超时，单进程复验 localAiCapabilities/localCapabilities 后 18 项全部通过；Windows 注册表实机用例单独复验仍在 180 秒超时。未修改无关的注册表实现或放宽断言。
- 首次源码 Electron E2E：品牌和 ESC 隐藏 2 项通过；更新与紧凑顶部栏 2 项在最终关闭/重启测试实例时达到 120 秒上限，trace 显示业务断言已完成，但本轮不能记为通过。另有 worker 退出超时。
- 新图标更新后的品牌专项复验通过：1 项，1.1 分钟。已人工查看关于页和致谢区两张实际 WebContentsView 截图，名称、图标、Caicy 维护者及原作者致谢显示完整；截图位于 `test-results/playwright/branding-final/`。

- PNG、ICO 和 ICNS 实际解码与图标容器偏移检查通过；`git diff --check` 通过。Windows/macOS 原生安装及托盘硬件显示未进行验收。

## 继续验证（2026-10-22）

- 单独复现更新测试时发现：更新窗口获取焦点会触发设置插件 `onPluginOut`，将路由重置到通用设置；原用例无范围的 `input[type="checkbox"]` 因此操作了开机启动开关，更新偏好仍为 undefined。已修正用例：关闭更新窗口后重新进入关于页，等待 `.upstream-notice` 正文，并仅点击该区域已勾选的更新复选框。
- `pnpm test:e2e tests/e2e/auto-update.spec.ts tests/e2e/compact-header.spec.ts --output=test-results/playwright/exit-recheck`：2 项通过，耗时 2.3 分钟，包含两次启动、偏好与插件数据回读及正常退出。此次未修改生产退出逻辑、未增加超时。
- 注册表只读分段探测：普通菜单 88 项（4.75 秒）、新式菜单 16 项（10.45 秒）均成功；后续实机写入用例结果另记。仅凭此前总超时不能推断注册表实现失败。
- 恢复独立类型检查生成的 `tsconfig.web.tsbuildinfo`，不将缓存变化混入产品修改。

- 注册表完整实机用例再次在 180 秒超时，临时备份表明已完成扩展屏蔽与批量还原，尚未完成经典菜单部分。只读探测显示每次完整 Appx 枚举需约 10 秒，而原 `stateOf` 每次都触发完整枚举。已调整测试回读辅助方法：首次 `manager.list()` 继续执行真实完整枚举，之后对唯一测试项使用真实 `list-registry` 并限制到 `*` 位置；所有状态、备份、跨实例还原与经典菜单断言以及 180 秒上限保持。

- 注册表优化后的真实用例通过：1 项，55.98 秒。三态切换、批量部分失败、扩展屏蔽、经典菜单和跨实例还原全部执行并通过；生产实现未改，超时仍为 180 秒。本轮超时残留的唯一 CAIToolsTest 菜单项已按临时备份中的随机标识清理，并用 reg query 确认不存在。

- 最终 `pnpm test --maxWorkers=1`：110 个文件、971 项测试全部通过，耗时 89.87 秒；其中 Windows 实机注册表用例 46.85 秒通过。单 worker 避免此前并行模块转换争用，未更改 Vitest 默认 worker 配置。
- 本轮修改仅涉及两处测试与验证记录。设置插件独立类型检查的既有错误仍保留此前基线证据；不宣称独立类型检查已通过。没有提交、发布或打包。

## 2026-10-23 后续修复

设置插件既有类型错误现已由 agy 起草修复并经 Codex 独立复核，设置插件 vue-tsc 和完整 pnpm build 已通过。全量单元测试单 worker 110 文件、971 项通过；最终发布及运行时验证记录见 [设置类型修复与发布计划](2026-10-23-setting-type-repair-release.md)。
