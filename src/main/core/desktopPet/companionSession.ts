import { randomUUID } from 'node:crypto'
import type {
  PetDialogueEntry,
  PetInteraction,
  PetUtterance
} from '../../../shared/desktopPetCompanionTypes'

export interface CompanionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type CompanionTransport = (
  messages: CompanionMessage[],
  signal: AbortSignal,
  onText: (text: string) => void
) => Promise<string>

const PERSONA =
  '你是桌面伙伴小薄荷，温暖、轻松、有一点俏皮。使用中文简短回应，通常一到三句话。只根据用户提供的内容交流，不声称看到了屏幕、文件或用户活动。不执行工具，不假装已经完成操作。'

/** 管理文字台词生命周期；UI 和未来语音均消费同一个受控会话。 */
export class CompanionSession {
  public messages: PetDialogueEntry[] = []
  public busy = false
  public notice = ''
  private controller: AbortController | null = null
  private generation = 0
  private lastInteraction = 0

  /**
   * 注入变化通知和有界请求超时，测试无需真实供应商。
   * @param changed 会话变化通知。
   * @param timeoutMs 单次请求最长毫秒数。
   * @returns 会话实例。
   */
  constructor(
    private readonly changed: () => void,
    private readonly timeoutMs = 30_000
  ) {}

  /**
   * 生成可供不同呈现方式复用的台词。
   * @param text 台词正文。
   * @param source 本地或模型来源。
   * @param action 受控动画。
   * @param emotion 受控情绪。
   * @returns 新台词对象。
   */
  private utterance(
    text: string,
    source: PetUtterance['source'] = 'local',
    action: PetUtterance['action'] = 'idle',
    emotion: PetUtterance['emotion'] = 'warm'
  ): PetUtterance {
    return { id: randomUUID(), text: text.slice(0, 2000), source, action, emotion }
  }

  /**
   * 追加有界对话，避免长期积累私有内容。
   * @param line 台词对象。
   * @param role 发言方。
   * @returns 无返回值。
   */
  private append(line: PetUtterance, role: PetDialogueEntry['role'] = 'assistant'): void {
    this.messages.push({ ...line, role })
    this.messages = this.messages.slice(-20)
  }

  /**
   * 立即结束当前请求；迟到的增量或完成结果不能再次发布。
   * @returns 无返回值。
   */
  public cancel(): void {
    // 即使网络刚完成，尚未应用的完成回调也属于被取消的旧一代。
    this.generation++
    const active = this.controller
    this.controller = null
    active?.abort()
    if (this.busy) this.notice = '已停止回复'
    this.busy = false
    // 空的流式占位不保留；已经显示的正文可由用户继续阅读。
    this.messages = this.messages.filter(
      /**
       * 移除没有正文的流式占位。
       * @param message 当前消息。
       * @returns 是否保留。
       */
      (message) => message.text.length > 0
    )
    this.changed()
  }

  /**
   * 清空仅存在内存中的对话并结束请求。
   * @returns 无返回值。
   */
  public clear(): void {
    this.cancel()
    this.messages = []
    this.notice = ''
    this.changed()
  }

  /**
   * 为轻互动提供即时本地反馈，并抑制连续点击。
   * @param kind 已校验的互动类别。
   * @returns 新台词，冷却中返回 null。
   */
  public interact(kind: PetInteraction): PetUtterance | null {
    if (Date.now() - this.lastInteraction < 700) return null
    this.lastInteraction = Date.now()
    this.cancel()
    const line =
      kind === 'pat'
        ? this.utterance('嘿嘿，摸摸头，今天也一起慢慢来吧。', 'local', 'waving', 'happy')
        : this.utterance('收到小点心！补充一点能量，再陪你待一会儿。', 'local', 'coffee', 'happy')
    this.append(line)
    this.notice = '本地互动 · 无需联网'
    this.changed()
    return line
  }

