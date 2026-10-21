import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'

const entryId = 'HKCU\\Software\\Classes\\*\\shell\\RestoreTest'
const older = '1700000000000-00000000-0000-4000-8000-000000000001'
const newer = '1700000000001-00000000-0000-4000-8000-000000000002'

/**
 * 写入与 Windows 禁用脚本一致的持久化记录，隔离验证重启后的还原流程。
 * @param directory 临时备份目录
 * @param backupId 记录标识
 * @param overrides 用于损坏或修改记录的测试字段
 * @returns 记录写入完成后的 Promise
 */
async function snapshot(
  directory: string,
  backupId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await writeFile(
    path.join(directory, `${backupId}.json`),
    JSON.stringify({
      version: 1,
      originalEnabled: true,
      backupId,
      entryId,
      createdAt: new Date(Number(backupId.slice(0, 13))).toISOString(),
      backupPath: '/untrusted/path.reg',
      ...overrides
    })
  )
}

describe('禁用还原记录', () => {
  it('跨实例读取持久化记录，还原失败可重试，成功后重启及重复调用不再次修改', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-restore-'))
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Access denied' })
      .mockResolvedValue({ success: true })
    try {
      await snapshot(directory, older)
      const first = new WindowsContextMenuManager(directory, 'win32', execute)
      const history = await first.listBackups()
      expect(history.backups?.[0]).toMatchObject({
        backupId: older,
        canRestore: true,
        backupPath: path.join(directory, `${older}.reg`)
      })
      expect((await first.restore(older)).success).toBe(false)
      expect(
        JSON.parse(await readFile(path.join(directory, `${older}.json`), 'utf8')).restoredAt
      ).toBeUndefined()
      const restarted = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await restarted.restore(older)).success).toBe(true)
      expect(execute).toHaveBeenLastCalledWith({ action: 'restore', id: entryId })
      expect((await restarted.listBackups()).backups?.[0]).toMatchObject({
        canRestore: false,
        restoredAt: expect.any(String)
      })
      const again = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await again.restore(older)).success).toBe(true)
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenLastCalledWith({ action: 'verify-restored', id: entryId })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('只允许还原同一菜单最近一次禁用，拒绝旧记录覆盖新状态', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-restore-'))
    const execute = vi.fn().mockResolvedValue({ success: true })
    try {
      await snapshot(directory, older)
      await snapshot(directory, newer)
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await manager.restore(older)).success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      expect((await manager.restore(newer)).success).toBe(true)
      expect((await manager.restore(older)).success).toBe(false)
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('记录损坏、路径被篡改及任意文件名不得触发注册表操作', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-restore-'))
    const execute = vi.fn()
    try {
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await manager.restore('../other')).success).toBe(false)
      expect((await manager.restore(older)).success).toBe(false)
      await snapshot(directory, older, { entryId: 'HKCU\\Other' })
      expect((await manager.listBackups()).warnings).toHaveLength(1)
      expect((await manager.restore(older)).success).toBe(false)
      await writeFile(path.join(directory, `${older}.json`), '{partial')
      expect((await manager.restore(older)).success).toBe(false)
      expect((await manager.setEnabled(entryId, false)).success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('还原期间阻止其他写入，异常后释放写锁', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-restore-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        throw new Error('Interrupted')
      })
      .mockResolvedValue({ success: true })
    try {
      await snapshot(directory, older)
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      const restore = manager.restore(older)
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      expect((await manager.setEnabled(entryId, false)).success).toBe(false)
      expect((await manager.restore(older)).success).toBe(false)
      release()
      expect((await restore).success).toBe(false)
      expect((await manager.restore(older)).success).toBe(true)
    } finally {
      release()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
