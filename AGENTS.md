# AGENTS.md

## 注释规范

- 新增或实质修改的方法、函数，必须在声明正上方使用多行 JSDoc，简要说明职责。
- JSDoc 必须为每个参数提供 `@param`，并提供 `@returns`；方法可能主动抛错时补充 `@throws`。
- `void`、`Promise<void>` 方法也需要写明 `@returns`，例如“无返回值”或“操作完成后结束的 Promise”。
- 方法内部应在准备、校验、状态切换、资源发布、回滚、清理等关键步骤前添加单行注释。
- 单行注释应解释步骤目的、约束或失败边界，不要逐行复述代码行为。
- 修改实现时同步更新相关注释，禁止保留与当前行为不一致的旧注释。

## 桌宠交互原则

- 桌宠互动应通过用户动作、行为及状态变化触发，不通过操作按钮触发。
- 不提供“摸头”“喂零食”等互动按钮；后续新增互动也应遵循此原则。

## E2E 验证

- 使用 Playwright Electron 运行端到端测试：`pnpm test:e2e`。
- 修改 ZTools 后必须直接使用开发方式进行 E2E，不要为了 E2E 打包应用，不要执行 `electron-builder`、`pnpm build:unpack` 或使用 `dist/*.app`。
- 命令会先构建可供源码 Electron 启动的 ZTools 主程序，再由 Playwright 自动启动设置插件开发服务器（`127.0.0.1:15177`）和隔离的 Electron 测试实例；这不属于应用打包，无需手动启动服务。
- 专项 E2E 同样使用源码项目作为 Electron 启动参数，并通过 `ZTOOLS_SETTING_DEV_SERVER_URL=http://127.0.0.1:15177` 加载设置插件开发页面。
- E2E 使用临时数据目录，不得读写真实的 `~/.ztools`；新增用例必须继续传入隔离的数据与旧数据目录。
- 排查插件界面时直接截取插件 WebContentsView，不要与宿主窗口截图拼接。
- 默认只截取当前可见区域；只有测试明确要求时才增加全页面或滚动截图逻辑。
- 截图前必须等待页面正文中的稳定特征出现，不能只等待侧栏、标题等可能提前渲染的内容。
- 测试截图和 trace 输出到 `test-results/playwright`，该目录不提交版本库。
- Electron E2E 使用 Electron 自带的 Chromium，不需要执行 `playwright install chromium`。

## 项目概述

CAI.Tools 是基于 ZTools 的本地版应用启动器和插件平台，代码包含 macOS、Windows 和 Linux 支持，具体能力以各平台实现为准。
技术栈：Electron 41 + Vue 3 + TypeScript + Pinia + LMDB + WebContentsView。

核心能力：拼音搜索、插件系统（UI/无界面）、剪贴板管理、超级面板、分离窗口、MCP Server、AI 集成、ZBrowser 浏览器自动化、离线翻译、悬浮球、网页快开。

当前产品采用本地免登录模式。官方账号、支付和云同步由本地兼容入口明确返回不可用；启动链不得因复用历史模块而重新启用这些能力。以 `src/main/appMain.ts`、`src/main/api/index.ts` 和 `src/shared/localEdition.ts` 为准。

## 开发命令

```bash
pnpm dev              # 启动开发（主进程 + setting 内置插件并行热重载）
pnpm dev:main         # 仅启动主进程
pnpm dev:setting      # 仅启动 setting 内置插件开发服务器
pnpm typecheck        # 全部类型检查（node + web）
pnpm typecheck:node   # 主进程 + preload 类型检查
pnpm typecheck:web    # 渲染进程类型检查
pnpm build            # 编译源码（含类型检查和 setting 构建）
pnpm build:mac        # 打包 macOS
pnpm build:win        # 打包 Windows
pnpm build:linux      # 打包 Linux
pnpm build:unpack     # 打包但不生成安装包（调试用）
pnpm test             # 运行测试 (vitest)
pnpm test:e2e         # 源码 Electron E2E（隔离数据，不打包）
pnpm test:watch       # 测试观察模式
pnpm sync-api-types   # 同步 ztools-api-types 子模块类型
```

## 项目结构

