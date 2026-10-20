# CAI.Tools Desktop Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task when independent tasks warrant it. Steps use checkbox (`- [ ]`) syntax for tracking. 本文记录实施前的技术方案；已交付范围及自动化验收结果见 `tests/desktop-pet-report.md`。完整 look16 素材与 Windows 实机验证仍属后续工作。

**Goal:** 将现有桌面悬浮球升级为可切换的本地 2D 动画宠物，保留工具入口能力，先交付基础动作，再增加方向注视。

**Architecture:** 复用 FloatingBallManager 的单窗口生命周期，新增隔离 preload 和 Canvas 精灵图播放器。主进程负责窗口、坐标、配置和宿主操作，页面负责动画和交互意图；素材只包含图片和声明式配置。

**Tech Stack:** Electron 41、TypeScript、Canvas 2D、Vue 设置页、现有 LMDB StorageRouter、Vitest、Playwright Electron。运行时不引入 Live2D、3D 引擎、云端宠物服务或模型调用。

---

## 1. 决策与范围

### P0：首版交付

- 一个内置宠物，四种动作：idle、running-right、running-left、waving。
- 待机循环；左右拖动播放对应动作；宠物模式首次显示播放一次招呼。
- 单击显示/隐藏主窗口；双击执行已有目标指令；右键菜单；文件拖入沿用现有行为。
- 保留原悬浮球模式与原有配置；新增模式、尺寸、暂停动画设置。
- Windows 优先验收；补齐多屏坐标恢复、鼠标穿透、资源失败降级。
- 首版只加载随应用发布的可信素材，不增加皮肤市场、下载服务、导入删除界面。

### P1：后续独立交付

- 十六方向注视；只有素材包含完整 look16 时才提供开关。
- 接受完整 Work Pets v2 排列作为素材输入，通过本地适配器得到内部清单。
- P0 已预留可选 look16 字段，但不要求生成全套 73 帧，也不触发全部九种工作状态。

### 本轮不包含

自主行走、攀爬其他窗口、聊天、语音、养成、任务结果订阅、自动生成素材、用户导入任意代码。首版也不要求扩展主程序和第三方插件的公共 API。

## 2. 已核实的代码基础

| 文件                                                                   | 已有能力或约束                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/main/core/floatingBallManager.ts`                                 | 48px 透明置顶窗口、不抢焦点、拖动、位置保存、右键、单双击、文件转发           |
| `resources/floatingBall.html`                                          | HTML/CSS 悬浮球；直接 require Electron、fs、path；当前 nodeIntegration=true   |
| `resources/preload.js`                                                 | setting 插件已有悬浮球内部入口，文件不经过 Vite 构建                          |
| `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue` | 悬浮球开关、文字、双击目标和 settings-general 保存流程                        |
| `src/main/core/storage/storageRouting.ts`                              | settings-general 明确归属设备库                                               |
| `electron.vite.config.ts`                                              | 已有多页面 renderer 和多入口 preload，可按现有模式增加入口                    |
| `playwright.e2e.config.ts`                                             | Electron 源码启动；设置开发服务 15177；串行执行；输出 test-results/playwright |

需在改造中解决：双击第一次按下会立即触发单击；保存坐标直接恢复可能落在已移除的屏幕；当前拖拽开始用越过阈值后的坐标计算偏移，可能造成初始位移损失。上述来自源码检查，未作真实桌面复现。

## 3. 运行架构

```text
设置插件 ──授权内部 IPC──> FloatingBallManager ──> 单个 BrowserWindow
                                │                        │
                        settings-general          专用隔离 preload
                                │                        │
                       StorageRouter              Canvas 播放器
                                                         │
                                              内置 manifest + 精灵图
