import type {
  AiProviderStore,
  StoredAiProviderStore,
  AiProvider,
  AiProviderModel
} from '../../../shared/aiProviderShared'
import {
  AI_PROVIDER_STORE_VERSION,
  AI_REASONING_EFFORTS,
  isAiProviderStore
} from '../../../shared/aiProviderShared'
import { canonicalJson, strictParseJson } from './canonicalJson'
import type { Json } from '../../../shared/gitMirrorTypes'
import { fields, requireValue } from './adapters/validation'

export interface ProviderCredentials {
  version: 1
  keys: Record<string, string>
}
export interface ProviderStorage {
  getMetadata(): unknown
  getCredentials(): unknown
  putMetadata(value: StoredAiProviderStore): void
  putCredentials(value: ProviderCredentials): void
}

/**
 * 校验本机凭据文档，不在错误信息中打印密钥。
 * @param value 设备库读取结果。
 * @returns 独立的 ID 到密钥映射。
 * @throws 已存在的凭据结构损坏时抛错，避免迁移覆盖它。
 */
export function readProviderCredentials(value: unknown): ProviderCredentials {
  if (value === null || value === undefined) return { version: 1, keys: Object.create(null) }
  const doc = value as ProviderCredentials
  if (
    doc.version !== 1 ||
    !doc.keys ||
    typeof doc.keys !== 'object' ||
    Array.isArray(doc.keys) ||
    Object.values(doc.keys).some((key) => typeof key !== 'string')
  )
    throw new Error('INVALID_PROVIDER_CREDENTIALS')
  return { version: 1, keys: Object.assign(Object.create(null), doc.keys) }
}

/**
 * 先持久化并读回凭据，再删除账户元数据中的旧密钥。
 * @param store 完整运行时供应商配置。
 * @param storage 本机设备库与账户库端口。
 * @returns 无返回值。
 * @throws 凭据写入、读回或元数据保存失败时抛错，旧密钥不提前删除。
 */
export function saveProviderStore(store: AiProviderStore, storage: ProviderStorage): void {
  const credentials = readProviderCredentials(storage.getCredentials())
  const metadata: StoredAiProviderStore = { version: AI_PROVIDER_STORE_VERSION, providers: [] }
  const ids = new Set<string>()
  for (const provider of store.providers) {
    if (
      !provider.id ||
      ids.has(provider.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(provider.id)
    )
      throw new Error('INVALID_PROVIDER_ID')
    ids.add(provider.id)
    // 只拆分明确的凭据字段，保留现有提供商 API 与模型选择合同。
    const { apiKey, ...portable } = provider
    if (typeof apiKey !== 'string') throw new Error('INVALID_PROVIDER_KEY')
    credentials.keys[provider.id] = apiKey
    metadata.providers.push(structuredClone(portable))
  }
  storage.putCredentials(credentials)
  const verified = readProviderCredentials(storage.getCredentials())
  for (const provider of store.providers) {
    if (verified.keys[provider.id] !== provider.apiKey)
      throw new Error('PROVIDER_CREDENTIAL_READBACK_FAILED')
  }
  // 两个库不是同一事务；先有耐久的设备凭据，崩溃重试才不会丢失旧密钥。
  storage.putMetadata(metadata)
}

/**
 * 读取元数据并组装本机密钥；旧完整文档先完成可重试拆分。
 * @param storage 本机持久化端口。
 * @returns 完整的运行时配置，缺失密钥保持空字符串。
 * @throws 已有凭据损坏或迁移保存失败时抛错。
 */
export function loadProviderStore(storage: ProviderStorage): AiProviderStore {
  const value = storage.getMetadata()
  if (!isAiProviderStore(value)) return { version: AI_PROVIDER_STORE_VERSION, providers: [] }
  const credentials = readProviderCredentials(storage.getCredentials())
  const result: AiProviderStore = {
    version: AI_PROVIDER_STORE_VERSION,
    providers: value.providers.map((provider) => ({
      ...structuredClone(provider),
      apiKey:
        typeof provider.apiKey === 'string'
          ? provider.apiKey
          : (credentials.keys[provider.id] ?? '')
    }))
  }
  if (value.providers.some((provider) => Object.prototype.hasOwnProperty.call(provider, 'apiKey')))
    saveProviderStore(result, storage)
  return result
}

/**
 * 判断地址能否共享，URL 内的认证与查询参数必须留本机。
 * @param value 供应商 URL。
 * @returns 是否为没有内嵌凭据的 HTTP 地址。
 */
function isPortableUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/**
 * 读取本机可选字段，忽略 undefined，未知字段仍拒绝。
 * @param value 本机普通配置对象。
 * @param allowed 唯一允许的字段。
 * @returns 可继续进行 JSON 校验的字段集。
 * @throws 不是普通对象或包含未知字段时抛错。
 */
function definedFields(value: unknown, allowed: readonly string[]): Record<string, Json> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw new Error('INVALID_PAYLOAD')
  const result: Record<string, Json> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`UNSUPPORTED_FIELD:${key}`)
    if (entry !== undefined) result[key] = entry as Json
  }
  return result
}

