export const CONTEXT_MENU_LOCATIONS = {
  '*': '所有文件',
  AllFilesystemObjects: '文件和文件夹',
  Folder: '文件夹（含库等虚拟文件夹）',
  Directory: '文件夹',
  'Directory\\Background': '文件夹空白处',
  Drive: '磁盘',
  DesktopBackground: '桌面空白处'
} as const

export type ContextMenuLocation = keyof typeof CONTEXT_MENU_LOCATIONS

/** verb 为 shell 子项；shellex 为 COM 扩展；packaged 为 Win11 新式菜单的打包应用项。 */
export type ContextMenuKind = 'verb' | 'shellex' | 'packaged'

/** shown 正常显示；extended 仅按住 Shift 显示；disabled 已禁用或已屏蔽。 */
export type ContextMenuState = 'shown' | 'extended' | 'disabled'

export const CONTEXT_MENU_KIND_LABELS: Record<ContextMenuKind, string> = {
  verb: '菜单命令',
  shellex: 'Shell 扩展',
  packaged: '新式菜单'
}

export const CONTEXT_MENU_STATE_LABELS: Record<ContextMenuState, string> = {
  shown: '显示',
  extended: '仅 Shift',
  disabled: '禁用'
}

export const CLASSIC_MENU_ENTRY_ID = 'CLASSIC_MENU'
export const CLASSIC_MENU_CLSID = '{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}'
export const BLOCKED_KEYS = {
  HKCU: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked',
  HKLM: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked'
} as const
export const MAX_BATCH_SIZE = 200

const clsidPattern = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i

export interface WindowsContextMenuEntry {
  id: string
  kind: ContextMenuKind
  name: string
  /** 仅菜单命令有注册来源；扩展按 CLSID 屏蔽，不区分注册来源。 */
  hive?: 'HKCU' | 'HKLM'
  /** 注册位置，可能包含 `.png` 等文件类型。 */
  locations: string[]
  /** 菜单命令、扩展 DLL 或打包应用的包名。 */
  command: string
  clsid?: string
  state: ContextMenuState
  /** 屏蔽列表所在位置，用于判断启用时是否需要管理员权限。 */
  blockedBy?: Array<'HKCU' | 'HKLM'>
  system: boolean
  group: string
}

export interface ContextMenuEnvironment {
  build: number
  win11: boolean
  classicMenu: boolean
  isAdmin: boolean
}

export interface ContextMenuChange {
  id: string
  state: ContextMenuState
  label?: string
}

export interface ContextMenuItemResult {
  id: string
  success: boolean
  error?: string
  backupPath?: string
  changed?: boolean
}

export interface ContextMenuResult {
  success: boolean
  entries?: WindowsContextMenuEntry[]
  environment?: ContextMenuEnvironment
  backupPath?: string
  error?: string
  backups?: ContextMenuBackup[]
  warnings?: string[]
  results?: ContextMenuItemResult[]
}

export type ContextMenuRecordOp = 'verb-state' | 'block' | 'classic-menu'

export interface ContextMenuBackup {
  backupId: string
  entryId: string
  createdAt: string
  backupPath: string
  op: ContextMenuRecordOp
  label: string
  fromState: string
  toState: string
  restoredAt?: string
  canRestore?: boolean
}

export interface ParsedContextMenuId {
  kind: ContextMenuKind
  /** verb 的完整注册表键；扩展项为空。 */
  key?: string
  hive?: 'HKCU' | 'HKLM'
  clsid?: string
}

/**
 * 解析受支持的菜单项标识，防止 IPC 参数访问任意注册表位置。
 * @param id 列表返回的菜单项标识
 * @returns 解析结果；不是受支持的标识时返回 null
 */
export function parseContextMenuId(id: unknown): ParsedContextMenuId | null {
  // 必须拒绝控制字符，避免日志与导出路径被注入换行等不可见内容。
  // eslint-disable-next-line no-control-regex
  if (typeof id !== 'string' || /[\x00-\x1f]/.test(id)) return null
  // 扩展按 CLSID 屏蔽，标识中只允许携带格式严格的 GUID。
  for (const kind of ['shellex', 'packaged'] as const) {
    const prefix = `${kind.toUpperCase()}\\`
    if (id.startsWith(prefix)) {
      const clsid = id.slice(prefix.length)
      return clsidPattern.test(clsid) ? { kind, clsid: clsid.toUpperCase() } : null
    }
  }
  // 精确比较父路径，避免子菜单、相对路径或其他注册表分支进入写入流程。
  for (const hive of ['HKCU', 'HKLM'] as const) {
    for (const location of Object.keys(CONTEXT_MENU_LOCATIONS)) {
      const prefix = `${hive}\\Software\\Classes\\${location}\\shell\\`
      if (!id.startsWith(prefix)) continue
      const name = id.slice(prefix.length)
      if (name.length > 0 && !name.includes('\\') && name !== '.' && name !== '..') {
        return { kind: 'verb', key: id, hive }
      }
    }
  }
  return null
}

/**
 * 仅允许受支持位置下的直接 shell 子项。
 * @param id 注册表项标识
 * @returns 参数是否为允许管理的菜单命令
 */
export function isContextMenuId(id: unknown): id is string {
  return parseContextMenuId(id)?.kind === 'verb'
}

/**
 * 判断菜单项是否支持目标状态；仅菜单命令支持「仅 Shift 显示」。
 * @param kind 菜单项类型
 * @param state 目标状态
 * @returns 是否支持
 */
export function supportsState(kind: ContextMenuKind, state: unknown): state is ContextMenuState {
  if (state === 'shown' || state === 'disabled') return true
  return state === 'extended' && kind === 'verb'
}

/**
 * 判断 CLSID 字符串格式，大小写不敏感。
 * @param value 待校验的值
 * @returns 是否为带花括号的 GUID
 */
export function isClsid(value: unknown): value is string {
  return typeof value === 'string' && clsidPattern.test(value)
}
