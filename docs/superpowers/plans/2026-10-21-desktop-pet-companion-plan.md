# 小薄荷互动第一版实施计划

Goal: 增加摸摸、喂食、文字聊天与快跑结算短评，复用现有自配 AI 供应商，并将台词和呈现分离。

Architecture: 主进程管理受限会话、模型解析和取消；独立可聚焦面板承载文字交互；原桌宠维持现有点击与拖动行为。PetUtterance 承载台词、来源、情绪与预设动作，未来语音接入同一生命周期。第一版不包含音频依赖、语音配置、长期记忆、养成数值或新游戏。

Tech Stack: Electron、TypeScript、现有 AI 协议适配器、LMDB 路由、Vitest、Playwright Electron。

## 任务与文件边界

- [x] 会话核心：`src/main/core/desktopPet/companionSession.ts`，有界会话、输入校验、单请求取消、30 秒超时、本地兜底、快跑短评；`tests/main/desktopPetCompanion.test.ts` 验证错误、取消、迟到回包、历史和输入边界。
- [x] 受控窗口：`src/main/core/desktopPet/companionManager.ts`，专用 sender/mainFrame 校验、模型选择持久化、按需面板、退出清理；配置登记在 `storageKeys.ts` / `storageRouting.ts`。
- [x] 视图：`src/renderer/src/desktopPet/companion/`、`src/renderer/desktop-pet-companion.html`、`src/preload/desktop-pet-companion.ts`，模型选择、互动按钮、流式文本、停止/清空/关闭以及本地状态提示。
- [x] 宿主集成：`floatingBallManager.ts` 增加菜单并在游戏、关闭与退出时清理；`desktopPet/main.ts` 接收预设动作并显示短时反馈。
- [x] 游戏集成：`runnerGameManager.ts`、runner preload/types/page 添加单次结算短评，重开与退出取消，失败保留本地短评。
- [x] 回归：源码 Electron E2E 使用隔离数据与本地模拟供应商，验证流式成功、停止、错误、无模型、模型持久化、菜单、互动和快跑短评，截图位于 `test-results/playwright`。

## 明确行为

初始选择为本地陪伴，不自动使用用户供应商；模型在面板选择后保存稳定 ref。快跑 AI 短评有独立开关。摸摸/喂食永远即时本地响应。聊天正文以 textContent 呈现，不执行模型文本或工具。每次回复最多 2000 字，输入最多 1000 字，最多保留 20 条对话；模型上下文仅含当前会话文字。关闭、清空、换模型、进入游戏、关闭桌宠和系统挂起均取消未完成回复，已取消的回包不得发布。

## 验证命令

1. `pnpm test tests/main/desktopPetCompanion.test.ts`：确定性注入传输，验证成功、异常及并发边界。
2. `pnpm typecheck`：主进程、渲染及现有内置插件类型检查。
3. `pnpm test:e2e tests/e2e/desktop-pet-companion.spec.ts tests/e2e/desktop-pet.spec.ts tests/e2e/desktop-pet-runner.spec.ts`：开发源码 Electron，不打包，不访问真实用户数据或真实供应商。
4. 检查真实截图及 `git diff --check`；Windows 多显示器/DPI 与真实供应商质量另列未验证边界。

## 执行方式

按 subagent-driven-development 技能分离独立界面工作，由主执行者完成会话与宿主集成；合并后依次进行范围检查、代码审查及完整验证。按用户要求在独立工作树 desktop-pet-companion 的 feat/desktop-pet-companion 分支开发；原工作区已有修改保持原样；首版验证完成后按用户授权提交并发布 local.15。

## 已完成验证

- 已拉取远端，并在独立工作树快进至 `88f4c68`（local.14）；桌宠改动位于 `feat/desktop-pet-companion`；发布版本号为 `3.2.0-local.15`。
- `node node_modules/vitest/vitest.mjs run desktopPet`：11 个文件、80 项测试全部通过，覆盖会话失败/超时/迟到回包、单局短评授权和原有桌宠/引擎回归。
- `pnpm typecheck`：node、web、context-menu 全部通过。
- 完整源码 Electron E2E：陪聊、快跑、桌宠共 6 项通过；随后在 local.14 基线构建后复验陪聊和系统空闲两项通过，包含互动被拖动打断后恢复空闲动画的回归。
- 最终专项通过 `pnpm exec electron-vite build` 构建源码，再运行 `node node_modules/@playwright/test/cli.js test --config=playwright.e2e.config.ts tests/e2e/desktop-pet-companion.spec.ts tests/e2e/desktop-pet.spec.ts --grep '陪聊|系统空闲'`。直接运行 CLI 避免 Windows pnpm 脚本对竖线的二次解释。
- 已查看真实陪聊面板与快跑短评截图；短评限制显示高度，长文本可滚动。截图位于忽略目录 `test-results/playwright`。
- AI 端到端验证使用本机 HTTP 模拟供应商和虚拟密钥，确认成功流、协议中断兜底、取消、关闭、清空、配置重启恢复及快跑新局丢弃旧短评；未调用真实付费供应商。
- 工作树复用现有依赖目录 junction，pnpm 的运行前依赖检查会提示 hoist 目录不是实体目录；随后源码构建、测试与类型检查实际完成。未修改依赖清单或锁文件。
- 尚未验收真实鼠标硬件拖动、跨显示器/DPI、真实供应商回复质量，以及 macOS/Linux 桌面行为。

## 后续扩展边界

语音仍在后续版本。以 `PetUtterance` 的 ID、正文、来源、情绪和动作作为统一台词输入；语音呈现层可按台词 ID 接入 TTS，复用停止、清空、关闭、新局与系统挂起的取消生命周期。语音供应商能力、音色、音频缓存和播放资源清理需要单独实现与验证，第一版不声明模型具备语音能力。
