# Windows 右键菜单管理

搜索「右键菜单管理」「Windows 右键菜单」或「Context Menu」，打开独立内置插件。插件位于 `internal-plugins/windows-context-menu`，与设置插件分开加载，不再向设置侧栏添加页面。

支持查看当前用户（HKCU）和所有用户（HKLM）`Software\Classes` 下，所有文件、文件和文件夹、文件夹、文件夹空白处、磁盘、桌面空白处的直接 `shell` 菜单项。可按位置、状态筛选，按名称、命令、注册表路径搜索。

禁用设置 `LegacyDisable` 字符串值，启用删除此值，不删除菜单项及命令。每次实际变更前先用 `reg.exe export` 导出完整菜单项，备份失败则不执行修改。备份保存在应用数据目录的 `context-menu-backups`，界面显示最近一次备份路径。

## 禁用后的还原

- 禁用前先保存 `.reg` 备份和对应的版本化 `.json` 还原记录，并刷新到磁盘；这些步骤失败时不禁用。
- 点击顶部「还原记录」，选择最近一次禁用记录的「还原」。记录位于原应用数据目录，迁移到独立插件及重启应用不会更换备份位置。
- 还原仅撤销本工具添加的空字符串禁用标记，保留菜单命令和其他属性；不通过整项导入覆盖其他软件后续的改动。
- 菜单项已删除或禁用标记被外部修改时停止还原，保留记录并显示错误；同一菜单只允许还原最近一次禁用。
- 还原后刷新注册表并回读确认，再保存还原时间。重复请求只校验当前状态，不再次写入。操作失败可重试；如果注册表已恢复但保存记录失败，会明确说明实际结果。
- 旧版只有 `.reg` 的备份仍可手动导入；没有自动伪造旧记录。原本已经禁用的项再次点击禁用不写入、不新建记录。

修改 HKLM 项需要以管理员身份运行应用；工具不会自动提权。若提示拒绝访问，应检查权限后刷新重试。重新打开资源管理器的右键菜单查看效果。Windows 11 的传统菜单一般位于「显示更多选项」。

当前不处理文件类型专属菜单、COM Shell 扩展、Windows 11 新式菜单或 32 位独立注册表视图。已启用表示不存在 `LegacyDisable`，菜单还可能受 `Extended`、`ProgrammaticAccessOnly` 等标志及系统策略影响。资源字符串形式的菜单名称显示原始注册表值。

`.reg` 导入采用合并语义：对原本不存在 `LegacyDisable` 的菜单项，备份额外包含此值的删除指令，因此导入对应备份可恢复修改前的禁用标记。备份仅用于恢复对应菜单项，不替代系统级备份。当前用户同名项可能覆盖所有用户项，因此分别显示两个来源，并不等于它们会同时出现在实际菜单里。

## 验证

- 单元与权限测试：`pnpm exec vitest run tests/main/windowsContextMenu.test.ts tests/main/windowsContextMenuRestore.test.ts tests/main/windowsContextMenuIPC.test.ts`，覆盖跨实例读取记录、失败重试、重复还原只校验、拒绝旧记录、损坏记录和并发保护。
- Windows 注册表集成测试：`pnpm exec vitest run tests/main/windowsContextMenu.windows.test.ts`。仅在 Windows 运行；自动创建唯一命名的 HKCU 测试项及临时备份，验证中文读取、启停、两种原始标记状态的备份导入、跨实例还原、外部修改时拒绝还原及重试，最后清理测试项。其他平台自动跳过。
- 开发模式 Electron E2E：`pnpm test:e2e tests/e2e/windows-context-menu.spec.ts`，使用隔离数据目录，校验真实搜索入口、独立插件页面、IPC 和平台提示。随后以示例数据验证滚动、搜索、取消不写入、确认后刷新、失败保持原状态、还原失败重试及还原成功，并生成明确标注示例数据的截图，不修改注册表。
- Windows 手工验证：在 HKCU 的 `Software\Classes\Directory\Background\shell` 创建专用测试项及无害命令；刷新后禁用、核对 `.reg` 备份与 `LegacyDisable`、启用、核对标记已删除。测试结束删除测试项。
- 额外检查：HKLM 权限不足、备份目录不可写、菜单项被外部删除时应展示失败并刷新，不把操作误报为成功。

Linux 下的单元测试及页面构建无法替代 Windows 的真实注册表和资源管理器验证。

## 开发与随包加载

`pnpm dev` 同时启动主程序、设置插件和本插件。单独启动插件可用 `pnpm dev:context-menu`，端口为 `5178`。E2E 使用独立端口 `15178`，通过 `ZTOOLS_CONTEXT_MENU_DEV_SERVER_URL` 指定测试入口，避免占用日常开发服务。本插件使用根项目的 Vue/Vite 依赖，不需要独立安装一份依赖。

`pnpm typecheck:context-menu` 检查独立插件类型；`pnpm build:context-menu` 构建到插件的 `dist`。根项目构建已包含此步骤。内置插件注册表及 `afterPack` 均包含本插件，打包时缺少其构建产物会报错。

注册表 IPC 仅允许名称、内置标记、源码/安装目录均匹配的内置右键菜单插件主框架调用；设置插件、未知窗口、其他插件、同名外部插件或子框架均拒绝调用。主进程再校验操作路径和布尔状态，限定在支持的直接 shell 子项内。
