import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { PluginManager } from '../../src/main/managers/pluginManager'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  list: vi.fn().mockResolvedValue({ success: true, entries: [] }),
  setEnabled: vi.fn().mockResolvedValue({ success: true }),
  listBackups: vi.fn().mockResolvedValue({ success: true, backups: [] }),
  restore: vi.fn().mockResolvedValue({ success: true })
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/context-menu-ipc-test' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/utils/windowsContextMenu', () => ({
  WindowsContextMenuManager: class {
    list = mocks.list
    setEnabled = mocks.setEnabled
    listBackups = mocks.listBackups
    restore = mocks.restore
  }
}))
import { registerWindowsContextMenuIPC } from '../../src/main/api/plugin/windowsContextMenu'

describe('右键菜单 IPC 权限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
  })

  it.each([
    null,
    { name: 'other', isBundledInternal: false, canUseInternalApi: true },
    { name: 'windows-context-menu', isBundledInternal: false, canUseInternalApi: true },
    { name: 'system', isBundledInternal: true, canUseInternalApi: true },
    { name: 'setting', isBundledInternal: true, canUseInternalApi: true },
    {
      name: 'windows-context-menu',
      path: '/other-plugin',
      isBundledInternal: true,
      canUseInternalApi: true
    }
  ])('拒绝未知窗口、同名普通插件及其他内部插件：%j', async (plugin) => {
    const frame = {}
    registerWindowsContextMenuIPC({
      getPluginInfoByWebContents: vi.fn().mockReturnValue(plugin)
    } as unknown as Pick<PluginManager, 'getPluginInfoByWebContents'>)
    const event = { sender: { mainFrame: frame }, senderFrame: frame }
    for (const handler of mocks.handlers.values()) {
      await expect(handler(event, 'invalid', true)).rejects.toThrow('仅限内置右键菜单插件')
    }
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.setEnabled).not.toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
  })

  it('插件管理器未就绪时拒绝调用', async () => {
    registerWindowsContextMenuIPC(null)
    await expect(mocks.handlers.get('internal:context-menu-list')!({ sender: {} })).rejects.toThrow(
      '仅限内置右键菜单插件'
    )
  })

  it('允许独立内置插件主框架，同时拒绝其子框架和已销毁框架', async () => {
    const frame = {}
    registerWindowsContextMenuIPC({
      getPluginInfoByWebContents: vi.fn().mockReturnValue({
        name: 'windows-context-menu',
        path: path.resolve('internal-plugins/windows-context-menu/public'),
        isBundledInternal: true
      })
    } as unknown as Pick<PluginManager, 'getPluginInfoByWebContents'>)
    const event = {
      sender: { mainFrame: frame },
      senderFrame: frame
    } as unknown as IpcMainInvokeEvent
    const list = mocks.handlers.get('internal:context-menu-list')!
    expect(await list(event)).toEqual({ success: true, entries: [] })
    const id = 'HKCU\\Software\\Classes\\*\\shell\\Demo'
    await mocks.handlers.get('internal:context-menu-toggle')!(event, id, false)
    expect(mocks.setEnabled).toHaveBeenCalledWith(id, false)
    await mocks.handlers.get('internal:context-menu-backups')!(event)
    await mocks.handlers.get('internal:context-menu-restore')!(event, 'backup-id')
    expect(mocks.listBackups).toHaveBeenCalledTimes(1)
    expect(mocks.restore).toHaveBeenCalledWith('backup-id')
    await expect(list({ ...event, senderFrame: {} })).rejects.toThrow('仅限内置右键菜单插件')
    await expect(list({ ...event, senderFrame: null })).rejects.toThrow('仅限内置右键菜单插件')
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })
})