```
src/main/                          # 主进程
  index.ts                         # 应用入口、单例锁、运行时兼容性检查
  appMain.ts                       # 本地版启动、ZPX 文件关联、窗口与 API 初始化
  appWatcher.ts                    # 应用目录监听（chokidar，自动检测安装/卸载）
  managers/
    windowManager.ts               # 窗口管理、全局快捷键
    pluginManager.ts               # 插件 WebContentsView 生命周期管理
    clipboardManager.ts            # 剪贴板监听和历史管理
    pluginAssemblyCoordinator.ts   # 插件装配会话状态机（加载→就绪→显示）
    proxyManager.ts                # 代理配置统一管理
  api/
    index.ts                       # API 管理器（统一初始化所有模块 + 全局快捷键处理）
    localUpdater.ts                # 本地产品信息及独立的手动上游研究提醒
    updater.ts                     # 自有 GitHub Releases 更新入口，复用平台更新器和窗口
    shared/                        # 主程序和插件共享 API
      database.ts                  # LMDB 数据库（命名空间隔离：ZTOOLS/ 和 PLUGIN/{name}/）
      clipboard.ts                 # 剪贴板 API
      imageAnalysis.ts             # 图像分析（sharp）
    renderer/                      # 主程序渲染进程专用 API
      commands.ts                  # 指令管理（历史、固定、启动）
      commandMatchers.ts           # 指令匹配纯函数（便于单元测试）
      plugins.ts                   # 插件安装/删除/市场
      window.ts                    # 窗口控制
      settings.ts                  # 设置管理
      system.ts                    # 系统功能
      systemSettings.ts            # Windows 系统设置集成
      systemCommands.ts            # 系统内置指令执行（截图、取色等）
      webSearch.ts                 # 网页快开搜索引擎管理
      localShortcuts.ts            # 本地启动项（自定义文件/文件夹/应用快捷方式）
      aiModels.ts                  # AI 模型配置管理（OpenAI 兼容格式）
    plugin/                        # 插件专用 API
      pluginApiDispatcher.ts       # 统一 API 分发器（注册表模式）
      lifecycle.ts                 # 生命周期（onPluginEnter/Out）
      ui.ts                        # UI 控制（setExpendHeight、hideWindow、setSubInput、list mode）
      window.ts                    # 插件窗口管理
      dialog.ts                    # 对话框
      clipboard.ts                 # 剪贴板操作
      input.ts                     # 输入模拟（paste/type/sendInputEvent）
      shell.ts                     # Shell 命令执行
      feature.ts                   # 动态功能管理
      device.ts                    # 设备信息
      http.ts                      # HTTP 请求
      redirect.ts                  # 搜索重定向
      screen.ts                    # 屏幕功能（截图）
      toast.ts                     # Toast 通知（独立透明窗口）
      tools.ts                     # 插件工具声明（供 MCP 消费）
      ai.ts                        # AI 对话 API（OpenAI 兼容，流式）
      zbrowser.ts                  # 浏览器自动化 API
      ffmpeg.ts                    # FFmpeg 路径获取
      internal.ts                  # 内置插件专用 API（更高权限）
  core/
    appData/appDataPaths.ts         # 本地版数据布局与隔离路径
    storage/                       # device/account 数据路由与生命周期
    gitMirror/                     # Git 镜像协议、插件投影及路径边界
    lmdb/                          # LMDB 数据持久化
      index.ts                     # Database 类主入口
      lmdbInstance.ts              # 单例实例
      syncApi.ts / promiseApi.ts   # 同步/异步 API
    zbrowser/                      # 浏览器自动化
      zbrowserManager.ts           # 窗口池管理（每插件独立 Session）
      zbrowserExecutor.ts          # 操作队列执行器
      devices.ts / types.ts        # 设备预设和类型
    commandScanner/                # 指令扫描（macOS: .app plist / Windows: .lnk 开始菜单）
    commandLauncher/               # 指令启动
    native/index.ts                # 跨平台原生模块（C++）：ClipboardMonitor、WindowMonitor、WindowManager、ScreenCapture、ColorPicker、MouseMonitor
    systemSettings/                # Windows 系统设置（ms-settings URI）
    superPanelManager.ts           # 超级面板（鼠标中键/长按右键触发，智能识别剪贴板内容）
    floatingBallManager.ts         # 悬浮球（置顶小圆球，单击/双击触发）
    translationManager.ts          # 离线翻译（Bergamot WASM + Firefox 翻译模型）
    mcpServer.ts                   # MCP JSON-RPC 服务（暴露插件工具）
    httpServer.ts                  # HTTP API 服务（外部调用 ZTools 功能）
    ffmpeg.ts                      # FFmpeg 下载管理（按平台从 GitHub 下载）
    doubleTapManager.ts            # 双击修饰键检测（uiohook-napi）
    detachedWindowManager.ts       # 分离窗口管理（插件独立为窗口）
    pluginWindowManager.ts         # 插件创建的独立窗口管理
    internalPlugins.ts             # 内置插件定义
    internalPluginLoader.ts        # 内置插件加载器
    iconProtocol.ts                # ztools-icon:// 协议（图标加载）
    screenCapture.ts               # 屏幕截图
    logCollector.ts                # 日志收集
    globalStyles.ts                # 全局滚动条样式注入
  common/
    constants.ts                   # 常量
    iconUtils.ts                   # 图标工具
  utils/
    zpxArchive.ts                  # ZPX 归档（asar + gzip）
    lanzou.ts                      # 蓝奏云 API
    download.ts                    # 文件下载
    httpRequest.ts                 # HTTP 请求工具
    windowUtils.ts                 # 窗口材质工具
    clipboardFiles.ts              # 剪贴板文件读取
    appleScriptHelper.ts           # macOS AppleScript 辅助
    elevation.ts                   # 权限提升
    systemPaths.ts                 # 系统路径
    devToolsShortcut.ts            # 开发者工具快捷键
    common.ts                      # 通用工具函数

src/preload/index.ts               # 主程序 preload（contextBridge → window.ztools）
resources/preload.js               # 插件 preload（不经过 Vite 构建，修改需重启）

src/renderer/src/                  # 渲染进程 Vue 源码
  App.vue                          # 两种视图：Search / Plugin
  stores/
    commandDataStore.ts            # 指令数据核心（搜索引擎、历史、固定列表）
    commandUtils.ts                # 指令工具函数
    windowStore.ts                 # 窗口和 UI 配置
  composables/
    useSearchResults.ts            # 搜索结果逻辑
    useMainPushResults.ts          # mainPush 结果（插件回调搜索结果）
    useNavigation.ts               # 键盘导航
    useColorScheme.ts              # 颜色方案
  components/
    search/
      SearchBox.vue                # 搜索框
      SearchResults.vue            # 搜索结果展示
      AggregateView.vue            # 聚合视图（历史+固定+窗口匹配+mainPush）
      UpdateIcon.vue               # 更新提示图标
    common/
      VerticalList.vue             # 垂直列表（搜索结果项渲染）
      CollapsibleList.vue          # 可折叠列表（历史/固定区域）
      CommandList.vue              # 指令列表
      MainPushList.vue             # mainPush 结果列表
      DetailPanel.vue              # 详情面板
      AdaptiveIcon.vue             # 自适应图标
    detached/DetachedTitlebar.vue  # 分离窗口标题栏
    updater/UpdateWindow.vue       # 更新窗口
    SuperPanel.vue                 # 超级面板 UI

internal-plugins/                  # 内置插件
  setting/                         # 应用设置插件（独立 Vue 项目，Vite + UnoCSS）
  system/                          # 系统工具插件
  string-tools/                    # 字符串处理插件（静态 HTML/CSS/JS）

ztools-api-types/                  # 插件 API 类型定义子模块（对外发布）
```

