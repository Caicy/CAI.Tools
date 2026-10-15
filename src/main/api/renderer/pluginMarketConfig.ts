import type { HttpRequestOptions, HttpResponse } from '../../utils/httpRequest'
import { httpRequest } from '../../utils/httpRequest.js'
import { OFFICIAL_SERVER_HTTP_URL } from '../../../shared/syncServerUrl'
import { unavailableOfficialCapability } from '../../../shared/localEdition'

export const DEFAULT_PLUGIN_MARKET_API_BASE = `${OFFICIAL_SERVER_HTTP_URL}/api/market`
const DEFAULT_PLUGIN_MARKET_TIMEOUT = 15_000

export class PluginMarketAuthRequiredError extends Error {
  /**
   * 标明调用方请求了本地版不提供的官方账号能力。
   * @param message 面向用户的操作限制说明。
   * @returns 新建的能力限制错误。
   */
  constructor(message = '此操作需要官方账号，本地版不提供') {
    super(message)
    this.name = 'PluginMarketAuthRequiredError'
  }
}

export const PluginMarketAuthMode = {
  OPTIONAL: 'optional',
  REQUIRED: 'required'
} as const

export type PluginMarketAuthMode = (typeof PluginMarketAuthMode)[keyof typeof PluginMarketAuthMode]

/**
 * 获取公开插件市场的 API 基础地址。
 * @returns 市场 API 地址。
 */
export function getPluginMarketApiBase(): string {
  return DEFAULT_PLUGIN_MARKET_API_BASE
}

/**
 * 保留旧认证头接口，本地版始终匿名且不读取官方会话。
 * @param marketApiBase 兼容旧调用方的市场地址参数。
 * @returns 空的认证头集合。
 */
export async function getPluginMarketAuthHeaders(
  marketApiBase = getPluginMarketApiBase()
): Promise<Record<string, string>> {
  void marketApiBase
  return {}
}

/**
 * 匿名访问市场，并在网络错误或非成功状态下直接结束请求。
 * @param path 相对市场路径或明确的 HTTP(S) 完整地址。
 * @param options 请求选项；所有大小写形式的 Authorization 都会被移除。
 * @param authMode 操作是否依赖官方账号。
 * @returns 市场成功响应，含外部市场返回的原始 downloadUrl。
 * @throws 官方账号必需、HTTP 状态失败或请求超时时抛出错误。
 */
export async function requestPluginMarket(
  path: string,
  options: HttpRequestOptions = {},
  authMode: PluginMarketAuthMode = PluginMarketAuthMode.OPTIONAL
): Promise<HttpResponse> {
  // 在任何网络访问前拒绝依赖官方账号的操作。
  if (authMode === PluginMarketAuthMode.REQUIRED) {
    throw new PluginMarketAuthRequiredError('此操作需要官方账号，本地版不提供')
  }

  const url = /^https?:\/\//i.test(path) ? path : `${getPluginMarketApiBase()}${path}`
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'authorization')
  )
  // 允许调用方缩短等待；零、非法值和更长等待均不能取消市场的退出边界。
  const timeout =
    Number.isFinite(options.timeout) && (options.timeout ?? 0) > 0
      ? Math.min(options.timeout!, DEFAULT_PLUGIN_MARKET_TIMEOUT)
      : DEFAULT_PLUGIN_MARKET_TIMEOUT
  return httpRequest(url, {
    ...options,
    headers,
    timeout,
    validateStatus: (status) => status >= 200 && status < 300
  })
}

/**
 * 拒绝旧插件写入官方市场令牌，避免恢复隐式账号依赖。
 * @param input 旧接口传入的账号凭据；本地版不读取或保存。
 * @returns 操作结束的 Promise；此接口始终拒绝。
 * @throws 带 OFFICIAL_CAPABILITY_UNAVAILABLE 错误码的能力限制错误。
 */
export async function savePluginMarketTokens(input: {
  serverUrl?: string
  token: string
  refreshToken?: string
  username?: string
}): Promise<void> {
  void input
  const failure = unavailableOfficialCapability('保存官方插件市场令牌')
  throw Object.assign(new Error(failure.error), { code: failure.code })
}
