# Remove Pet Text Panel Implementation Plan

**Goal:** 移除桌宠文字聊天面板和右键打开入口。

**Architecture:** 删除聊天窗口页面、preload、IPC 和专用 UI 类型。CompanionManager 仅保留快跑结算短评及取消生命周期，继续读取已有设备偏好，不主动改写用户数据。

**Tech Stack:** Electron、TypeScript、Playwright、Vitest。

- [x] 从 src/main/core/floatingBallManager.ts 删除聊天菜单项与 openCompanion；关闭调用改为取消短评。
- [x] 简化 src/main/core/desktopPet/companionManager.ts，保留 init、transport、review、cancel、cleanup；删除窗口、聊天 IPC 和相关依赖。
- [x] 删除 src/preload/desktop-pet-companion.ts、src/renderer/desktop-pet-companion.html、src/renderer/src/desktopPet/companion/main.ts、style.css，并删除 electron.vite.config.ts 的两处构建入口及专用 UI 类型。
- [x] 更新 tests/e2e/desktop-pet-companion.spec.ts：验证右键菜单没有聊天和按钮互动入口，旧聊天 IPC 未注册，快跑仍可启动并显示结算短评；继续使用隔离新旧数据目录。
- [x] 运行 pnpm typecheck、pnpm test tests/main/desktopPetCompanion.test.ts、pnpm test:e2e tests/e2e/desktop-pet-companion.spec.ts，检查 git diff --check。

## 验证记录

- `pnpm typecheck`：通过。
- `pnpm test tests/main/desktopPetCompanion.test.ts`：20 项通过。
- `pnpm test:e2e tests/e2e/desktop-pet-companion.spec.ts tests/e2e/desktop-pet.spec.ts`：移除面板专项、系统空闲睡眠两项通过；已有桌宠配置/交互用例在挥手采样中未捕获第 31 帧（实际采到 24、26、27、28、29、30），已启动单独复验。没有因此改动动画实现或放宽断言。
- 构建产物中 `out/renderer/desktop-pet-companion.html` 与 `out/preload/desktop-pet-companion.js` 均不存在。

- 桌宠配置/交互用例在相同源码产物上单独复验通过（1 项，2.0 分钟）。首次组合运行有末帧采样波动，未改动动画代码或测试断言。