## 核心概念

### 万物皆指令

所有可搜索内容统一为 `Command` 类型：

- `type: 'direct'` - 直接启动（`subType: 'app'` 系统应用 / `subType: 'system-setting'` Windows 设置）
- `type: 'plugin'` - 插件功能
- `type: 'builtin'` - 内置功能（系统指令如截图、取色等）

### 命令匹配类型

`plugin.json` 的 `features[].cmds` 支持 6 种类型：

| 类型     | 说明                                | 存储位置                   |
| -------- | ----------------------------------- | -------------------------- |
| 字符串   | 功能指令，支持拼音搜索              | `commands` 数组（Fuse.js） |
| `regex`  | 正则匹配用户输入                    | `regexCommands` 数组       |
| `over`   | 匹配任意文本（可设排除规则）        | `regexCommands` 数组       |
| `img`    | 匹配粘贴的图片                      | `regexCommands` 数组       |
| `files`  | 匹配粘贴的文件（可限制类型/扩展名） | `regexCommands` 数组       |
| `window` | 匹配当前活动窗口（应用名/窗口标题） | `regexCommands` 数组       |

### 插件系统

- **UI 插件**：`plugin.json` 有 `main` 字段 → WebContentsView 加载界面
- **无界面插件**：无 `main` 字段 → WebContentsView 加载空白页，通过 `window.exports[featureCode].args.enter()` 执行
- **数据隔离**：插件数据库自动添加 `PLUGIN/{pluginName}/` 前缀
- **内置与权限分离**：随包内置不等于内部 API 授权；`string-tools` 是内置插件，但不拥有 `window.ztools.internal` 特权。名单以 `src/main/core/internalPlugins.ts` 为准。
- **部署**：生产用 ZPX（gzip asar），开发用本地目录或 HTTP URL
- **API 注入**：通过 `resources/preload.js` + `session.registerPreloadScript()`
- **装配流程**：`pluginAssemblyCoordinator.ts` 管理状态机（idle → assembling → domReady → readyToDisplay → displayed）

