import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'fs'
import path from 'path'
import databaseAPI from '../api/shared/database'
import windowManager from '../managers/windowManager'
import { getPreloadPath, getRendererPath } from '../utils/appBundlePath'
import { clampPetBounds } from './desktopPet/windowGeometry'
import { RunnerGameManager } from './desktopPet/runnerGameManager'
import {
  normalizeDesktopPetConfig,
  type DesktopPetConfig,
  type PetIntent,
  type PetSnapshot
} from '../../shared/desktopPetTypes'

type PetEvent = IpcMainEvent | IpcMainInvokeEvent

/** 管理球与宠物共用的浮窗、受控交互和设备配置。 */
class FloatingBallManager {
  private ballWindow: BrowserWindow | null = null
  private enabled = false
  private letter = 'Z'
  private doubleClickCommand = ''
  private config = normalizeDesktopPetConfig(null)
  private error: string | null = null
  private initialized = false
  private dragging: { x: number; y: number } | null = null
  private menuOpen = false
  private pressed = false
  private fileHover = false
  private masks: Uint8Array[] = []
  private frame = 0
  private lastGaze = ''
  private ignoring = false
  private poll: ReturnType<typeof setTimeout> | undefined
  private deliveries = new Set<ReturnType<typeof setTimeout>>()
  private authorizeSettings: ((event: PetEvent) => boolean) | null = null
  private quitting = false
  private runner = new RunnerGameManager({
    /**
     * 游戏准备完成后释放宠物手势并临时隐藏，不保存开关。
     * @returns 无返回值。
     */
    hide: () => {
      this.dragging = null
      this.pressed = this.fileHover = false
      for (const timer of this.deliveries) clearTimeout(timer)
      this.deliveries.clear()
      this.ballWindow?.hide()
    },
    /**
     * 按最新设置恢复桌宠，应用退出时不再显示。
     * @returns 无返回值。
     */
    restore: () => {
      if (!this.enabled || this.quitting) return
      this.fitWindow()
      this.ballWindow?.showInactive()
    },
    /**
     * 提示游戏失败，保留宠物素材状态以便重试。
     * @param message 可读错误说明。
     * @returns 无返回值。
     */
    failed: (message) => {
      if (!this.quitting)
        void dialog.showMessageBox({ type: 'info', title: '小薄荷 · 桌面快跑', message })
    }
  })

  /**
   * 注入设置授权检查，未注册时默认拒绝。
   * @param authorize 主窗口及已授权插件检查。
   * @returns 无返回值。
   */
  public setSettingsAuthorizer(authorize: (event: PetEvent) => boolean): void {
    this.authorizeSettings = authorize
  }

