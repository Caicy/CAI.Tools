import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isContextMenuId } from '../../src/shared/windowsContextMenu'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'

describe('Windows 右键菜单管理边界', () => {
  it('接受字面量菜单名称，拒绝任意路径、嵌套子项及控制字符', () => {
    expect(isContextMenuId('HKCU\\Software\\Classes\\*\\shell\\菜单 [abc]')).toBe(true)
    expect(isContextMenuId('HKLM\\Software\\Classes\\Directory\\Background\\shell\\VSCode')).toBe(
      true
    )
    for (const id of [
      null,
      42,
      '',
      'HKCR\\Software\\Classes\\*\\shell\\x',
      'HKCU\\Software\\Microsoft\\Windows\\Run',
      'HKCU\\Software\\Classes\\*\\shell\\x\\command',
      'HKCU\\Software\\Classes\\*\\shell\\',
      'HKCU\\Software\\Classes\\*\\shell\\..',
      'HKCU\\Software\\Classes\\*\\shell\\x\nInjected'
    ]) {
      expect(isContextMenuId(id)).toBe(false)
    }
  })

  it('非 Windows 环境不执行注册表脚本', async () => {
    const execute = vi.fn()
    const manager = new WindowsContextMenuManager('/unused', 'linux', execute)
    expect((await manager.list()).success).toBe(false)
    expect((await manager.setEnabled('anything', true)).success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('写入前拒绝不可信 IPC 参数', async () => {
    const execute = vi.fn()
    const manager = new WindowsContextMenuManager('/unused', 'win32', execute)
    expect((await manager.setEnabled('HKCU\\Other', true)).success).toBe(false)
    expect(
      (await manager.setEnabled('HKCU\\Software\\Classes\\*\\shell\\Demo', 'false')).success
    ).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('阻止并发写入，执行失败后释放锁并为重试生成独立备份路径', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'context-menu-test-'))
    const id = 'HKCU\\Software\\Classes\\*\\shell\\Demo'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        throw new Error('Access denied')
      })
      .mockResolvedValue({ success: true })
    const manager = new WindowsContextMenuManager(directory, 'win32', execute)
    try {
      const first = manager.setEnabled(id, false)
      expect((await manager.setEnabled(id, true)).success).toBe(false)
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      release()
      expect(await first).toMatchObject({ success: false, error: 'Error: Access denied' })
      expect((await manager.setEnabled(id, false)).success).toBe(true)
      const [one, two] = execute.mock.calls.map(([request]) => request)
      expect(one).toMatchObject({ action: 'toggle', id, enabled: false })
      expect(path.dirname(one.backupPath)).toBe(directory)
      expect(one.backupPath).not.toBe(two.backupPath)
    } finally {
      release()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