```

保持 floatingBallManager 的对外导出与启动清理调用不变，避免扩大启动链改造。球与宠物使用同一个新页面，切换外观时调整窗口尺寸并重新夹取坐标，不同时保留两个浮窗。

新窗口使用 contextIsolation=true、nodeIntegration=false、sandbox=true。新 preload 只暴露具名方法，不暴露 ipcRenderer、文件读写或任意通道调用。球模式也迁入新页面，保留视觉与行为。

### 文件职责

| 操作 | 路径                                                                                      | 职责                                                        |
| ---- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 修改 | `src/main/core/floatingBallManager.ts`                                                    | 窗口、生命周期、命中采样、状态同步、操作授权、降级          |
| 新增 | `src/main/core/desktopPet/windowGeometry.ts`                                              | DIP 坐标转换、屏幕工作区夹取纯函数                          |
| 新增 | `src/shared/desktopPetTypes.ts`                                                           | 配置、素材清单、事件、状态类型                              |
| 新增 | `src/shared/desktopPetManifest.ts`                                                        | 清单验证与 Work Pets v2 固定行适配                          |
| 新增 | `src/preload/desktop-pet.ts`                                                              | 最小页面桥接、File 到本地路径转换                           |
| 新增 | `src/renderer/desktop-pet.html`                                                           | 浮窗独立构建入口                                            |
| 新增 | `src/renderer/src/desktopPet/main.ts`                                                     | DOM 绑定、球模式、Canvas 加载和生命周期                     |
| 新增 | `src/renderer/src/desktopPet/player.ts`                                                   | 帧时间推进、绘制、暂停和恢复                                |
| 新增 | `src/renderer/src/desktopPet/interaction.ts`                                              | 点击仲裁、拖动意图、状态优先级                              |
| 新增 | `src/renderer/src/desktopPet/assets/manifest.json`                                        | 内置素材动作定义                                            |
| 新增 | `src/renderer/src/desktopPet/assets/atlas.png`                                            | 有来源记录且通过视觉验收的正式素材                          |
| 新增 | `src/renderer/src/desktopPet/assets/README.md`                                            | 素材来源、制作方式、使用权依据、校验记录                    |
| 修改 | `electron.vite.config.ts`                                                                 | 新增 renderer/preload 入口，沿用项目开发与生产 URL 选择方式 |
| 修改 | `src/main/api/plugin/internal.ts`、`resources/preload.js`                                 | setting 专用配置读写接口与调用方检查                        |
| 修改 | `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`                    | 模式、尺寸、暂停与错误反馈；保留旧配置字段                  |
| 新增 | `tests/main/desktopPetManifest.test.ts`、`tests/main/desktopPetGeometry.test.ts`          | 清单与坐标边界测试                                          |
| 新增 | `tests/renderer/desktopPetInteraction.test.ts`、`tests/renderer/desktopPetPlayer.test.ts` | 状态与时间行为测试                                          |
| 新增 | `tests/e2e/desktop-pet.spec.ts`                                                           | 隔离源码 Electron 验收                                      |

迁移成功后移除旧 `resources/floatingBall.html` 及其引用，避免两套交互逻辑长期漂移。已有主程序 preload 的文件接收和双击事件保持不变；若实施中确需修改公共类型，必须同步 `src/preload/index.ts` 与 `src/renderer/src/env.d.ts`。

## 4. 素材协议

内部协议不要求所有素材都填满 11 行，允许 P0 只提供四个动作。与 OpenAI 图片排列兼容不等于其服务接受本项目的简化素材。

```typescript
type PetAction =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

interface PetClip {
  row: number
  frames: number
  durationsMs: number[]
  loop: boolean
}

