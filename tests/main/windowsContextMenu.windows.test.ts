import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'
import { BLOCKED_KEYS, type ContextMenuState } from '../../src/shared/windowsContextMenu'

const execFileAsync = promisify(execFile)
const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
const view = process.arch === 'ia32' && !process.env.PROCESSOR_ARCHITEW6432 ? '/reg:32' : '/reg:64'

/**
 * 查询注册表值是否存在，不存在时 reg.exe 以非零码退出。
 * @param key 完整注册表键
 * @param name 值名称；为空字符串时查询默认值
 * @returns 值存在时返回 reg 输出，否则返回 null
 */
async function queryValue(key: string, name: string): Promise<string | null> {
  const args = name ? ['query', key, '/v', name, view] : ['query', key, '/ve', view]
  return execFileAsync(reg, args, { encoding: 'utf8' })
    .then(({ stdout }) => stdout)
    .catch(() => null)
}

/**
 * 读取最新列表中的指定菜单项状态。
 * @param manager 右键菜单服务
 * @param id 菜单项标识
 * @returns 当前状态，未找到时为 undefined
 */
async function stateOf(
  manager: WindowsContextMenuManager,
  id: string
): Promise<ContextMenuState | undefined> {
  return (await manager.list()).entries?.find((entry) => entry.id === id)?.state
}

/**
 * 获取指定菜单项最新且可还原的记录标识。
 * @param manager 右键菜单服务
 * @param entryId 菜单项标识
 * @returns 记录标识
 */
async function latestRecord(manager: WindowsContextMenuManager, entryId: string): Promise<string> {
  const record = (await manager.listBackups()).backups?.find(
    (item) => item.entryId === entryId && item.canRestore
  )
  expect(record).toBeDefined()
  return record!.backupId
}

it.skipIf(process.platform !== 'win32')(
  'Windows 实机：三态切换、批量部分失败、扩展屏蔽、经典菜单及跨实例还原',
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-context-menu-registry-'))
    const id = `HKCU\\Software\\Classes\\*\\shell\\CAIToolsTest_${randomUUID()}`
    const missing = `HKCU\\Software\\Classes\\*\\shell\\CAIToolsMissing_${randomUUID()}`
    const clsid = `{${randomUUID().toUpperCase()}}`
    const classicKey = `Software\\Classes\\CLSID\\{${randomUUID()}}`
    const manager = new WindowsContextMenuManager(directory, 'win32', undefined, classicKey)
    try {
      // 仅创建唯一命名的测试项，不写现有菜单，也不添加可执行命令。
      await execFileAsync(reg, ['add', id, '/ve', '/t', 'REG_SZ', '/d', '右键菜单测试', '/f', view])
      const initial = await manager.list()
      expect(initial.success).toBe(true)
      expect(initial.entries?.find((entry) => entry.id === id)).toMatchObject({
        name: '右键菜单测试',
        kind: 'verb',
        state: 'shown'
      })

      // 原本不存在标记时，导入备份必须删除新加的禁用值。
      const disabled = await manager.apply([{ id, state: 'disabled' }])
      expect(disabled.success).toBe(true)
      expect(disabled.results?.[0]).toMatchObject({ success: true, changed: true })
      expect(await stateOf(manager, id)).toBe('disabled')
      const backupPath = disabled.results![0].backupPath!
      expect(await readFile(backupPath, 'utf16le')).toContain('"LegacyDisable"=-')
      await execFileAsync(reg, ['import', backupPath, view])
      expect(await stateOf(manager, id)).toBe('shown')

      // 仅 Shift 显示后再禁用，禁用保留 Extended；逐条还原依次回到原状态。
      expect((await manager.apply([{ id, state: 'extended' }])).success).toBe(true)
      expect(await stateOf(manager, id)).toBe('extended')
      expect((await manager.apply([{ id, state: 'disabled' }])).success).toBe(true)
      expect(await queryValue(id, 'Extended')).not.toBeNull()
      const restarted = new WindowsContextMenuManager(directory, 'win32', undefined, classicKey)
      expect((await restarted.restore([await latestRecord(restarted, id)])).success).toBe(true)
      expect(await stateOf(restarted, id)).toBe('extended')
      const extendedRecord = await latestRecord(restarted, id)
      expect((await restarted.restore([extendedRecord])).success).toBe(true)
      expect(await stateOf(restarted, id)).toBe('shown')
      expect((await restarted.restore([extendedRecord])).success).toBe(true)

      // 外部软件改变标记时拒绝覆盖；恢复本工具的标记后允许重试。
      await restarted.apply([{ id, state: 'disabled' }])
      const pending = await latestRecord(restarted, id)
      await execFileAsync(reg, ['add', id, '/v', 'LegacyDisable', '/d', '外部修改', '/f', view])
      expect((await restarted.restore([pending])).success).toBe(false)
      await execFileAsync(reg, ['add', id, '/v', 'LegacyDisable', '/d', '', '/f', view])
      expect((await restarted.restore([pending])).success).toBe(true)

      // 批量操作中不存在的菜单项单独失败，其余项照常完成且各自留有记录。
      const batch = await manager.apply([
        { id, state: 'disabled' },
        { id: missing, state: 'disabled' },
        { id: `SHELLEX\\${clsid}`, state: 'disabled' }
      ])
      expect(batch.success).toBe(false)
      expect(batch.results?.map((item) => item.success)).toEqual([true, false, true])
      expect(batch.results?.[1].error).toContain('不存在')
      expect(await stateOf(manager, id)).toBe('disabled')
      expect(await queryValue(BLOCKED_KEYS.HKCU, clsid)).not.toBeNull()
      const history = await manager.listBackups()
      expect(history.backups?.some((item) => item.entryId === missing)).toBe(false)
      const toRestore = (history.backups || [])
        .filter((item) => item.canRestore && [id, `SHELLEX\\${clsid}`].includes(item.entryId))
        .map((item) => item.backupId)
      expect(toRestore).toHaveLength(2)
      expect((await manager.restore(toRestore)).success).toBe(true)
      expect(await stateOf(manager, id)).toBe('shown')
      expect(await queryValue(BLOCKED_KEYS.HKCU, clsid)).toBeNull()

      // 经典菜单开关使用专用测试项，验证开启、关闭以及按记录撤销关闭。
      const classicPath = `HKCU\\${classicKey}\\InprocServer32`
      expect((await manager.setClassicMenu(true)).success).toBe(true)
      expect(await queryValue(classicPath, '')).not.toBeNull()
      expect((await manager.setClassicMenu(false)).success).toBe(true)
      expect(await queryValue(classicPath, '')).toBeNull()
      expect((await manager.restore([await latestRecord(manager, 'CLASSIC_MENU')])).success).toBe(
        true
      )
      expect(await queryValue(classicPath, '')).not.toBeNull()
    } finally {
      // 即使断言失败，也清理专用注册表项、屏蔽值和临时备份。
      await execFileAsync(reg, ['delete', id, '/f', view]).catch(() => undefined)
      await execFileAsync(reg, ['delete', BLOCKED_KEYS.HKCU, '/v', clsid, '/f', view]).catch(
        () => undefined
      )
      await execFileAsync(reg, ['delete', `HKCU\\${classicKey}`, '/f', view]).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  },
  180_000
)