/**
 * 校验模型及嵌套能力字段，防止新增配置被隐式同步。
 * @param value 本机模型配置。
 * @returns 无未声明字段、可稳定序列化的模型。
 * @throws 模型结构或能力字段不兼容时抛错。
 */
function projectModel(value: unknown): Json {
  const model = definedFields(value, [
    'ref',
    'aliases',
    'modelId',
    'description',
    'icon',
    'cost',
    'contextWindow',
    'inputModalities',
    'reasoning',
    'temperature'
  ])
  requireValue(
    typeof model.ref === 'string' &&
      !!model.ref &&
      typeof model.modelId === 'string' &&
      !!model.modelId
  )
  for (const key of ['description', 'icon'])
    requireValue(model[key] === undefined || typeof model[key] === 'string')
  requireValue(
    model.aliases === undefined ||
      (Array.isArray(model.aliases) && model.aliases.every((alias) => typeof alias === 'string'))
  )
  requireValue(
    model.cost === undefined ||
      (typeof model.cost === 'number' && Number.isFinite(model.cost) && model.cost >= 0)
  )
  requireValue(
    model.contextWindow === undefined ||
      (typeof model.contextWindow === 'number' &&
        Number.isInteger(model.contextWindow) &&
        model.contextWindow > 0)
  )
  requireValue(
    model.inputModalities === undefined ||
      (Array.isArray(model.inputModalities) &&
        model.inputModalities.every((entry) => entry === 'text' || entry === 'image'))
  )
  if (model.reasoning !== undefined && model.reasoning !== false) {
    const reasoning = definedFields(model.reasoning, [
      'protocol',
      'efforts',
      'defaultEffort',
      'responseField'
    ])
    requireValue(
      ['auto', 'passthrough', 'openai-compatible', 'deepseek'].includes(
        reasoning.protocol as string
      )
    )
    requireValue(
      ['auto', 'reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details'].includes(
        reasoning.responseField as string
      )
    )
    requireValue(
      reasoning.defaultEffort === undefined ||
        AI_REASONING_EFFORTS.includes(reasoning.defaultEffort as never)
    )
    const efforts = fields(reasoning.efforts, AI_REASONING_EFFORTS)
    requireValue(
      Object.values(efforts).every((effort) => effort === null || typeof effort === 'string')
    )
    reasoning.efforts = efforts
    model.reasoning = reasoning
  }
  if (model.temperature !== undefined && model.temperature !== false) {
    const temperature = fields(model.temperature, ['mode', 'value', 'min', 'max', 'default'])
    if (temperature.mode === 'fixed') {
      requireValue(
        Object.keys(temperature).length === 2 &&
          typeof temperature.value === 'number' &&
          Number.isFinite(temperature.value)
      )
    } else {
      requireValue(temperature.mode === 'range' && temperature.value === undefined)
      const { min, max, default: initial } = temperature
      requireValue(
        typeof min === 'number' &&
          typeof max === 'number' &&
          typeof initial === 'number' &&
          min <= initial &&
          initial <= max
      )
    }
  }
  return strictParseJson(canonicalJson(model))
}