### 插件 API 分发器

新的插件 API 优先通过 `pluginApiDispatcher.ts` 的 `registerPluginApiServices` 注册。handler 接收 `(event, args)`；插件 preload 通过 `ipcSendSync`、`ipcInvoke` 或 `ipcSend` 调用，再向插件页面暴露命名方法。不要假设存在通用 `ztools.callService` 方法。直接使用 `ipcMain.handle`/`ipcMain.on` 的旧方式仍在使用，详见下文。

### 数据持久化 (LMDB)

默认数据根目录为 `~/.cai-tools`，可通过 `ZTOOLS_DATA_ROOT` 显式覆盖；路径解析以 `src/main/core/appData/appDataPaths.ts` 为准，不再假定数据库位于 Electron `userData` 下。

设备库位于 `<root>/lmdb/device`，默认账户库位于 `<root>/lmdb/accounts/default`。`lmdbInstance` 实际导出 `StorageRouter`，按 key 路由到 device/account LMDB；每个物理 LMDB 保持自身的文档、元数据和附件存储。不得绕过路由读写或自动探测、导入原版用户数据。

命名空间：`ZTOOLS/`（主程序）、`PLUGIN/{name}/`（插件，自动隔离）、`SYNC/`（同步配置）。

`window.ztools.dbGet/dbPut` 自动添加 `ZTOOLS/` 前缀。插件通过 `db.put/get` 自动添加 `PLUGIN/{name}/` 前缀。

存储归属以 `src/main/core/storage/storageRouting.ts` 为准。AI 凭据保留在设备本地；插件数据导出应使用显式投影适配器，不得将全部 `PLUGIN/` 数据直接纳入 Git 镜像。协议与投影已有实现不代表完整多机同步流程已完成。

## 关键代码路径

未写完整前缀的 `api/`、`core/`、`managers/` 路径相对 `src/main/`；`stores/`、`components/`、`composables/` 相对 `src/renderer/src/`。`resources/` 和 `internal-plugins/` 相对仓库根目录。

| 修改目标         | 关键文件                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 插件系统         | `managers/pluginManager.ts`, `api/renderer/plugins.ts`, `api/plugin/`, `resources/preload.js`                  |
| 搜索逻辑         | `stores/commandDataStore.ts`, `components/search/SearchResults.vue`, `composables/useSearchResults.ts`         |
| 指令管理         | `api/renderer/commands.ts`, `api/renderer/commandMatchers.ts`, `core/commandScanner/`, `core/commandLauncher/` |
| 数据库           | `core/lmdb/`, `api/shared/database.ts`                                                                         |
| 剪贴板           | `managers/clipboardManager.ts`, `core/native/index.ts`                                                         |
| 窗口管理         | `managers/windowManager.ts`, `core/detachedWindowManager.ts`                                                   |
| 超级面板         | `core/superPanelManager.ts`, `components/SuperPanel.vue`                                                       |
| 本地兼容入口     | `src/main/api/renderer/localCapabilities.ts`, `src/main/api/plugin/localUserCapabilities.ts`                   |
| Git 镜像         | `src/main/core/gitMirror/`, `src/shared/gitMirrorTypes.ts`                                                     |
| 历史云同步       | `core/sync/`, `api/renderer/sync.ts`（保留源码，不代表本地版启动时启用）                                       |
| 插件 AI          | `api/plugin/ai.ts`, `api/renderer/aiModels.ts`                                                                 |
| 浏览器自动化     | `core/zbrowser/`, `api/plugin/zbrowser.ts`                                                                     |
| 内置插件         | `internal-plugins/`, `core/internalPlugins.ts`, `core/internalPluginLoader.ts`                                 |
| 自有版本更新     | `src/main/api/updater.ts`, `src/main/api/electronUpdater.ts`, `src/main/api/platformUpdater/windows.ts`        |
| 手动上游研究提醒 | `src/main/api/localUpdater.ts`, `src/main/core/localEdition/upstreamUpdateNotice.ts`                           |
| MCP 服务         | `core/mcpServer.ts`, `api/plugin/tools.ts`                                                                     |
| 翻译             | `core/translationManager.ts`                                                                                   |
| IPC 通信         | `api/index.ts`（统一初始化），`api/shared/`、`api/renderer/`、`api/plugin/`                                    |
| UI 样式          | `src/renderer/src/style.css`（通用控件类：.btn .input .select .toggle .card）                                  |

