import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { WindowsContextMenuManager } from '../../src/main/utils/windowsContextMenu'

const execFileAsync = promisify(execFile)

it.skipIf(process.platform !== 'win32')(
  'Windows 实机：中文菜单、启停及两种原始标记状态的备份恢复',
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cai-context-menu-registry-'))
    const id = `HKCU\\Software\\Classes\\*\\shell\\CAIToolsTest_${randomUUID()}`
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const view =
      process.arch === 'ia32' && !process.env.PROCESSOR_ARCHITEW6432 ? '/reg:32' : '/reg:64'
    const manager = new WindowsContextMenuManager(directory)
    try {
      // 仅创建唯一命名的测试项，不写现有菜单，也不添加可执行命令。
      await execFileAsync(reg, ['add', id, '/ve', '/t', 'REG_SZ', '/d', '右键菜单测试', '/f', view])
      const initial = await manager.list()
      expect(initial.success).toBe(true)
      expect(initial.entries?.find((entry) => entry.id === id)).toMatchObject({
        name: '右键菜单测试',
        enabled: true
      })

      // 原本不存在标记时，导入备份必须删除新加的禁用值。
      const disabled = await manager.setEnabled(id, false)
      expect(disabled.success).toBe(true)
      expect((await manager.list()).entries?.find((entry) => entry.id === id)?.enabled).toBe(false)
      expect(await readFile(disabled.backupPath!, 'utf16le')).toContain('"LegacyDisable"=-')
      await execFileAsync(reg, ['import', disabled.backupPath!, view])
      expect((await manager.list()).entries?.find((entry) => entry.id === id)?.enabled).toBe(true)

      // 禁用后创建全新服务实例，必须仍能发现记录并通过独立还原入口恢复。
      const secondDisable = await manager.setEnabled(id, false)
      expect(secondDisable.success).toBe(true)
      const restarted = new WindowsContextMenuManager(directory)
      const history = await restarted.listBackups()
      const record = history.backups?.find((item) => item.entryId === id && item.canRestore)
      expect(record).toBeDefined()
      expect((await restarted.restore(record!.backupId)).success).toBe(true)
      expect((await restarted.list()).entries?.find((entry) => entry.id === id)?.enabled).toBe(true)
      expect((await restarted.restore(record!.backupId)).success).toBe(true)

      // 外部软件改变标记时拒绝覆盖；恢复本工具的标记后允许重试。
      await restarted.setEnabled(id, false)
      const pending = (await restarted.listBackups()).backups?.find(
        (item) => item.entryId === id && item.canRestore
      )
      await execFileAsync(reg, [
        'add',
        id,
        '/v',
        'LegacyDisable',
        '/t',
        'REG_SZ',
        '/d',
        '外部修改',
        '/f',
        view
      ])
      expect((await restarted.restore(pending!.backupId)).success).toBe(false)
      await execFileAsync(reg, [
        'add',
        id,
        '/v',
        'LegacyDisable',
        '/t',
        'REG_SZ',
        '/d',
        '',
        '/f',
        view
      ])
      expect((await restarted.restore(pending!.backupId)).success).toBe(true)

      // 原本有非空字符串时，启用不应丢失备份中的原值。
      await execFileAsync(reg, [
        'add',
        id,
        '/v',
        'LegacyDisable',
        '/t',
        'REG_SZ',
        '/d',
        '保留原值',
        '/f',
        view
      ])
      const enabled = await manager.setEnabled(id, true)
      expect(enabled.success).toBe(true)
      expect((await manager.list()).entries?.find((entry) => entry.id === id)?.enabled).toBe(true)
      expect(await readFile(enabled.backupPath!, 'utf16le')).toContain('"LegacyDisable"="保留原值"')
      await execFileAsync(reg, ['import', enabled.backupPath!, view])
      expect((await manager.list()).entries?.find((entry) => entry.id === id)?.enabled).toBe(false)
    } finally {
      // 即使断言失败，也清理专用注册表项和临时备份。
      await execFileAsync(reg, ['delete', id, '/f', view]).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000
)
