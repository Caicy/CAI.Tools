export const CONTEXT_MENU_LOCATIONS = {
  '*': '所有文件',
  AllFilesystemObjects: '文件和文件夹',
  Directory: '文件夹',
  'Directory\\Background': '文件夹空白处',
  Drive: '磁盘',
  DesktopBackground: '桌面空白处'
} as const

export interface WindowsContextMenuEntry {
  id: string
  name: string
  hive: 'HKCU' | 'HKLM'
  location: keyof typeof CONTEXT_MENU_LOCATIONS
  command: string
  enabled: boolean
}

export interface ContextMenuResult {
  success: boolean
  entries?: WindowsContextMenuEntry[]
  backupPath?: string
  error?: string
  backups?: ContextMenuBackup[]
  warnings?: string[]
}

export interface ContextMenuBackup {
  backupId: string
  entryId: string
  createdAt: string
  backupPath: string
  restoredAt?: string
  canRestore?: boolean
}

/**
 * 仅允许受支持位置下的直接 shell 子项，防止 IPC 参数访问任意注册表位置。
 * @param id 注册表项标识
 * @returns 参数是否为允许管理的菜单项
 */
export function isContextMenuId(id: unknown): id is string {
  // 必须拒绝控制字符，避免日志与导出路径被注入换行等不可见内容。
  // eslint-disable-next-line no-control-regex
  if (typeof id !== 'string' || /[\x00-\x1f]/.test(id)) return false
  // 精确比较父路径，避免子菜单、相对路径或其他注册表分支进入写入流程。
  return ['HKCU', 'HKLM'].some((hive) =>
    Object.keys(CONTEXT_MENU_LOCATIONS).some((location) => {
      const prefix = `${hive}\\Software\\Classes\\${location}\\shell\\`
      if (!id.startsWith(prefix)) return false
      const name = id.slice(prefix.length)
      return name.length > 0 && !name.includes('\\') && name !== '.' && name !== '..'
    })
  )
}
