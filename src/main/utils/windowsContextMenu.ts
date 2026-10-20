import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CONTEXT_MENU_LOCATIONS,
  isContextMenuId,
  type ContextMenuResult,
  type ContextMenuBackup
} from '../../shared/windowsContextMenu'

const execFileAsync = promisify(execFile)
const backupIdPattern = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// 使用 .NET 注册表接口按字面量读写，名称中的通配符不会被解释为路径表达式。
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
$options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$bases = @{}
try {
  $bases.HKCU = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  $bases.HKLM = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  if ($request.action -eq 'list') {
    $entries = @()
    foreach ($hive in @('HKCU', 'HKLM')) {
      foreach ($location in $request.locations) {
        $relative = 'Software\Classes\' + $location + '\shell'
        $parent = $bases[$hive].OpenSubKey($relative)
        if ($null -eq $parent) { continue }
        try {
          foreach ($name in $parent.GetSubKeyNames()) {
            $key = $parent.OpenSubKey($name)
            if ($null -eq $key) { continue }
            try {
              $label = [string]$key.GetValue('MUIVerb', '', $options)
              if (!$label) { $label = [string]$key.GetValue('', $name, $options) }
              $commandKey = $key.OpenSubKey('command')
              $command = ''
              if ($null -ne $commandKey) {
                try { $command = [string]$commandKey.GetValue('', '', $options) } finally { $commandKey.Dispose() }
              }
              $entries += @{
                id = $hive + '\' + $relative + '\' + $name
                name = $label; hive = $hive; location = $location; command = $command
                enabled = !($key.GetValueNames() -contains 'LegacyDisable')
              }
            } finally { $key.Dispose() }
          }
        } finally { $parent.Dispose() }
      }
    }
    @{ success = $true; entries = @($entries) } | ConvertTo-Json -Depth 5 -Compress
  } else {
    $parts = $request.id.Split('\', 2)
    $key = $bases[$parts[0]].OpenSubKey($parts[1], ($request.action -ne 'verify-restored'))
    if ($null -eq $key) { throw '菜单项已不存在，请刷新列表。' }
    try {
      $enabled = !($key.GetValueNames() -contains 'LegacyDisable')
      if ($request.action -eq 'verify-restored') {
        if (!$enabled) { throw '该记录还原后菜单又被禁用，请刷新检查当前状态。' }
        @{ success = $true } | ConvertTo-Json -Compress
      } elseif ($request.action -eq 'restore') {
        # 只撤销本工具写入的空字符串标记；其他软件改过的值不覆盖。
        if (!$enabled) {
          if ($key.GetValueKind('LegacyDisable') -ne [Microsoft.Win32.RegistryValueKind]::String -or [string]$key.GetValue('LegacyDisable', $null, $options) -ne '') {
            throw '禁用标记已被外部修改，未执行还原。请检查该菜单项。'
          }
          $key.DeleteValue('LegacyDisable', $false)
          $key.Flush()
        }
        if ($key.GetValueNames() -contains 'LegacyDisable') { throw '还原后回读校验失败。' }
        @{ success = $true } | ConvertTo-Json -Compress
      } elseif ($enabled -eq $request.enabled) {
        @{ success = $true } | ConvertTo-Json -Compress
      } else {
        # 先成功导出完整菜单项，再改变唯一的禁用标记；导出失败不写注册表。
        $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
        $regView = if ([Environment]::Is64BitOperatingSystem) { '/reg:64' } else { '/reg:32' }
        & $reg export $request.id $request.backupPath /y $regView | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '注册表备份失败，未修改菜单项。' }
        # .reg 导入只合并值；补上删除指令才能恢复原本不存在的禁用标记。
        if ($enabled) {
          $rootName = if ($parts[0] -eq 'HKCU') { 'HKEY_CURRENT_USER' } else { 'HKEY_LOCAL_MACHINE' }
          $section = $rootName + '\' + $parts[1]
          $undo = [Environment]::NewLine + '[' + $section + ']' + [Environment]::NewLine + '"LegacyDisable"=-' + [Environment]::NewLine
          [System.IO.File]::AppendAllText($request.backupPath, $undo, [System.Text.Encoding]::Unicode)
          # 先持久化恢复记录，进程意外退出或应用重启后仍能找到原始状态。
          $record = @{
            version = 1; originalEnabled = $true
            backupId = $request.backupId; entryId = $request.id
            createdAt = $request.createdAt; backupPath = $request.backupPath
          } | ConvertTo-Json -Compress
          $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($record)
          $file = [System.IO.File]::Open($request.recordPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
          try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        }
        # 将完整备份刷新到磁盘；任何一步失败均不会进入禁用写入。
        $file = [System.IO.File]::Open($request.backupPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        try { $file.Flush($true) } finally { $file.Dispose() }
        if ($request.enabled) { $key.DeleteValue('LegacyDisable', $false) }
        else { $key.SetValue('LegacyDisable', '', [Microsoft.Win32.RegistryValueKind]::String) }
        $key.Flush()
        $actualEnabled = !($key.GetValueNames() -contains 'LegacyDisable')
        if ($actualEnabled -ne $request.enabled) { throw '修改后回读校验失败，备份已保留。' }
        @{ success = $true; backupPath = $request.backupPath } | ConvertTo-Json -Compress
      }
    } finally { $key.Dispose() }
  }
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  foreach ($base in $bases.Values) { $base.Dispose() }
}
`

/**
 * 使用编码命令执行固定脚本，参数作为 JSON 数据传递而非拼接为 PowerShell 语法。
 * @param request 已校验的操作及参数
 * @returns PowerShell 返回的结构化操作结果
 * @throws PowerShell 启动失败、超时或结果格式异常时抛错
 */
async function runRegistryRequest(request: Record<string, unknown>): Promise<ContextMenuResult> {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const script = `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${registryScript}`
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const { stdout } = await execFileAsync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }
  )
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as ContextMenuResult
}

export class WindowsContextMenuManager {
  private busy = false

  /**
   * 创建右键菜单服务并限定备份存放位置。
   * @param backupDirectory 应用数据目录内的注册表备份文件夹
   * @param platform 当前操作系统，测试时可替换
   * @param execute 固定注册表脚本执行器，测试时可替换
   * @returns 右键菜单服务实例
   */
  constructor(
    private readonly backupDirectory: string,
    private readonly platform: string = process.platform,
    private readonly execute = runRegistryRequest
  ) {}

  /**
   * 列出当前用户及计算机范围内受支持的传统菜单项。
   * @returns 菜单列表或可展示的错误
   */
  async list(): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    try {
      return await this.execute({ action: 'list', locations: Object.keys(CONTEXT_MENU_LOCATIONS) })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 从应用数据目录读取持久化禁用记录；损坏记录明确报错且不参与还原。
   * @returns 可还原记录及读取警告
   */
  async listBackups(): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    try {
      const backups: ContextMenuBackup[] = []
      const warnings: string[] = []
      await mkdir(this.backupDirectory, { recursive: true })
      for (const file of await readdir(this.backupDirectory, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const backupId = file.name.slice(0, -5)
        if (!backupIdPattern.test(backupId)) continue
        try {
          const record = JSON.parse(
            await readFile(path.join(this.backupDirectory, file.name), 'utf8')
          )
          if (
            record.version !== 1 ||
            record.originalEnabled !== true ||
            record.backupId !== backupId ||
            !isContextMenuId(record.entryId) ||
            typeof record.createdAt !== 'string' ||
            !Number.isFinite(Date.parse(record.createdAt)) ||
            (record.restoredAt !== undefined &&
              (typeof record.restoredAt !== 'string' ||
                !Number.isFinite(Date.parse(record.restoredAt))))
          )
            throw new Error('记录格式无效')
          // 不信任记录中保存的路径，所有备份必须来自固定目录及校验后的文件名。
          backups.push({
            backupId,
            entryId: record.entryId,
            createdAt: record.createdAt,
            backupPath: path.join(this.backupDirectory, `${backupId}.reg`),
            restoredAt: record.restoredAt
          })
        } catch {
          warnings.push(`还原记录损坏：${file.name}。对应 .reg 备份仍保留，请检查。`)
        }
      }
      backups.sort((a, b) => b.backupId.localeCompare(a.backupId))
      const seen = new Set<string>()
      for (const backup of backups) {
        backup.canRestore = !seen.has(backup.entryId) && !backup.restoredAt
        seen.add(backup.entryId)
      }
      return { success: true, backups, warnings }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 按持久化记录撤销最近一次禁用，只恢复本工具修改的标记，不覆盖菜单命令。
   * @param backupId 固定目录内的禁用记录标识
   * @returns 回读校验完成后的还原结果
   */
  async restore(backupId: unknown): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    if (typeof backupId !== 'string' || !backupIdPattern.test(backupId)) {
      return { success: false, error: '无效的还原记录。' }
    }
    if (this.busy) return { success: false, error: '正在修改菜单项，请稍后重试。' }
    this.busy = true
    let temporaryPath: string | undefined
    let verified = false
    try {
      const history = await this.listBackups()
      if (!history.success || history.warnings?.length)
        throw new Error(history.error || '还原记录存在损坏，请检查备份文件。')
      const record = history.backups?.find((item) => item.backupId === backupId)
      if (!record) throw new Error('还原记录不存在。')
      if (history.backups?.find((item) => item.entryId === record.entryId)?.backupId !== backupId) {
        throw new Error('存在更新的禁用记录，请还原最新一条。')
      }
      if (record.restoredAt)
        return await this.execute({ action: 'verify-restored', id: record.entryId })
      if (!record.canRestore) throw new Error('存在更新的禁用记录，请还原最新一条。')
      // 记录验证通过后由固定脚本读取实际值，遇到外部修改或菜单删除时停止。
      const result = await this.execute({ action: 'restore', id: record.entryId })
      if (!result.success) return result
      verified = true
      const { canRestore: _canRestore, ...stored } = record
      temporaryPath = path.join(this.backupDirectory, `${backupId}.${randomUUID()}.tmp`)
      await writeFile(
        temporaryPath,
        JSON.stringify({
          ...stored,
          version: 1,
          originalEnabled: true,
          restoredAt: new Date().toISOString()
        }),
        { encoding: 'utf8', flag: 'wx', flush: true }
      )
      await rename(temporaryPath, path.join(this.backupDirectory, `${backupId}.json`))
      return { success: true, backupPath: record.backupPath }
    } catch (error) {
      return {
        success: false,
        error: verified
          ? `注册表已还原，但保存还原状态失败；记录已保留，可重试。${String(error)}`
          : String(error)
      }
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
      this.busy = false
    }
  }

  /**
   * 备份菜单项后启用或禁用，只修改 LegacyDisable 值且串行执行写入。
   * @param id 列表返回的菜单项标识
   * @param enabled 是否启用菜单项
   * @returns 操作结果及成功备份的路径
   */
  async setEnabled(id: unknown, enabled: unknown): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    if (!isContextMenuId(id) || typeof enabled !== 'boolean') {
      return { success: false, error: '无效的菜单项或状态。' }
    }
    if (this.busy) return { success: false, error: '正在修改菜单项，请稍后重试。' }
    // 在任何异步操作之前锁定写入，避免两次操作备份与修改相互覆盖。
    this.busy = true
    try {
      await mkdir(this.backupDirectory, { recursive: true })
      // 恢复记录不可读或已损坏时停止新增禁用，避免积累无法在界面还原的操作。
      if (!enabled) {
        const history = await this.listBackups()
        if (!history.success || history.warnings?.length) {
          return {
            success: false,
            error: history.error || '还原记录存在损坏，未禁用菜单项。请先检查备份。'
          }
        }
      }
      const backupId = `${Date.now()}-${randomUUID()}`
      const backupPath = path.join(this.backupDirectory, `${backupId}.reg`)
      return await this.execute({
        action: 'toggle',
        id,
        enabled,
        backupPath,
        backupId,
        recordPath: path.join(this.backupDirectory, `${backupId}.json`),
        createdAt: new Date().toISOString()
      })
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      // 失败也必须释放锁，允许刷新状态后再次尝试。
      this.busy = false
    }
  }
}
