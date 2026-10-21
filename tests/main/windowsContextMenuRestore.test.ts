import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'
import { BLOCKED_KEYS } from '../../src/shared/windowsContextMenu'

const entryId = 'HKCU\\Software\\Classes\\*\\shell\\RestoreTest'
const clsid = '{0D2E74C4-3C34-4B3F-9B4F-6E1D5C3A2B10}'
const older = '1700000000000-00000000-0000-4000-8000-000000000001'
const newer = '1700000000001-00000000-0000-4000-8000-000000000002'
const newest = '1700000000002-00000000-0000-4000-8000-000000000003'
const empty = { kind: 'String', data: '' }

/**
 * 写入与旧版禁用脚本一致的 v1 持久化记录，验证升级后仍可还原。
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

/**
 * 写入与当前脚本格式一致的 v2 记录。
 * @param directory 临时备份目录
 * @param backupId 记录标识
 * @param record 记录主体字段
 * @returns 记录写入完成后的 Promise
 */
async function snapshotV2(
  directory: string,
  backupId: string,
  record: Record<string, unknown>
): Promise<void> {
  await writeFile(
    path.join(directory, `${backupId}.json`),
    JSON.stringify({
      version: 2,
      backupId,
      createdAt: new Date(Number(backupId.slice(0, 13))).toISOString(),
      label: '测试项',
      fromState: 'shown',
      toState: 'disabled',
      ...record
    })
  )
}

/**
 * 生成屏蔽指定扩展的 v2 记录字段。
 * @param id 扩展菜单项标识
 * @returns 记录主体字段
 */
function blockRecord(id: string): Record<string, unknown> {
  return {
    op: 'block',
    entryId: id,
    changes: [{ key: BLOCKED_KEYS.HKCU, valueName: clsid, before: null, after: empty }]
  }
}