interface PetManifest {
  schemaVersion: 1
  id: string
  image: string
  cell: { width: number; height: number }
  columns: number
  rows: number
  clips: Partial<Record<PetAction, PetClip>>
  look16?: { startRow: number; count: 16 }
}
```

内部清单 schemaVersion 与外部精灵图 v1/v2 是不同概念。

P0 推荐每帧 192×208、8 列×4 行：idle 6 帧、向右 8 帧、向左 8 帧、招呼 4 帧，共 26 帧；其余单元格透明。允许按 manifest 描述的合法网格处理，禁止任意脚本、表达式和远程 URL。

验证规则：PNG/WebP；文件 ≤20 MiB；解码像素 ≤4,000,000；单张静态 atlas；尺寸等于 cell×grid；row/frames 均为合法整数；frames 不超过列数；帧时长数量匹配且每项 50–2000ms；必有四种 P0 动作；必需格非空；未使用格透明；声明 look16 时必须连续占用两个完整八格行。image 限制为同目录固定文件名，拒绝绝对路径、分隔符和路径穿越。

Work Pets v2 适配：1536×2288、8×11、每格192×208；前九行动作数为6/8/8/4/5/8/6/6/6；第9、10行为16个方向。适配器验证整套结构后映射为内部清单；未接入业务事件的动作仅保留定义，不虚构执行状态。

## 5. 动画与交互

### 状态优先级

拖拽 > 文件悬停 > 首次招呼 > 注视（P1）> idle。暂停设置独立覆盖动画时钟，但仍允许拖动与点击。

- 首次显示：waving 播放一次后回 idle；模式切换、重建窗口不循环触发招呼。
- 拖拽：mousedown 记录最初屏幕坐标和窗口偏移；位移超过5 DIP判定拖动；窗口按原始偏移定位；水平位移绝对值超过2 DIP再切换左右方向，避免抖动。
- 文件悬停：保持当前稳定动作并显示轻量目标轮廓，不为首版追加第五套素材；drop 后清理状态并交付主窗口。
- 鼠标释放、失焦、菜单打开、模式切换、页面销毁都结束未完成手势。拖出窗口后仍须能结束手势，不能仅依赖页面 mouseup；原型验证 pointer capture 与主进程轮询配合。
- 单双击仲裁：第一次松开后延迟300ms执行单击；窗口内第二次点击取消单击并只执行双击；拖拽结束不触发任何点击；已有双击无配置时只执行一次默认切换。
- 动画按累计时间选择帧，只在帧发生变化时绘制。隐藏、销毁停止动画定时器，恢复时重置时间基准，不补播积压帧。
- 窗口逻辑尺寸提供96×104、144×156、192×208三档，默认144×156；Canvas backing store按DPR设置，素材保持比例。

### P1 注视

在距宠物中心480 DIP内、非拖动且未暂停时采样鼠标方向；中心半径24 DIP内回 idle，离开范围后回 idle。坐标中右为+x、下为+y，角度为 `(atan2(dx, -dy) * 180 / PI + 360) % 360`；四舍五入到22.5°档位，跨边界再超过3°才换档，减少抖动。look16 是静态方向姿态选择，不把16格按时间轮播成转圈动画。

### 透明区域命中与文件拖入

仅 CSS 透明不能让桌面收到点击。每帧预计算 alpha 掩码；主进程获得已验证掩码，按当前帧和窗口缩放判断指针是否落在角色上。alpha阈值16/255，额外向外扩2 DIP；拖拽和菜单期间锁定命中状态，防止动画轮廓变化导致手势丢失。

窗口显示时主进程以30Hz采样 screen.getCursorScreenPoint；接近窗口后提高到60Hz；离开窗口64 DIP以上恢复30Hz。仅命中状态发生改变时调用 setIgnoreMouseEvents；在 Windows 使用 forward:true辅助页面移动事件。主进程采样保证窗口已经穿透时仍能重新进入交互，不能只依赖 DOM mouseenter。

先做 Windows 风险原型：验证真实系统文件拖入在 ignoreMouseEvents 切换后仍能交付 drop。若失败，宠物模式降级为明确标识的矩形文件接收区，或暂不验收该模式；不得将 DOM 合成 drop 当作系统拖放通过。最终选择必须记录真实验证结果，球模式继续可用。

## 6. 窗口、配置与 IPC

### 窗口与显示器

- 坐标计算统一使用 Electron DIP，页面 Canvas 像素不得直接作为窗口屏幕坐标。
- 拖动开始用鼠标所在显示器；恢复位置时选择与旧矩形相交最多的工作区，没有交集则主屏。
- 用目标工作区夹取完整窗口矩形；屏幕宽高不足时优先保证可操作区域可见。
- display-added/removed/metrics-changed、尺寸切换后重新夹取；支持负坐标显示器。
- 不定时抢置顶、不主动抢焦点；关闭功能时销毁窗口并停止采样、订阅和计时器。

### 持久化

保留现有 floatingBallEnabled、floatingBallLetter、floatingBallPosition、floatingBallDoubleClickCommand；在同一 settings-general 设备文档中新增：

```json
{
  "desktopPet": {
    "version": 1,
    "mode": "ball",
    "petId": "builtin-default",
    "size": "medium",
    "paused": false,
    "lookEnabled": false
  }
}
```

旧用户缺字段默认仍为ball；启用状态不变；仅显式选择宠物后切换。更新时读取最新文档并合并字段；设置页通用保存也必须保留 desktopPet，避免过期表单覆盖。无需新增数据目录、绕过StorageRouter或接入Git镜像。

### IPC 边界

- 设置插件：`internal:get-desktop-pet-config` 与 `internal:set-desktop-pet-config`，复用宿主内部调用方授权检查；只接受上述已知字段和枚举，返回规范化配置。
- 宠物页面：专用bridge提供ready、click、doubleClick、dragStart/Move/End、contextMenu、dropFiles，以及配置与播放状态订阅；禁止通用调用接口。
- 宠物事件只接受当前浮窗主frame；renderer ready后发送配置和已注册素材信息，避免初始化竞态。
- File 路径由专用 preload 调用 webUtils.getPathForFile 提取；主进程检查字段、实际文件状态和数量上限100，再复用现有主窗口文件转发；页面不可任意调用fs。
- 新内部配置写入成功后再发布运行态；数据库写入失败返回错误并保留旧配置。加载图片失败只回退球模式，不覆盖用户的宠物选择；设置页展示原因并允许重试。
- 既有 floating-ball 操作通道同步增加来源检查，保留主窗口与经授权setting的现有调用，不误伤合法入口。

## 7. 素材生产与成本

素材生产与应用运行解耦。P0先确定一个原创角色及标准图，再生成四条动作，抠图、统一比例和基线、拼图并检查实际播放。左右不对称角色不能直接镜像；跳跃等高级动作留待后续。

P1增加四方向基准和两条八方向素材。可参考work-pets的方法，但其本地插件元数据标为Proprietary，本项目独立实现所需逻辑，不复制其脚本作为MIT仓库代码。

生成调用可能计费，具体依生成渠道、次数和返工决定；当前不发起生成、不估报固定金额。图片播放不产生按次API费用。正式素材缺失时可以用明确标记的测试fixture验证工程，但不得作为最终视觉交付或声称素材验收通过。

完整v2图片单份RGBA原始像素约13.4MiB；这不是进程内存预测，解码副本、Canvas和GPU纹理会带来额外占用。P0只常驻当前一个atlas，切换后释放旧资源。

## 8. 实施任务与验收

以下任务以本方案定义的协议为实现约束；开始代码实施时再细化函数级补丁，不把本文视为已可直接应用的源码补丁。

### Task 1：Windows 风险原型（优先，0.5–1人日）

- [ ] 建立隔离测试窗口，确认新preload、透明Canvas与source Electron构建路径。
- [ ] 验证角色命中/空白穿透、跨窗口拖动释放、真实资源管理器拖入。
- [ ] 在100%/150%缩放和至少一次跨屏切换下记录结果；未具备设备的项标为未验证。
- [ ] 固定穿透策略与降级行为后再进入完整实现。

### Task 2：协议与播放器（1–1.5人日）

- [ ] 建立上述类型与manifest验证；测试越界row、错误duration长度、超限解码像素、缺动作和不完整look16。
- [ ] 实现时间驱动播放器；测试暂停后不推进、恢复不跳帧、waving结束回idle、隐藏后无绘制。
- [ ] 添加四动作测试素材；测试fixture与正式素材来源明确区分。

### Task 3：窗口与交互（1–2人日）

- [ ] 实现专用preload、页面入口、ball/pet共用生命周期及权限检查。
- [ ] 实现点击仲裁、拖拽阈值与稳定偏移、alpha命中切换和清理。
- [ ] 实现工作区夹取；测试负坐标、移除屏幕、尺寸增大、无交集恢复。
- [ ] 接入文件、菜单及现有主窗口指令流程；检查降级没有重复动作。

### Task 4：设置与正式素材（工程0.5–1人日，素材另计）

- [ ] 接入模式/尺寸/暂停设置及默认兼容；证明通用设置保存不会擦除desktopPet。
- [ ] 正式角色四动作通过逐帧与正常尺寸播放检查，记录来源及授权依据。
- [ ] 设置图片加载错误与恢复入口；切回球模式后原设置仍可用。

### Task 5：验收（0.5–1.5人日）

- [ ] 运行下列检查，记录真实结果及已有失败，不能以单元测试代替系统交互验证。
- [ ] 使用正常尺寸截图与短录屏确认动作、不抢焦点、拖拽无跳变。
- [ ] 保留原球模式与宠物模式对照性能数据；确认关闭后无残留窗口、定时器或重复事件。

### P1（额外1–2人日工程，素材另计）

- [ ] 完成look16生成与方向审核；实现方向量化、中心死区和边界滞回。
- [ ] 验证完整v2适配器；不完整素材禁用注视并正常播放基础动作。

P0合计约4–7人日，已包含相较初步估算更明确的安全桥接和Windows风险验证；美术生成、精修、付费服务与macOS/Linux实机验收另计。此为工程估算，不是交付承诺。

## 9. 验证命令与通过条件

```bash
pnpm exec vitest run tests/main/desktopPetManifest.test.ts tests/main/desktopPetGeometry.test.ts tests/renderer/desktopPetInteraction.test.ts tests/renderer/desktopPetPlayer.test.ts
pnpm typecheck
pnpm --dir internal-plugins/setting exec vue-tsc --noEmit
pnpm test:e2e tests/e2e/desktop-pet.spec.ts
pnpm test:e2e
```

预期以上检查退出码0；若遇已有失败，说明与本功能关系并保留证据。E2E以项目源码启动Electron，设置 `ZTOOLS_SETTING_DEV_SERVER_URL=http://127.0.0.1:15177`，数据根与旧数据目录均指向测试临时目录，禁止访问真实用户数据。不要运行electron-builder、build:unpack或额外安装Chromium。

