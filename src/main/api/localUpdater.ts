import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  LOCAL_PRODUCT_NAME,
  UPSTREAM_BASE_VERSION,
  type LocalEditionInfo
} from '../../shared/localEdition'
import {
  checkUpstreamUpdate,
  isAllowedUpstreamReleaseUrl
} from '../core/localEdition/upstreamUpdateNotice'

export class LocalUpdaterAPI {
  private initialized = false

  /**
   * 注册产品信息与用户触发的上游研究提醒，不持有自有更新器资源。
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

    // 自有更新 IPC 由 UpdaterAPI 独立注册；此模块仅保留上游研究提醒。
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
