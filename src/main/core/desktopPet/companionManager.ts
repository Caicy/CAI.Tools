import {
  BrowserWindow,
  ipcMain,
  powerMonitor,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { is } from '@electron-toolkit/utils'
import databaseAPI from '../../api/shared/database'
import aiProviderService from '../aiProviderService'
import { createAdapter } from '../../api/plugin/aiProtocol/adapters'
import { streamSingleAiProtocolChat } from '../aiChatTransport'
import { normalizeAiModelCapabilities } from '../../../shared/aiProviderShared'
import { HOST_STORAGE_KEYS } from '../../../shared/storageKeys'
import { getPreloadPath, getRendererPath } from '../../utils/appBundlePath'
import type {
  PetCompanionSnapshot,
  PetInteraction,
  PetUtterance
} from '../../../shared/desktopPetCompanionTypes'
import { CompanionSession, type CompanionTransport } from './companionSession'

/** 提供桌宠专用的受限窗口与 AI 接入，不复用插件授权身份。 */
export class CompanionManager {
  private window: BrowserWindow | null = null
  private initialized = false
  private modelRef = ''
  private reviewsEnabled = false
  private loadTimeout: ReturnType<typeof setTimeout> | undefined
  private readonly session = new CompanionSession(this.publish.bind(this))

  /**
   * 注入原桌宠的受控动作回调。
   * @param react 将台词中的白名单动作转交原桌宠。
   * @returns 互动管理器。
   */
  constructor(private readonly react: (line: PetUtterance) => void) {}

  /**
   * 只接受当前互动窗口主 frame，拒绝其他页面使用此能力。
   * @param event IPC 事件。
   * @returns 无返回值。
   * @throws 非当前互动窗口调用时抛错。
   */
  private authorize(event: IpcMainEvent | IpcMainInvokeEvent): void {
    if (
      !this.window ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('桌宠互动调用未授权')
  }

  /**
   * 延迟加载设备偏好并注册成对释放的受控 IPC。
   * @returns 无返回值。
   */
  private init(): void {
    if (this.initialized) return
    this.initialized = true
    try {
      const data = databaseAPI.dbGet(HOST_STORAGE_KEYS.desktopPetCompanion)
      if (data?.version === 1) {
        this.modelRef =
          typeof data.modelRef === 'string' && data.modelRef.length <= 500 ? data.modelRef : ''
        this.reviewsEnabled = data.reviewsEnabled === true
      }
    } catch {
      this.session.notice = '偏好读取失败，暂用本地陪伴'
    }
    ipcMain.handle(
      'desktop-pet-companion:ready',
      /**
       * 返回不含密钥的快照。
       * @param event IPC 事件。
       * @returns 当前状态。
       * @throws 未授权时抛错。
       */
      (event) => {
        this.authorize(event)
        return this.snapshot()
      }
    )
    ipcMain.handle(
      'desktop-pet-companion:send',
      /**
       * 执行有界聊天，不允许页面提交系统提示或工具。
       * @param event IPC 事件。
       * @param text 用户输入。
       * @returns 生成结束的 Promise。
       * @throws 未授权或输入非法时抛错。
       */
      (event, text: unknown) => {
        this.authorize(event)
        return this.session.send(text, this.transport())
      }
    )
    ipcMain.handle(
      'desktop-pet-companion:interact',
      /**
       * 校验并执行本地轻互动。
       * @param event IPC 事件。
       * @param kind 互动类别。
       * @returns 无返回值。
       * @throws 未授权或类别非法时抛错。
       */
      (event, kind: unknown) => {
        this.authorize(event)
        if (kind !== 'pat' && kind !== 'feed') throw new Error('互动类型无效')
        this.interact(kind)
      }
    )
    ipcMain.handle(
      'desktop-pet-companion:configure',
      /**
       * 保存经模型列表验证的稳定引用和短评开关。
       * @param event IPC 事件。
       * @param value 未信任的配置。
       * @returns 无返回值。
       * @throws 未授权、参数无效或保存失败时抛错。
       */
      (event, value: unknown) => {
        this.authorize(event)
        const data = value as { modelRef?: unknown; reviewsEnabled?: unknown } | null
        if (
          !data ||
          typeof data.modelRef !== 'string' ||
          typeof data.reviewsEnabled !== 'boolean' ||
          (data.modelRef !== '' &&
            !this.snapshot().models.some(
              /**
               * 仅接受当前已启用模型的稳定引用。
               * @param model 模型摘要。
               * @returns 是否精确匹配。
               */
              (model) => model.value === data.modelRef
            ))
        )
          throw new Error('请选择可用的 AI 模型')
        const saved = databaseAPI.dbPut(HOST_STORAGE_KEYS.desktopPetCompanion, {
          version: 1,
          modelRef: data.modelRef,
          reviewsEnabled: data.reviewsEnabled
        })
        if (!saved?.ok) throw new Error('桌宠偏好保存失败')
        this.session.cancel()
        this.modelRef = data.modelRef
        this.reviewsEnabled = data.reviewsEnabled
        this.session.notice = this.modelRef
          ? '使用选定的 AI 模型；对话仅保留在本次应用会话中'
          : '本地陪伴 · 无需联网'
        this.publish()
      }
    )
    ipcMain.handle(
      'desktop-pet-companion:cancel',
      /**
       * 取消当前请求。
       * @param event IPC 事件。
       * @returns 无返回值。
       * @throws 未授权时抛错。
       */
      (event) => {
        this.authorize(event)
        this.session.cancel()
      }
    )
    ipcMain.handle(
      'desktop-pet-companion:clear',
      /**
       * 清空内存会话。
       * @param event IPC 事件。
       * @returns 无返回值。
       * @throws 未授权时抛错。
       */
      (event) => {
        this.authorize(event)
        this.session.clear()
      }
    )
    ipcMain.on('desktop-pet-companion:close', this.onCloseRequest)
    powerMonitor.on('suspend', this.cancel)
    powerMonitor.on('lock-screen', this.cancel)
    screen.on('display-metrics-changed', this.fit)
    screen.on('display-removed', this.fit)
  }

  /**
   * 创建仅绑定当前模型的传输；凭据始终留在主进程。
   * @returns 未选择模型时返回 undefined，否则返回请求函数。
   */
  private transport(): CompanionTransport | undefined {
    if (!this.modelRef) return undefined
    const ref = this.modelRef
    /**
     * 复用现有协议适配器，限制输出、超时和模型能力。
     * @param messages 受控上下文。
     * @param signal 取消信号。
     * @param onText 正文消费者。
     * @returns 完整正文。
     * @throws 配置不可用或供应商失败时抛错。
     */
    return async (messages, signal, onText) => {
      const resolved = aiProviderService.resolveModel(ref)
      if (!resolved || !resolved.provider.apiKey.trim()) throw new Error('模型不可用')
      const capabilities = normalizeAiModelCapabilities(resolved.model)
      const result = await streamSingleAiProtocolChat(
        createAdapter(resolved.provider),
        resolved.model.modelId,
        {
          // 为启用扩展思考的协议保留最低预算，实际呈现仍受台词字数上限约束。
          messages,
          maxTokens: 2048,
          timeout: 30_000,
          modelReasoning: capabilities.reasoning,
          modelTemperature: capabilities.temperature
        },
        signal,
        /**
         * 只传递正文，不向宠物暴露推理内容或工具调用。
         * @param event 协议事件。
         * @returns 无返回值。
         */
        (event) => {
          if (event.type === 'content') onText(event.delta)
        }
      )
      return result.content || ''
    }
  }

  /**
   * 生成无敏感连接信息的页面快照。
   * @returns 独立快照。
   */
  private snapshot(): PetCompanionSnapshot {
    let models: PetCompanionSnapshot['models'] = []
    try {
      models = aiProviderService.getModelChoices().map(
        /**
         * 只投影选择器需要的公开信息。
         * @param model 已启用模型。
         * @returns 安全摘要。
         */
        (model) => ({ value: model.value, label: model.label })
      )
    } catch {
      /* 配置异常时仍可使用本地互动。 */
    }
    return {
      messages: this.session.messages,
      busy: this.session.busy,
      notice: this.session.notice,
      modelRef: this.modelRef,
      reviewsEnabled: this.reviewsEnabled,
      models
    }
  }

  /**
   * 将当前状态发给仍存活的页面。
   * @returns 无返回值。
   */
  private publish(): void {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('desktop-pet-companion:state', this.snapshot())
  }

  /**
   * 在宠物旁打开独立可聚焦面板，重复打开只激活已有窗口。
   * @param anchor 宠物边界。
   * @param interaction 可选的初始互动。
   * @returns 无返回值。
   */
  public open(anchor: Electron.Rectangle, interaction?: PetInteraction): void {
    this.init()
    if (this.window) {
      this.window.show()
      this.window.focus()
      if (interaction) this.interact(interaction)
      this.publish()
      return
    }
    const area = screen.getDisplayMatching(anchor).workArea
    const win = new BrowserWindow({
      width: Math.min(380, area.width),
      height: Math.min(520, area.height),
      x: Math.min(anchor.x + anchor.width + 8, area.x + area.width - 380),
      y: Math.max(area.y, Math.min(anchor.y, area.y + area.height - 520)),
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#f4faf6',
      title: '小薄荷 · 陪你聊聊',
      webPreferences: {
        preload: getPreloadPath('desktop-pet-companion.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.window = win
    this.fit()
    win.webContents.setWindowOpenHandler(
      /**
       * 禁止派生页面。
       * @returns 拒绝策略。
       */
      () => ({ action: 'deny' })
    )
    win.webContents.on(
      'will-navigate',
      /**
       * 固定为本地互动页面。
       * @param event 导航事件。
       * @returns 无返回值。
       */
      (event) => event.preventDefault()
    )
    win.on(
      'closed',
      /**
       * 释放窗口并取消仍运行的请求。
       * @returns 无返回值。
       */
      () => {
        if (this.window === win) {
          this.window = null
          clearTimeout(this.loadTimeout)
          this.session.cancel()
        }
      }
    )
    win.webContents.on('render-process-gone', this.close)
    this.loadTimeout = setTimeout(this.close, 15_000)
    // 面板请求完成前可先进行本地互动，ready 会返回完整状态。
    if (interaction) this.interact(interaction)
    const loading =
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/desktop-pet-companion.html`)
        : win.loadFile(getRendererPath('desktop-pet-companion.html'))
    void loading
      .then(
        /**
         * 仅显示当前仍有效的面板。
         * @returns 无返回值。
         */
        () => {
          if (this.window === win) {
            clearTimeout(this.loadTimeout)
            win.show()
            win.focus()
          }
        }
      )
      .catch(
        /**
         * 加载失败回收窗口，原桌宠仍可继续操作。
         * @returns 无返回值。
         */
        () => {
          if (this.window === win) this.close()
        }
      )
  }

  /**
   * 处理有效的摸摸或喂食，动作与台词来自同一事件。
   * @param kind 互动种类。
   * @returns 无返回值。
   */
  private interact(kind: PetInteraction): void {
    const line = this.session.interact(kind)
    if (line) this.react(line)
  }

  /**
   * 生成可选 AI 结算短评，未启用时完全离线。
   * @param distance 当前距离。
   * @param bestBefore 之前最佳距离。
   * @returns 台词或已取消标记。
   */
  public review(distance: number, bestBefore: number): Promise<PetUtterance | null> {
    this.init()
    return this.session.review(
      distance,
      bestBefore,
      this.reviewsEnabled ? this.transport() : undefined
    )
  }

  /**
   * 在挂起、新游戏或关闭时取消当前台词生成。
   * @returns 无返回值。
   */
  public cancel = (): void => {
    this.session.cancel()
  }

  /**
   * 校验关闭消息，其他窗口的单向消息直接忽略。
   * @param event IPC 事件。
   * @returns 无返回值。
   */
  private onCloseRequest = (event: IpcMainEvent): void => {
    if (
      this.window &&
      event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame
    )
      this.close()
  }

  /**
   * 将现存面板夹取至有效工作区。
   * @returns 无返回值。
   */
  private fit = (): void => {
    if (!this.window) return
    const bounds = this.window.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(380, area.width)
    const height = Math.min(520, area.height)
    this.window.setBounds({
      width,
      height,
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
    })
  }

  /**
   * 收起面板并取消请求，保留本次应用会话的文字。
   * @returns 无返回值。
   */
  public close = (): void => {
    clearTimeout(this.loadTimeout)
    this.session.cancel()
    const win = this.window
    this.window = null
    win?.destroy()
  }

  /**
   * 退出应用时释放窗口、请求、通道和系统监听。
   * @returns 无返回值。
   */
  public cleanup(): void {
    this.close()
    if (!this.initialized) return
    for (const name of ['ready', 'send', 'interact', 'configure', 'cancel', 'clear'])
      ipcMain.removeHandler(`desktop-pet-companion:${name}`)
    ipcMain.removeListener('desktop-pet-companion:close', this.onCloseRequest)
    powerMonitor.removeListener('suspend', this.cancel)
    powerMonitor.removeListener('lock-screen', this.cancel)
    screen.removeListener('display-metrics-changed', this.fit)
    screen.removeListener('display-removed', this.fit)
    this.initialized = false
  }
}
