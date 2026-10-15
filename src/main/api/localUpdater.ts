import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  LOCAL_PRODUCT_NAME,
  UPSTREAM_BASE_VERSION,
  unavailableOfficialCapability,
  type LocalEditionInfo
} from '../../shared/localEdition'
import {
  checkUpstreamUpdate,
  isAllowedUpstreamReleaseUrl
} from '../core/localEdition/upstreamUpdateNotice'

interface LegacyUpdateCheckResult {
  success: boolean
  updateAvailable: boolean
  hasUpdate: boolean
  status: 'available' | 'not-available' | 'error'
  latestVersion?: string
  updateInfo?: { version?: string; releaseUrl?: string }
  error?: string
}

export class LocalUpdaterAPI {
  private initialized = false

  /**
   * 注册用户触发的上游检查及旧更新入口兼容响应，不初始化平台更新器。
   * @param _mainWindow 为兼容既有 API 初始化签名接收的主窗口，不保留其资源。
   * @returns 无返回值。
   */
  public init(_mainWindow: BrowserWindow): void {
    // 重复初始化不重复注册通道；导入和注册阶段都不执行网络请求。
    if (this.initialized) return
    this.initialized = true
    ipcMain.handle('local-edition:get-info', () => this.getInfo())
    ipcMain.handle('local-edition:check-upstream', () => checkUpstreamUpdate())
    ipcMain.handle('local-edition:open-upstream-release', (_event, url: unknown) =>
      this.openUpstreamRelease(url)
    )

    // 旧 invoke 调用仍有明确响应，但只保留手动查询及空下载状态。
    ipcMain.handle('updater:check-update', () => this.checkUpdate())
    ipcMain.handle('updater:show-update-window', () =>
      unavailableOfficialCapability('原版更新窗口')
    )
    ipcMain.handle('updater:start-update', (_event, sourceID?: number) =>
      this.startUpdate(sourceID)
    )
    ipcMain.handle('updater:cancel-update', () => unavailableOfficialCapability('原版更新下载'))
    ipcMain.handle('updater:open-download-source', () =>
      unavailableOfficialCapability('原版更新下载源')
    )
    ipcMain.handle('updater:install-downloaded-update', () =>
      unavailableOfficialCapability('原版应用安装')
    )
    ipcMain.handle('updater:get-download-status', () => ({
      status: 'idle',
      hasDownloaded: false,
      hasUpdate: false
    }))
    // sendSync 通过事件字段获得失败；普通 send 没有回应，也不触发安装或窗口操作。
    ipcMain.on('updater:quit-and-install', (event) => {
      event.returnValue = unavailableOfficialCapability('原版应用安装')
    })
    ipcMain.on('updater:minimize-window', (event) => {
      event.returnValue = unavailableOfficialCapability('原版更新窗口')
    })
    ipcMain.on('updater:close-window', (event) => {
      event.returnValue = unavailableOfficialCapability('原版更新窗口')
    })
    ipcMain.on('updater:window-ready', (event) => {
      event.returnValue = unavailableOfficialCapability('原版更新窗口')
    })
  }

  /**
   * 返回本地产品和已禁用的官方服务能力，供设置界面统一展示。
   * @returns 本地版基础信息。
   */
  private getInfo(): LocalEditionInfo {
    return {
      product: LOCAL_PRODUCT_NAME,
      upstreamBase: UPSTREAM_BASE_VERSION,
      officialAccount: false,
      cloudSync: false
    }
  }

  /**
   * 将用户主动查询的上游提醒转换为旧更新检查结果。
   * @returns 兼容旧界面的查询结果，不含下载源或安装状态。
   */
  public async checkUpdate(): Promise<LegacyUpdateCheckResult> {
    const notice = await checkUpstreamUpdate()
    if (notice.kind === 'unavailable') {
      return {
        success: false,
        updateAvailable: false,
        hasUpdate: false,
        status: 'error',
        error: notice.message
      }
    }
    // 只传递发布页面信息，旧界面无法凭此得到可执行的更新包。
    const available = notice.kind === 'available'
    return {
      success: true,
      updateAvailable: available,
      hasUpdate: available,
      status: available ? 'available' : 'not-available',
      latestVersion: notice.version,
      ...(available
        ? { updateInfo: { version: notice.version, releaseUrl: notice.releaseUrl } }
        : {})
    }
  }

  /**
   * 明确拒绝原版下载或安装请求，避免上游安装包覆盖本地版。
   * @param _sourceID 旧调用方提供的下载源编号，在本地版不使用。
   * @returns 包含稳定错误码的失败结果。
   */
  public async startUpdate(
    _sourceID?: number
  ): Promise<ReturnType<typeof unavailableOfficialCapability>> {
    return unavailableOfficialCapability('原版应用更新')
  }

  /**
   * 兼容旧自动检查开关，但始终保持关闭且不创建定时器。
   * @param _enabled 旧调用方请求的状态，在本地版不启用。
   * @returns 已处理请求且实际 enabled 固定为 false 的结果。
   */
  public setAutoCheck(_enabled: boolean): { success: true; enabled: false } {
    return { success: true, enabled: false }
  }

  /**
   * 复验用户提供的发布页后交给系统浏览器打开。
   * @param url 渲染进程提供的未知地址，不能信任此前查询的结果。
   * @returns 浏览器打开结果或稳定的地址校验失败结果。
   */
  private async openUpstreamRelease(
    url: unknown
  ): Promise<{ success: true } | { success: false; code: string; error: string }> {
    // 此处独立验证，防止伪造 IPC 直接绕过上游响应校验。
    if (!isAllowedUpstreamReleaseUrl(url)) {
      return {
        success: false,
        code: 'INVALID_UPSTREAM_RELEASE_URL',
        error: '仅允许打开上游稳定版发布页'
      }
    }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch {
      return { success: false, code: 'UPSTREAM_RELEASE_OPEN_FAILED', error: '无法打开上游发布页' }
    }
  }

  /**
   * 保留应用退出时的清理合同；本地提醒层没有定时器、窗口或更新器资源。
   * @returns 无返回值。
   */
  public cleanup(): void {
    // 通道随主进程退出释放，无需启动或停止任何后台工作。
  }
}

export default new LocalUpdaterAPI()
