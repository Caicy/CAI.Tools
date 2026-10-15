export const LOCAL_PRODUCT_NAME = 'CAI.Tools'
export const LOCAL_APP_ID = 'tools.cai.local'
export const UPSTREAM_BASE_VERSION = '3.2.0'
export const LOCAL_DEFAULT_ROOT_NAME = '.cai-tools'

export interface LocalEditionInfo {
  product: typeof LOCAL_PRODUCT_NAME
  upstreamBase: string
  officialAccount: false
  cloudSync: false
}

export interface UpstreamNotice {
  kind: 'available' | 'up-to-date' | 'unavailable'
  version?: string
  releaseUrl?: string
  message?: string
}

/**
 * 为本地版未提供的官方服务能力生成稳定的失败结果。
 * @param capability 不可用能力的名称。
 * @returns 包含稳定错误码和中文说明的失败结果。
 */
export function unavailableOfficialCapability(capability: string): {
  success: false
  code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
  error: string
} {
  return {
    success: false,
    code: 'OFFICIAL_CAPABILITY_UNAVAILABLE',
    error: `当前本地版不提供官方服务能力：${capability}`
  }
}
