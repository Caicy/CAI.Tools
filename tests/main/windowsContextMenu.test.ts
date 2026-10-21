import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BLOCKED_KEYS,
  MAX_BATCH_SIZE,
  isContextMenuId,
  parseContextMenuId,
  supportsState
} from '../../src/shared/windowsContextMenu'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'

const verb = 'HKCU\\Software\\Classes\\*\\shell\\Demo'
const clsid = '{0D2E74C4-3C34-4B3F-9B4F-6E1D5C3A2B10}'

describe('Windows 右键菜单管理边界', () => {
  it('接受字面量菜单名称，拒绝任意路径、嵌套子项及控制字符', () => {
    expect(isContextMenuId('HKCU\\Software\\Classes\\*\\shell\\菜单 [abc]')).toBe(true)
    expect(isContextMenuId('HKLM\\Software\\Classes\\Directory\\Background\\shell\\VSCode')).toBe(
      true
    )
    expect(isContextMenuId('HKCU\\Software\\Classes\\Folder\\shell\\Demo')).toBe(true)
    for (const id of [
      null,
      42,
      '',
      'HKCR\\Software\\Classes\\*\\shell\\x',
      'HKCU\\Software\\Microsoft\\Windows\\Run',
      'HKCU\\Software\\Classes\\*\\shell\\x\\command',
      'HKCU\\Software\\Classes\\*\\shell\\',
      'HKCU\\Software\\Classes\\*\\shell\\..',
      'HKCU\\Software\\Classes\\*\\shell\\x\nInjected',
      `SHELLEX\\${clsid}`
    ]) {
      expect(isContextMenuId(id)).toBe(false)
    }
  })

  it('扩展标识只接受格式严格的 CLSID，并统一为大写', () => {
    expect(parseContextMenuId(`SHELLEX\\${clsid.toLowerCase()}`)).toEqual({
      kind: 'shellex',
      clsid
    })
    expect(parseContextMenuId(`PACKAGED\\${clsid}`)).toEqual({ kind: 'packaged', clsid })
    expect(parseContextMenuId(verb)).toEqual({ kind: 'verb', key: verb, hive: 'HKCU' })
    for (const id of [
      'SHELLEX\\{not-a-guid}',
      `SHELLEX\\${clsid}\\x`,
      `SHELLEX\\..\\${clsid}`,
      `shellex\\${clsid}`,
      `OTHER\\${clsid}`
    ]) {
      expect(parseContextMenuId(id)).toBeNull()
    }
    expect(supportsState('verb', 'extended')).toBe(true)
    expect(supportsState('shellex', 'extended')).toBe(false)
    expect(supportsState('packaged', 'disabled')).toBe(true)
    expect(supportsState('verb', 'hidden')).toBe(false)
  })

  it('非 Windows 环境不执行注册表脚本', async () => {
    const execute = vi.fn()
    const manager = new WindowsContextMenuManager('/unused', 'linux', execute)
    expect((await manager.list()).success).toBe(false)
    expect((await manager.apply([{ id: verb, state: 'disabled' }])).success).toBe(false)
    expect((await manager.restore(['x'])).success).toBe(false)
    expect((await manager.setClassicMenu(true)).success).toBe(false)
    expect((await manager.restartExplorer()).success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('写入前整批拒绝不可信 IPC 参数', async () => {
    const execute = vi.fn()
    const manager = new WindowsContextMenuManager('/unused', 'win32', execute)
    for (const changes of [
      'x',
      [],
      [{ id: 'HKCU\\Other', state: 'disabled' }],
      [{ id: verb, state: 'false' }],
      [{ id: `SHELLEX\\${clsid}`, state: 'extended' }],
      [{ id: verb, state: 'disabled' }, null],
      [
        { id: verb, state: 'disabled' },
        { id: verb, state: 'shown' }
      ],
      Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => ({
        id: `${verb}${index}`,
        state: 'disabled'
      }))
    ]) {
      expect((await manager.apply(changes)).success).toBe(false)
    }
    for (const ids of ['id', [], [42], ['../x'], ['a', 'a']]) {
      expect((await manager.restore(ids)).success).toBe(false)
    }
    expect((await manager.setClassicMenu('true')).success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('批量修改一次执行，逐项分配有序且独立的备份并清理标签', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'context-menu-test-'))
    const execute = vi.fn().mockResolvedValue({ success: true, results: [] })
    const manager = new WindowsContextMenuManager(directory, 'win32', execute)
    try {
      await manager.apply([
        { id: verb, state: 'extended', label: '演示\n菜单'.padEnd(200, 'x') },
        { id: `SHELLEX\\${clsid.toLowerCase()}`, state: 'disabled' },
        { id: `PACKAGED\\${clsid}`, state: 'shown' }
      ])
      expect(execute).toHaveBeenCalledTimes(1)
      const [request, timeout] = execute.mock.calls[0]
      expect(request).toMatchObject({ action: 'apply', blockedKeys: BLOCKED_KEYS })
      expect(timeout).toBeGreaterThan(30_000)
      const [first, second, third] = request.changes
      expect(first).toMatchObject({ id: verb, kind: 'verb', state: 'extended' })
      expect(first.label).toHaveLength(120)
      expect(first.label).not.toMatch(/\n/)
      expect(second).toMatchObject({ kind: 'shellex', clsid, state: 'disabled' })
      expect(third).toMatchObject({ kind: 'packaged', clsid, state: 'shown' })
      const ids = request.changes.map((item: { backupId: string }) => item.backupId)
      expect([...ids].sort()).toEqual(ids)
      expect(new Set(ids).size).toBe(3)
      for (const item of request.changes) {
        expect(path.dirname(item.backupPath)).toBe(directory)
        expect(item.recordPath).toBe(path.join(directory, `${item.backupId}.json`))
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('阻止并发写入，执行失败后释放锁并为重试生成独立备份路径', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'context-menu-test-'))
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
      const first = manager.apply([{ id: verb, state: 'disabled' }])
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      expect((await manager.apply([{ id: verb, state: 'shown' }])).success).toBe(false)
      expect((await manager.setClassicMenu(true)).success).toBe(false)
      expect((await manager.restartExplorer()).success).toBe(false)
      release()
      expect(await first).toMatchObject({ success: false, error: 'Error: Access denied' })
      expect((await manager.apply([{ id: verb, state: 'disabled' }])).success).toBe(true)
      const [one, two] = execute.mock.calls.map(([request]) => request.changes[0])
      expect(path.dirname(one.backupPath)).toBe(directory)
      expect(one.backupPath).not.toBe(two.backupPath)
    } finally {
      release()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('并行读取注册表与新式菜单，新式菜单失败只作为警告', async () => {
    const environment = { build: 26100, win11: true, classicMenu: false, isAdmin: false }
    const execute = vi.fn(async (request: Record<string, unknown>) =>
      request.action === 'list-registry'
        ? { success: true, entries: [{ id: verb }], environment }
        : { success: true, entries: [{ id: `PACKAGED\\${clsid}` }], warnings: ['部分包读取失败'] }
    )
    const manager = new WindowsContextMenuManager('/unused', 'win32', execute)
    expect(await manager.list()).toEqual({
      success: true,
      entries: [{ id: verb }, { id: `PACKAGED\\${clsid}` }],
      environment,
      warnings: ['部分包读取失败']
    })
    execute.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.action === 'list-packaged') throw new Error('Appx unavailable')
      return { success: true, entries: [{ id: verb }], environment }
    })
    const degraded = await manager.list()
    expect(degraded.success).toBe(true)
    expect(degraded.entries).toEqual([{ id: verb }])
    expect(degraded.warnings?.[0]).toContain('Appx unavailable')
    execute.mockResolvedValue({ success: false, error: 'denied' })
    expect(await manager.list()).toEqual({ success: false, error: 'denied' })
  })

  it('经典菜单与重启资源管理器只发送固定参数', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'context-menu-test-'))
    const execute = vi.fn().mockResolvedValue({ success: true })
    const manager = new WindowsContextMenuManager(directory, 'win32', execute, 'Software\\Test')
    try {
      await manager.setClassicMenu(false)
      expect(execute.mock.calls[0][0]).toMatchObject({
        action: 'classic',
        enabled: false,
        entryId: 'CLASSIC_MENU',
        classicKey: 'Software\\Test'
      })
      await manager.restartExplorer()
      expect(execute.mock.calls[1][0]).toMatchObject({ action: 'restart-explorer' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
