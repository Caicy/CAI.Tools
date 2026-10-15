# Git 同步目录阶段证据

日期：2026-10-15。用户授权开始下一阶段，B 阶段已启动。本次交付 B1 的协议基础模块；B2–B9 尚未实施，不能据此使用完整 Git 同步功能。

检查点：用户随后明确要求“先提交一次代码，然后继续开始任务”，本次本地检查点包含 A 阶段及 B1，B2 在检查点之后实施。下文“未提交”描述验收当时的历史状态；该授权不包含推送或发布。

## 接续基线

- 主目录起始 HEAD 为 `6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c`，只有未跟踪的计划文档；A 阶段代码位于另一个任务拥有的 `codex/cai-tools-local-edition` 工作区。
- 未修改该工作区，只读比较并复制 145 个不同或新增的源文件/文档到当前目录，承接 A 阶段未提交实现；随后在当前目录离线恢复依赖。未将另一个任务的工作区重新归属本任务。
- 首次复制依赖因 Windows 链接权限失败，已中止；使用提权审批后的 `pnpm install --offline --frozen-lockfile --ignore-scripts` 与指定原生依赖 rebuild 完成恢复。未执行应用打包。
- 当前改动保留为未提交文件，未推送、发布或部署。

## B1｜协议、JSON 与路径边界

新增文件：

- `src/shared/gitMirrorTypes.ts`：清单、记录、插件程序、状态及资源限额。
- `src/main/core/gitMirror/canonicalJson.ts`：严格解析、解码后重复键检测、危险键/深度/大小/非有限数值校验、稳定序列化与内容摘要。数字形式的对象键也使用字典序；数组和正文保持原意。
- `src/main/core/gitMirror/pathSafety.ts`：逻辑键 SHA-256 文件名、Windows 路径检查、大小写/文件目录冲突、逐级 lstat/realpath 链接检查，以及同步根与本机根双向包含检查。
- `src/main/core/gitMirror/attributes.ts`：追加受管 `.gitattributes` 块并保留用户规则；重复调用不重写，已有块损坏则拒绝。
- `tests/main/gitMirrorFormat.test.ts`：34 项真实临时文件系统与 JSON 边界测试，包含 Windows junction。

先运行新增专项测试，确认因 `canonicalJson` 模块尚不存在失败，再实现。自查后补充非有限 JSON 数值、循环、数字键排序、UNC 根、文件/目录碰撞和损坏属性块等边界；修正两项 lint 问题。

最终验证：

| 检查                                                                                               | 实际结果                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/main/gitMirrorFormat.test.ts`                                          | 34/34 通过，退出 0                                                                                                                     |
| 新文件 Prettier 与 ESLint                                                                          | 通过，退出 0                                                                                                                           |
| `pnpm typecheck`                                                                                   | node/web 均通过，退出 0；日志 `test-results/git-mirror-typecheck.log`                                                                  |
| `pnpm test`                                                                                        | 86 文件、721 项通过，退出 0；日志 `test-results/git-mirror-unit.log`                                                                   |
| `pnpm test:e2e`                                                                                    | 源码 Electron，5 通过、3 个原版账号流程不适用跳过，退出 0，耗时约 2.5 分钟；结果与截图位于 `test-results/playwright`                   |
| `pnpm --dir internal-plugins/setting exec vue-tsc --noEmit`                                        | 退出 0，但根配置 `files: []`，不作为完整设置页面检查通过的证据                                                                         |
| `pnpm --dir internal-plugins/setting exec vue-tsc --noEmit -p tsconfig.web.json --composite false` | 退出 2，22 项类型错误；与 A 阶段记录的数量和错误位置相符。本次未修改设置页面；日志 `test-results/git-mirror-setting-web-typecheck.log` |

E2E 沿用 A 阶段已隔离的数据根与旧数据目录，自动启动 `127.0.0.1:15177` 设置开发服务。没有安装 Playwright Chromium，没有使用安装包或 `electron-builder`。

## 尚未验证的产品行为

Linear 同步边界：开始实施时已成功将 CAI-26 改为 In Progress。完成后尝试更新任务为 Done、B 里程碑说明和项目当前进度，均遇连接层 HTTP 传输失败；随后的任务/项目读回同样失败，因此完成状态与说明未确认写入。待连接恢复后应按本记录同步并回读，不把本地完成等同于远端完成。

G02、G12、G14 目前仅有 B1 基础函数证据；实际目录绑定、完整快照校验和导出不重写还依赖 B3/B6/B8。B1 测试通过不代表 G01–G16 全部完成。

插件数据白名单与凭据拆分（B2）、只读 Git（B3）、事务 journal（B4）、原始包与附件（B5）、三方比较和导出（B6）、启动代次（B7）、设置 IPC/UI（B8）、真实插件与双实例 Git / 两台 Windows（B9）仍待实施或验收。路径检查也不承诺抵御任意外部进程在检查后替换目录；后续导出仍须实现内容比较与恢复证据。