/**
 * 创建临时目录并在回调结束后清理。
 * @param run 使用临时目录的测试逻辑
 * @returns 测试完成后的 Promise
 */
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-restore-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('修改还原记录', () => {
  it('v1 记录跨实例读取，失败可重试，成功后重启及重复调用不再次修改', async () => {
    await withDirectory(async (directory) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'Access denied' })
        .mockResolvedValue({ success: true })
      await snapshot(directory, older)
      const first = new WindowsContextMenuManager(directory, 'win32', execute)
      const history = await first.listBackups()
      expect(history.backups?.[0]).toMatchObject({
        backupId: older,
        canRestore: true,
        op: 'verb-state',
        fromState: 'shown',
        toState: 'disabled',
        label: 'RestoreTest',
        backupPath: path.join(directory, `${older}.reg`)
      })
      expect((await first.restore([older])).success).toBe(false)
      expect(
        JSON.parse(await readFile(path.join(directory, `${older}.json`), 'utf8')).restoredAt
      ).toBeUndefined()
      const restarted = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await restarted.restore([older])).success).toBe(true)
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'restore',
          record: {
            op: 'verb-state',
            entryId,
            changes: [{ key: entryId, valueName: 'LegacyDisable', before: null, after: empty }]
          }
        })
      )
      const stored = JSON.parse(await readFile(path.join(directory, `${older}.json`), 'utf8'))
      expect(stored).toMatchObject({ version: 1, originalEnabled: true })
      expect((await restarted.listBackups()).backups?.[0]).toMatchObject({
        canRestore: false,
        restoredAt: expect.any(String)
      })
      const again = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await again.restore([older])).success).toBe(true)
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'verify-restored' })
      )
    })
  })

  it('只允许还原同一注册表值最近一次修改，跨 v1/v2 及扩展类型判断冲突', async () => {
    await withDirectory(async (directory) => {
      const execute = vi.fn().mockResolvedValue({ success: true })
      await snapshot(directory, older)
      await snapshotV2(directory, newer, {
        op: 'verb-state',
        entryId,
        changes: [{ key: entryId, valueName: 'LegacyDisable', before: null, after: empty }]
      })
      await snapshotV2(directory, newest, blockRecord(`PACKAGED\\${clsid}`))
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      const backups = (await manager.listBackups()).backups!
      expect(backups.map((item) => [item.backupId, item.canRestore])).toEqual([
        [newest, true],
        [newer, true],
        [older, false]
      ])
      expect((await manager.restore([older])).success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      expect((await manager.restore([newer])).success).toBe(true)
      expect((await manager.restore([older])).success).toBe(false)
      expect(execute).toHaveBeenCalledTimes(1)
      // 同一 CLSID 的 Shell 扩展与新式菜单共用屏蔽值，旧记录不得覆盖新状态。
      const shellex = '1699999999999-00000000-0000-4000-8000-000000000004'
      await snapshotV2(directory, shellex, blockRecord(`SHELLEX\\${clsid}`))
      expect(
        (await manager.listBackups()).backups?.find((item) => item.backupId === shellex)
      ).toMatchObject({ canRestore: false })
    })
  })

  it('批量还原逐条执行，单条失败不影响其他记录并返回逐条结果', async () => {
    await withDirectory(async (directory) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: '外部修改' })
        .mockResolvedValue({ success: true })
      await snapshotV2(directory, newer, {
        op: 'verb-state',
        entryId,
        fromState: 'shown',
        toState: 'extended',
        changes: [{ key: entryId, valueName: 'Extended', before: null, after: empty }]
      })
      await snapshotV2(directory, newest, blockRecord(`SHELLEX\\${clsid}`))
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      const result = await manager.restore([newest, newer])
      expect(result.success).toBe(false)
      expect(result.results).toEqual([
        { id: newest, success: false, error: '外部修改' },
        { id: newer, success: true, backupPath: path.join(directory, `${newer}.reg`) }
      ])
      const backups = (await manager.listBackups()).backups!
      expect(backups.find((item) => item.backupId === newest)?.canRestore).toBe(true)
      expect(backups.find((item) => item.backupId === newer)?.restoredAt).toEqual(
        expect.any(String)
      )
    })
  })

  it('经典菜单记录可还原，篡改的状态无效', async () => {
    await withDirectory(async (directory) => {
      const execute = vi.fn().mockResolvedValue({ success: true })
      await snapshotV2(directory, newer, {
        op: 'classic-menu',
        entryId: 'CLASSIC_MENU',
        fromState: 'off',
        toState: 'on',
        before: false,
        after: true
      })
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await manager.restore([newer])).success).toBe(true)
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'restore',
          record: { op: 'classic-menu', entryId: 'CLASSIC_MENU', before: false, after: true }
        })
      )
      await snapshotV2(directory, newest, {
        op: 'classic-menu',
        entryId: 'CLASSIC_MENU',
        before: true,
        after: true
      })
      expect((await manager.listBackups()).warnings).toHaveLength(1)
    })
  })

  it.each([
    ['v1 菜单项越界', { entryId: 'HKCU\\Other' }, 1],
    [
      'v2 修改了其他注册表项',
      {
        op: 'verb-state',
        entryId,
        changes: [
          { key: 'HKCU\\Software\\Other', valueName: 'LegacyDisable', before: null, after: empty }
        ]
      },
      2
    ],
    [
      'v2 写入任意值名',
      {
        op: 'verb-state',
        entryId,
        changes: [{ key: entryId, valueName: 'Run', before: null, after: empty }]
      },
      2
    ],
    [
      'v2 屏蔽值与 CLSID 不符',
      {
        op: 'block',
        entryId: `SHELLEX\\${clsid}`,
        changes: [
          {
            key: BLOCKED_KEYS.HKCU,
            valueName: '{11111111-1111-4111-8111-111111111111}',
            before: null,
            after: empty
          }
        ]
      },
      2
    ],
    [
      'v2 写入非屏蔽列表',
      {
        op: 'block',
        entryId: `SHELLEX\\${clsid}`,
        changes: [{ key: 'HKCU\\Software\\Run', valueName: clsid, before: null, after: empty }]
      },
      2
    ],
    [
      'v2 不支持的值类型',
      {
        op: 'verb-state',
        entryId,
        changes: [
          {
            key: entryId,
            valueName: 'LegacyDisable',
            before: { kind: 'Binary', data: '00' },
            after: null
          }
        ]
      },
      2
    ]
  ])('记录被篡改（%s）时报告损坏且拒绝任何写入', async (_name, record, version) => {
    await withDirectory(async (directory) => {
      const execute = vi.fn()
      if (version === 1) await snapshot(directory, older, record)
      else await snapshotV2(directory, older, record)
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await manager.listBackups()).warnings).toHaveLength(1)
      expect((await manager.restore([older])).success).toBe(false)
      expect((await manager.apply([{ id: entryId, state: 'disabled' }])).success).toBe(false)
      expect((await manager.setClassicMenu(true)).success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
    })
  })

  it('记录损坏、任意文件名不得触发注册表操作', async () => {
    await withDirectory(async (directory) => {
      const execute = vi.fn()
      const manager = new WindowsContextMenuManager(directory, 'win32', execute)
      expect((await manager.restore(['../other'])).success).toBe(false)
      expect((await manager.restore([older])).success).toBe(false)
      await writeFile(path.join(directory, `${older}.json`), '{partial')
      expect((await manager.restore([older])).success).toBe(false)
      expect((await manager.apply([{ id: entryId, state: 'disabled' }])).success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
    })
  })

  it('还原期间阻止其他写入，异常后释放写锁', async () => {
    await withDirectory(async (directory) => {
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
        const restore = manager.restore([older])
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
        expect((await manager.apply([{ id: entryId, state: 'disabled' }])).success).toBe(false)
        expect((await manager.restore([older])).success).toBe(false)
        release()
        expect((await restore).success).toBe(false)
        expect((await manager.restore([older])).success).toBe(true)
      } finally {
        release()
      }
    })
  })
})
