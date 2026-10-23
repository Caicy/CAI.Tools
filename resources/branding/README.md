# CAI.Tools 图标

`cai-tools.svg` 是 CAI 字母应用标识的可编辑源文件，`cai-tools-tray.svg` 是单色托盘 C 标识。两者均为本项目原创矢量图形，不沿用上游 Z 字图标。

生成命令：`node scripts/generate-brand-icons.cjs`，需要本地可用的 sharp。也可通过 `CAI_SHARP_MODULE` 指定已有 sharp 模块路径，无需运行时安装依赖。脚本生成当前仓库中的 PNG、ICO 和 ICNS，不执行应用打包。

主窗口右侧设置入口、超级面板及设置页的默认头像分别引用两份 `assets/image/default.png`；它们也由同一脚本生成，避免只替换应用图标而遗漏这些入口。用户自定义头像仍按原设置显示。
