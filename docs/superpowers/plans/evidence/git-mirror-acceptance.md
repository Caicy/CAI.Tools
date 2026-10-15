# Git 同步目录阶段证据

日期：2026-10-15。B1 已完成并进入检查点提交 `bdf563c`；B2 已完成实施与本机验证，结果见下文。B3–B9 尚未实施，完整 Git 同步功能尚未可用。

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

Linear 同步边界：B1 完成时连接故障，最初未确认完成状态。用户随后要求检查点提交并继续；连接恢复后已补写并回读 CAI-26 为 Done。B2 最终验证后已将 CAI-27 标为 Done，并回读确认；A/B 里程碑说明及项目当前进度均已更新，项目保持 In Progress，B3–B9 待实施。

G02、G12、G14 目前仅有 B1 基础函数证据；实际目录绑定、完整快照校验和导出不重写还依赖 B3/B6/B8。B1 测试通过不代表 G01–G16 全部完成。

只读 Git（B3）、事务 journal（B4）、原始包与附件（B5）、三方比较和导出（B6）、启动代次（B7）、设置 IPC/UI（B8）、真实插件与双实例 Git / 两台 Windows（B9）仍待实施或验收。路径检查也不承诺抵御任意外部进程在检查后替换目录；后续导出仍须实现内容比较与恢复证据。

## 本地检查点提交

用户明确授权先提交一次，已成功创建 `bdf563c`：`feat: establish local edition and Git mirror protocol`，包含 A 阶段及 B1，共 82 个文件。提交前 B1 专项 34/34 再次通过，暂存区 whitespace 检查通过。

提交钩子运行全库格式化；其中 3 个额外文件存在实际内容差异。自动审批最初拒绝未经逐文件证明的批量还原。随后逐文件比较当前内容与 Prettier 格式化 HEAD 的结果并保存 SHA-256，3 项均完全相同；仅针对这 3 个明确文件还原获准并成功。其他文件的行尾差异在 Git 内容比较中没有新增差异。审计位于忽略目录 `test-results/hook-format-audit.json`。未绕过提交钩子，未推送。

## B2｜插件与宿主投影、AI 凭据隔离

实现内容：

- `adapters/types.ts`、`validation.ts`、`codeSnippets.ts`、`aiHelper.ts`、`registry.ts`：只登记 code-snippets 1.2.0、ai-helper 1.2.1。未知键、版本、字段拒绝进入投影；模板保留业务内容与本机使用统计，会话按照原插件 data 字符串读写，模型选择恢复为 value。
- `hostProjection.ts`：通用偏好白名单；插件 canonical 快捷键投影和合并。保留本机应用快捷键、环境字段，拒绝远端路径字段与本机记录 ID 冲突。
- `aiProviderProjection.ts` 与 `aiProviderService.ts`：运行时继续返回完整 AiProviderStore；持久化的 StoredAiProviderStore 不含 apiKey。设备凭据先写入并读回成功后才发布元数据，迁移中断可重试。配置 URL 含认证、查询参数或 fragment 时留本机；导入保留目标机器密钥。没有密钥时模型标签提示本机配置，调用仍在联网前拒绝。
- `startupDataMigrations.ts`：凭据迁移失败保留旧配置并报告待重试，不阻断其他本机 API 初始化。新增回归先证实修复前失败，修复后通过。

数据结构核对来源为固定插件提交 `e4962a0a44d2cc50bdb1c2f85577e8525e6bf040`：
[code-snippets 模板](https://github.com/ZToolsCenter/ZTools-plugins/blob/e4962a0a44d2cc50bdb1c2f85577e8525e6bf040/plugins/code-snippets/src/Snippets/index.vue)、[ai-helper 会话](https://github.com/ZToolsCenter/ZTools-plugins/blob/e4962a0a44d2cc50bdb1c2f85577e8525e6bf040/plugins/ai-helper/src/useChat.ts)。本次实际读取源码核对 schema；尚未完成这两个真实插件的 Git 跨实例迁移，不能把适配器单测写成 G07 已通过。

最终单元测试使用真实临时 LMDB，覆盖设备/账户路由、凭据读回失败、元数据发布中断后关闭重开、幂等重试和缺少本机密钥。`LOCAL_ONLY_SECRET` 配置值未进入供应商投影；同样字符串出现在模板正文时按正文保留，不把此测试当作通用秘密识别。

| 检查                       | 实际结果                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| 插件与宿主投影专项         | 10/10 通过                                                                                             |
| 真实 LMDB 与供应商投影专项 | 8/8 通过                                                                                               |
| `pnpm typecheck`           | 退出 0，日志 `test-results/b2-typecheck-final.log`                                                     |
| `pnpm test`                | 88 文件、741 项通过，退出 0；日志 `test-results/b2-unit-final.log`                                     |
| 定向 ESLint                | 退出 0；日志 `test-results/b2-lint-final.log`                                                          |
| 完整设置页面类型检查       | 退出 2；22 项错误的文件/行/列/错误码均与 B1 相同，未计为通过；日志 `test-results/b2-setting-types.log` |
| `pnpm test:e2e` 最终产物   | 退出 0，5 通过、3 项原版账号流程不适用跳过，耗时约 2.2 分钟；日志 `test-results/b2-e2e-final.log`      |

首轮源码 E2E 为 5 通过、3 项原版账号流程不适用跳过；随后补充启动失败边界，因此最终源码产物已另行重建并完成验证。B2 改动保留在检查点之后的工作区，未另行提交；用户本次只要求先提交一次。
