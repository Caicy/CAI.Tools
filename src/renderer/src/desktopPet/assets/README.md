# 小薄荷（builtin-default）

- 2026-10-19 使用本会话 imagegen 工具生成的原创薄荷绿机器人角色，未采用 ChatGPT 内置宠物或 work-pets 插件美术。
- 经第二次图像编辑去背景；文件为1536×1024 RGBA PNG，8列4行，每格192×256。对应idle、running-right、running-left、waving，每行8帧。
- 角色没有外部品牌标识，使用图像生成服务的输出条款；这不是第三方开源素材授权声明，也不宣称取得排他版权。
- 清单内帧停留时间由本项目独立定义，客户端会校验图片尺寸、帧占用与透明背景。正常尺寸动作连续性由独立测试任务验收。
- 源生成任务：exec-acd258b0-b24f-442f-a195-81b0ab6b5229；去背景任务：exec-e9eb5f33-3ba7-4030-ab04-40f400dde8c0。
- P0素材采用32帧自有清单，不是OpenAI完整v2（73帧）；P1才扩展注视与外部v2适配。

## 2026-10-20 侧面圆润优化

- 使用内置 imagegen 编辑原图，优化左右跑动的球形外壳，让额头、脸缘、腹部和背部弧线更饱满，保持薄荷绿机器人、奶油色面板和橙色天线的角色特征。
- 侧面优化仅装配生成图的第 2、3 行；第 1 行待机保留原始像素，避免影响固定坐标的眼睛跟随。第 4 行挥手另按下文修正对齐。最终素材仍为本目录 `atlas.png`，1536×1024 RGBA、8×4 网格、每格 192×256，动作时长不变。
- 生成任务：`exec-6883fd3c-cdb1-40a7-b8b8-2a46e18c972b`。提示词要点：edit original atlas; plump spherical side bodies; continuously curved forehead, face edge, belly and back; cream face painted on curved sphere; consistent volume across running frames; preserve identity, limb poses, grid, scale and baseline; transparent background; no labels or props。
- 侧面接入后的像素检查：两行正面与优化前逐像素一致；32 帧均非空，未出现整格不透明背景。后续挥手调整不改变待机或跑动行。

## 2026-10-20 点击挥手对齐

- 原挥手面板位于单格 y=96–159，待机面板位于 y=124–182，切换时会上跳约 25 像素；挥手各帧还存在横向漂移。
- 第 4 行的帧 0、1、7 复用待机首帧，帧 2–6 分别平移 (+5,+27)、(+6,+27)、(+7,+28)、(+7,+25)、(+7,+25)，保持脸部基准一致。此步骤是现有图集的确定性帧装配，没有重新生成角色。
- 渲染层在挥手时继续绘制当前视线；失焦只取消尚未结束的手势，避免单击打开主窗口后立即截断挥手。

## 2026-10-21 同基线、圆形侧身与咖啡/睡眠

- 图集扩展为 1536×1536 RGBA PNG，8 列 6 行，每格仍为 192×256：idle、running-right、running-left、waving、coffee、sleeping。48 帧以 alpha>16 测量的最低像素全部为单格 y=230（偏差 0px），没有跳跃动作。
- 待机保留原首帧身体与固定注视坐标，只装配眨眼；挥手按奶油面板中心对齐，低位球壳和脚复用待机，取代此前逐帧手工平移造成的基线差。跑动球壳确定性缩放至约 120×116 的轮廓，脚部独立落地，不再使用宽扁侧身或移动身体来补偿抬脚。
- `tests/main/desktopPetAtlas.test.ts` 解码实际 PNG（Node zlib 撤销标准 PNG 滤波，不依赖系统 Python），逐帧验证基线、占用量和透明背景；球壳使用最大浅色连通区域，宽度取没有摆臂的肩部/赤道带 y≤160，排除深绿轮廓分隔的天线、手脚和耳部。侧身球壳宽高比 1.009–1.045，待机 1.035；侧身球壳中心在同一动作内漂移不超过 1.5px。
- 咖啡和睡眠原画使用本会话 ImageGen 工具原创生成。工具没有返回独立 exec 任务号；返回的生成文件标识为 `xiaobohe-coffee-sleep-poses_1792515057321_808eb01a.png`。提示词要点：4×2 equal-cell game sprite sheet, plain white background, dark-green outline, cel-shaded glossy mint-green circular robot, cream oval face, black oval eyes, orange antenna; front-facing takeaway cup at belly / lift / sip / lower; sleeping face-down child’s pose, low left head on cream pillow, teal eye mask, raised round rear under lavender-blue blanket, tucked dark-green feet; no lettering, no ground shadow.
- 生成图以 Pillow 做边缘连通白背景去除、边缘去白底、切片、球壳中心对齐和确定性装配；复用原待机天线与脚保持切换锚点。睡眠以底边固定的微幅缩放形成呼吸。`zzz` 不在原画中，由画布在睡眠头部上方绘制三个错相浮动、渐隐文字；暂停时冻结位置与透明度。生成输入、装配脚本和灰底/红基线 contact sheet 仅留在不提交的 `vibe_images/`，生产代码只引用本目录图集。
- 咖啡为 8 帧非循环动作（总时长 1600ms），睡眠为 8 帧循环呼吸（3200ms）。主进程每 750ms 读取 `powerMonitor.getSystemIdleTime()`，正常阈值 5s/15s/25s；第三杯由渲染器确认播放完后进入睡眠，系统输入唤醒并重置循环。测试比例 `ZTOOLS_DESKTOP_PET_IDLE_SCALE` 只在主进程读取；暂停、隐藏及快跑期间不持续采样，注视覆盖仅用于 idle/waving。
- 素材沿用上文原创生成来源说明，没有第三方品牌或授权变更；不将未提交的参考插画作为运行时素材。