自动化必须覆盖：旧配置启动为球；切换宠物并在重启后保留；双击只发出一次目标指令；拖拽不误触；关闭重开不重复订阅；错误素材回退；未授权webContents不能调用操作；设置保存失败不假成功。

Windows实机必须覆盖：透明角落点击落在底层窗口；快速进入角色可以点击；鼠标拖出窗口再释放；资源管理器真实文件拖入；输入其他应用时不抢焦点；高DPI与屏幕移除恢复。合成DOM事件不能证明原生穿透与系统拖放。

设置插件截图直接捕获其WebContentsView，等待模式选项及实际配置值出现后截图，不与宿主拼接；宠物截取自己的窗口，等待atlas完成解码且至少显示一帧。默认只截可见区域，结果存test-results/playwright。

性能记录：同机同场景分别采集关闭/球/宠物各60秒、预热10秒，记录进程CPU、私有内存及采样条件。目标是待机CPU相对球模式增量不超过一个逻辑核的2%、私有内存增量不超过40MiB；这些是待验证预算而非已测结果。暂停动画停止帧推进，窗口仍显示时保留命中采样；关闭功能后采样必须归零。

## 10. 研究依据与证据边界

- 本仓库现有floatingBallManager、floatingBall.html、preload、设置、storageRouting及E2E配置，检查日期2026-10-19。
- 本机work-pets 0.1.6：`skills/create-pet/SKILL.md`、`references/sprite-sheet-contract.md`、`references/upload-session.md`、`scripts/render_animation_previews.py`及插件元数据。仅作为格式和流程研究，没有取得ChatGPT客户端播放器源码。
- Electron透明窗与鼠标交互官方参考：https://www.electronjs.org/docs/latest/tutorial/custom-window-styles 、https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions 。具体Electron41/Windows行为以风险原型实测为准。

