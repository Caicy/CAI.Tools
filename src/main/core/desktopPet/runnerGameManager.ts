import {
  BrowserWindow,
  ipcMain,
  powerMonitor,
  screen,
  type IpcMainInvokeEvent,
  type IpcMainEvent
} from 'electron'
import { is } from '@electron-toolkit/utils'
import databaseAPI from '../../api/shared/database'
import { getPreloadPath, getRendererPath } from '../../utils/appBundlePath'
import { HOST_STORAGE_KEYS } from '../../../shared/storageKeys'
import {
  MAX_RUNNER_DISTANCE,
  readRunnerRecord,
  type RunnerSaveResult
} from '../../../shared/desktopPetRunnerTypes'
import { runnerBounds } from './runnerGeometry'

interface RunnerHost {
  hide(): void
  restore(): void
  failed(message: string): void
}

/** 按需持有单个游戏窗口；所有退出路径汇入同一清理流程。 */
export class RunnerGameManager {
  private window: BrowserWindow | null = null
  private ready = false
  private timeout: ReturnType<typeof setTimeout> | undefined

  /**
   * 注入桌宠生命周期，不让游戏模块依赖桌宠单例。
   * @param host 隐藏、恢复与失败提示回调。
   * @returns 窗口管理实例。
   */
  constructor(private readonly host: RunnerHost) {}

  /**
   * 查询游戏是否正在加载或显示。
   * @returns 是否存在游戏会话。
   */
  public isActive(): boolean {
    return this.window !== null
  }

