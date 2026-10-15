import type { Json } from '../../../../shared/gitMirrorTypes'
import type { Adapter } from './types'
import { strictParseJson, canonicalJson } from '../canonicalJson'
import { fields, requireValue, documentMetadata, assertDocumentIdentity } from './validation'

/**
 * 只匹配 AI 助手已声明的会话与模型选择。
 * @param key 插件逻辑键。
 * @returns 是否具有已适配的数据结构。
 */
function acceptsKey(key: string): boolean {
  return key === 'selected_model' || (key.startsWith('conv/') && key.length > 5)
}

/**
 * 验证会话及消息，不改写正文、图片或推理内容。
 * @param key 会话逻辑键。
 * @param value 结构化会话。
 * @returns 独立、限额内的会话 JSON。
 * @throws 身份、字段或类型不兼容时抛错。
 */
function conversationPayload(key: string, value: Json): Json {
  const doc = fields(value, ['id', 'title', 'messages', 'createdAt', 'updatedAt'])
  if (`conv/${doc.id}` !== key) throw new Error('IDENTITY_MISMATCH')
  requireValue(
    typeof doc.id === 'string' && typeof doc.title === 'string' && Array.isArray(doc.messages)
  )
  for (const field of ['createdAt', 'updatedAt'])
    requireValue(typeof doc[field] === 'number' && Number.isFinite(doc[field]))
  const ids = new Set<string>()
  for (const value of doc.messages as Json[]) {
    const message = fields(value, ['id', 'role', 'content', 'images', 'reasoning', 'timestamp'])
    requireValue(typeof message.id === 'string' && !ids.has(message.id))
    ids.add(message.id as string)
    requireValue(
      ['user', 'assistant'].includes(message.role as string) && typeof message.content === 'string'
    )
    requireValue(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp))
    requireValue(message.reasoning === undefined || typeof message.reasoning === 'string')
    requireValue(
      message.images === undefined ||
        (Array.isArray(message.images) &&
          message.images.every((image) => typeof image === 'string'))
    )
  }
  return strictParseJson(canonicalJson(doc))
}

/**
 * 按原插件存储结构读取会话 data 或模型 value。
 * @param key 插件逻辑键。
 * @param localDocument 本机文档。
 * @returns 结构化业务投影。
 * @throws 未知键、字段或坏 JSON 时抛错。
 */
function exportPayload(key: string, localDocument: Json): Json {
  requireValue(acceptsKey(key))
  const doc = fields(localDocument, [
    ...documentMetadata,
    key === 'selected_model' ? 'value' : 'data'
  ])
  assertDocumentIdentity(doc, 'ai-helper', key)
  if (key === 'selected_model') {
    requireValue(typeof doc.value === 'string')
    return doc.value
  }
  requireValue(typeof doc.data === 'string')
  return conversationPayload(key, strictParseJson(doc.data as string))
}

/**
 * 将会话投影还原成原插件 data 字符串或模型 value 文档。
 * @param key 插件逻辑键。
 * @param payload 结构化会话或模型字符串。
 * @param previousDocument 目标设备已有文档，非空时校验兼容性。
 * @returns 具有本机 namespace 的文档，不继承远端 revision。
 * @throws 投影或本机结构未知时抛错。
 */
function importPayload(key: string, payload: Json, previousDocument: Json | null): Json {
  requireValue(acceptsKey(key))
  if (previousDocument) exportPayload(key, previousDocument)
  if (key === 'selected_model') {
    requireValue(typeof payload === 'string')
    return { _id: `PLUGIN/ai-helper/${key}`, value: payload }
  }
  return { _id: `PLUGIN/ai-helper/${key}`, data: canonicalJson(conversationPayload(key, payload)) }
}

export const aiHelperAdapter: Adapter = {
  name: 'ai-helper',
  pluginVersion: '1.2.1',
  adapterVersion: 'ai-helper@1',
  acceptsKey,
  exportPayload,
  importPayload
}