/**
 * 按明确字段投影供应商，API 密钥和含鉴权参数的 URL 永不导出。
 * @param store 完整运行时供应商配置。
 * @returns 可共享的供应商元数据。
 * @throws 模型未知字段、结构错误或 JSON 超限时抛错。
 */
export function projectAiProviders(store: AiProviderStore): Json {
  requireValue(store.version === AI_PROVIDER_STORE_VERSION && Array.isArray(store.providers))
  const ids = new Set<string>()
  const providers = store.providers.map((provider) => {
    definedFields(provider, [
      'id',
      'name',
      'apiUrl',
      'apiKey',
      'apiFormat',
      'enabled',
      'selectedModels'
    ])
    requireValue(
      typeof provider.id === 'string' &&
        !!provider.id &&
        !ids.has(provider.id) &&
        !['__proto__', 'constructor', 'prototype'].includes(provider.id)
    )
    ids.add(provider.id)
    requireValue(
      typeof provider.name === 'string' &&
        typeof provider.apiUrl === 'string' &&
        typeof provider.enabled === 'boolean'
    )
    requireValue(
      ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(provider.apiFormat) &&
        Array.isArray(provider.selectedModels)
    )
    const models = provider.selectedModels.map(projectModel)
    return {
      id: provider.id,
      name: provider.name,
      apiFormat: provider.apiFormat,
      enabled: provider.enabled,
      selectedModels: models,
      ...(isPortableUrl(provider.apiUrl) ? { apiUrl: provider.apiUrl } : {})
    }
  })
  return strictParseJson(canonicalJson({ version: AI_PROVIDER_STORE_VERSION, providers } as Json))
}

/**
 * 合并共享提供商元数据，密钥及不共享的 URL 只取本机旧值。
 * @param payload 共享供应商配置。
 * @param previous 目标设备完整运行时配置。
 * @returns 可保存的本机运行配置。
 * @throws 共享凭据、未知字段、身份或 URL 不合法时抛错。
 */
export function mergeAiProviders(payload: Json, previous: AiProviderStore): AiProviderStore {
  const doc = fields(payload, ['version', 'providers'])
  requireValue(doc.version === AI_PROVIDER_STORE_VERSION && Array.isArray(doc.providers))
  const ids = new Set<string>()
  const providers = (doc.providers as Json[]).map((value) => {
    const item = fields(value, ['id', 'name', 'apiUrl', 'apiFormat', 'enabled', 'selectedModels'])
    requireValue(
      typeof item.id === 'string' &&
        !ids.has(item.id) &&
        typeof item.name === 'string' &&
        typeof item.enabled === 'boolean'
    )
    ids.add(item.id as string)
    requireValue(
      ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(
        item.apiFormat as string
      ) && Array.isArray(item.selectedModels)
    )
    requireValue(
      item.apiUrl === undefined || (typeof item.apiUrl === 'string' && isPortableUrl(item.apiUrl))
    )
    const local = previous.providers.find((provider) => provider.id === item.id)
    const apiUrl = item.apiUrl ?? local?.apiUrl ?? ''
    return {
      ...item,
      apiKey: local?.apiKey ?? '',
      apiUrl,
      enabled: item.enabled && !!apiUrl,
      selectedModels: item.selectedModels as unknown as AiProviderModel[]
    } as unknown as AiProvider
  })
  const result = { version: AI_PROVIDER_STORE_VERSION, providers }
  // 再投影一次校验模型字段；缺少安全 URL 与本机密钥的新设备不会得到远端秘密。
  projectAiProviders(result)
  return result
}
