import type { Json } from '../../../shared/gitMirrorTypes'
import { canonicalJson, strictParseJson } from './canonicalJson'
import { fields, requireValue } from './adapters/validation'

const textPreferences = [
  'theme',
  'primaryColor',
  'customColor',
  'placeholder',
  'searchMode',
  'hotkey',
  'autoPaste',
  'autoClear',
  'autoBackToSearch'
]
const boolPreferences = [
  'showRecentInSearch',
  'showMatchRecommendation',
  'hideMainWindowOnPluginEsc',
  'spaceOpenCommand'
]
const numberPreferences = ['recentRows', 'pinnedRows']
const preferenceKeys = [...textPreferences, ...boolPreferences, ...numberPreferences]

/**
 * 提取宿主已声明的通用偏好，本机环境字段不进入投影。
 * @param document 本机 settings-general 内容。
 * @returns 通用字段的独立投影。
 * @throws 白名单字段类型不兼容时抛错。
 */
export function projectHostPreferences(document: Record<string, unknown>): Json {
  const result: Record<string, Json> = {}
  for (const key of preferenceKeys) {
    if (document[key] === undefined) continue
    const value = document[key]
    requireValue(
      textPreferences.includes(key)
        ? typeof value === 'string'
        : boolPreferences.includes(key)
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isInteger(value) && value >= 0
    )
    result[key] = value as Json
  }
  return strictParseJson(canonicalJson(result))
}

/**
 * 将通用偏好覆盖到本机配置，保留环境设置和凭据。
 * @param payload 共享偏好。
 * @param previous 目标设备已有配置。
 * @returns 保留非共享字段的本机配置。
 * @throws 共享数据含未知字段或坏类型时抛错。
 */
export function mergeHostPreferences(
  payload: Json,
  previous: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...previous,
    ...(projectHostPreferences(fields(payload, preferenceKeys)) as Record<string, Json>)
  }
}

/**
 * 仅导出已安装插件 canonical 目标的快捷键，去掉路径和展示缓存。
 * @param shortcuts 本机快捷键记录。
 * @param installedNames 已安装的非开发插件名称。
 * @returns 可迁移快捷键列表。
 * @throws 已选记录的字段类型或 ID 冲突时抛错。
 */
export function projectPluginShortcuts(shortcuts: Json[], installedNames: string[]): Json[] {
  const result: Json[] = []
  const ids = new Set<string>()
  for (const value of shortcuts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const target = value.target
    if (
      typeof target !== 'string' ||
      !installedNames.some(
        (name) => target.startsWith(name + '/') && target.length > name.length + 1
      )
    )
      continue
    requireValue(
      typeof value.id === 'string' &&
        !ids.has(value.id) &&
        typeof value.shortcut === 'string' &&
        typeof value.enabled === 'boolean'
    )
    ids.add(value.id as string)
    const projection: Record<string, Json> = {
      id: value.id,
      shortcut: value.shortcut,
      target: value.target,
      enabled: value.enabled
    }
    for (const key of ['autoCopy', 'preScreenshotOptimization']) {
      if (value[key] === undefined) continue
      requireValue(typeof value[key] === 'boolean')
      projection[key] = value[key]
    }
    result.push(projection)
  }
  return strictParseJson(canonicalJson(result)) as Json[]
}

/**
 * 合并已校验的插件快捷键，保留目标机器的应用路径快捷键。
 * @param payload 共享插件快捷键。
 * @param previous 本机全部快捷键。
 * @param installedNames 已恢复的非开发插件名称。
 * @returns 合并后的本机快捷键。
 * @throws 共享字段、目标或 ID 与本机环境记录冲突时抛错。
 */
export function mergePluginShortcuts(
  payload: Json[],
  previous: Json[],
  installedNames: string[]
): Json[] {
  for (const value of payload)
    fields(value, ['id', 'shortcut', 'target', 'enabled', 'autoCopy', 'preScreenshotOptimization'])
  const portable = projectPluginShortcuts(payload, installedNames)
  requireValue(portable.length === payload.length)
  const localPortable = projectPluginShortcuts(previous, installedNames)
  const localPortableIds = new Set(localPortable.map((value) => (value as Record<string, Json>).id))
  const incoming = new Map(portable.map((value) => [(value as Record<string, Json>).id, value]))
  const result = previous.map((value) => {
    const id = value && typeof value === 'object' && !Array.isArray(value) ? value.id : null
    if (!incoming.has(id)) return value
    if (!localPortableIds.has(id)) throw new Error('SHORTCUT_LOCAL_ID_CONFLICT')
    const replacement = incoming.get(id)!
    incoming.delete(id)
    return replacement
  })
  return [...result, ...incoming.values()]
}
