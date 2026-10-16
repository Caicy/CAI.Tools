import { app, BrowserWindow, dialog, ipcMain, screen, shell, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getPreloadPath, getRendererPath } from '../utils/appBundlePath'
import createPlatformUpdater from '@platform-updater'
import type { PlatformUpdateInfo, PlatformUpdaterService } from './platformUpdater/types'
import databaseAPI from './shared/database.js'
import windowManager from '../managers/windowManager'
import { applyWindowMaterial, getDefaultWindowMaterial } from '../utils/windowUtils.js'
import { isInAppUpdateSource } from '../../shared/updateSource'

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000

export class UpdaterAPI {
  private mainWindow: BrowserWindow | null = null
  private availableUpdateInfo: PlatformUpdateInfo | null = null
  private downloadedUpdateInfo: PlatformUpdateInfo | null = null
  private updateWindow: BrowserWindow | null = null
  private platformUpdater: PlatformUpdaterService | null = null
  private initializationPromise: Promise<void> = Promise.resolve()
  private initializationError: string | null = null
  private lastAutoNotifiedVersion = ''
  private autoCheckTimer: NodeJS.Timeout | null = null
  private autoCheckEnabled = false
  private autoCheckInFlight = false
  private initialized = false

  /**
   * 初始化平台更新服务并注册更新窗口使用的 IPC。
   * @param mainWindow 接收更新状态事件的主窗口。
   * @returns 无返回值。
   */
  public init(mainWindow: BrowserWindow): void {
    if (this.initialized) return
    this.initialized = true
    this.mainWindow = mainWindow
    this.platformUpdater = createPlatformUpdater({
      onDownloadStart: (info) => this.sendUpdateEvent('update-download-start', info),
      onDownloadProgress: (info) => this.sendUpdateEvent('update-download-progress', info),
      onDownloadCancelled: () => this.sendUpdateEvent('update-download-cancelled', undefined),
      onDownloaded: (info, showWindow) => this.handleUpdateDownloaded(info, showWindow),
      onDownloadFailed: (error) => this.sendUpdateEvent('update-download-failed', { error }),
      onBeforeInstall: () => windowManager.setQuitting(true),
      onInstallFailed: () => windowManager.setQuitting(false)
    })
    this.initializationPromise = this.platformUpdater.initialize().catch((error) => {
      // 初始化失败必须显式反馈，不能被解释成“没有新版本”。
      this.initializationError = error instanceof Error ? error.message : '更新器初始化失败'
      console.error('[Updater] 初始化平台更新器失败:', error)
    })

    this.setupIPC()
    this.setAutoCheck(databaseAPI.dbGet('settings-general')?.autoCheckUpdate !== false)
  }

  /**
   * 保存已验证的下载结果并通知更新窗口。
   * @param info 下载完成的版本。
   * @param showWindow 是否显示更新窗口。
   * @returns 无返回值。
   */
  private handleUpdateDownloaded(info: PlatformUpdateInfo, showWindow: boolean): void {
    this.availableUpdateInfo = info
    this.downloadedUpdateInfo = info
    this.sendUpdateEvent('update-downloaded', info)
    if (showWindow) this.createUpdateWindow()
  }

