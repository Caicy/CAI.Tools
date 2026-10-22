import { powerMonitor } from 'electron'
import databaseAPI from '../../api/shared/database'
import aiProviderService from '../aiProviderService'
import { createAdapter } from '../../api/plugin/aiProtocol/adapters'
import { streamSingleAiProtocolChat } from '../aiChatTransport'
import { normalizeAiModelCapabilities } from '../../../shared/aiProviderShared'
import { HOST_STORAGE_KEYS } from '../../../shared/storageKeys'
import type { PetUtterance } from '../../../shared/desktopPetCompanionTypes'
import { CompanionSession, type CompanionTransport } from './companionSession'

/** 提供快跑结算短评及取消生命周期，不创建文字聊天窗口。 */
export class CompanionManager {
  private initialized = false
  private modelRef = ''
  private reviewsEnabled = false
  private readonly session = new CompanionSession(
    /**
     * 短评由 review 返回值交付，无需向聊天页面推送状态。
     * @returns 无返回值。
     */
    () => {
      // 文字聊天面板已移除，不创建页面状态消费者。
    }
  )

  /**
   * 延迟读取已有短评偏好并注册系统取消事件。
   * @returns 无返回值。
   */
  private init(): void {
    if (this.initialized) return
    this.initialized = true
    // 只读兼容已有设备偏好，不再注册聊天窗口 IPC 或改写配置。
    try {
      const data = databaseAPI.dbGet(HOST_STORAGE_KEYS.desktopPetCompanion)
      if (data?.version === 1) {
        this.modelRef =
          typeof data.modelRef === 'string' && data.modelRef.length <= 500 ? data.modelRef : ''
        this.reviewsEnabled = data.reviewsEnabled === true
      }
    } catch {
      // 偏好不可读时使用默认离线短评，游戏结算仍可继续。
      this.modelRef = ''
      this.reviewsEnabled = false
    }
    powerMonitor.on('suspend', this.cancel)
    powerMonitor.on('lock-screen', this.cancel)
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
   * 退出应用时取消短评并释放系统监听。
   * @returns 无返回值。
   */
  public cleanup(): void {
    this.cancel()
    if (!this.initialized) return
    // 仅释放本服务注册的监听，不影响其他模块。
    powerMonitor.removeListener('suspend', this.cancel)
    powerMonitor.removeListener('lock-screen', this.cancel)
    this.initialized = false
  }
}
