# 字符串处理

CAI.Tools 内置的离线文本工作台，无额外依赖，不保存输入历史。

## 使用

重启开发实例后，在搜索框输入“字符串处理”或“SQL IN”。首次进入自动读取剪贴板；后续进入保留当前草稿，可用“读取剪贴板”主动替换。

- SQL IN 拼接：每行或每个制表符单元格为一项，默认去空行、首尾空格和重复项。自动识别每个值，文本加单引号，普通十进制数直接拼接；可选全部文本、全部数字以及带括号输出。
- 大小写与命名：小写、大写、大驼峰、小驼峰、下划线、短横线。每行独立转换，支持已有驼峰和英文缩写边界。
- Unicode：支持 `\u4e2d\u6587`、UTF-16 代理对、`\u{1F600}` 和 `U+4E2D`；反向转换只转义非 ASCII 字符，保留英文及排版。错误转义会清除结果并禁止复制。
- 行整理：忽略空行，可选去首尾空格与去重，保持原顺序和大小写。

输入后实时预览，“复制结果”或 Ctrl/Cmd+Enter 复制。切换页签保留原文和选项；清空同时清空输入与输出。

## SQL 细节

`00123` 等有前导零的编号按文本保留，长数字 ID 不经过 JavaScript Number。选择全部数字时，前导零编号与非普通十进制值会报错。

文本单引号按 SQL 标准重复转义，如 `O'Reilly` → `'O''Reilly'`。输入含反斜杠会提示数据库模式差异；使用前应确认目标数据库的字符串转义设置。列表为空时不输出无效的 `()`。本工具只生成值列表，不执行 SQL。

## 开发

静态资源在 `public/`，宿主开发启动直接加载；正式制品沿用 `build/afterPack.js` 复制资源，不需要独立 Vite 服务。

- 转换与接入测试：`pnpm exec vitest run tests/main/stringTools.test.ts tests/main/internalPlugins.test.ts tests/main/pluginDevelopmentRegistry.test.ts`
- 源码 Electron E2E：`pnpm test:e2e`；专项可使用 `pnpm test:e2e tests/e2e/string-tools.spec.ts`。
- E2E 使用临时数据与旧数据目录，截图来自插件 WebContentsView，输出到 `test-results/playwright`。