## 添加新功能指南

### IPC 体系概览

项目有**两个独立的 preload 文件**，分别面向不同消费者，暴露的 `window.ztools` 接口完全不同：

|                  | 主程序渲染进程                    | 插件（第三方 + 内置）            |
| ---------------- | --------------------------------- | -------------------------------- |
| **Preload 文件** | `src/preload/index.ts`            | `resources/preload.js`           |
| **构建方式**     | 经过 Vite 构建                    | **不经过 Vite**，原生 JS         |
| **注入方式**     | `contextBridge.exposeInMainWorld` | 直接挂载 `window.ztools`         |
| **类型声明**     | `src/renderer/src/env.d.ts`       | `ztools-api-types/` 子模块       |
| **消费者**       | `src/renderer/src/` 下的 Vue 应用 | 第三方插件 + `internal-plugins/` |
| **修改后生效**   | 热重载                            | 需要**重启应用**                 |

### 新增主程序渲染进程 API

面向主窗口 Vue 应用（搜索界面、超级面板等）。

**步骤**：

1. **主进程 handler**：在 `src/main/api/renderer/xxx.ts` 中 `ipcMain.handle('channel', handler)`
2. **Preload 暴露**：在 `src/preload/index.ts` 的 `api` 对象中添加方法（如 `myFeature: () => ipcRenderer.invoke('channel')`）
3. **类型声明**：在 `src/preload/index.ts` 底部的 `declare global { interface Window { ztools: { ... } } }` 中添加类型
4. **同步更新** `src/renderer/src/env.d.ts`（渲染进程 IDE 提示用）

### 新增插件 API

面向第三方插件开发者。有两种注册方式：

#### 方式一：plugin.api 统一分发器（推荐）

通过 `pluginApiDispatcher.ts` 注册，插件端通过 `ipcSendSync`/`ipcInvoke`/`ipcSend` 三个公共方法调用。

**步骤**：

1. **主进程注册**：在 `src/main/api/plugin/xxx.ts` 中调用 `registerPluginApiServices`
2. **Preload 暴露**：在 `resources/preload.js` 的 `window.ztools` 对象中添加调用入口
3. **初始化**：在 `src/main/api/index.ts` 的 `APIManager.init()` 中导入并 `init()`

```typescript
// src/main/api/plugin/xxx.ts
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { registerPluginApiServices } from './pluginApiDispatcher'

class MyPluginAPI {
  /**
   * 注册本模块的同步和异步插件 API。
   * @returns 无返回值。
   */
  public init(): void {
    // 同步结果必须写入 event.returnValue，异步结果通过 Promise 返回。
    registerPluginApiServices({
      /**
       * 同步返回调用方传入的文本。
       * @param event 当前同步 IPC 事件。
       * @param value 调用方传入的文本。
       * @returns 无返回值，结果写入 event.returnValue。
       */
      mySync: (event: IpcMainEvent, value: string): void => {
        event.returnValue = value
      },
      /**
       * 异步返回调用方传入的文本。
       * @param _event 当前异步 IPC 事件。
       * @param value 调用方传入的文本。
       * @returns 包含原文本的 Promise。
       */
      myAsync: async (_event: IpcMainInvokeEvent, value: string): Promise<string> => {
        return value
      }
    })
  }
}
```

