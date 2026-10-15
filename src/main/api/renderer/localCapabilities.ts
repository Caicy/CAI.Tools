import { ipcMain } from 'electron'
import { unavailableOfficialCapability } from '../../../shared/localEdition'

// 旧 sync.ts 和 resources/preload.js 的账号/同步请求均为 invoke 通道；推送事件无需注册。
// 保留确定清单供旧插件兼容，测试同时核对原模块与 preload，防止漏掉历史入口。
const UNAVAILABLE_CHANNELS = [
  'sync:test-connection',
  'sync:get-captcha-config',
  'account:login',
  'account:save-session',
  'account:logout',
  'account:change-password',
  'account:delete',
  'sync:login',
  'sync:login-private',
  'sync:logout-private',
  'sync:save-config',
  'sync:get-config',
  'sync:get-state',
  'sync:get-status',
  'sync:get-default-import-status',
  'sync:import-default-data',
  'sync:skip-default-import',
  'sync:get-account-stats',
  'sync:get-account-credits',
  'sync:get-ai-checkin-status',
  'sync:ai-checkin',
  'sync:create-ai-recharge-order',
  'sync:get-ai-recharge-order',
  'sync:open-ai-recharge-url',
  'sync:close-ai-recharge-window',
  'sync:get-account-profile',
  'sync:upload-account-avatar',
  'sync:get-retry-status',
  'sync:retry-now',
  'sync:perform-sync',
  'sync:stop-auto-sync',
  'sync:get-unsynced-count',
  'sync:reset-local-sync-state',
  'sync:get-conflict-count',
  'sync:list-conflicts',
  'sync:get-conflict-detail',
  'sync:resolve-conflict',
  'sync:force-push-all',
  'sync:github-init-session',
  'sync:github-open-browser',
  'sync:github-poll-status',
  'sync:update-nickname'
] as const

/**
 * 注册原账号与同步 IPC 的本地版响应，不初始化账号存储或同步客户端。
 * @returns 无返回值。
 */
export function registerLocalCapabilities(): void {
  // 会话只读查询保持空身份；其他旧入口统一给出稳定的能力不可用错误。
  ipcMain.handle('account:get-session', () => null)
  for (const channel of UNAVAILABLE_CHANNELS) {
    ipcMain.handle(channel, () => unavailableOfficialCapability(channel))
  }
}
