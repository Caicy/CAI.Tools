import { registerPluginApiServices } from './pluginApiDispatcher'

/**
 * 返回本地版的空用户信息，保持插件同步调用约定。
 * @param event 插件发起的同步 IPC 事件。
 * @returns 无返回值。
 */
function getUser(event: Electron.IpcMainEvent): void {
  // 本地运行不建立官方身份，也不读取持久化的旧账号资料。
  event.returnValue = null
}

/**
 * 拒绝官方令牌和支付能力，供原有异步插件 API 共用。
 * @returns 始终被拒绝的 Promise。
 * @throws 始终抛出 OFFICIAL_CAPABILITY_UNAVAILABLE。
 */
async function rejectOfficialCapability(): Promise<never> {
  // 在任何账号读取、网络请求或支付窗口创建之前结束调用。
  throw new Error('OFFICIAL_CAPABILITY_UNAVAILABLE')
}

/**
 * 注册本地版插件兼容能力，沿用 getUser 同步、令牌与支付异步的调用方式。
 * @returns 无返回值。
 */
export function registerLocalUserCapabilities(): void {
  registerPluginApiServices({
    getUser,
    getUserTempToken: rejectOfficialCapability,
    requestPayment: rejectOfficialCapability,
    getPaymentRecords: rejectOfficialCapability
  })
}
