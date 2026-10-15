import type { Json } from '../../../../shared/gitMirrorTypes'
import type { Adapter } from './types'
import { fields, requireValue, documentMetadata, assertDocumentIdentity } from './validation'

const portable = ['name', 'description', 'language', 'tags', 'code', 'pinned', 'createdAt']

/**
 * 限定模板插件真正使用的逻辑键。
 * @param key 插件内部键。
 * @returns 是否是非空模板 ID。
 */
function acceptsKey(key: string): boolean {
  return key.startsWith('tpl_') && key.length > 4
}

/**
 * 验证模板业务字段，返回独立的可迁移投影。
 * @param value 模板投影。
 * @returns 字段白名单投影。
 * @throws 类型或日期格式无效时抛错。
 */
function templatePayload(value: Json): Record<string, Json> {
  const doc = fields(value, portable)
  for (const key of ['name', 'description', 'language', 'code', 'createdAt'])
    requireValue(typeof doc[key] === 'string')
  requireValue(Array.isArray(doc.tags) && doc.tags.every((tag) => typeof tag === 'string'))
  requireValue(doc.pinned === undefined || typeof doc.pinned === 'boolean')
  requireValue(
    typeof doc.createdAt === 'string' &&
      /^\d{4}-\d\d-\d\dT/.test(doc.createdAt) &&
      Number.isFinite(Date.parse(doc.createdAt))
  )
  return {
    name: doc.name,
    description: doc.description,
    language: doc.language,
    code: doc.code,
    tags: [...(doc.tags as Json[])],
    pinned: doc.pinned === true,
    createdAt: doc.createdAt
  }
}

/**
 * 从模板文档剔除本机复制统计和宿主 revision。
 * @param key 模板逻辑键。
 * @param localDocument 本机模板文档。
 * @returns 可迁移业务投影。
 * @throws 未知键、未知字段或结构不兼容时抛错。
 */
function exportPayload(key: string, localDocument: Json): Json {
  requireValue(acceptsKey(key))
  const doc = fields(localDocument, [...portable, ...documentMetadata, 'usageCount', 'updatedAt'])
  assertDocumentIdentity(doc, 'code-snippets', key)
  requireValue(
    typeof doc.usageCount === 'number' && Number.isInteger(doc.usageCount) && doc.usageCount >= 0
  )
  requireValue(typeof doc.updatedAt === 'string' && Number.isFinite(Date.parse(doc.updatedAt)))
  const projection: Record<string, Json> = {}
  // 只拷贝声明字段；复制次数与复制产生的更新时间始终留本机。
  for (const field of portable) if (doc[field] !== undefined) projection[field] = doc[field]
  return templatePayload(projection)
}

/**
 * 恢复模板的本机 namespace，并保留已有使用统计。
 * @param key 模板逻辑键。
 * @param payload 已共享的模板内容。
 * @param previousDocument 目标设备已有文档，首次导入为空。
 * @returns 不含远端 revision 的本机文档。
 * @throws 键或投影不合法、本机文档结构未知时抛错。
 */
function importPayload(key: string, payload: Json, previousDocument: Json | null): Json {
  requireValue(acceptsKey(key))
  const value = templatePayload(payload)
  if (previousDocument) exportPayload(key, previousDocument)
  const previous = previousDocument as Record<string, Json> | null
  // 不继承远端统计；首次恢复以创建时间初始化插件要求的更新时间。
  return {
    _id: `PLUGIN/code-snippets/${key}`,
    ...value,
    usageCount: previous?.usageCount ?? 0,
    updatedAt: previous?.updatedAt ?? value.createdAt
  }
}

export const codeSnippetsAdapter: Adapter = {
  name: 'code-snippets',
  pluginVersion: '1.2.0',
  adapterVersion: 'code-snippets@1',
  acceptsKey,
  exportPayload,
  importPayload
}