```javascript
// resources/preload.js - 插件端入口
Object.assign(window.ztools, {
  /**
   * 同步调用主进程文本接口。
   * @param {string} value 输入文本。
   * @returns {string} 主进程返回的文本。
   */
  mySync: (value) => ipcSendSync('mySync', value),
  /**
   * 异步调用主进程文本接口。
   * @param {string} value 输入文本。
   * @returns {Promise<string>} 主进程返回文本的 Promise。
   */
  myAsync: (value) => ipcInvoke('myAsync', value)
})
```

**三个公共方法**（定义在 `resources/preload.js` 顶部）：

- `ipcSendSync(apiName, args)` → `ipcMain.on('plugin.api')` → 同步返回
- `ipcInvoke(apiName, args)` → `ipcMain.handle('plugin.api')` → 异步返回 Promise
- `ipcSend(apiName, args)` → `ipcMain.on('plugin.api')` → 单向发送，无返回值

#### 方式二：直接 IPC（旧方式，仍在使用）

部分 API（如 `db:put`、`set-expend-height`、`show-notification` 等）直接在各模块中 `ipcMain.handle`/`ipcMain.on`，不走分发器。

**步骤**：

1. **主进程 handler**：在 `src/main/api/plugin/xxx.ts` 中直接 `ipcMain.handle('channel', handler)`
2. **Preload 暴露**：在 `resources/preload.js` 中直接调用 `electron.ipcRenderer.invoke('channel')`

```javascript
// resources/preload.js
Object.assign(window.ztools, {
  /**
   * 调用已通过直接 IPC 注册的功能。
   * @param {string} value 调用参数。
   * @returns {Promise<unknown>} 主进程 handler 的结果。
   */
  myFeature: (value) => electron.ipcRenderer.invoke('plugin:my-feature', value)
})
```

### 新增内置插件 API

面向经宿主授权的插件（包括 setting、system），通过 `window.ztools.internal` 命名空间访问，提供更高系统权限。授权以 `canPluginUseInternalApi` 及发送者检查为准，不得仅凭插件位于 `internal-plugins/` 就授予特权。

**步骤**：

1. **主进程 handler**：在 `src/main/api/plugin/internal.ts` 中 `ipcMain.handle('internal:channel', handler)`
2. **Preload 暴露**：在 `resources/preload.js` 的 `window.ztools.internal` 对象中添加方法

通道名约定使用 `internal:` 前缀。内置插件 API 同时可以直接调用普通插件 API（如 `db`、`clipboard` 等）。

### 新增 API 模块通用模板

```typescript
// src/main/api/{shared|renderer|plugin}/newModule.ts
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { PluginManager } from '../../managers/pluginManager'

class NewAPI {
  /**
   * 初始化模块；按业务需要接收宿主依赖。
   * @param _mainWindow 可选的主窗口。
   * @param _pluginManager 可选的插件管理器。
   * @returns 无返回值。
   */
  public init(_mainWindow?: BrowserWindow, _pluginManager?: PluginManager): void {
    this.setupIPC()
  }
  /**
   * 注册示例渲染进程 IPC 通道。
   * @returns 无返回值。
   */
  private setupIPC(): void {
    // 插件模块优先采用上文的统一分发器，不重复注册同名通道。
    ipcMain.handle(
      'new-module:echo',
      /**
       * 返回渲染进程传入的文本。
       * @param _event 当前异步 IPC 事件。
       * @param value 调用方传入的文本。
       * @returns 原文本。
       */
      (_event: IpcMainInvokeEvent, value: string): string => value
    )
  }
}
export default new NewAPI()
```

在 `src/main/api/index.ts` 的 `APIManager.init()` 中导入并调用 `newAPI.init()`。

## 注意事项

- 项目有两套独立的 preload（主程序用 `src/preload/index.ts` vs 插件用 `resources/preload.js`），详见"IPC 体系概览"
- `resources/preload.js` 不经过 Vite 构建，修改后需重启应用
- `src/preload/index.ts` 底部的类型声明需要与 `src/renderer/src/env.d.ts` 保持同步
- 主进程和渲染进程类型检查分开运行
- 优先使用 `style.css` 中的通用控件类（.btn .input .select .toggle .card），不在组件中重复定义
- 内置插件 setting 是独立 Vue 项目（`internal-plugins/setting/`），有自己的 vite.config.ts
- 原生模块：macOS `resources/lib/mac/ztools_native.node`，Windows `resources/lib/win/ztools_native.node`
- 插件数据自动隔离，删除插件时自动清理历史和固定列表
- 新的插件 API 优先使用 `registerPluginApiServices` 注册到统一分发器