## 2026-10-21 睡眠身形修正

- 原睡眠原画把面板所在球壳与被子下方的身体分成两段，形成额外的高拱背部，与角色一体式圆球身材不符。使用内置 ImageGen 基于当前图集重绘单张睡姿：奶油面板、眼罩与薄荷绿外壳属于同一个球体，被子贴合球壳右半侧，去除独立躯干、拱起臀部与长身体。
- 生成文件：`exec-862aaf32-e673-428a-a5a4-ff857fe1dd8a.png`。提示词要点：one single compact spherical robot, face panel on the same ball, no separate head/neck/torso/rear, lavender-blue blanket draped over the right half of the same sphere, no second dome or elongated body; cream pillow, teal sleep mask, orange antenna, tiny tucked feet; preserve identity and cel-shaded style; transparent background, no shadow, no lettering。
- 仅替换 `atlas.png` 第 6 行的 8 帧；第 1–5 行逐像素保持一致，清单与播放逻辑不变。单帧宽度保持 160px，呼吸沿用 `[0,1,2,1,0,-1,-2,-1]` 的微幅高度变化，alpha>16 的最低像素固定在单格 y=230。源图与确定性装配脚本留在本地 `vibe_images/`。

## 2026-10-21 圆形睡姿与隐藏双脚（当前版本）

- 上一版仍呈现脸部与被子两个鼓包，本版重新生成单一圆形外轮廓：薄荷绿外壳与右侧紫色被子共用圆心与半径，被子不向右扩出独立身体，两只脚完全隐藏，枕头收在圆形下缘内。保留眼罩、奶油面板和橙色天线。
- 内置 ImageGen 输出：`exec-e0a3e706-2bd0-4b7d-81f2-14cc6b24f400.png`。提示词要点：one perfect circle silhouette for the entire robot including blanket; exposed mint-green left 65% and lavender blanket right 35% share one center and radius; no feet, no protruding hands, no second lobe or flared hem; preserve original character identity and transparent background。
- 当前装配宽度改为 132px，使主体球体直径接近待机外壳；含天线的首帧高度为 150px，八帧沿用原微幅呼吸与 y=230 基线。只替换第 6 行，前 5 行逐像素一致。源图、`assemble-sleep.cjs` 与八帧预览保留在本地 `vibe_images/`。

## 2026-10-21 睡眠倾摆与睡眠符号

- 渲染器沿用圆形无脚图集，按 3200ms 正弦周期轻微左右倾摆，身体以 y=230 为固定落地锚点。单格 y=108 以上的天线区域在根部与身体连续衔接，向尖端施加反向轻摆；倾摆参数位于 `../sleepMotion.ts`。
- 原手绘 z 字母替换为两个错相浮动、渐隐的 `💤`，使用系统彩色 emoji 字体；实际 Electron 截图已确认符号可见。呼吸帧、身体、天线和符号共用有效动画时钟，暂停时整个画布冻结。

## 2026-10-21 文字 zzz 与咖啡脚部修复（当前显示）

- 睡眠提示改为三个普通字体绘制的 `z`，错相浮起、渐隐并逐渐放大；不使用 emoji 字体或表情字符。原有身体倾摆、天线反向摆动与暂停时钟保留。
- 咖啡脚部原装配从 y=216 截取待机下缘，切掉鞋面上半部，形成水平遮挡。八个咖啡帧补回待机鞋面轮廓，仅装配脚部区域，中央咖啡杯与其他动作保留；落地基线仍为 y=230。
