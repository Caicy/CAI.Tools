# 贡献指南

感谢你对 CAI.Tools 的关注！我们欢迎所有形式的贡献。

CAI.Tools 是 [ZTools](https://github.com/ZToolsCenter/ZTools) 的免登录本地版分支。贡献前请先阅读 [AGENTS.md](./AGENTS.md)，其中的架构说明、IPC 体系与注释规范是权威依据。

## 📋 贡献方式

### 报告 Bug

如果你发现了 Bug，请在 [Issues](https://github.com/Caicy/CAI.Tools/issues) 中创建一个新的 Issue，并提供以下信息：

- 操作系统版本（macOS/Windows/Linux 版本号）
- CAI.Tools 版本号（设置页或 `package.json`）
- 详细的复现步骤
- 预期行为和实际行为
- 错误日志（如果有）
- 截图（如果适用）

与本地版改动无关的上游通用问题，请提交到 [ZToolsCenter/ZTools](https://github.com/ZToolsCenter/ZTools/issues)。

### 提出新功能

如果你有新功能的想法：

1. 先在 Issues 中搜索，确保没有重复的建议
2. 创建一个新的 Feature Request Issue
3. 详细描述功能需求和使用场景
4. 如果可能，提供设计草图或示例

注意：官方账号登录、支付与官方云同步属于本地版明确不提供的能力，不接受重新启用这些链路的提案，详见下文「本地版约束」。

### 提交代码

我们欢迎 Pull Request！请遵循以下流程。

## 🔧 开发流程

### 1. Fork 和克隆

```bash
# Fork 本仓库到你的账号，然后克隆你的 fork（必须带子模块）
git clone https://github.com/your-username/CAI.Tools.git --recurse-submodules
cd CAI.Tools

# 添加上游仓库
git remote add upstream https://github.com/Caicy/CAI.Tools.git
```

仓库包含两个子模块：`ztools-api-types`（插件 API 类型定义）和 `ztools-plugin-cli`（插件开发 CLI）。如需修改它们，请分别 fork [ztools-api-types](https://github.com/ZToolsCenter/ztools-api-types) 和 [ztools-plugin-cli](https://github.com/ZToolsCenter/ztools-plugin-cli)。

已经克隆但缺少子模块时：

```bash
git submodule update --init --recursive
```

### 2. 创建分支

```bash
# 从 main 分支创建新分支
git checkout -b feature/my-feature
# 或
git checkout -b fix/my-bugfix
```

分支命名规范：

- `feature/` - 新功能
- `fix/` - Bug 修复
- `docs/` - 文档更新
- `refactor/` - 代码重构
- `perf/` - 性能优化
- `test/` - 测试相关

### 3. 开发

环境要求：

- Node.js >= 22（CI 使用 22）
- pnpm 11（CI 使用 11.18.0）

```bash
# 安装依赖（postinstall 会自动配置 git hooks）
pnpm install

# 启动开发模式（主进程 + setting 内置插件并行热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 代码格式化
pnpm format

# ESLint 检查
pnpm lint

# 测试
pnpm test
pnpm test:e2e
```

修改 `resources/preload.js`（插件 preload）后需要重启应用，该文件不经过 Vite 构建。

### 4. 提交

提交信息格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

类型（type）：

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式调整（不影响功能）
- `refactor`: 代码重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具相关

示例：

```bash
git commit -m "feat(plugin): add clipboard history plugin"
git commit -m "fix(search): fix pinyin search issue"
git commit -m "docs: update plugin development guide"
```

提交信息说明「为什么」而不只是「改了什么」。

### 5. 推送和创建 PR

```bash
# 推送到你的 fork
git push origin feature/my-branch
```

PR 标题格式：

- 使用清晰简洁的标题
- 参考 commit 信息格式
- 如 `feat: add xxx feature` 或 `fix: resolve xxx issue`

PR 描述应包含：

- **变更内容**：详细说明做了什么改动
- **动机**：为什么要做这个改动
- **测试**：运行了哪些验证（`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`）
- **截图**：如果涉及 UI 改动，提供截图
- **相关 Issue**：如 `Closes #123`

提交前请确保 `pnpm typecheck`、`pnpm lint` 和 `pnpm test` 全部通过。

## 📝 代码规范

### TypeScript

- 使用 TypeScript 编写所有代码
- 为所有函数添加类型注解
- 避免使用 `any`，优先使用具体类型或泛型
- 遵循项目的 ESLint 规则

### 命名规范

- 文件名：使用 camelCase（如 `pluginManager.ts`）
- 组件名：使用 PascalCase（如 `SearchResults.vue`）
- 变量/函数名：使用 camelCase（如 `getUserInfo`）
- 常量：使用 UPPER_SNAKE_CASE（如 `MAX_HISTORY_SIZE`）
- 接口/类型：使用 PascalCase（如 `PluginConfig`）

### Vue 组件

- 使用 Composition API
- 使用 `<script setup>` 语法
- 优先复用 `src/renderer/src/style.css` 中的通用控件类（`.btn` `.input` `.select` `.toggle` `.card`），不要在组件内重复定义
- 组件按以下顺序组织：
  1. imports
  2. props/emits
  3. composables/stores
  4. reactive state
  5. computed
  6. methods
  7. lifecycle hooks

### 注释

- 新增或实质修改的方法、函数，必须在声明正上方使用多行 JSDoc 说明职责
- JSDoc 必须为每个参数提供 `@param`，并提供 `@returns`；可能主动抛错时补充 `@throws`
- `void`、`Promise<void>` 方法也要写明 `@returns`，例如「无返回值」
- 方法内部在准备、校验、状态切换、资源发布、回滚、清理等关键步骤前添加单行注释，解释目的、约束或失败边界，不要逐行复述代码
- 修改实现时同步更新注释，禁止保留与当前行为不一致的旧注释

```typescript
/**
 * 搜索应用和插件。
 * @param query 搜索关键词。
 * @returns 搜索结果对象，包含模糊匹配和正则匹配结果。
 */
function search(query: string): SearchResult {
  // ...
}
```

### IPC 与插件 API

- 主程序渲染进程 API 走 `src/preload/index.ts`（contextBridge），并同步更新 `src/renderer/src/env.d.ts` 类型
- 插件 API 走 `resources/preload.js`，优先通过 `registerPluginApiServices` 注册到统一分发器
- 不要假设存在通用 `ztools.callService` 方法
- 内置插件（`internal-plugins/`）随包打包不等于拥有 `window.ztools.internal` 特权，授权名单以 `src/main/core/internalPlugins.ts` 为准

## 🧪 测试

项目已有完整的自动化测试，新增或修改功能必须补充对应用例。

| 目录              | 内容                           | 运行方式        |
| ----------------- | ------------------------------ | --------------- |
| `tests/main/`     | 主进程单元测试                 | `pnpm test`     |
| `tests/renderer/` | 渲染进程逻辑单元测试           | `pnpm test`     |
| `tests/scripts/`  | 构建与发布脚本测试             | `pnpm test`     |
| `tests/e2e/`      | Playwright Electron 端到端测试 | `pnpm test:e2e` |

### 单元测试

- 使用 Vitest，配置见 `vitest.config.ts`（`maxWorkers: 4`，限制 Windows worker 争用）
- `tests/setup/isolatedData.ts` 会在每个测试文件导入业务模块前分配唯一临时数据根和旧数据目录
- 用例可以进一步细分隔离路径；不要依赖其他用例创建的临时目录

### 端到端测试

- E2E 使用源码 Electron 启动，**不要为测试打包应用**，不要执行 `electron-builder` 或 `pnpm build:unpack`
- Playwright 会自动启动 setting 插件开发服务器（`127.0.0.1:15177`，`--strictPort`）和隔离的 Electron 实例，运行前请确认该端口空闲
- Electron E2E 使用 Electron 自带的 Chromium，不需要执行 `playwright install chromium`
- 单个用例：`pnpm test:e2e tests/e2e/string-tools.spec.ts`

### 数据隔离（强制）

- 测试必须使用临时数据目录，**不得读写真实的 `~/.cai-tools` 或 `~/.ztools`**
- 新增用例必须继续传入隔离的数据根与旧数据目录
- 曾因未设置隔离环境变量导致旧用例初始化真实用户数据库，该记录保留在验收文档中，不要重犯

### 截图与产物

- 排查插件界面时直接截取插件 WebContentsView，不要与宿主窗口截图拼接
- 默认只截取当前可见区域；仅当测试明确要求时才增加全页面或滚动截图
- 截图前必须等待页面正文中的稳定特征出现，不能只等待侧栏、标题等可能提前渲染的内容
- 截图与 trace 输出到 `test-results/playwright`，该目录不提交版本库

## 🔒 本地版约束

本地版免登录，以下边界不得在贡献中被破坏：

- 启动链不得重新启用官方账号、支付、云同步、活动心跳或原版更新器；相关兼容入口必须继续返回明确的 `OFFICIAL_CAPABILITY_UNAVAILABLE`，不能静默失败
- 插件市场保持匿名访问，不得为请求附加 `Authorization`
- AI 能力只使用用户自配的供应商
- 更新只做手动上游版本检查，自动检查保持关闭，不下载或安装更新包
- 数据根固定为 `~/.cai-tools`（可由 `ZTOOLS_DATA_ROOT` 覆盖），不得探测或自动导入原版 `.ztools` 数据
- AI 凭据保留在设备本地；插件数据导出必须使用显式投影适配器，不得将全部 `PLUGIN/` 数据直接纳入 Git 镜像

权威实现：`src/main/appMain.ts`、`src/main/api/index.ts`、`src/shared/localEdition.ts`。

## ⚠️ 提交钩子

`pnpm install` 会通过 postinstall 执行 `pnpm hooks:install`，将 `core.hooksPath` 指向 `.githooks`。

`pre-commit` 钩子会无条件运行 `pnpm run format`（即 `prettier --write .`），格式化**整个仓库**，随后只重新暂存本次已 staged 的文件。在 Windows 上（`core.autocrlf=true`）这会把大量文件从 CRLF 改写为 LF，`git status` 因此可能显示数百个「已修改」文件，但 `git diff` 中它们没有内容差异。

提交后如需清理这类噪音：

```bash
git status --porcelain | wc -l            # 查看数量
git diff --numstat                        # 只有真实内容变更的文件会出现在这里
git checkout -- .                         # 还原钩子产生的无关改动
```

不要绕过钩子（`--no-verify`）。如果确实需要仓库级修复，请单独提 Issue 讨论 `.gitattributes` 或 Prettier `endOfLine` 配置。

## 📚 文档

如果你的改动涉及：

- 新功能：更新 `README.md` 与 `README_CN.md`（两份必须保持章节对应），必要时更新 [AGENTS.md](./AGENTS.md)
- API 变更：更新 AGENTS.md 中的 API 文档；插件 API 类型变更需同步 `ztools-api-types` 子模块
- 配置变更：更新相关文档
- 行为或版本变更：更新 [changelog.md](./changelog.md)
- Bug 修复：可选择更新文档

## ❓ 问题？

如果你有任何问题，可以：

- 在 Issues 中提问
- 查看 [AGENTS.md](./AGENTS.md) 开发规范与技术文档
- 查看 `docs/` 下的 [HTTP API](./docs/http-api.md)、[Provider 开发指南](./docs/provider-development-guide.md) 等文档
- 查看现有的 Pull Requests

## 📜 行为准则

我们期望所有贡献者：

- 友好、尊重他人
- 接受建设性批评
- 专注于对项目最有利的事情
- 对社区表现出同理心

## 🎉 感谢

感谢你的贡献！每一个 PR、Issue、建议都会让 CAI.Tools 变得更好。
