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
