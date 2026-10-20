import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { PluginManager } from '../../managers/pluginManager'
import { WindowsContextMenuManager } from '../../utils/windowsContextMenu'
import { getInternalPluginPath } from '../../core/internalPlugins'

/**
 * 注册注册表管理接口，仅授权已识别的内置右键菜单插件主框架。
 * @param pluginManager 用于识别插件实例的管理器；不可用时拒绝访问
 * @returns 无返回值
 */
export function registerWindowsContextMenuIPC(
  pluginManager: Pick<PluginManager, 'getPluginInfoByWebContents'> | null
): void {
  const manager = new WindowsContextMenuManager(
    path.join(app.getPath('userData'), 'context-menu-backups')
  )
  const pluginPath = path.join(
    getInternalPluginPath('windows-context-menu'),
    app.isPackaged ? '' : 'public'
  )

  /**
   * 校验请求来自内置右键菜单插件本身，不将未知窗口或子框架视为已授权。
   * @param event 当前 IPC 请求
   * @returns 无返回值
   * @throws 请求来源不满足权限要求时抛错
   */
  function authorize(event: IpcMainInvokeEvent): void {
    const plugin = pluginManager?.getPluginInfoByWebContents(event.sender)
    if (
      !plugin?.isBundledInternal ||
      plugin.name !== 'windows-context-menu' ||
      plugin.path !== pluginPath ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Windows 右键菜单接口仅限内置右键菜单插件主框架调用。')
    }
  }

  ipcMain.handle('internal:context-menu-list', async (event) => {
    authorize(event)
    return manager.list()
  })
  ipcMain.handle('internal:context-menu-toggle', async (event, id: unknown, enabled: unknown) => {
    authorize(event)
    return manager.setEnabled(id, enabled)
  })
  ipcMain.handle('internal:context-menu-backups', async (event) => {
    authorize(event)
    return manager.listBackups()
  })
  ipcMain.handle('internal:context-menu-restore', async (event, backupId: unknown) => {
    authorize(event)
    return manager.restore(backupId)
  })
}