  /**
   * 向仍存活的宿主和更新窗口广播更新状态。
   * @param channel 更新事件通道。
   * @param payload 事件数据。
   * @returns 无返回值。
   */
  private sendUpdateEvent(channel: string, payload: unknown): void {
    this.mainWindow?.webContents.send(channel, payload)
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.webContents.send(channel, payload)
    }
  }

  /**
   * 发布可用版本并显示用户确认窗口。
   * @param info 已检查的自有版本。
   * @returns 无返回值。
   */
  private showAvailableUpdate(info: PlatformUpdateInfo): void {
    this.notifyAvailableUpdate(info)
    this.createUpdateWindow()
  }

  /**
   * 保存版本并通知搜索栏更新入口。
   * @param info 已检查的自有版本。
   * @returns 无返回值。
   */
  private notifyAvailableUpdate(info: PlatformUpdateInfo): void {
    this.availableUpdateInfo = info
    this.sendUpdateEvent('update-available', info)
  }

  /**
   * 注册更新检查、下载、取消和安装相关的 IPC 处理器。
   * @returns 无返回值。
   */
  private setupIPC(): void {
    ipcMain.handle('updater:check-update', () => this.checkUpdate())
    ipcMain.handle('updater:show-update-window', () => this.showUpdateWindow())
    ipcMain.handle('updater:start-update', (_event, sourceID?: number) =>
      this.startUpdate(sourceID)
    )
    ipcMain.handle('updater:cancel-update', () => this.cancelUpdate())
    ipcMain.handle('updater:open-download-source', (_event, sourceID: number) =>
      this.openDownloadSource(sourceID)
    )
    ipcMain.handle('updater:install-downloaded-update', () => this.installDownloadedUpdate())
    ipcMain.handle('updater:get-download-status', () => this.getDownloadStatus())

    ipcMain.on('updater:quit-and-install', () => void this.installDownloadedUpdate())
    ipcMain.on('updater:minimize-window', () => this.minimizeUpdateWindow())
    ipcMain.on('updater:close-window', () => this.closeUpdateWindow())
    ipcMain.on('updater:window-ready', () => {
      const info = this.availableUpdateInfo ?? this.downloadedUpdateInfo
      if (this.updateWindow && info) {
        this.updateWindow.webContents.send('update-info', {
          ...info,
          downloadStatus: this.getDownloadStatus()
        })
      }
    })
  }

  /**
   * 启用或停止自动检查更新，并将最新开关状态同步给主窗口。
   * @param enabled 是否启用自动检查更新
   * @returns 无返回值
   */
  public setAutoCheck(enabled: boolean): void {
    this.autoCheckEnabled = enabled
    this.sendUpdateEvent('auto-check-update-changed', enabled)
    if (!enabled) {
      if (this.autoCheckTimer) clearInterval(this.autoCheckTimer)
      this.autoCheckTimer = null
      return
    }
    // 源码运行及 E2E 不启动后台联网；用户仍可主动检查，但不能安装。
    if (!app.isPackaged || process.env.ZTOOLS_E2E === '1' || this.autoCheckTimer) return
    void this.checkAutomatically()
    this.autoCheckTimer = setInterval(() => {
      void this.checkAutomatically()
    }, AUTO_CHECK_INTERVAL_MS)
  }

  /**
   * 通过自有 GitHub 源查询版本，同一版本只自动提示一次。
   * @returns 更新检查处理完成后的 Promise。
   */
  private async checkAutomatically(): Promise<void> {
    if (!this.autoCheckEnabled || this.autoCheckInFlight) return
    this.autoCheckInFlight = true
    try {
      await this.initializationPromise
      if (this.initializationError) return
      const result = await this.platformUpdater?.checkForUpdates(false)
      if (
        !this.autoCheckEnabled ||
        !result?.success ||
        !result.hasUpdate ||
        !result.updateInfo ||
        result.status === 'downloading' ||
        result.status === 'downloaded' ||
        result.status === 'installing' ||
        result.updateInfo.version === this.lastAutoNotifiedVersion
      )
        return
      const info = result.updateInfo
      // 请求期间关闭自动检查后，不再展示提示。
      if (!this.autoCheckEnabled) return
      this.lastAutoNotifiedVersion = info.version
      this.showAvailableUpdate(info)
    } catch (error) {
      console.error('[Updater] 自动检查更新失败:', error)
    } finally {
      this.autoCheckInFlight = false
    }
  }

  /**
   * 汇总平台状态与可用版本，保留下载和安装阶段的真实状态。
   * @returns 窗口可恢复的更新状态。
   */
  private getDownloadStatus(): ReturnType<PlatformUpdaterService['getDownloadStatus']> & {
    hasUpdate: boolean
  } {
    const status = this.platformUpdater?.getDownloadStatus() ?? {
      hasDownloaded: false,
      status: 'idle'
    }
    const info = this.downloadedUpdateInfo ?? this.availableUpdateInfo
    return {
      ...status,
      hasUpdate: Boolean(info),
      version: status.version ?? info?.version,
      changelog: status.changelog ?? info?.changelog,
      status: status.status === 'idle' && info ? 'available' : status.status
    }
  }

  /**
   * 安装已下载的更新，开发环境则显示不支持升级的提示。
   * @returns 安装流程启动结果。
   */
  private async installDownloadedUpdate(): Promise<{
    success: boolean
    migrationRequired?: boolean
    error?: string
  }> {
    // 任何安装入口都不得在未打包运行时替换开发中的应用。
    if (!app.isPackaged) return this.rejectDevelopmentUpdate()

    await this.initializationPromise
    if (this.initializationError) return { success: false, error: this.initializationError }
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    return this.platformUpdater.installDownloadedUpdate()
  }

  /**
   * 停止后台更新检查并释放平台更新器。
   * @returns 无返回值。
   */
  public cleanup(): void {
    this.autoCheckEnabled = false
    if (this.autoCheckTimer) clearInterval(this.autoCheckTimer)
    this.autoCheckTimer = null
    this.platformUpdater?.cleanup()
  }

  /**
   * 从平台更新器读取自有 GitHub 版本并展示可用更新。
   * @returns 包含版本、下载来源或错误的检查结果。
   */
  public async checkUpdate(): Promise<
    Awaited<ReturnType<PlatformUpdaterService['checkForUpdates']>>
  > {
    try {
      await this.initializationPromise
      if (this.initializationError) {
        return {
          success: false,
          status: 'error',
          hasUpdate: false,
          error: this.initializationError
        }
      }
      if (!this.platformUpdater)
        return { success: false, hasUpdate: false, error: '更新器尚未初始化' }
      const result = await this.platformUpdater.checkForUpdates(false)
      if (result.success && result.hasUpdate && result.updateInfo) {
        this.showAvailableUpdate(result.updateInfo)
      } else if (result.success && !this.platformUpdater.getDownloadStatus().hasDownloaded) {
        this.availableUpdateInfo = null
      }
      return result
    } catch (error) {
      return {
        success: false,
        status: 'error',
        hasUpdate: false,
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  /**
   * 使用检查结果中的 GitHub 来源执行更新。
   * @param sourceID 用户在更新窗口中选择的下载源标识；未提供时沿用默认渠道。
   * @returns 更新流程启动结果。
   */
  public async startUpdate(sourceID?: number): Promise<{
    success: boolean
    cancelled?: boolean
    migrationRequired?: boolean
    error?: string
  }> {
    const updateInfo = this.availableUpdateInfo ?? this.downloadedUpdateInfo
    if (!updateInfo) return { success: false, error: '没有可用的更新' }

    // 渠道只来自固定的自有更新器，不能由 IPC 调用方提供地址。
    const selectedSource =
      typeof sourceID === 'number'
        ? updateInfo.sources?.find((source) => source.id === sourceID)
        : undefined
    if (typeof sourceID === 'number' && !selectedSource) {
      return { success: false, error: '下载渠道不存在' }
    }
    if (selectedSource && !isInAppUpdateSource(selectedSource)) {
      return this.openDownloadSource(selectedSource.id)
    }
    if (!selectedSource && updateInfo.manualDownloadRequired) {
      if (updateInfo.releaseUrl) {
        await shell.openExternal(updateInfo.releaseUrl)
        return { success: true }
      }
      const manualSource = updateInfo.sources?.find((source) => !isInAppUpdateSource(source))
      if (!manualSource) return { success: false, error: '没有可用的手动下载地址' }
      return this.openDownloadSource(manualSource.id)
    }

    // 应用内下载安装必须依赖打包产物和已经初始化的平台更新器。
    if (!app.isPackaged) return this.rejectDevelopmentUpdate()
    await this.initializationPromise
    if (this.initializationError) return { success: false, error: this.initializationError }
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    const selectedUpdateInfo = selectedSource
      ? {
          ...updateInfo,
          downloadUrl: selectedSource.downloadUrl,
          feedUrl: selectedSource.feedUrl,
          manualDownloadRequired: false
        }
      : updateInfo
    return this.platformUpdater.startUpdate(selectedUpdateInfo)
  }

  /**
   * 取消平台更新器当前正在执行的下载。
   * @returns 取消请求处理结果。
   */
  public async cancelUpdate(): Promise<{
    success: boolean
    cancelled?: boolean
    error?: string
  }> {
    await this.initializationPromise
    if (this.initializationError) return { success: false, error: this.initializationError }
    if (!this.platformUpdater) return { success: false, error: '更新器尚未初始化' }
    return this.platformUpdater.cancelUpdate()
  }

  /**
   * 使用系统浏览器打开当前版本中已由服务端登记的下载源。
   * @param sourceID 下载接口返回的下载源标识。
   * @returns 浏览器是否成功打开对应 HTTPS 地址。
   */
  private async openDownloadSource(
    sourceID: number
  ): Promise<{ success: boolean; error?: string }> {
    const info = this.availableUpdateInfo ?? this.downloadedUpdateInfo
    const source = info?.sources?.find((item) => item.id === sourceID)
    if (!source) return { success: false, error: '下载地址不存在' }
    try {
      const target = new URL(source.downloadUrl)
      if (target.protocol !== 'https:') return { success: false, error: '下载地址不安全' }
      await shell.openExternal(target.toString())
      return { success: true }
    } catch {
      return { success: false, error: '无法打开下载地址' }
    }
  }

  /**
   * 显示开发环境不支持升级的原生提示并返回失败结果。
   * @returns 固定的开发环境升级失败结果。
   */
  private async rejectDevelopmentUpdate(): Promise<{ success: false; error: string }> {
    const error = '开发环境不支持升级'
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'CAI.Tools',
      message: error,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true
    }
    const parentWindow =
      this.updateWindow && !this.updateWindow.isDestroyed() ? this.updateWindow : this.mainWindow

    // 优先绑定更新窗口，避免原生对话框被其他窗口遮挡。
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, options)
    } else {
      await dialog.showMessageBox(options)
    }

    return { success: false, error }
  }

  /**
   * 重新显示已检查或下载的更新窗口。
   * @returns 窗口显示结果。
   */
  private showUpdateWindow(): { success: boolean; error?: string } {
    if (!this.availableUpdateInfo && !this.downloadedUpdateInfo) {
      return { success: false, error: '没有可用的更新' }
    }
    this.createUpdateWindow()
    return { success: true }
  }

  /**
   * 将当前本机材质设置应用到更新窗口。
   * @param win 更新窗口。
   * @returns 无返回值。
   */
  private applyMaterialToUpdateWindow(win: BrowserWindow): void {
    try {
      const settings = databaseAPI.dbGet('settings-general')
      const material = settings?.windowMaterial || getDefaultWindowMaterial()
      applyWindowMaterial(win, material)
    } catch (error) {
      console.error('[Updater] 应用窗口材质失败:', error)
    }
  }

  /**
   * 使用系统默认浏览器打开更新日志中的 HTTP(S) 链接。
   * @param url 更新日志请求打开的链接。
   * @returns 无返回值。
   */
  private openExternalUpdateLink(url: string): void {
    try {
      const target = new URL(url)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return

      // 外部打开失败不应影响更新窗口本身，记录错误供诊断即可。
      void shell.openExternal(target.toString()).catch((error) => {
        console.error('[Updater] 使用默认浏览器打开更新日志链接失败:', error)
      })
    } catch {
      console.warn('[Updater] 忽略无效的更新日志链接:', url)
    }
  }

  /**
   * 阻止更新日志链接接管更新窗口，并将可信的网页链接交给系统浏览器。
   * @param webContents 更新窗口的 WebContents。
   * @returns 无返回值。
   */
  private registerExternalLinkInterceptor(webContents: WebContents): void {
    webContents.on('will-navigate', (event, url) => {
      // 更新窗口只承载本地界面，任何页面导航都不得替换当前更新流程。
      event.preventDefault()
      this.openExternalUpdateLink(url)
    })

    webContents.setWindowOpenHandler(({ url }) => {
      // 新窗口链接同样统一交给系统浏览器，且不创建额外 Electron 窗口。
      this.openExternalUpdateLink(url)
      return { action: 'deny' }
    })
  }

  /**
   * 创建并加载居中的更新窗口，已有窗口则直接显示并聚焦。
   * @returns 无返回值。
   */
  private createUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.show()
      this.updateWindow.focus()
      return
    }

    const width = 500
    const height = 450
    const { workArea } = screen.getPrimaryDisplay()
    const windowConfig: Electron.BrowserWindowConstructorOptions = {
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      hasShadow: true,
      type: 'panel',
      webPreferences: {
        preload: getPreloadPath(),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    }

    if (process.platform === 'darwin') {
      windowConfig.transparent = true
      windowConfig.vibrancy = 'fullscreen-ui'
    } else if (process.platform === 'win32') {
      windowConfig.backgroundColor = '#00000000'
    }

    this.updateWindow = new BrowserWindow(windowConfig)
    this.registerExternalLinkInterceptor(this.updateWindow.webContents)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void this.updateWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/updater.html`)
    } else {
      void this.updateWindow.loadFile(getRendererPath('updater.html'))
    }

    if (process.platform === 'win32') this.applyMaterialToUpdateWindow(this.updateWindow)
    this.updateWindow.once('ready-to-show', () => this.updateWindow?.show())
    this.updateWindow.on('closed', () => {
      this.updateWindow = null
    })
  }

  /**
   * 关闭提示窗口，保留后台下载状态。
   * @returns 无返回值。
   */
  private closeUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) this.updateWindow.close()
  }

  /**
   * 最小化当前更新窗口，让更新流程在后台继续运行。
   * @returns 无返回值。
   */
  private minimizeUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) this.updateWindow.minimize()
  }
}

export default new UpdaterAPI()
