import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BLOCKED_KEYS,
  CLASSIC_MENU_CLSID,
  CLASSIC_MENU_ENTRY_ID,
  CONTEXT_MENU_LOCATIONS,
  MAX_BATCH_SIZE,
  isContextMenuId,
  parseContextMenuId,
  supportsState,
  type ContextMenuBackup,
  type ContextMenuItemResult,
  type ContextMenuRecordOp,
  type ContextMenuResult,
  type ContextMenuState,
  type WindowsContextMenuEntry
} from '../../shared/windowsContextMenu'

const backupIdPattern = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const recordStates = new Set(['shown', 'extended', 'disabled', 'on', 'off'])
const verbMarkers = new Set(['LegacyDisable', 'Extended'])
const DEFAULT_CLASSIC_KEY = `Software\\Classes\\CLSID\\${CLASSIC_MENU_CLSID}`

type RegValue = { kind: 'String' | 'DWord'; data: string } | null

interface MarkerChange {
  key: string
  valueName: string
  before: RegValue
  after: RegValue
}

type RestorePayload =
  | { op: 'verb-state' | 'block'; entryId: string; changes: MarkerChange[] }
  | { op: 'classic-menu'; entryId: string; before: boolean; after: boolean }

interface StoredRecord {
  raw: Record<string, unknown>
  backup: ContextMenuBackup
  markers: string[]
  payload: RestorePayload
  superseded: boolean
}

export type RegistryExecutor = (
  request: Record<string, unknown>,
  timeoutMs?: number
) => Promise<ContextMenuResult>

// 使用 .NET 注册表接口按字面量读写，名称中的通配符不会被解释为路径表达式。
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
$options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$clsidPattern = '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$'
$nl = [Environment]::NewLine
$bases = @{}

function Open-Key([string]$keyId, [bool]$writable) {
  $parts = $keyId.Split('\', 2)
  return $bases[$parts[0]].OpenSubKey($parts[1], $writable)
}

function Read-Marker([string]$keyId, [string]$name) {
  $key = Open-Key $keyId $false
  if ($null -eq $key) { return $null }
  try {
    if ($key.GetValueNames() -notcontains $name) { return $null }
    $kind = $key.GetValueKind($name).ToString()
    $value = $key.GetValue($name, $null, $options)
    if ($kind -eq 'DWord') { $value = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$value), 0) }
    return @{ kind = $kind; data = [string]$value }
  } finally { $key.Dispose() }
}

function Test-MarkerEqual($a, $b) {
  if ($null -eq $a -or $null -eq $b) { return ($null -eq $a) -and ($null -eq $b) }
  return ([string]$a.kind -eq [string]$b.kind) -and ([string]$a.data -ceq [string]$b.data)
}

function Test-BlockedKey([string]$keyId) {
  return ($keyId -eq $request.blockedKeys.HKCU) -or ($keyId -eq $request.blockedKeys.HKLM)
}

function Write-Marker([string]$keyId, [string]$name, $value) {
  # 只有屏蔽列表允许创建父项；菜单项被外部删除时不能被重新创建。
  if ($null -eq $value) {
    $key = Open-Key $keyId $true
    if ($null -eq $key) { return }
    try { $key.DeleteValue($name, $false); $key.Flush() } finally { $key.Dispose() }
    return
  }
  $key = Open-Key $keyId $true
  if ($null -eq $key -and (Test-BlockedKey $keyId)) {
    $parts = $keyId.Split('\', 2)
    $key = $bases[$parts[0]].CreateSubKey($parts[1])
  }
  if ($null -eq $key) { throw '菜单项已不存在，请刷新列表。' }
  try {
    if ($value.kind -eq 'DWord') {
      $key.SetValue($name, [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$value.data), 0), [Microsoft.Win32.RegistryValueKind]::DWord)
    } elseif ($value.kind -eq 'String') {
      $key.SetValue($name, [string]$value.data, [Microsoft.Win32.RegistryValueKind]::String)
    } else { throw '不支持的注册表值类型。' }
    $key.Flush()
  } finally { $key.Dispose() }
}

function Assert-Restorable($value, [string]$name) {
  if ($null -ne $value -and $value.kind -ne 'String' -and $value.kind -ne 'DWord') {
    throw ('值 ' + $name + ' 的类型为 ' + $value.kind + '，为保证可还原未修改。')
  }
}

function Format-Error($record) {
  $exception = $record.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  if ($exception -is [System.Security.SecurityException] -or $exception -is [System.UnauthorizedAccessException]) {
    return '拒绝访问：修改所有用户（HKLM）项需要以管理员身份运行 CAI.Tools。'
  }
  return $exception.Message
}

function Get-RootName([string]$hive) {
  if ($hive -eq 'HKCU') { return 'HKEY_CURRENT_USER' }
  return 'HKEY_LOCAL_MACHINE'
}

