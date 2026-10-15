# 字符串处理内置插件实施计划

**Goal:** 在 CAI.Tools 内提供可搜索启动、离线运行、实时预览和复制的字符串工具。

**Architecture:** `internal-plugins/string-tools/public` 保存独立静态界面、纯转换模块和最小剪贴板 preload。沿用宿主内置插件装载机制，无新增依赖、服务器、历史持久化或网络请求。

**Tech Stack:** HTML/CSS、ES modules、Electron preload、Vitest、Playwright Electron。

## 功能约定

- SQL IN：按换行或制表符拆项，默认去首尾空格、忽略空行、去重且保持顺序。逐项自动识别普通十进制数；不经过 Number，长 ID 不丢精度。前导零编号按文本保留。可选择全部文本或全部数字，可加括号；数字模式拒绝不符合格式的值。文本的单引号按 SQL 标准重复转义，含反斜杠时提示数据库转义模式差异。
- 命名转换：小写、大写、PascalCase、camelCase、snake_case、kebab-case；驼峰与缩写边界拆词，每行独立转换。
- Unicode：解码 `\uXXXX`、`\u{...}`、`U+XXXX`，正确处理代理对；畸形转义或孤立代理项提示错误，不发布部分结果。编码仅转义非 ASCII，保留原有排版。
- 行整理：去空行、去首尾空格、去重（可选），保留输入顺序与大小写；显示行数、字符数及有效项数量。
- 进入时优先接收文本匹配参数，首次普通进入读取剪贴板；之后保留当前草稿，主动“读取剪贴板”可替换。输出只读，复制失败明确提示；Ctrl/Cmd+Enter 复制；清空同时清空两侧。无正文日志或本地存储。

## 实施步骤

- [x] 创建 `internal-plugins/string-tools/public/{plugin.json,logo.svg,preload.js,index.html,style.css,app.mjs,transforms.mjs}`。纯模块导出 `buildSqlList(text, options)`、`convertCase(text, mode)`、`decodeUnicode(text)`、`encodeUnicode(text)`、`cleanLines(text, options)`；UI 只负责读取控件、展示结果和调用剪贴板。
- [x] 添加 `tests/main/stringTools.test.ts`，覆盖混合类型、SQL 引号、反斜杠提示、长数字、前导零、制表符、重复空行、命名边界、代理对和错误输入。运行 `pnpm exec vitest run tests/main/stringTools.test.ts`。
- [x] 将 string-tools 加入 `src/main/core/internalPlugins.ts`、`src/main/api/renderer/pluginDevelopmentRegistry.ts`、`internal-plugins/setting/src/views/AllCommandsSetting/AllCommandsSetting.vue`、`build/afterPack.js`。保持内部 API 特权仅授予原有 setting/system 等插件。补上内置分类、保留名称与静态资源完整性测试。
- [x] 创建 `tests/e2e/string-tools.spec.ts`，用隔离 Electron 实例验证搜索启动、真实输入和输出、类型选项、复制回读、Unicode 错误、清空、主题切换和插件 WebContentsView 截图。
- [x] 运行目标 Vitest、目标 ESLint、`pnpm typecheck` 和 `pnpm test:e2e`；查看插件截图，记录实际结果。只构建源码 Electron 启动所需产物，不打包应用。已有未提交改动保持原样，不提交代码。

## 验收样例

输入 `123\n张三\nO'Reilly\n00123\n90071992547409931234`，默认输出 `123,'张三','O''Reilly','00123',90071992547409931234`。

输入 `HTTPResponse user_id`，camelCase 输出 `httpResponseUserId`，PascalCase 输出 `HttpResponseUserId`。

输入字面量 `\u4e2d\u6587\uD83D\uDE00`，输出 `中文😀`；输入 `\uD800` 提示错误并禁用复制。

## 实际验证（2026-10-15）

- `pnpm test`：90 个文件、772 项全部通过。
- `pnpm typecheck`：Node 与 Web 均通过。
- 新增及接入文件的目标 ESLint、Prettier 与 `git diff --check` 通过。
- `pnpm test:e2e`：6 项通过；3 项原有官方账号/私有同步流程在本地版中按现有规则跳过。
- 字符串专项验证了搜索启动、首次剪贴板导入、真实文本输入、SQL 类型切换、单引号转义、长数字和前导零、大小写、Unicode 编解码与错误阻断、行整理、真实剪贴板回读、快捷键复制、清空和明暗主题。新增两个 Unicode 搜索入口分别明确设置转换方向。
- 已直接查看插件 WebContentsView 截图；结果区保持单行横向滚动，未发现裁切控件或重叠。截图位于 `test-results/playwright/string-tools-字符串内置插件支持-SQL、命名、Unicode、行整理与真实剪贴板/string-tools.png`，不提交版本库。
- E2E 的剪贴板样例在宿主就绪后写入；主题检查清除 Playwright 默认浅色媒体模拟后使用 Electron 原生主题。所有数据库与旧数据目录均隔离，退出时恢复剪贴板纯文本。
- 实际运行仅使用源码 Electron；未打包应用、未提交代码。输入仅在当前插件运行期间保留，不跨应用重启持久化。