初次方案阶段未生成素材、修改运行代码或执行功能测试。以下记录后续实施进展，不替代独立测试报告。

## 11. 2026-10-19 实施记录

- 用户已授权开始开发，并指定另一个agent负责测试；本实现任务不执行Vitest/E2E。
- P0代码已接入：隔离preload、独立Canvas页面、四动作播放器、配置入口、错误回退、点击仲裁、系统光标拖动、alpha命中和工作区夹取。
- 素材为原创“小薄荷”机器人，imagegen生成并去背景。实际采用1536×1024图集、8列4行、每帧192×256、每动作8帧；这是内部manifest允许的布局变体。窗口尺寸改为96×128、144×192、192×256，保持素材比例。
- 删除旧resources/floatingBall.html；球与宠物均从desktop-pet.html进入。旧主窗口文件接收、双击指令事件保持兼容。
- E2E仅在ZTOOLS_E2E_DESKTOP_PET=1时启用浮窗模块；继续要求临时数据根与旧数据目录，不改变其他测试的默认后台模块隔离。
- P1的look16、完整外部v2适配、任务状态动作没有实现，避免将接口预留当作已交付。
- 独立测试任务：01a15381-2232-7531-ac6d-9030f8221d18；测试文件由该任务管理。真实系统拖放、高DPI、多屏、持续运行性能与视觉连续性以它的验收结果为准。

## 12. 2026-10-20 桌面宠物替换入口

用户要求用“小薄荷 · 桌面宠物”替换原悬浮窗。本次变更优先于前文保留外观选择的设计：新配置和旧球模式配置均规范为宠物模式，保留原开关、位置、大小、暂停和双击指令。设置页移除经典悬浮球选项及文字编辑，直接呈现宠物设置；图片加载失败时保留应急球形入口及重试操作。未改动真实用户数据，重启更新后的应用时按兼容规则读取旧配置。测试仍由独立测试任务执行，结果见 tests/desktop-pet-report.md。

## 13. 2026-10-20 静止待机与鼠标视线

用户要求无操作时宠物不动，眼睛跟随鼠标。待机固定使用正面首帧并停止动画计时器，取消启动自动打招呼；单击打招呼和拖动动作继续保留。主进程复用已有系统光标采样，仅向宠物专用preload发送变化的归一化方向，不发送桌面绝对坐标。渲染器在待机帧内移动眼睛，不移动身体；暂停时冻结视线，隐藏时停止绘制，窗口卸载解除监听。这是内置素材的动态眼睛实现，不是外部v2 look16图集适配。相关视觉与行为测试继续由独立测试agent负责。