  /**
   * 运行支持主动取消与硬超时的单次生成，隔离不响应 abort 的传输。
   * @param transport 已绑定选定模型的传输。
   * @param messages 有界上下文。
   * @param onText 正文增量接收器。
   * @returns 完整正文，主动取消返回 null。
   * @throws 超时、空回复或传输失败时抛错。
   */
  private async generate(
    transport: CompanionTransport,
    messages: CompanionMessage[],
    onText: (text: string) => void
  ): Promise<string | null> {
    const controller = new AbortController()
    this.controller = controller
    this.busy = true
    this.changed()
    let timedOut = false
    const timeout = setTimeout(
      /**
       * 到期后取消网络和等待，不依赖供应商主动结束。
       * @returns 无返回值。
       */
      () => {
        timedOut = true
        controller.abort()
      },
      this.timeoutMs
    )
    let abortListener: (() => void) | undefined
    try {
      const aborted = new Promise<never>(
        /**
         * 将取消信号转换为可竞争的结束事件。
         * @param _resolve 未使用的完成回调。
         * @param reject 拒绝回调。
         * @returns 无返回值。
         */
        (_resolve, reject) => {
          /**
           * 通知请求等待结束。
           * @returns 无返回值。
           */
          abortListener = () => reject(new Error('请求已结束'))
          controller.signal.addEventListener('abort', abortListener, { once: true })
        }
      )
      const result = await Promise.race([
        transport(
          messages,
          controller.signal,
          /**
           * 只发布当前请求的正文，忽略旧请求的迟到数据。
           * @param text 正文增量。
           * @returns 无返回值。
           */
          (text) => {
            if (this.controller === controller && !controller.signal.aborted) onText(text)
          }
        ),
        aborted
      ])
      if (this.controller !== controller) return null
      if (!result.trim()) throw new Error('空回复')
      return result.trim().slice(0, 2000)
    } catch (error) {
      if (this.controller !== controller) return null
      if (timedOut) throw new Error('回复超时')
      throw error
    } finally {
      clearTimeout(timeout)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      if (this.controller === controller) {
        this.controller = null
        this.busy = false
      }
    }
  }

  /**
   * 处理主动聊天；没有模型和网络失败时仍给出明确本地反馈。
   * @param value 未信任的输入正文。
   * @param transport 可选的已绑定传输。
   * @returns 操作完成后的 Promise。
   * @throws 输入为空、超长或类型非法时抛错。
   */
  public async send(value: unknown, transport?: CompanionTransport): Promise<void> {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000)
      throw new Error('请输入 1–1000 字的消息')
    this.cancel()
    this.notice = ''
    const generation = this.generation
    this.append(this.utterance(value.trim()), 'user')
    if (!transport) {
      this.append(this.utterance('我在这里陪着你。选择上方的 AI 模型后，就能和我聊更多啦。'))
      this.notice = '本地陪伴 · 可在应用设置的 AI 供应商中添加模型'
      this.changed()
      return
    }
    const context: CompanionMessage[] = [{ role: 'system', content: PERSONA }]
    // 仅携带当前有界文字，不附加屏幕、文件或剪贴板内容。
    for (const entry of this.messages) context.push({ role: entry.role, content: entry.text })
    const line: PetDialogueEntry = { ...this.utterance('', 'ai'), role: 'assistant' }
    this.messages.push(line)
    this.messages = this.messages.slice(-20)
    try {
      const result = await this.generate(
        transport,
        context,
        /**
         * 更新同一条台词，避免流式回复产生多条消息。
         * @param text 正文增量。
         * @returns 无返回值。
         */
        (text) => {
          line.text = (line.text + text).slice(0, 2000)
          this.changed()
        }
      )
      if (result === null || generation !== this.generation) return
      line.text = result
    } catch {
      if (generation !== this.generation) return
      // 错误详情可能含连接信息；页面仅接收固定、可操作的失败说明。
      line.text = '这次没能连上我的 AI，不过我还在。可以检查模型设置后再试一次。'
      line.source = 'local'
      this.notice = 'AI 回复失败或超时，已使用本地台词'
    }
    this.changed()
  }

  /**
   * 根据实际距离生成结算短评，不更改分数和奖励。
   * @param distance 本局距离。
   * @param bestBefore 开局前的历史最佳距离。
   * @param transport 用户启用后提供的可选模型传输。
   * @returns 短评，主动取消时返回 null。
   */
  public async review(
    distance: number,
    bestBefore: number,
    transport?: CompanionTransport
  ): Promise<PetUtterance | null> {
    this.cancel()
    const generation = this.generation
    const line = this.utterance(
      distance > bestBefore
        ? `跑了 ${distance} 米，刷新纪录啦！击个掌！`
        : `这次跑了 ${distance} 米，一起歇一下，再来一局吧。`,
      'local',
      'waving',
      distance > bestBefore ? 'happy' : 'encouraging'
    )
    if (!transport) return line
    try {
      const result = await this.generate(
        transport,
        [
          {
            role: 'system',
            content: PERSONA + '为快跑结算写一句不超过60字的鼓励。不得编造碰撞原因或历史事件。'
          },
          {
            role: 'user',
            content: `本局 ${distance} 米，之前最佳 ${bestBefore} 米。${distance > bestBefore ? '本局刷新纪录。' : '本局未刷新纪录。'}`
          }
        ],
        /**
         * 结算短评一次显示完整句子。
         * @param _text 未发布的正文增量。
         * @returns 无返回值。
         */
        (_text) => {}
      )
      if (result === null || generation !== this.generation) return null
      line.text = result.slice(0, 160)
      line.source = 'ai'
    } catch {
      if (generation !== this.generation) return null
      // 结算始终保留确定性的本地短评，不让网络影响游戏。
      this.notice = 'AI 短评暂不可用，已使用本地台词'
    }
    this.changed()
    return line
  }
}
