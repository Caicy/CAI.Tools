# 桌面快跑独立验收报告

日期：2026-10-20。最终状态：本轮要求的自动化验收及截图审查已完成；最新类型检查、49项专项单测、快跑完整主流程均通过。早期两轮非预期暂停在后续诊断和定向复测中未复现，根因未确定，保留该稳定性观察项。

使用共享工作区，无独立分支、无提交，未还原或格式化其他文件。本测试 agent 未修改实现或正式测试；仅写本报告及 test-results 下诊断脚本、日志与证据。父 agent 明确说明以 `model: gpt-6.1-sol`、`reasoning_effort: medium` 创建本测试 agent；此处记录创建参数，不声称额外核验平台路由。

## 最终实际结果

| 命令                                                                                                                                                                                                                                                                                                              | 退出码 | 实际结果                                                                                       | 日志                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                                                                                                                                                  | 0      | 最新 node、web 类型检查均完成                                                                  | `test-results/runner-evidence/typecheck-final.log`         |
| `pnpm test tests/renderer/desktopPetRunnerEngine.test.ts tests/main/desktopPetRunnerGeometry.test.ts tests/main/desktopPetRunnerSession.test.ts tests/renderer/desktopPetPlayer.test.ts tests/renderer/desktopPetInteraction.test.ts tests/main/desktopPetManifest.test.ts tests/main/desktopPetGeometry.test.ts` | 0      | 7文件、49用例全部通过，6.29秒                                                                  | `test-results/runner-evidence/unit-final.log`              |
| `pnpm test:e2e tests/e2e/desktop-pet-runner.spec.ts --grep '快跑：真实跳跃'`                                                                                                                                                                                                                                      | 0      | 1通过，总计1.7分钟，用例约1.5分钟；结算、返回恢复、重启纪录读回均完成                          | `test-results/runner-evidence/e2e-focused.log`             |
| `pnpm test:e2e tests/e2e/desktop-pet-runner.spec.ts tests/e2e/desktop-pet.spec.ts`（此前整套）                                                                                                                                                                                                                    | 1      | 两轮各2通过、1失败；关闭设置和普通桌宠回归通过，快跑主流程当时失败，随后由上行定向复测覆盖通过 | `test-results/runner-evidence/e2e-escalated.log`及历史证据 |

最终49例分布：引擎8、跑道几何/记录3、会话9、播放器3、交互3、manifest17、宠物几何6。新增变化种子回放、旧加载拒绝竞态、同sender子frame授权、数据库抛错4例已实际执行通过，不能再沿用旧45例数。

最终提权单测首次申请因自动审批审核额度不足而未执行；收到继续指令后按相同 require_escalated 路径重新申请成功，完成49例。没有绕过审核，也未采用TEMP/TMP替代、修改HOME/CODEX_HOME或更改临时目录权限。

## 输入与主流程验收

- 发现的准备态点击跑道不能启动问题已由主 agent 修复；独立诊断实际验证点击跑道进入countdown，再进入running。
- 顶部暂停/继续按钮焦点问题已由主 agent 修复；诊断及正式E2E验证继续后activeElement为BODY，Space仍跳跃。
- 正式主流程通过开始、Space跳跃、Esc暂停且分数冻结、主按钮继续、顶部按钮暂停/继续后跳跃、原生宿主窗口抢焦点自动暂停、回到游戏后主动继续、碰撞结算、保存纪录、再来一次、返回原宠物位置/可见状态、重启读回最佳纪录。
- 关闭桌宠设置用例两轮均通过（45.7秒、46.3秒），普通桌宠回归两轮均通过（1.9分钟、1.6分钟）。最新运行时变更集中在游戏页面输入/暂停诊断及纯引擎暂停原因，没有改动关闭设置的宿主生命周期；不重复已通过的两项回归。未声称最新版本又完成过一轮3用例全绿的整套运行。

## 截图实际检查

均通过 tools.view_image 逐张查看，路径目录：
`test-results/playwright/desktop-pet-runner-快跑：真实跳跃、失焦暂停、结算重开、返回恢复与重启纪录/`

- `runner-ready.png`：角色比例正常，脚底接近地面；开始/返回按钮、分数和底部提示清晰，无截断或重叠。
- `runner-paused.png`：角色保持跳跃高度；暂停文字、继续/重新开始/返回按钮均可读，布局正常。
- `runner-game-over.png`：本局118米、最佳0118、再跑一次/返回桌宠及本机保存提示清晰；角色轻微后仰，碰撞石块与后方石块可辨识，无溢出或异常遮挡。本截图没有仙人掌，不能称两类障碍视觉均已检查。

截图均为游戏窗口可见区，未拼接宿主窗口。设置正文等待采用正文特征，未仅等待侧栏。通过用例默认不保留trace，失败trace另有备份。

## 独立代码审查与验证边界

