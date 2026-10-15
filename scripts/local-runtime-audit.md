# 本地版普通运行网络验收

先结束源码 E2E 和所有占用 `127.0.0.1:15177` 的设置开发服务器，再在项目根目录依次运行：

```powershell
pnpm exec electron-vite build
node scripts/local-runtime-audit.mjs --minutes=35 --market-install
```

这里只构建源码 Electron 入口，不执行应用打包。工具自行启动和清理设置开发服务器及隔离 Electron；默认观察 35 分钟，`--minutes=0` 只做冒烟检查，不能作为长时间观察通过的证据。

工具不设置 `ZTOOLS_E2E`。它通过 `-r` 在业务模块导入前安装 Node fetch/http/https、Electron net.fetch/net.request 及每个 Session 的 webRequest 观察器。观察器放行请求，只保存时间、通道、origin、pathname，丢弃查询、认证头、正文和 URL 用户信息。本机自检逐一验证 8 条通道，以及后续创建的新 Session；任何自检失败都会退出。

每轮自动创建唯一临时数据根及旧数据根，检查实际 `app.getPath('userData')` 和两个环境变量。工具打开设置的通用页，等到“开机自动启动”正文后运行自检，再开始静置计时。启动、自检和静置期间的非本机请求都会被判为失败；自检只访问本机服务。35 分钟结束后才主动获取匿名市场和检查上游版本。`--market-install` 另会真实下载、安装并打开 code-snippets 1.2.0，等到空数据页面正文后截取该插件 WebContentsView 的当前可见区域。

日志目录会打印为 `AUDIT_OUTPUT=...`，位于 `test-results/local-runtime/local-runtime-<timestamp>`，独立于 Playwright 每轮清理的输出目录：

- `network.jsonl`：实时追加的网络目标记录。
- `status.json`：每 10 秒更新静置进度、预加载顺序、数据隔离、自检通道、构建产物哈希和各步骤实际结果。
- `market-plugin.png`：真实市场插件当前可见视图（使用 `--market-install` 时），按 E2E 约定单独写入 `test-results/playwright/local-runtime-<timestamp>`；精确目录也记录在 `status.json` 的 `screenshotOutput`。

`passiveObservation` 独立保存起止时间、实际秒数、非本机请求检查和是否满足完整时长。后续市场失败不会抹掉该记录。GitHub 限流或离线以 `upstream.kind = unavailable` 及原因记录，不伪装成“没有更新”。总结果 `passed-smoke-only` 只表示工具短程验证通过；`passed-35-minute-observation` 才表示长观察和随后步骤完成。

本工具验证主进程和 Electron Session 可见的网络请求，不是操作系统级抓包；本轮没有安装的第三方插件、原生子进程或未来修改不能从该证据推定无网络行为。
