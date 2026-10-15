import type { Json } from '../../../../shared/gitMirrorTypes'
import { canonicalJson } from '../canonicalJson'

export const documentMetadata = ['_id', '_rev', '_lastModified']

/**
 * 验证投影对象与其字段白名单，未知业务字段必须显式适配。
 * @param value 待验证的 JSON。
 * @param allowed 唯一允许的字段名称。
 * @returns 已校验的普通对象。
 * @throws 不是对象或存在未知字段时抛错。
 */
export function fields(value: Json, allowed: readonly string[]): Record<string, Json> {
  canonicalJson(value)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_PAYLOAD')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`UNSUPPORTED_FIELD:${key}`)
  }
  return value
}

/**
 * 验证字段满足声明类型而非进行隐式转换。
 * @param valid 校验条件。
 * @returns 无返回值。
 * @throws 条件不满足时抛错。
 */
export function requireValue(valid: boolean): asserts valid {
  if (!valid) throw new Error('INVALID_PAYLOAD')
}

/**
 * 检查文档标识与插件逻辑键一致，不将本机 namespace 放进投影。
 * @param doc 本机文档。
 * @param plugin 插件 canonical 名称。
 * @param key 无 namespace 的逻辑键。
 * @returns 无返回值。
 * @throws 文档标识或宿主 revision 元信息无效时抛错。
 */
export function assertDocumentIdentity(
  doc: Record<string, Json>,
  plugin: string,
  key: string
): void {
  if (doc._id !== undefined && doc._id !== key && doc._id !== `PLUGIN/${plugin}/${key}`) {
    throw new Error('IDENTITY_MISMATCH')
  }
  requireValue(doc._rev === undefined || typeof doc._rev === 'string')
  requireValue(
    doc._lastModified === undefined ||
      (typeof doc._lastModified === 'number' && Number.isFinite(doc._lastModified))
  )
}