  /**
   * 注册浮窗通道并加载设备配置，不重复订阅。
   * @returns 初始化完成的 Promise。
   */
  public async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.setupIPC()
    const data = databaseAPI.dbGet('settings-general') || {}
    this.enabled = data.floatingBallEnabled === true
    this.letter =
      typeof data.floatingBallLetter === 'string' ? data.floatingBallLetter.slice(0, 8) : 'Z'
    this.doubleClickCommand =
      typeof data.floatingBallDoubleClickCommand === 'string'
        ? data.floatingBallDoubleClickCommand
        : ''
    this.config = normalizeDesktopPetConfig(data.desktopPet)
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
    if (this.enabled) this.createBallWindow()
  }

  /**
   * 验证当前浮窗主 frame。
   * @param event IPC 事件。
   * @returns 是否可信。
   */
  private isPet(event: PetEvent): boolean {
    return (
      !!this.ballWindow &&
      event.sender === this.ballWindow.webContents &&
      event.senderFrame === event.sender.mainFrame
    )
  }

  /**
   * 验证设置入口来源。
   * @param event IPC 事件。
   * @returns 无返回值。
   * @throws 未授权调用时抛错。
   */
  private requireSettings(event: PetEvent): void {
    if (event.senderFrame !== event.sender.mainFrame || !this.authorizeSettings?.(event))
      throw new Error('浮窗设置调用未授权')
  }

  /**
   * 注册页面专用通道和兼容设置入口。
   * @returns 无返回值。
   */
  private setupIPC(): void {
    ipcMain.handle(
      'desktop-pet:ready',
      /**
       * 处理 desktop-pet:ready 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 当前操作的处理结果。
       * @throws 调用身份不满足时拒绝请求。
       */
      (event) => {
        if (!this.isPet(event)) throw new Error('浮窗调用未授权')
        this.lastGaze = ''
        return this.getSnapshot()
      }
    )
    ipcMain.on(
      'desktop-pet:intent',
      /**
       * 处理 desktop-pet:intent 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param intent 当前回调输入。
       * @returns 无返回值。
       */
      (event, intent: PetIntent) => {
        if (this.isPet(event)) this.handleIntent(intent)
      }
    )
    ipcMain.on(
      'desktop-pet:masks',
      /**
       * 处理 desktop-pet:masks 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param data 当前回调输入。
       * @returns 无返回值。
       */
      (event, data) => {
        if (
          !this.isPet(event) ||
          !data ||
          data.width !== 48 ||
          data.height !== 64 ||
          !Array.isArray(data.masks) ||
          data.masks.length < 1 ||
          data.masks.length > 128 ||
          data.masks.some(
            /**
             * 判断当前元素是否触及输入校验边界。
             * @param mask 当前回调输入。
             * @returns 是否满足检查条件。
             */
            (mask: unknown) => !(mask instanceof Uint8Array) || mask.length !== 3072
          )
        )
          return
        this.masks = data.masks
      }
    )
    ipcMain.on(
      'desktop-pet:drop',
      /**
       * 处理 desktop-pet:drop 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param paths 当前回调输入。
       * @returns 无返回值。
       */
      (event, paths: unknown) => {
        if (this.isPet(event)) void this.handleFileDrop(paths)
      }
    )
    ipcMain.handle(
      'floating-ball:set-enabled',
      /**
       * 处理 floating-ball:set-enabled 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param enabled 当前回调输入。
       * @returns 当前操作的处理结果。
       * @throws 调用身份不满足时拒绝请求。
       */
      (event, enabled: unknown) => {
        this.requireSettings(event)
        if (typeof enabled !== 'boolean') throw new Error('开关无效')
        return this.setEnabled(enabled)
      }
    )
    ipcMain.handle(
      'floating-ball:get-enabled',
      /**
       * 处理 floating-ball:get-enabled 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 当前操作的处理结果。
       */
      (event) => {
        this.requireSettings(event)
        return this.enabled
      }
    )
    ipcMain.handle(
      'floating-ball:set-letter',
      /**
       * 处理 floating-ball:set-letter 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param letter 当前回调输入。
       * @returns 当前操作的处理结果。
       */
      (event, letter: string) => {
        this.requireSettings(event)
        return this.setLetter(letter)
      }
    )
    ipcMain.handle(
      'floating-ball:get-letter',
      /**
       * 处理 floating-ball:get-letter 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 当前操作的处理结果。
       */
      (event) => {
        this.requireSettings(event)
        return this.letter
      }
    )
    ipcMain.handle(
      'floating-ball:set-double-click-command',
      /**
       * 处理 floating-ball:set-double-click-command 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @param command 当前回调输入。
       * @returns 当前操作的处理结果。
       */
      (event, command: string) => {
        this.requireSettings(event)
        return this.setDoubleClickCommand(command)
      }
    )
    ipcMain.handle(
      'floating-ball:get-double-click-command',
      /**
       * 处理 floating-ball:get-double-click-command 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 当前操作的处理结果。
       */
      (event) => {
        this.requireSettings(event)
        return this.doubleClickCommand
      }
    )
  }

  /**
   * 执行白名单交互，先校验坐标与帧号。
   * @param intent 页面交互意图。
   * @returns 无返回值。
   */
  private handleIntent(intent: PetIntent): void {
    if (!intent || typeof intent !== 'object' || !this.ballWindow) return
    switch (intent.type) {
      case 'press':
        this.pressed = intent.active === true
        if (this.pressed) this.setIgnoring(false)
        break
      case 'fileHover':
        this.fileHover = intent.active === true
        if (this.fileHover) this.setIgnoring(false)
        break
      case 'click':
        this.handleBallClick()
        break
      case 'doubleClick':
        this.handleBallDoubleClick()
        break
      case 'contextMenu':
        this.showContextMenu()
        break
      case 'dragStart': {
        if (!Number.isFinite(intent.x) || !Number.isFinite(intent.y)) return
        const bounds = this.ballWindow.getBounds()
        this.dragging = { x: intent.x - bounds.x, y: intent.y - bounds.y }
        this.setIgnoring(false)
        break
      }
      case 'dragEnd':
        this.pressed = false
        this.dragging = null
        this.fitWindow()
        this.savePosition()
        break
      case 'frame':
        if (Number.isInteger(intent.index) && intent.index >= 0 && intent.index < this.masks.length)
          this.frame = intent.index
        break
      case 'failure':
        this.error =
          typeof intent.message === 'string' ? intent.message.slice(0, 240) : '宠物加载失败'
        this.dragging = null
        this.resizeWindow()
        this.publish()
        break
    }
  }

  /**
   * 返回设置及运行时降级原因。
   * @returns 可序列化快照。
   */
  public getSnapshot(): PetSnapshot {
    return { config: { ...this.config }, letter: this.letter, error: this.error }
  }

  /**
   * 合并设备设置，数据库返回错误时不更新运行态。
   * @param patch 待合并字段。
   * @returns 无返回值。
   * @throws 写入失败时抛错。
   */
  private persist(patch: Record<string, unknown>): void {
    const data = databaseAPI.dbGet('settings-general') || {}
    const result = databaseAPI.dbPut('settings-general', { ...data, ...patch })
    if (!result?.ok) throw new Error(result?.message || '浮窗设置保存失败')
  }

  /**
   * 保存宠物设置，重新选择时允许重试素材加载。
   * @param value 设置页配置。
   * @returns 最新快照。
   * @throws 参数或持久化无效时抛错。
   */
  public setPetConfig(value: unknown): PetSnapshot {
    const data = value as DesktopPetConfig
    if (
      !data ||
      !['ball', 'pet'].includes(data.mode) ||
      !['small', 'medium', 'large'].includes(data.size) ||
      typeof data.paused !== 'boolean' ||
      data.version !== 1 ||
      data.petId !== 'builtin-default' ||
      data.lookEnabled !== false
    )
      throw new Error('宠物配置无效')
    const next = normalizeDesktopPetConfig(data)
    const geometryChanged =
      this.config.mode !== next.mode || this.config.size !== next.size || this.error !== null
    this.persist({ desktopPet: next })
    this.config = next
    this.error = null
    if (geometryChanged) {
      this.dragging = null
      this.resizeWindow()
    }
    this.publish()
    return this.getSnapshot()
  }

  /**
   * 向页面发布配置。
   * @returns 无返回值。
   */
  private publish(): void {
    this.ballWindow?.webContents.send('desktop-pet:snapshot', this.getSnapshot())
  }

  /**
   * 计算有效模式尺寸，错误时恢复球入口。
   * @returns DIP 尺寸。
   */
  private windowSize(): { width: number; height: number } {
    if (this.config.mode === 'ball' || this.error) return { width: 48, height: 48 }
    const width = { small: 96, medium: 144, large: 192 }[this.config.size]
    return { width, height: Math.round((width * 4) / 3) }
  }

  /**
   * 创建隔离浮窗并恢复屏幕内位置。
   * @returns 无返回值。
   */
  private createBallWindow(): void {
    // 重复启用设置不能让游戏中的宠物重新出现。
    if (this.runner.isActive()) return
    if (this.ballWindow) {
      this.ballWindow.showInactive()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const saved = databaseAPI.dbGet('settings-general')?.floatingBallPosition
    const size = this.windowSize()
    const bounds = {
      ...size,
      x: area.x + area.width - size.width - 30,
      y: area.y + Math.floor(area.height / 2)
    }
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
      bounds.x = saved.x
      bounds.y = saved.y
    }
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      type: 'panel',
      webPreferences: {
        preload: getPreloadPath('desktop-pet.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.ballWindow = win
    this.ignoring = false
    this.fitWindow()
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    win.webContents.setWindowOpenHandler(
      /**
       * 处理当前回调并同步桌面入口状态。
       * @returns 当前表达式的计算结果。
       */
      () => ({ action: 'deny' })
    )
    win.webContents.on(
      'will-navigate',
      /**
       * 处理 will-navigate 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 当前表达式的计算结果。
       */
      (event) => event.preventDefault()
    )
    win.once(
      'ready-to-show',
      /**
       * 处理 ready-to-show 事件，维护对应的窗口或页面状态。
       * @returns 当前表达式的计算结果。
       */
      () => {
        if (!this.runner.isActive() && !this.quitting) win.showInactive()
      }
    )
    win.on(
      'hide',
      /**
       * 处理 hide 事件，维护对应的窗口或页面状态。
       * @returns 无返回值。
       */
      () => {
        clearTimeout(this.poll)
        this.dragging = null
      }
    )
    win.on(
      'show',
      /**
       * 处理 show 事件，维护对应的窗口或页面状态。
       * @returns 当前表达式的计算结果。
       */
      () => this.sampleCursor()
    )
    win.on(
      'close',
      /**
       * 处理 close 事件，维护对应的窗口或页面状态。
       * @param event 当前事件及其调用上下文。
       * @returns 无返回值。
       */
      (event) => {
        if (this.enabled) event.preventDefault()
      }
    )
    // 页面主动请求快照，避免 did-finish-load 之前的配置消息丢失。
    const loading =
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/desktop-pet.html`)
        : win.loadFile(getRendererPath('desktop-pet.html'))
    void loading.catch(
      /**
       * 处理异步失败并记录可恢复的错误状态。
       * @param error 当前回调输入。
       * @returns 无返回值。
       */
      (error) => {
        console.error('[DesktopPet] 页面加载失败', error)
        this.error = '浮窗页面加载失败，请重启应用'
      }
    )
  }

  /**
   * 调整尺寸后夹取位置并恢复点击。
   * @returns 无返回值。
   */
  private resizeWindow(): void {
    if (!this.ballWindow) return
    this.ballWindow.setBounds({ ...this.ballWindow.getBounds(), ...this.windowSize() })
    this.fitWindow()
    this.setIgnoring(false)
  }

  /**
   * 屏幕变化后恢复可操作位置。
   * @returns 无返回值。
   */
  private onDisplaysChanged = (): void => {
    this.fitWindow()
    this.savePosition()
  }

  /**
   * 用当前工作区夹取窗口。
   * @returns 无返回值。
   */
  private fitWindow(): void {
    if (!this.ballWindow) return
    const primary = screen.getPrimaryDisplay()
    const areas = [
      primary,
      ...screen.getAllDisplays().filter(
        /**
         * 筛选需要处理的显示器。
         * @param display 当前回调输入。
         * @returns 是否保留当前元素。
         */
        (display) => display.id !== primary.id
      )
    ].map(
      /**
       * 转换当前元素，构造后续处理需要的数据。
       * @param display 当前回调输入。
       * @returns 转换后的元素。
       */
      (display) => display.workArea
    )
    this.ballWindow.setBounds(clampPetBounds(this.ballWindow.getBounds(), areas), false)
  }

  /**
   * 仅在命中改变时调用鼠标穿透接口。
   * @param ignore 是否穿透。
   * @returns 无返回值。
   */
  private setIgnoring(ignore: boolean): void {
    if (!this.ballWindow || ignore === this.ignoring) return
    this.ignoring = ignore
    this.ballWindow.setIgnoreMouseEvents(ignore, { forward: true })
  }

  /**
   * 用系统光标更新拖动、视线及透明区域命中；拖动保持配置尺寸，远离时降低频率。
   * @returns 无返回值。
   */
  private sampleCursor = (): void => {
    clearTimeout(this.poll)
    const win = this.ballWindow
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    if (this.dragging) {
      const current = win.getBounds()
      const target = {
        x: Math.round(cursor.x - this.dragging.x),
        y: Math.round(cursor.y - this.dragging.y),
        ...this.windowSize()
      }
      // 不继承原生移窗后的尺寸偏差；光标停止时避免重复提交窗口布局。
      if (
        current.x !== target.x ||
        current.y !== target.y ||
        current.width !== target.width ||
        current.height !== target.height
      )
        win.setBounds(target, false)
    }
    const bounds = win.getBounds()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    // 复用命中采样，仅发送变化的相对方向；暂停时停止眼睛跟随。
    if (this.config.mode === 'pet' && !this.error && !this.config.paused) {
      const dx = (x - bounds.width * (104 / 192)) / (bounds.width * 1.5)
      const dy = (y - bounds.height * (157 / 256)) / (bounds.height * 1.5)
      const length = Math.max(1, Math.hypot(dx, dy))
      const gaze = {
        x: Math.round((dx / length) * 20) / 20,
        y: Math.round((dy / length) * 20) / 20
      }
      const key = `${gaze.x},${gaze.y}`
      if (key !== this.lastGaze) {
        this.lastGaze = key
        win.webContents.send('desktop-pet:gaze', gaze)
      }
    } else this.lastGaze = ''
    const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height
    if (!inside) this.fileHover = false
    let hit = inside
    if (inside && this.config.mode === 'pet' && !this.error && this.masks[this.frame]) {
      hit = false
      const mx = Math.floor((x * 48) / bounds.width)
      const my = Math.floor((y * 64) / bounds.height)
      const radius = Math.max(1, Math.ceil((2 * 48) / bounds.width))
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (
            mx + dx >= 0 &&
            mx + dx < 48 &&
            my + dy >= 0 &&
            my + dy < 64 &&
            this.masks[this.frame][(my + dy) * 48 + mx + dx] > 0
          ) {
            hit = true
            break
          }
        }
      }
    }
    // 按下与系统拖放悬停期间固定命中，避免动画轮廓变化打断手势。
    this.setIgnoring(!(hit || this.dragging || this.menuOpen || this.pressed || this.fileHover))
    const near = x > -64 && y > -64 && x < bounds.width + 64 && y < bounds.height + 64
    this.poll = setTimeout(this.sampleCursor, near ? 16 : 33)
  }

  /**
   * 切换主窗口可见性。
   * @returns 无返回值。
   */
  private handleBallClick(): void {
    const win = windowManager.getMainWindow()
    if (!win) return
    if (win.isVisible()) windowManager.hideWindow(false)
    else windowManager.showWindow()
  }

  /**
   * 跟踪延迟交付，关闭浮窗时可统一取消。
   * @param callback 交付操作。
   * @param delay 等待主窗口焦点处理的毫秒数。
   * @returns 无返回值。
   */
  private deliver(callback: () => void, delay: number): void {
    const timer = setTimeout(
      /**
       * 完成延迟操作并清理对应计时状态。
       * @returns 无返回值。
       */
      () => {
        this.deliveries.delete(timer)
        callback()
      },
      delay
    )
    this.deliveries.add(timer)
  }

  /**
   * 执行双击目标，未配置时只切换一次。
   * @returns 无返回值。
   */
  private handleBallDoubleClick(): void {
    if (!this.doubleClickCommand) {
      this.handleBallClick()
      return
    }
    const command = this.doubleClickCommand
    windowManager.showWindow()
    this.deliver(
      /**
       * 处理当前回调并同步桌面入口状态。
       * @returns 当前表达式的计算结果。
       */
      () =>
        windowManager
          .getMainWindow()
          ?.webContents.send('floating-ball-double-click-command', command),
      100
    )
  }

  /**
   * 验证系统文件路径后交付主窗口。
   * @param value 从真实 File 对象取得的路径列表。
   * @returns 交付安排完成的 Promise。
   */
  private async handleFileDrop(value: unknown): Promise<void> {
    if (!Array.isArray(value) || value.length > 100) return
    const source = this.ballWindow
    const files: Array<{ path: string; name: string; isDirectory: boolean }> = []
    for (const item of value) {
      if (typeof item !== 'string' || !path.isAbsolute(item)) continue
      try {
        const stat = await fs.stat(item)
        files.push({ path: item, name: path.basename(item), isDirectory: stat.isDirectory() })
      } catch {
        /* 拖放期间已删除的文件不再交付。 */
      }
    }
    if (!files.length || source !== this.ballWindow || !this.enabled) return
    windowManager.showWindow()
    this.deliver(
      /**
       * 处理当前回调并同步桌面入口状态。
       * @returns 当前表达式的计算结果。
       */
      () => windowManager.getMainWindow()?.webContents.send('floating-ball-files', files),
      500
    )
  }

  /**
   * 保存位置，失败时保留可用窗口并记录原因。
   * @returns 无返回值。
   */
  private savePosition(): void {
    if (!this.ballWindow) return
    const { x, y } = this.ballWindow.getBounds()
    try {
      this.persist({ floatingBallPosition: { x, y } })
    } catch (error) {
      console.error('[DesktopPet] 位置保存失败', error)
    }
  }

  /**
   * 显示桌宠操作与游戏入口，菜单期间保持鼠标事件。
   * @returns 无返回值。
   */
  private showContextMenu(): void {
    if (!this.ballWindow) return
    this.dragging = null
    this.menuOpen = true
    this.setIgnoring(false)
    const menu = Menu.buildFromTemplate([
      {
        label: '开始桌面快跑',
        enabled: this.config.mode === 'pet' && !this.error,
        /**
         * 从当前宠物所在屏幕进入快跑。
         * @returns 无返回值。
         */
        click: () => this.startRunner()
      },
      { type: 'separator' },
      {
        label: '显示/隐藏 CAI.Tools',
        /**
         * 处理当前回调并同步桌面入口状态。
         * @returns 当前表达式的计算结果。
         */
        click: () => this.handleBallClick()
      },
      { type: 'separator' },
      {
        label: '隐藏桌面入口',
        /**
         * 处理当前回调并同步桌面入口状态。
         * @returns 无返回值。
         */
        click: () => {
          void this.setEnabled(false).catch(console.error)
        }
      }
    ])
    menu.popup({
      window: this.ballWindow,
      /**
       * 处理当前回调并同步桌面入口状态。
       * @returns 无返回值。
       */
      callback: () => {
        this.menuOpen = false
      }
    })
  }

  /**
   * 保存开关后创建或销毁浮窗，关闭时同时结束游戏。
   * @param enabled 是否启用。
   * @returns 成功结果 Promise。
   * @throws 数据库写入失败时抛错。
   */
  public async setEnabled(enabled: boolean): Promise<{ success: boolean }> {
    this.persist({ floatingBallEnabled: enabled })
    this.enabled = enabled
    if (enabled) this.createBallWindow()
    else {
      // 先关闭开关再结束游戏，阻止恢复回调重新显示宠物。
      this.runner.close()
      this.destroyBallWindow()
    }
    return { success: true }
  }

  /**
   * 保存球文字并同步页面。
   * @param letter 显示文字。
   * @returns 成功结果。
   * @throws 参数或持久化无效时抛错。
   */
  public setLetter(letter: string): { success: boolean } {
    if (typeof letter !== 'string' || letter.length > 8) throw new Error('悬浮球文字无效')
    this.persist({ floatingBallLetter: letter || 'Z' })
    this.letter = letter || 'Z'
    this.publish()
    return { success: true }
  }

  /**
   * 保存已有双击目标。
   * @param command 指令文本。
   * @returns 成功结果。
   * @throws 参数或持久化无效时抛错。
   */
  public setDoubleClickCommand(command: string): { success: boolean } {
    if (typeof command !== 'string' || command.length > 1000) throw new Error('双击指令无效')
    this.persist({ floatingBallDoubleClickCommand: command })
    this.doubleClickCommand = command
    return { success: true }
  }

  /**
   * 释放窗口、采样和延迟操作。
   * @returns 无返回值。
   */
  private destroyBallWindow(): void {
    clearTimeout(this.poll)
    for (const timer of this.deliveries) clearTimeout(timer)
    this.deliveries.clear()
    this.dragging = null
    this.menuOpen = false
    this.pressed = false
    this.fileHover = false
    this.masks = []
    this.frame = 0
    this.ballWindow?.destroy()
    this.ballWindow = null
  }

  /**
   * 查询启用状态。
   * @returns 当前开关。
   */
  public isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 退出时释放游戏、宠物窗口和屏幕监听，不再恢复桌宠。
   * @returns 无返回值。
   */
  public cleanup(): void {
    this.quitting = true
    this.runner.close()
    this.destroyBallWindow()
    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
  }

  /**
   * 从有效桌宠启动单例游戏，不改变持久化偏好。
   * @returns 无返回值。
   */
  private startRunner(): void {
    if (
      !this.enabled ||
      this.quitting ||
      !this.ballWindow ||
      this.error ||
      this.config.mode !== 'pet'
    )
      return
    this.runner.open(this.ballWindow.getBounds())
  }
}
export default new FloatingBallManager()