function Format-RegString([string]$value) {
  return '"' + $value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Format-UndoText($changes) {
  # .reg 导入只合并值；原本不存在的值需要显式删除指令才能恢复。
  $text = ''
  foreach ($change in $changes) {
    $parts = $change.key.Split('\', 2)
    $text += $nl + '[' + (Get-RootName $parts[0]) + '\' + $parts[1] + ']' + $nl
    $name = Format-RegString $change.valueName
    if ($null -eq $change.before) { $text += $name + '=-' + $nl }
    elseif ($change.before.kind -eq 'DWord') { $text += $name + '=dword:' + ([uint32]$change.before.data).ToString('x8') + $nl }
    else { $text += $name + '=' + (Format-RegString $change.before.data) + $nl }
  }
  return $text
}

function Save-Backup($item, [string]$exportKey, [string]$undoText, $record) {
  if ($exportKey) {
    $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
    $regView = if ([Environment]::Is64BitOperatingSystem) { '/reg:64' } else { '/reg:32' }
    & $reg export $exportKey $item.backupPath /y $regView | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '注册表备份失败，未修改菜单项。' }
    [System.IO.File]::AppendAllText($item.backupPath, $undoText, [System.Text.Encoding]::Unicode)
  } else {
    [System.IO.File]::WriteAllText($item.backupPath, 'Windows Registry Editor Version 5.00' + $nl + $undoText, [System.Text.Encoding]::Unicode)
  }
  $file = [System.IO.File]::Open($item.backupPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try { $file.Flush($true) } finally { $file.Dispose() }
  # 先持久化还原记录，进程意外退出或应用重启后仍能找到原始状态。
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
  $file = [System.IO.File]::Open($item.recordPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}

function Get-VerbState($markers) {
  if ($null -ne $markers.LegacyDisable) { return 'disabled' }
  if ($null -ne $markers.Extended) { return 'extended' }
  return 'shown'
}

function Get-VerbPlan($item) {
  $key = Open-Key $item.id $false
  if ($null -eq $key) { throw '菜单项已不存在，请刷新列表。' }
  $key.Dispose()
  $current = @{ LegacyDisable = (Read-Marker $item.id 'LegacyDisable'); Extended = (Read-Marker $item.id 'Extended') }
  $desired = @{ LegacyDisable = $current.LegacyDisable; Extended = $current.Extended }
  $empty = @{ kind = 'String'; data = '' }
  # 每种状态只调整必要的标记，保留安装程序写入的其他值。
  switch ($item.state) {
    'disabled' { if ($null -eq $desired.LegacyDisable) { $desired.LegacyDisable = $empty } }
    'extended' { $desired.LegacyDisable = $null; if ($null -eq $desired.Extended) { $desired.Extended = $empty } }
    'shown' { $desired.LegacyDisable = $null; $desired.Extended = $null }
    default { throw '不支持的目标状态。' }
  }
  $changes = @()
  foreach ($name in @('LegacyDisable', 'Extended')) {
    if (!(Test-MarkerEqual $current[$name] $desired[$name])) {
      Assert-Restorable $current[$name] $name
      $changes += @{ key = $item.id; valueName = $name; before = $current[$name]; after = $desired[$name] }
    }
  }
  return @{ op = 'verb-state'; changes = $changes; fromState = (Get-VerbState $current); toState = (Get-VerbState $desired); exportKey = $item.id }
}

function Get-BlockPlan($item) {
  $clsid = [string]$item.clsid
  if ($clsid -notmatch $clsidPattern) { throw '无效的扩展标识。' }
  $current = @{ HKCU = (Read-Marker $request.blockedKeys.HKCU $clsid); HKLM = (Read-Marker $request.blockedKeys.HKLM $clsid) }
  $blocked = ($null -ne $current.HKCU) -or ($null -ne $current.HKLM)
  $changes = @()
  if ($item.state -eq 'disabled') {
    # 屏蔽统一写入当前用户，不需要管理员权限，也不改动扩展自身的注册项。
    if (!$blocked) { $changes += @{ key = $request.blockedKeys.HKCU; valueName = $clsid; before = $null; after = @{ kind = 'String'; data = '' } } }
  } elseif ($item.state -eq 'shown') {
    foreach ($hive in @('HKCU', 'HKLM')) {
      if ($null -ne $current[$hive]) {
        Assert-Restorable $current[$hive] $clsid
        $changes += @{ key = $request.blockedKeys.$hive; valueName = $clsid; before = $current[$hive]; after = $null }
      }
    }
  } else { throw '扩展仅支持显示或禁用。' }
  $from = if ($blocked) { 'disabled' } else { 'shown' }
  return @{ op = 'block'; changes = $changes; fromState = $from; toState = [string]$item.state; exportKey = '' }
}

function Get-ClassicInfo {
  $root = $bases.HKCU.OpenSubKey($request.classicKey)
  if ($null -eq $root) { return @{ state = $false; clean = $true } }
  try {
    $inproc = $root.OpenSubKey('InprocServer32')
    $rootClean = ($root.ValueCount -eq 0) -and ($root.SubKeyCount -eq 0 -or ($root.SubKeyCount -eq 1 -and $null -ne $inproc))
    if ($null -eq $inproc) { return @{ state = $false; clean = $rootClean } }
    try {
      $names = @($inproc.GetValueNames())
      $defaultEmpty = ($names -notcontains '') -or ([string]$inproc.GetValue('', $null, $options) -eq '')
      $inprocClean = ($inproc.SubKeyCount -eq 0) -and (@($names | Where-Object { $_ -ne '' }).Count -eq 0)
      return @{ state = $defaultEmpty; clean = ($rootClean -and $inprocClean) }
    } finally { $inproc.Dispose() }
  } finally { $root.Dispose() }
}

function Set-Classic([bool]$enabled) {
  $info = Get-ClassicInfo
  if ($info.state -eq $enabled) { return }
  # 仅处理本开关的标准结构，存在其他值或子项时拒绝删除。
  if (!$info.clean) { throw '经典菜单注册表项包含其他内容，为避免误删未修改。' }
  if ($enabled) {
    $key = $bases.HKCU.CreateSubKey($request.classicKey + '\InprocServer32')
    try { $key.SetValue('', '', [Microsoft.Win32.RegistryValueKind]::String); $key.Flush() } finally { $key.Dispose() }
  } else { $bases.HKCU.DeleteSubKeyTree($request.classicKey, $false) }
  if ((Get-ClassicInfo).state -ne $enabled) { throw '修改后回读校验失败。' }
}

$versionCache = @{}
function Get-Owner([string]$target) {
  try {
    if (!$target -or !$target.Trim()) { return @{ group = '其他'; system = $false } }
    $expanded = [Environment]::ExpandEnvironmentVariables($target.Trim().Trim('"'))
    if (![System.IO.Path]::IsPathRooted($expanded)) {
      foreach ($dir in @((Join-Path $env:SystemRoot 'System32'), $env:SystemRoot)) {
        $candidate = Join-Path $dir $expanded
        if ([System.IO.File]::Exists($candidate)) { $expanded = $candidate; break }
      }
    }
    if ($expanded.StartsWith($env:SystemRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { return @{ group = 'Windows 系统'; system = $true } }
    if ($versionCache.ContainsKey($expanded)) { return $versionCache[$expanded] }
    $group = [System.IO.Path]::GetFileNameWithoutExtension($expanded)
    if ([System.IO.File]::Exists($expanded)) {
      $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($expanded)
      # 部分程序保留了模板占位符，作为分组名称没有意义。
      foreach ($candidate in @($info.ProductName, $info.FileDescription)) {
        if ($candidate -and $candidate.Trim() -and $candidate -notmatch 'TODO|<.*>') { $group = $candidate.Trim(); break }
      }
    }
    if (!$group) { $group = '其他' }
    $owner = @{ group = $group; system = $false }
    $versionCache[$expanded] = $owner
    return $owner
  } catch { return @{ group = '其他'; system = $false } }
}

function Get-CommandPath([string]$command) {
  $text = $command.Trim()
  if (!$text) { return '' }
  if ($text.StartsWith('"')) {
    $end = $text.IndexOf('"', 1)
    if ($end -gt 1) { return $text.Substring(1, $end - 1) }
    return ''
  }
  $match = [regex]::Match($text, '^(.+?\.(exe|com|bat|cmd|dll))(\s|,|$)', 'IgnoreCase')
  if ($match.Success) { return $match.Groups[1].Value }
  return ($text -split '\s+')[0]
}

function Get-ClsidInfo([string]$clsid) {
  foreach ($hive in @('HKCU', 'HKLM')) {
    $key = $bases[$hive].OpenSubKey('Software\Classes\CLSID\' + $clsid)
    if ($null -eq $key) { continue }
    try {
      $server = ''
      foreach ($sub in @('InprocServer32', 'LocalServer32')) {
        $serverKey = $key.OpenSubKey($sub)
        if ($null -ne $serverKey) {
          try { $server = [string]$serverKey.GetValue('', '', $options) } finally { $serverKey.Dispose() }
        }
        if ($server) { break }
      }
      return @{ name = [string]$key.GetValue('', '', $options); server = $server }
    } finally { $key.Dispose() }
  }
  return @{ name = ''; server = '' }
}

function Get-BlockedNames([string]$keyId) {
  $names = @{}
  $key = Open-Key $keyId $false
  if ($null -ne $key) {
    try { foreach ($name in $key.GetValueNames()) { $names[$name.ToUpperInvariant()] = $true } } finally { $key.Dispose() }
  }
  return $names
}

function Get-BlockedBy([string]$clsid, $blocked) {
  $hives = @()
  foreach ($hive in @('HKCU', 'HKLM')) { if ($blocked[$hive].ContainsKey($clsid)) { $hives += $hive } }
  return $hives
}

function Get-RegistryEntries {
  $entries = @()
  $blocked = @{ HKCU = (Get-BlockedNames $request.blockedKeys.HKCU); HKLM = (Get-BlockedNames $request.blockedKeys.HKLM) }
  $handlers = @{}
  foreach ($hive in @('HKCU', 'HKLM')) {
    foreach ($location in $request.locations) {
      $relative = 'Software\Classes\' + $location + '\shell'
      $parent = $bases[$hive].OpenSubKey($relative)
      if ($null -ne $parent) {
        try {
          foreach ($name in $parent.GetSubKeyNames()) {
            $key = $parent.OpenSubKey($name)
            if ($null -eq $key) { continue }
            try {
              $label = [string]$key.GetValue('MUIVerb', '', $options)
              if (!$label) { $label = [string]$key.GetValue('', $name, $options) }
              if (!$label) { $label = $name }
              $commandKey = $key.OpenSubKey('command')
              $command = ''
              if ($null -ne $commandKey) {
                try { $command = [string]$commandKey.GetValue('', '', $options) } finally { $commandKey.Dispose() }
              }
              $values = @($key.GetValueNames())
              $state = if ($values -contains 'LegacyDisable') { 'disabled' } elseif ($values -contains 'Extended') { 'extended' } else { 'shown' }
              # 依次从命令、委托处理器和图标推断所属程序，仅用于分组展示。
              $target = Get-CommandPath $command
              $handler = [string]$key.GetValue('ExplorerCommandHandler', '', $options)
              if (!$target -and $handler -match $clsidPattern) { $target = (Get-ClsidInfo $handler).server }
              if (!$target) { $target = ([string]$key.GetValue('Icon', '', $options) -split ',')[0] }
              $owner = Get-Owner $target
              $entries += @{
                id = $hive + '\' + $relative + '\' + $name; kind = 'verb'; name = $label; hive = $hive
                locations = @($location); command = $command; state = $state; system = $owner.system; group = $owner.group
              }
            } finally { $key.Dispose() }
          }
        } finally { $parent.Dispose() }
      }
      $parent = $bases[$hive].OpenSubKey('Software\Classes\' + $location + '\shellex\ContextMenuHandlers')
      if ($null -eq $parent) { continue }
      try {
        foreach ($name in $parent.GetSubKeyNames()) {
          $trimmed = $name.Trim()
          # 以 - 开头的处理器已被其他工具改名停用，Explorer 不会加载。
          if (!$trimmed -or $trimmed.StartsWith('-')) { continue }
          $clsid = $trimmed
          if ($clsid -notmatch $clsidPattern) {
            $key = $parent.OpenSubKey($name)
            if ($null -eq $key) { continue }
            try { $clsid = ([string]$key.GetValue('', '', $options)).Trim() } finally { $key.Dispose() }
          }
          if ($clsid -notmatch $clsidPattern) { continue }
          $clsid = $clsid.ToUpperInvariant()
          if (!$handlers.ContainsKey($clsid)) {
            $handlers[$clsid] = @{ locations = New-Object 'System.Collections.Generic.List[string]'; names = New-Object 'System.Collections.Generic.List[string]' }
          }
          if (!$handlers[$clsid].locations.Contains($location)) { $handlers[$clsid].locations.Add($location) }
          if ($trimmed -notmatch $clsidPattern -and !$handlers[$clsid].names.Contains($trimmed)) { $handlers[$clsid].names.Add($trimmed) }
        }
      } finally { $parent.Dispose() }
    }
  }
  foreach ($clsid in @($handlers.Keys)) {
    $handler = $handlers[$clsid]
    $info = Get-ClsidInfo $clsid
    $label = $info.name
    if (!$label -and $handler.names.Count -gt 0) { $label = $handler.names[0] }
    if (!$label) { $label = $clsid }
    $owner = Get-Owner $info.server
    $blockedBy = @(Get-BlockedBy $clsid $blocked)
    $state = if ($blockedBy.Count -gt 0) { 'disabled' } else { 'shown' }
    $entries += @{
      id = 'SHELLEX\' + $clsid; kind = 'shellex'; name = $label; locations = @($handler.locations); command = $info.server
      clsid = $clsid; state = $state; blockedBy = $blockedBy; system = $owner.system; group = $owner.group
    }
  }
  return $entries
}

function Get-PackagedEntries {
  $entries = @()
  $warnings = @()
  if ([Environment]::OSVersion.Version.Build -lt 22000) { return @{ entries = $entries; warnings = $warnings } }
  $blocked = @{ HKCU = (Get-BlockedNames $request.blockedKeys.HKCU); HKLM = (Get-BlockedNames $request.blockedKeys.HKLM) }
  try { $packages = @(Get-AppxPackage -ErrorAction Stop) }
  catch { return @{ entries = $entries; warnings = @('读取新式菜单失败：' + (Format-Error $_)) } }
  $found = @{}
  foreach ($package in $packages) {
    try {
      if (!$package.InstallLocation) { continue }
      $manifest = Join-Path $package.InstallLocation 'AppxManifest.xml'
      if (![System.IO.File]::Exists($manifest)) { continue }
      $text = [System.IO.File]::ReadAllText($manifest)
      if ($text.IndexOf('fileExplorerContextMenus') -lt 0) { continue }
      $xml = [xml]$text
      $display = [string]$xml.SelectSingleNode("//*[local-name()='Properties']/*[local-name()='DisplayName']").InnerText
      if (!$display -or $display.StartsWith('ms-resource:')) { $display = $package.Name }
      $extensions = $xml.SelectNodes("//*[local-name()='Extension'][@Category='windows.fileExplorerContextMenus']")
      foreach ($extension in $extensions) {
        foreach ($itemType in $extension.SelectNodes(".//*[local-name()='ItemType']")) {
          foreach ($verb in $itemType.SelectNodes("./*[local-name()='Verb']")) {
            $clsid = '{' + ([string]$verb.Clsid).Trim('{', '}', ' ').ToUpperInvariant() + '}'
            if ($clsid -notmatch $clsidPattern) { continue }
            if (!$found.ContainsKey($clsid)) {
              $found[$clsid] = @{
                name = $display + ' · ' + [string]$verb.Id; command = $package.PackageFullName; group = $display
                system = ([string]$package.SignatureKind -eq 'System'); locations = New-Object 'System.Collections.Generic.List[string]'
              }
            }
            $type = [string]$itemType.Type
            if ($type -and !$found[$clsid].locations.Contains($type)) { $found[$clsid].locations.Add($type) }
          }
        }
      }
    } catch { $warnings += ('读取 ' + $package.Name + ' 的新式菜单失败。') }
  }
  foreach ($clsid in @($found.Keys)) {
    $item = $found[$clsid]
    $blockedBy = @(Get-BlockedBy $clsid $blocked)
    $state = if ($blockedBy.Count -gt 0) { 'disabled' } else { 'shown' }
    $entries += @{
      id = 'PACKAGED\' + $clsid; kind = 'packaged'; name = $item.name; locations = @($item.locations); command = $item.command
      clsid = $clsid; state = $state; blockedBy = $blockedBy; system = $item.system; group = $item.group
    }
  }
  return @{ entries = $entries; warnings = $warnings }
}

function Invoke-Apply {
  $results = @()
  foreach ($item in @($request.changes)) {
    $recordWritten = $false
    $applied = @()
    try {
      $plan = if ($item.kind -eq 'verb') { Get-VerbPlan $item } else { Get-BlockPlan $item }
      if ($plan.changes.Count -eq 0) { $results += @{ id = $item.id; success = $true; changed = $false }; continue }
      $record = @{
        version = 2; op = $plan.op; backupId = $item.backupId; entryId = $item.id; label = [string]$item.label
        createdAt = $item.createdAt; fromState = $plan.fromState; toState = $plan.toState; changes = @($plan.changes)
      }
      # 备份与记录都落盘后才写注册表；任一步失败均不修改菜单。
      Save-Backup $item $plan.exportKey (Format-UndoText $plan.changes) $record
      $recordWritten = $true
      foreach ($change in $plan.changes) {
        Write-Marker $change.key $change.valueName $change.after
        $applied += $change
      }
      foreach ($change in $plan.changes) {
        if (!(Test-MarkerEqual (Read-Marker $change.key $change.valueName) $change.after)) { throw '修改后回读校验失败，备份已保留。' }
      }
      $results += @{ id = $item.id; success = $true; changed = $true; backupPath = $item.backupPath }
    } catch {
      $message = Format-Error $_
      # 回滚已写入的标记；回滚成功才删除记录，否则保留记录供手动还原。
      $rolledBack = $true
      for ($i = $applied.Count - 1; $i -ge 0; $i--) {
        try { Write-Marker $applied[$i].key $applied[$i].valueName $applied[$i].before } catch { $rolledBack = $false }
      }
      if ($recordWritten -and $rolledBack) { try { [System.IO.File]::Delete($item.recordPath) } catch {} }
      elseif ($recordWritten) { $message += ' 部分修改未能回滚，已保留还原记录。' }
      $results += @{ id = $item.id; success = $false; error = $message }
    }
  }
  $failed = @($results | Where-Object { !$_.success }).Count
  return @{ success = ($failed -eq 0); results = $results }
}

function Invoke-Restore {
  $record = $request.record
  if ($record.op -eq 'classic-menu') {
    $current = (Get-ClassicInfo).state
    if ($request.action -eq 'verify-restored') {
      if ($current -ne [bool]$record.before) { throw '该记录还原后状态又被修改，请刷新检查当前状态。' }
    } elseif ($current -ne [bool]$record.before) {
      if ($current -ne [bool]$record.after) { throw '经典菜单状态已被外部修改，未执行还原。' }
      Set-Classic ([bool]$record.before)
    }
    return @{ success = $true }
  }
  $changes = @($record.changes)
  foreach ($change in $changes) {
    if (!(Test-BlockedKey $change.key)) {
      $key = Open-Key $change.key $false
      if ($null -eq $key) { throw '菜单项已不存在，请刷新列表。' }
      $key.Dispose()
    }
  }
  $atBefore = $true
  $atAfter = $true
  foreach ($change in $changes) {
    $current = Read-Marker $change.key $change.valueName
    if (!(Test-MarkerEqual $current $change.before)) { $atBefore = $false }
    if (!(Test-MarkerEqual $current $change.after)) { $atAfter = $false }
  }
  if ($request.action -eq 'verify-restored') {
    if (!$atBefore) { throw '该记录还原后状态又被修改，请刷新检查当前状态。' }
    return @{ success = $true }
  }
  # 重复请求只校验当前状态，不再次写入。
  if ($atBefore) { return @{ success = $true } }
  # 只撤销本工具写入的值；其他软件改过的值不覆盖。
  if (!$atAfter) { throw '注册表值已被外部修改，未执行还原。请检查该菜单项。' }
  foreach ($change in $changes) { Write-Marker $change.key $change.valueName $change.before }
  foreach ($change in $changes) {
    if (!(Test-MarkerEqual (Read-Marker $change.key $change.valueName) $change.before)) { throw '还原后回读校验失败。' }
  }
  return @{ success = $true }
}

function Invoke-Classic {
  $enabled = [bool]$request.enabled
  $info = Get-ClassicInfo
  if ($info.state -eq $enabled) { return @{ success = $true; changed = $false } }
  if (!$info.clean) { throw '经典菜单注册表项包含其他内容，为避免误删未修改。' }
  $rootName = 'HKEY_CURRENT_USER\' + $request.classicKey
  $undo = if ($enabled) { $nl + '[-' + $rootName + ']' + $nl } else { $nl + '[' + $rootName + ']' + $nl + $nl + '[' + $rootName + '\InprocServer32]' + $nl + '@=""' + $nl }
  $from = if ($info.state) { 'on' } else { 'off' }
  $to = if ($enabled) { 'on' } else { 'off' }
  $record = @{
    version = 2; op = 'classic-menu'; backupId = $request.backupId; entryId = $request.entryId; label = 'Windows 11 经典右键菜单'
    createdAt = $request.createdAt; fromState = $from; toState = $to; before = [bool]$info.state; after = $enabled
  }
  Save-Backup $request '' $undo $record
  try { Set-Classic $enabled }
  catch {
    $message = Format-Error $_
    if ((Get-ClassicInfo).state -eq [bool]$info.state) { try { [System.IO.File]::Delete($request.recordPath) } catch {} }
    throw $message
  }
  return @{ success = $true; changed = $true; backupPath = $request.backupPath }
}

function Invoke-RestartExplorer {
  $previous = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  # 已结束的进程可能仍短暂可见，只有新进程出现才算系统已自动重启外壳。
  $deadline = (Get-Date).AddSeconds(5)
  $restarted = $false
  while ((Get-Date) -lt $deadline) {
    if (@(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $previous -notcontains $_.Id }).Count -gt 0) { $restarted = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (!$restarted) { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') }
  return @{ success = $true }
}

try {
  $bases.HKCU = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  $bases.HKLM = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  $result = switch ($request.action) {
    'list-registry' {
      $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      $build = [Environment]::OSVersion.Version.Build
      @{
        success = $true; entries = @(Get-RegistryEntries)
        environment = @{
          build = $build; win11 = ($build -ge 22000); classicMenu = [bool](Get-ClassicInfo).state
          isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        }
      }
    }
    'list-packaged' { $packaged = Get-PackagedEntries; @{ success = $true; entries = @($packaged.entries); warnings = @($packaged.warnings) } }
    'apply' { Invoke-Apply }
    'restore' { Invoke-Restore }
    'verify-restored' { Invoke-Restore }
    'classic' { Invoke-Classic }
    'restart-explorer' { Invoke-RestartExplorer }
    default { throw '不支持的操作。' }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{ success = $false; error = (Format-Error $_) } | ConvertTo-Json -Compress
} finally {
  foreach ($base in $bases.Values) { $base.Dispose() }
}
`

// 引导命令只解码 stdin 中的 ASCII 脚本，避免超出命令行长度及控制台代码页影响中文。
const bootstrap =
  '$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));& ([ScriptBlock]::Create($s))'

/**
 * 执行固定注册表脚本，参数作为 JSON 数据传递而非拼接为 PowerShell 语法。
 * @param request 已校验的操作及参数
 * @param timeoutMs 允许的最长执行时间
 * @returns PowerShell 返回的结构化操作结果
 * @throws PowerShell 启动失败、超时或结果格式异常时抛错
 */
export async function runRegistryRequest(
  request: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<ContextMenuResult> {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const script = `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n${registryScript}`
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(bootstrap, 'utf16le').toString('base64')
      ],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    /**
     * 只结算一次结果，并在超时或输出异常时结束子进程；仅在定时器创建后的异步事件中调用。
     * @param action 结算动作
     * @returns 无返回值
     */
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error('PowerShell 执行超时。')))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 16 * 1024 * 1024) {
        child.kill()
        settle(() => reject(new Error('PowerShell 输出过大。')))
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) => {
      settle(() => {
        // 脚本只输出一行压缩 JSON，取最后一行可容忍外部模块打印的提示。
        const line =
          stdout
            .replace(/^\uFEFF/, '')
            .trim()
            .split(/\r?\n/)
            .pop() || ''
        try {
          resolve(JSON.parse(line) as ContextMenuResult)
        } catch {
          reject(new Error(stderr.trim() || `PowerShell 异常退出（${code}）。`))
        }
      })
    })
    child.stdin.end(Buffer.from(script, 'utf8').toString('base64'))
  })
}

/**
 * 校验记录中的注册表值快照，仅接受可无损写回的字符串与 DWORD。
 * @param value 记录中的值
 * @returns 是否为合法快照
 */
function isRegValue(value: unknown): value is RegValue {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const { kind, data } = value as Record<string, unknown>
  if (typeof data !== 'string') return false
  if (kind === 'String') return true
  return kind === 'DWord' && /^\d{1,10}$/.test(data) && Number(data) <= 0xffffffff
}

/**
 * 比较两个注册表值快照。
 * @param a 第一个值
 * @param b 第二个值
 * @returns 两者是否相同
 */
function sameValue(a: RegValue, b: RegValue): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.data === b.data
}

/**
 * 校验并规范化单条还原记录；v1 记录转换为等价的标记变更。
 * @param raw 解析后的 JSON 内容
 * @param backupId 由文件名得到的记录标识
 * @param backupDirectory 固定的备份目录
 * @returns 规范化后的记录（尚未计算是否被更新记录覆盖）
 * @throws 记录字段不符合格式时抛错
 */
function normalizeRecord(
  raw: Record<string, unknown>,
  backupId: string,
  backupDirectory: string
): Omit<StoredRecord, 'superseded'> {
  const invalid = (): never => {
    throw new Error('记录格式无效')
  }
  if (raw.backupId !== backupId || typeof raw.entryId !== 'string') invalid()
  const entryId = raw.entryId as string
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid()
  if (
    raw.restoredAt !== undefined &&
    (typeof raw.restoredAt !== 'string' || !Number.isFinite(Date.parse(raw.restoredAt)))
  )
    invalid()
  const backupPath = path.join(backupDirectory, `${backupId}.reg`)
  const base = {
    backupId,
    entryId,
    createdAt: raw.createdAt as string,
    backupPath,
    restoredAt: raw.restoredAt as string | undefined
  }
  if (raw.version === 1) {
    if (raw.originalEnabled !== true || !isContextMenuId(entryId)) invalid()
    const changes = [
      {
        key: entryId,
        valueName: 'LegacyDisable',
        before: null,
        after: { kind: 'String', data: '' } as RegValue
      }
    ]
    return {
      raw,
      backup: {
        ...base,
        op: 'verb-state',
        label: entryId.split('\\').pop() || entryId,
        fromState: 'shown',
        toState: 'disabled'
      },
      markers: [`${entryId}|LEGACYDISABLE`],
      payload: { op: 'verb-state', entryId, changes }
    }
  }
  if (raw.version !== 2) invalid()
  const op = raw.op as ContextMenuRecordOp
  if (
    typeof raw.fromState !== 'string' ||
    typeof raw.toState !== 'string' ||
    !recordStates.has(raw.fromState) ||
    !recordStates.has(raw.toState) ||
    (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > 300))
  )
    invalid()
  const backup: ContextMenuBackup = {
    ...base,
    op,
    label: (raw.label as string) || entryId.split('\\').pop() || entryId,
    fromState: raw.fromState as string,
    toState: raw.toState as string
  }
  if (op === 'classic-menu') {
    if (
      entryId !== CLASSIC_MENU_ENTRY_ID ||
      typeof raw.before !== 'boolean' ||
      typeof raw.after !== 'boolean' ||
      raw.before === raw.after
    )
      invalid()
    return {
      raw,
      backup,
      markers: ['CLASSIC_MENU'],
      payload: { op, entryId, before: raw.before as boolean, after: raw.after as boolean }
    }
  }
  const parsed = parseContextMenuId(entryId)
  const changes = raw.changes
  if (!parsed || !Array.isArray(changes) || changes.length < 1 || changes.length > 2) invalid()
  const seen = new Set<string>()
  const normalized: MarkerChange[] = []
  for (const change of changes as unknown[]) {
    if (!change || typeof change !== 'object') invalid()
    const { key, valueName, before, after } = change as Record<string, unknown>
    if (typeof key !== 'string' || typeof valueName !== 'string') invalid()
    if (!isRegValue(before) || !isRegValue(after) || sameValue(before, after)) invalid()
    // 不信任记录内容：变更只能落在该菜单项自身或屏蔽列表的对应 CLSID 上。
    if (op === 'verb-state') {
      if (parsed!.kind !== 'verb' || key !== entryId || !verbMarkers.has(valueName as string))
        invalid()
    } else if (op === 'block') {
      if (
        parsed!.kind === 'verb' ||
        !Object.values(BLOCKED_KEYS).includes(key as (typeof BLOCKED_KEYS)['HKCU']) ||
        (valueName as string).toUpperCase() !== parsed!.clsid
      )
        invalid()
    } else invalid()
    const marker = `${key}|${(valueName as string).toUpperCase()}`
    if (seen.has(marker)) invalid()
    seen.add(marker)
    normalized.push({
      key: key as string,
      valueName: valueName as string,
      before: before as RegValue,
      after: after as RegValue
    })
  }
  return {
    raw,
    backup,
    markers: [...seen],
    payload: { op: op as 'verb-state' | 'block', entryId, changes: normalized }
  }
}

export class WindowsContextMenuManager {
  private busy = false

  /**
   * 创建右键菜单服务并限定备份存放位置。
   * @param backupDirectory 应用数据目录内的注册表备份文件夹
   * @param platform 当前操作系统，测试时可替换
   * @param execute 固定注册表脚本执行器，测试时可替换
   * @param classicKey 经典菜单开关的 HKCU 相对路径，测试时可指向专用测试项
   * @returns 右键菜单服务实例
   */
  constructor(
    private readonly backupDirectory: string,
    private readonly platform: string = process.platform,
    private readonly execute: RegistryExecutor = runRegistryRequest,
    private readonly classicKey: string = DEFAULT_CLASSIC_KEY
  ) {}

  /**
   * 生成所有脚本请求共享的固定参数。
   * @param request 具体操作参数
   * @returns 合并后的脚本请求
   */
  private request(request: Record<string, unknown>): Record<string, unknown> {
    return { ...request, blockedKeys: BLOCKED_KEYS, classicKey: this.classicKey }
  }

  /**
   * 并行读取注册表菜单与 Win11 新式菜单；新式菜单失败只作为警告。
   * @returns 菜单列表、系统环境或可展示的错误
   */
  async list(): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    try {
      const [registry, packaged] = await Promise.all([
        this.execute(
          this.request({ action: 'list-registry', locations: Object.keys(CONTEXT_MENU_LOCATIONS) })
        ),
        this.execute(this.request({ action: 'list-packaged' }), 60_000).catch(
          (error): ContextMenuResult => ({ success: false, error: String(error) })
        )
      ])
      if (!registry.success) return registry
      const warnings = [...(packaged.warnings || [])]
      if (!packaged.success) warnings.push(`读取新式菜单失败：${packaged.error || '未知错误'}`)
      const entries: WindowsContextMenuEntry[] = [
        ...(registry.entries || []),
        ...(packaged.success ? packaged.entries || [] : [])
      ]
      return { success: true, entries, environment: registry.environment, warnings }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 读取并校验全部还原记录，计算每条记录是否已被同一目标的更新记录覆盖。
   * @returns 有效记录及损坏文件的警告
   * @throws 备份目录无法创建或读取时抛错
   */
  private async loadRecords(): Promise<{ records: StoredRecord[]; warnings: string[] }> {
    const records: Array<Omit<StoredRecord, 'superseded'>> = []
    const warnings: string[] = []
    await mkdir(this.backupDirectory, { recursive: true })
    for (const file of await readdir(this.backupDirectory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const backupId = file.name.slice(0, -5)
      if (!backupIdPattern.test(backupId)) continue
      try {
        const raw = JSON.parse(await readFile(path.join(this.backupDirectory, file.name), 'utf8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('记录格式无效')
        records.push(normalizeRecord(raw, backupId, this.backupDirectory))
      } catch {
        warnings.push(`还原记录损坏：${file.name}。对应 .reg 备份仍保留，请检查。`)
      }
    }
    records.sort((a, b) => b.backup.backupId.localeCompare(a.backup.backupId))
    // 同一注册表值只允许撤销最近一次修改，避免旧记录覆盖新状态。
    const touched = new Set<string>()
    const result = records.map((record) => {
      const superseded = record.markers.some((marker) => touched.has(marker))
      record.markers.forEach((marker) => touched.add(marker))
      record.backup.canRestore = !superseded && !record.backup.restoredAt
      return { ...record, superseded }
    })
    return { records: result, warnings }
  }

  /**
   * 从应用数据目录读取持久化还原记录；损坏记录明确报错且不参与还原。
   * @returns 可还原记录及读取警告
   */
  async listBackups(): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    try {
      const { records, warnings } = await this.loadRecords()
      return { success: true, backups: records.map((record) => record.backup), warnings }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 在写锁内执行修改；记录损坏时拒绝新增修改，避免积累无法在界面还原的操作。
   * @param task 实际写入操作
   * @returns 写入操作的结果
   */
  private async withWriteLock(task: () => Promise<ContextMenuResult>): Promise<ContextMenuResult> {
    if (this.busy) return { success: false, error: '正在修改菜单项，请稍后重试。' }
    // 在任何异步操作之前锁定写入，避免两次操作备份与修改相互覆盖。
    this.busy = true
    try {
      return await task()
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      // 失败也必须释放锁，允许刷新状态后再次尝试。
      this.busy = false
    }
  }

  /**
   * 确认还原记录完好，否则拒绝新的修改。
   * @returns 无返回值
   * @throws 记录损坏或不可读时抛错
   */
  private async assertHistoryHealthy(): Promise<void> {
    const { warnings } = await this.loadRecords()
    if (warnings.length) throw new Error('还原记录存在损坏，未修改菜单项。请先检查备份。')
  }

  /**
   * 生成一次修改专用的备份与记录路径；同批次按序号递增保证记录顺序稳定。
   * @param offset 批次内序号
   * @returns 备份标识、文件路径与创建时间
   */
  private allocateBackup(offset: number): Record<string, string> {
    const backupId = `${Date.now() + offset}-${randomUUID()}`
    return {
      backupId,
      backupPath: path.join(this.backupDirectory, `${backupId}.reg`),
      recordPath: path.join(this.backupDirectory, `${backupId}.json`),
      createdAt: new Date().toISOString()
    }
  }

  /**
   * 批量设置菜单项状态；每项单独备份和记录，失败项不影响其他项。
   * @param changes 菜单项标识与目标状态列表
   * @returns 整体结果及逐项结果
   */
  async apply(changes: unknown): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_BATCH_SIZE) {
      return { success: false, error: '无效的批量操作。' }
    }
    // 先完整校验全部参数，任一项非法则整批拒绝，不进入写入流程。
    const items: Array<Record<string, unknown>> = []
    const ids = new Set<string>()
    for (const change of changes) {
      const { id, state, label } = (change || {}) as Record<string, unknown>
      const parsed = parseContextMenuId(id)
      if (!parsed || !supportsState(parsed.kind, state) || ids.has(id as string)) {
        return { success: false, error: '无效的菜单项或状态。' }
      }
      ids.add(id as string)
      items.push({
        id,
        kind: parsed.kind,
        clsid: parsed.clsid,
        state: state as ContextMenuState,
        // eslint-disable-next-line no-control-regex
        label: typeof label === 'string' ? label.replace(/[\x00-\x1f]/g, ' ').slice(0, 120) : ''
      })
    }
    return this.withWriteLock(async () => {
      await this.assertHistoryHealthy()
      const prepared = items.map((item, index) => ({ ...item, ...this.allocateBackup(index) }))
      const timeout = Math.min(30_000 + prepared.length * 1_500, 330_000)
      const result = await this.execute(
        this.request({ action: 'apply', changes: prepared }),
        timeout
      )
      return result
    })
  }

  /**
   * 撤销单条记录，只恢复本工具修改的值，不覆盖菜单命令。
   * @param backupId 固定目录内的记录标识
   * @returns 回读校验完成后的还原结果
   */
  private async restoreOne(backupId: string): Promise<ContextMenuItemResult> {
    let temporaryPath: string | undefined
    let verified = false
    try {
      const { records, warnings } = await this.loadRecords()
      if (warnings.length) throw new Error('还原记录存在损坏，请检查备份文件。')
      const record = records.find((item) => item.backup.backupId === backupId)
      if (!record) throw new Error('还原记录不存在。')
      if (record.superseded) throw new Error('存在更新的修改记录，请先还原最新一条。')
      const request = this.request({ record: record.payload })
      if (record.backup.restoredAt) {
        const result = await this.execute({ ...request, action: 'verify-restored' })
        return { id: backupId, success: result.success, error: result.error }
      }
      // 记录验证通过后由固定脚本读取实际值，遇到外部修改或菜单删除时停止。
      const result = await this.execute({ ...request, action: 'restore' })
      if (!result.success) return { id: backupId, success: false, error: result.error }
      verified = true
      temporaryPath = path.join(this.backupDirectory, `${backupId}.${randomUUID()}.tmp`)
      await writeFile(
        temporaryPath,
        JSON.stringify({ ...record.raw, restoredAt: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx', flush: true }
      )
      await rename(temporaryPath, path.join(this.backupDirectory, `${backupId}.json`))
      temporaryPath = undefined
      return { id: backupId, success: true, backupPath: record.backup.backupPath }
    } catch (error) {
      return {
        id: backupId,
        success: false,
        error: verified
          ? `注册表已还原，但保存还原状态失败；记录已保留，可重试。${String(error)}`
          : String(error)
      }
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  /**
   * 按持久化记录依次撤销修改；单条失败不影响其余记录。
   * @param backupIds 要还原的记录标识列表
   * @returns 整体结果及逐条结果
   */
  async restore(backupIds: unknown): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    if (
      !Array.isArray(backupIds) ||
      backupIds.length === 0 ||
      backupIds.length > MAX_BATCH_SIZE ||
      new Set(backupIds).size !== backupIds.length ||
      !backupIds.every((id) => typeof id === 'string' && backupIdPattern.test(id))
    ) {
      return { success: false, error: '无效的还原记录。' }
    }
    return this.withWriteLock(async () => {
      const results: ContextMenuItemResult[] = []
      for (const backupId of backupIds as string[]) results.push(await this.restoreOne(backupId))
      const failed = results.find((item) => !item.success)
      return {
        success: !failed,
        results,
        error: failed?.error,
        backupPath: results.length === 1 ? results[0].backupPath : undefined
      }
    })
  }

  /**
   * 切换 Windows 11 经典右键菜单，修改前保存可还原记录。
   * @param enabled 是否启用经典菜单
   * @returns 操作结果及备份位置
   */
  async setClassicMenu(enabled: unknown): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    if (typeof enabled !== 'boolean') return { success: false, error: '无效的经典菜单状态。' }
    return this.withWriteLock(async () => {
      await this.assertHistoryHealthy()
      return this.execute(
        this.request({
          action: 'classic',
          enabled,
          entryId: CLASSIC_MENU_ENTRY_ID,
          ...this.allocateBackup(0)
        })
      )
    })
  }

  /**
   * 重启资源管理器使菜单修改立即生效；与注册表写入互斥。
   * @returns 重启结果
   */
  async restartExplorer(): Promise<ContextMenuResult> {
    if (this.platform !== 'win32') return { success: false, error: '此工具仅支持 Windows。' }
    return this.withWriteLock(() =>
      this.execute(this.request({ action: 'restart-explorer' }), 30_000)
    )
  }
}