| 重点          | 审查及已验证内容                                                                                                                     | 保留边界                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 帧步长/碰撞   | 固定1/120秒；最高速420时每步3.5px，小于最窄障碍与角色碰撞宽度。30/144Hz一致、高速碰撞、仙人掌越障、暂停不计分通过                    | 未穷尽所有边缘擦碰和实际低性能设备                                       |
| 障碍生成      | 最高速计算滞空+0.35秒余量，间距下限约483.7px；首障碍延迟2秒。固定样本间距与变化种子双类型回放通过                                    | 单一种子回放不代表所有极端序列或完整难度平衡                             |
| 焦点/暂停     | 可聚焦独立窗口、无全局空格；blur/hidden/宿主挂起等触发暂停，回来不主动继续。正式失焦/主动继续与顶部按钮跳跃均通过                    | 锁屏/系统休眠及真实外部应用竞争仍需实机验证                              |
| 键盘/鼠标     | 重复键过滤、落地才可再跳；按钮消费点击；准备态点击已接通。Space及跑道启动实际通过                                                    | 长按键、ArrowUp、游戏双击/文件拖入不触发旧行为没有逐项E2E断言            |
| 退出恢复/设置 | ready后隐藏宠物、停采样；统一关闭释放、按最新enabled/quitting决定恢复；位置恢复、关闭设置及重启纪录通过                              | 游戏期间修改大小/paused偏好、退出过程不显示宠物主要依靠代码审查          |
| 异常回滚/竞态 | 超时、崩溃恢复、旧窗口加载拒绝不关闭新会话均有通过单测；回调校验win身份，清理监听和IPC                                               | 当前窗口loadFile/loadURL拒绝、素材失败事件未各自进行真实Electron故障注入 |
| IPC授权       | 当前sender且mainFrame；最小具名桥接，禁新窗口/导航。其他sender、非法距离、同sender子frame ready/exit/failed拒绝通过                  | 未逐项对所有通道和组合进行渗透测试                                       |
| 记录保存      | 版本化设备键、有限数值/上限、整数化、低纪录不写；同步读写、写入返回失败/抛错可正常退出；重启读回通过。runId/disposed限制过期异步提示 | 读取抛错、延迟保存与立即重开/关闭的页面级交错未直接注入                  |
| JSDoc         | 检查新增实现/回调、参数与返回说明；主动抛错处throws，关键时间清零、隐藏/恢复、碰撞边界有目的注释                                     | 没有全仓自动注释审计；无关旧函数不计为本次新增问题                       |

## 历史失败及暂停诊断

1. 首次7文件单测退出1：7文件均在收集阶段遇到沙箱Temp SSR缓存rename EPERM，0用例执行，属环境失败。原命令提权后45例通过，原工具输出转存 `unit-escalated-tool-output.log`；最后新增4例后49例再次通过。
2. 首轮整套E2E退出1：2通过/1失败，总5.4分钟。主流程在第227行首次继续后countdown→paused，60秒断言失败，最终120秒用例时限耗尽。先收到5次countdown，随后114次paused。该轮构建与焦点修复并发，不能仅以产物写入时间推断转换时已含修复。
3. 第二轮整套E2E提权后仍退出1：2通过/1失败，总4.6分钟。第209行开始后4次countdown、116次paused，距离0；产物明确含activeElement.blur()。该轮曾与类型检查并发，可能有CPU调度压力，但没有证据认定这就是根因。
4. 主 agent 增加pauseReason/data-pause-reason/data-frame-gap，并修复准备态点击。独立诊断复用正式测试启动和菜单入口，只读每100ms采集页面/原生窗口焦点，启动/恢复最多观察7秒，异常paused立即结束。首次独立脚本默认5秒设置正文等待失败；对齐60秒后仍设置正文为空，15177连接探测False。两次均未进入游戏，属于诊断启动环境失败，分别保存 `diagnostic-launch-failure.log/json`、`diagnostic-server-failure.log/json`。
5. 将独立设置服务与Electron置于同一提权环境后，诊断退出0；全部阶段焦点正常，只有主动user暂停。采样RAF约12–14ms，最大13.8ms；末次顶部继续后Space的y=-57.501，activeElement=BODY，document.hasFocus与原生窗口focused均true。仅是离散采样，不是完整性能基准。证据 `diagnostic.json`、`diagnostic.log`、`diagnose.cjs`、`diagnostic-build.log`。
6. 关闭独立服务后，由官方Playwright配置管理webServer进行一次正式主流程定向复测，退出0，完成全部断言与3张截图，未和类型检查/单测并行。没有删自动暂停、跳过断言或修改正式测试以绕过失败。

早期非预期paused未在诊断/最终主流程复现；早期trace无暂停原因，因此不能追溯确认当时是long-frame、window-blur、hidden或host，也不能说已证明完全消除稳定性风险。出现再次暂停时应读取新诊断字段定位。

历史证据目录：`test-results/runner-evidence/initial-sandbox-failure/`、`test-results/runner-evidence/escalated-failure/`；第二轮原始trace文本为 `escalated-first-test.trace`。当前playwright目录存最终成功截图，历史失败未覆盖丢失。

## 未验证实机与平台边界

Windows物理键鼠、真实外部应用焦点竞争、窗口内外点击边界、任务栏布局、125%/150%/混合DPI、多显示器热插拔、锁屏/休眠、持续性能及macOS/Linux行为仍需实机验收。原生菜单E2E调用真实click handler但替换popup，不证明菜单坐标交互；桌宠回归含合成指针/凝视/resize，不等于物理拖放验收。

所有E2E均使用源码Electron、临时ZTOOLS_DATA_ROOT与旧数据隔离目录及127.0.0.1:15177设置开发页；未打包、未安装Chromium、未访问真实用户数据，未发布应用。测试与临时设置服务均已结束。

## local.10 发布前复验（2026-10-20）

误清理后从 Git 遗留快照恢复跑酷源码、集成与测试，保留 local.9 已提交的桌宠素材和交互优化。

- `pnpm test`：102 个文件、910 个用例通过。
- `pnpm typecheck`：恢复后 node 与 web 检查通过。
- `pnpm test:e2e tests/e2e/desktop-pet-runner.spec.ts tests/e2e/desktop-pet.spec.ts`：3 项全部通过，总计 2.3 分钟；覆盖快跑完整流程、游戏中关闭桌宠和普通桌宠交互。日志为 `test-results/release-local10-e2e.log`。
- 本次 E2E 使用源码 Electron、隔离数据目录和设置开发服务器；未进行本地安装升级或物理多屏/DPI 验收。