  /**
   * 从宠物所在显示器打开游戏；重复请求仅激活当前窗口。
   * @param petBounds 宠物当前边界。
   * @returns 无返回值。
   */
  public open(petBounds: Electron.Rectangle): void {
    if (this.window) {
      if (this.ready) {
        this.window.show()
        this.window.focus()
      }
      return
    }
    try {
      const bounds = runnerBounds(screen.getDisplayMatching(petBounds).workArea)
      const win = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        focusable: true,
        alwaysOnTop: true,
        backgroundColor: '#172b29',
        title: '小薄荷 · 桌面快跑',
        webPreferences: {
          preload: getPreloadPath('desktop-pet-runner.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      this.window = win
      this.registerIPC()
      win.on('closed', this.onClosed)
      win.on('blur', this.pause)
      win.webContents.on(
        'render-process-gone',
        /**
         * 仅回滚发生崩溃的当前会话。
         * @returns 无返回值。
         */
        () => {
          if (this.window === win) this.onFailure()
        }
      )
      win.webContents.setWindowOpenHandler(
        /**
         * 禁止游戏页面派生窗口。
         * @returns 拒绝策略。
         */
        () => ({ action: 'deny' })
      )
      win.webContents.on(
        'will-navigate',
        /**
         * 禁止页面导航离开本地游戏。
         * @param event 导航事件。
         * @returns 无返回值。
         */
        (event) => event.preventDefault()
      )
      screen.on('display-added', this.onDisplaysChanged)
      screen.on('display-removed', this.onDisplaysChanged)
      screen.on('display-metrics-changed', this.onDisplaysChanged)
      powerMonitor.on('suspend', this.pause)
      powerMonitor.on('lock-screen', this.pause)
      this.timeout = setTimeout(this.onFailure, 15_000)
      // 保留原宠物，直到页面完成素材加载并发送 ready。
      const loading =
        is.dev && process.env.ELECTRON_RENDERER_URL
          ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/desktop-pet-runner.html`)
          : win.loadFile(getRendererPath('desktop-pet-runner.html'))
      void loading.catch(
        /**
         * 忽略已经关闭的旧窗口加载结果，避免结束新会话。
         * @returns 无返回值。
         */
        () => {
          if (this.window === win) this.onFailure()
        }
      )
    } catch (error) {
      this.close()
      this.host.failed(error instanceof Error ? error.message : '快跑模式启动失败')
    }
  }

  /**
   * 验证游戏主 frame，拒绝其他窗口调用。
   * @param event IPC 调用事件。
   * @returns 是否来自当前游戏主 frame。
   */
  private authorized(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return (
      !!this.window &&
      event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame
    )
  }

  /**
   * 注册仅当前会话可用的 IPC，退出时成对解除。
   * @returns 无返回值。
   */
  private registerIPC(): void {
    ipcMain.handle(
      'desktop-pet-runner:ready',
      /**
       * 素材就绪后切换窗口并返回设备纪录。
       * @param event 游戏 IPC 事件。
       * @returns 本地最佳纪录。
       * @throws 非游戏页面调用时抛错。
       */
      (event) => {
        if (!this.authorized(event)) throw new Error('快跑调用未授权')
        const record = readRunnerRecord(databaseAPI.dbGet(HOST_STORAGE_KEYS.desktopPetRunner))
        if (!this.ready) {
          this.ready = true
          clearTimeout(this.timeout)
          this.host.hide()
          this.window!.show()
          this.window!.focus()
        }
        return record
      }
    )
    ipcMain.handle(
      'desktop-pet-runner:save',
      /**
       * 保存有效且更高的本地纪录，写入失败不阻塞退出。
       * @param event 游戏 IPC 事件。
       * @param distance 本局距离。
       * @returns 写入状态与最佳纪录。
       * @throws 未授权或距离非法时抛错。
       */
      (event, distance: unknown): RunnerSaveResult => {
        if (!this.authorized(event)) throw new Error('快跑调用未授权')
        if (
          typeof distance !== 'number' ||
          !Number.isFinite(distance) ||
          distance < 0 ||
          distance > MAX_RUNNER_DISTANCE
        )
          throw new Error('快跑距离无效')
        let bestDistance = 0
        try {
          bestDistance = readRunnerRecord(
            databaseAPI.dbGet(HOST_STORAGE_KEYS.desktopPetRunner)
          ).bestDistance
          const next = Math.floor(distance)
          if (next <= bestDistance) return { bestDistance, saved: true }
          const result = databaseAPI.dbPut(HOST_STORAGE_KEYS.desktopPetRunner, {
            version: 1,
            bestDistance: next
          })
          return { bestDistance: result?.ok ? next : bestDistance, saved: result?.ok === true }
        } catch {
          return { bestDistance, saved: false }
        }
      }
    )
    ipcMain.on('desktop-pet-runner:exit', this.onExit)
    ipcMain.on('desktop-pet-runner:failed', this.onPageFailure)
  }

  /**
   * 处理可信页面退出。
   * @param event 游戏事件。
   * @returns 无返回值。
   */
  private onExit = (event: IpcMainEvent): void => {
    if (this.authorized(event)) this.close()
  }

  /**
   * 处理可信页面素材加载失败。
   * @param event 游戏事件。
   * @returns 无返回值。
   */
  private onPageFailure = (event: IpcMainEvent): void => {
    if (this.authorized(event)) this.onFailure()
  }

  /**
   * 向页面发出暂停通知，不自动恢复。
   * @returns 无返回值。
   */
  private pause = (): void => {
    if (this.ready && this.window && !this.window.webContents.isDestroyed())
      this.window.webContents.send('desktop-pet-runner:pause')
  }

  /**
   * 屏幕变动后暂停并重新夹取跑道。
   * @returns 无返回值。
   */
  private onDisplaysChanged = (): void => {
    if (!this.window) return
    this.pause()
    try {
      this.window.setBounds(
        runnerBounds(screen.getDisplayMatching(this.window.getBounds()).workArea)
      )
    } catch {
      this.onFailure()
    }
  }

  /**
   * 回滚加载失败或崩溃，保留可重新进入的桌宠。
   * @returns 无返回值。
   */
  private onFailure = (): void => {
    if (!this.window) return
    this.close()
    this.host.failed('快跑模式加载失败，已返回桌宠；可以重试')
  }

  /**
   * 主动销毁游戏窗口；正常关闭和异常退出共用释放路径。
   * @returns 无返回值。
   */
  public close(): void {
    this.window?.destroy()
  }

  /**
   * 释放会话资源，再由宿主按最新开关恢复桌宠。
   * @returns 无返回值。
   */
  private onClosed = (): void => {
    clearTimeout(this.timeout)
    this.window = null
    this.ready = false
    ipcMain.removeHandler('desktop-pet-runner:ready')
    ipcMain.removeHandler('desktop-pet-runner:save')
    ipcMain.removeListener('desktop-pet-runner:exit', this.onExit)
    ipcMain.removeListener('desktop-pet-runner:failed', this.onPageFailure)
    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
    powerMonitor.removeListener('suspend', this.pause)
    powerMonitor.removeListener('lock-screen', this.pause)
    this.host.restore()
  }
}
