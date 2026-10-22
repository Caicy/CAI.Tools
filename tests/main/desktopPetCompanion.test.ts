import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompanionSession,
  type CompanionMessage,
  type CompanionTransport
} from '../../src/main/core/desktopPet/companionSession'

/**
 * 创建故意不响应 abort 的受控供应商，以验证会话自身的隔离边界。
 * @returns 传输、捕获请求及显式完成接口。
 */
function controlled() {
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  let emit!: (text: string) => void
  let signal!: AbortSignal
  let context: CompanionMessage[] = []
  const promise = new Promise<string>(
    /**
     * 暂存完成接口，测试无需真实网络或睡眠。
     * @param finish 成功回调。
     * @param fail 失败回调。
     * @returns 无返回值。
     */
    (finish, fail) => {
      resolve = finish
      reject = fail
    }
  )
  /**
   * 捕获会话交给供应商的内容及取消信号。
   * @param messages 受控上下文。
   * @param abortSignal 取消信号。
   * @param onText 流式正文消费者。
   * @returns 由测试显式完成的 Promise。
   */
  const transport: CompanionTransport = (messages, abortSignal, onText) => {
    context = messages
    signal = abortSignal
    emit = onText
    return promise
  }
  return {
    transport,
    resolve,
    reject,
    /**
     * 模拟一段正文，即使供应商已被取消也照常回调。
     * @param text 正文增量。
     * @returns 无返回值。
     */
    emit(text: string): void {
      emit(text)
    },
    /**
     * 读取捕获的取消信号。
     * @returns 当前请求信号。
     */
    get signal(): AbortSignal {
      return signal
    },
    /**
     * 读取发送给供应商的真实上下文。
     * @returns 上下文数组。
     */
    get context(): CompanionMessage[] {
      return context
    }
  }
}

beforeEach(
  /**
   * 使用固定非零时钟测试冷却与硬超时。
   * @returns 无返回值。
   */
  () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'))
  }
)
afterEach(
  /**
   * 恢复时钟，避免污染其他单元测试。
   * @returns 无返回值。
   */
  () => {
    vi.useRealTimers()
  }
)

describe('CompanionSession' /**
 * 声明不依赖 Electron、真实数据或模型的会话契约。
 * @returns 无返回值。
 */, () => {
  it('没有模型时保留用户正文并明确使用本地陪伴' /**
   * 验证本地模式无需供应商也能回应。
   * @returns 测试完成的 Promise。
   */, async () => {
    const changed = vi.fn()
    const session = new CompanionSession(changed)
    await session.send('  今天休息一下  ')
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toMatchObject({ role: 'user', text: '今天休息一下' })
    expect(session.messages[1]).toMatchObject({ role: 'assistant', source: 'local' })
    expect(session.messages[1].text).toContain('选择上方的 AI 模型')
    expect(session.busy).toBe(false)
    expect(changed).toHaveBeenCalled()
  })

  it('摸头和喂食共享冷却且互动取消活动请求' /**
   * 验证冷却边界与轻互动的动作台词。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    expect(session.interact('pat')).toMatchObject({
      source: 'local',
      action: 'waving',
      emotion: 'happy'
    })
    expect(session.interact('feed')).toBeNull()
    vi.advanceTimersByTime(699)
    expect(session.interact('feed')).toBeNull()
    vi.advanceTimersByTime(1)
    const request = controlled()
    const sending = session.send('正在等回复', request.transport)
    expect(session.interact('feed')).toMatchObject({ source: 'local', action: 'coffee' })
    expect(request.signal.aborted).toBe(true)
    await sending
    request.emit('迟到文字')
    request.resolve('迟到结果')
    expect(session.messages.at(-1)?.text).toContain('小点心')
    expect(session.busy).toBe(false)
  })

  it.each([null, undefined, 42, {}, '', ' \n ', 'a'.repeat(1001)])(
    '拒绝非法输入而不修改当前对话：%s',
    /**
     * 验证输入边界在状态变更前执行。
     * @param input 非法用户输入。
     * @returns 测试完成的 Promise。
     */
    async (input) => {
      const session = new CompanionSession(vi.fn())
      await session.send('保留的消息')
      const before = structuredClone(session.messages)
      await expect(session.send(input)).rejects.toThrow('1–1000')
      expect(session.messages).toEqual(before)
    }
  )

  it('流式更新同一条消息并在完成时结束忙碌状态' /**
   * 验证增量与最终结果共用同一个消息身份。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const request = controlled()
    const sending = session.send('聊天内容', request.transport)
    expect(session.busy).toBe(true)
    const id = session.messages.at(-1)?.id
    request.emit('你好')
    request.emit('，朋友')
    expect(session.messages.at(-1)).toMatchObject({ id, text: '你好，朋友', source: 'ai' })
    expect(request.context.at(-1)).toEqual({ role: 'user', content: '聊天内容' })
    expect(request.context[0].role).toBe('system')
    request.resolve('  你好，朋友！  ')
    await sending
    expect(session.messages).toHaveLength(2)
    expect(session.messages.at(-1)).toMatchObject({ id, text: '你好，朋友！' })
    expect(session.busy).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('历史、输入和输出始终有界' /**
   * 验证长期使用和异常长模型正文不会无限增长。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    for (let index = 0; index < 25; index++) await session.send(`历史 ${index}`)
    expect(session.messages).toHaveLength(20)
    expect(session.messages[0].text).toBe('历史 15')
    const request = controlled()
    const sending = session.send('x'.repeat(1000), request.transport)
    expect(request.context.length).toBeLessThanOrEqual(21)
    expect(request.context.at(-1)?.content).toHaveLength(1000)
    request.emit('流'.repeat(4000))
    expect(session.messages.at(-1)?.text).toHaveLength(2000)
    request.resolve('终'.repeat(5000))
    await sending
    expect(session.messages).toHaveLength(20)
    expect(session.messages.at(-1)?.text).toHaveLength(2000)
  })

  it('网络错误仅显示固定本地回退，不泄露错误详情' /**
   * 验证敏感网络错误不会进入 UI。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const request = controlled()
    const sending = session.send('你好', request.transport)
    request.emit('未完成部分')
    request.reject(new Error('secret-api-key https://private.example/token'))
    await sending
    expect(session.messages.at(-1)?.source).toBe('local')
    expect(session.messages.at(-1)?.text).toContain('检查模型设置')
    expect(JSON.stringify(session.messages) + session.notice).not.toContain('secret-api-key')
    expect(session.busy).toBe(false)
  })

  it('空白模型输出回退为本地回复' /**
   * 验证没有有效正文的成功网络响应也走回退。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const request = controlled()
    const sending = session.send('你好', request.transport)
    request.resolve('  \n ')
    await sending
    expect(session.messages.at(-1)?.source).toBe('local')
    expect(session.notice).toContain('失败或超时')
  })

  it('硬超时可以终止永远不响应 abort 的供应商' /**
   * 验证会话不依赖传输层自己实现超时。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn(), 50)
    const request = controlled()
    const sending = session.send('超时测试', request.transport)
    await vi.advanceTimersByTimeAsync(50)
    await sending
    expect(request.signal.aborted).toBe(true)
    expect(session.busy).toBe(false)
    expect(session.messages.at(-1)?.source).toBe('local')
    const final = structuredClone(session.messages)
    request.emit('超时后文字')
    request.resolve('超时后结果')
    await Promise.resolve()
    expect(session.messages).toEqual(final)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('主动取消保留已显示正文且忽略迟到回调' /**
   * 验证取消后旧回复不能重新写入。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const request = controlled()
    const sending = session.send('停止测试', request.transport)
    request.emit('已经看到的文字')
    session.cancel()
    await sending
    const final = structuredClone(session.messages)
    request.emit('不应显示')
    request.resolve('不应替换')
    await Promise.resolve()
    expect(session.messages).toEqual(final)
    expect(session.messages.at(-1)?.text).toBe('已经看到的文字')
    expect(session.notice).toBe('已停止回复')
    expect(session.busy).toBe(false)
  })

  it('清空期间取消请求，移除空占位及历史' /**
   * 验证 clear 与延迟完成竞争时不能恢复消息。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const request = controlled()
    const sending = session.send('清空测试', request.transport)
    session.clear()
    await sending
    request.emit('迟到')
    request.resolve('迟到')
    await Promise.resolve()
    expect(session.messages).toEqual([])
    expect(session.notice).toBe('')
    expect(session.busy).toBe(false)
    expect(request.signal.aborted).toBe(true)
  })

  it('第二个请求取代第一个，旧请求结束不重置新请求状态' /**
   * 验证不同生成生命周期之间没有状态串扰。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const first = controlled()
    const second = controlled()
    const oldSend = session.send('第一条', first.transport)
    const newSend = session.send('第二条', second.transport)
    await oldSend
    first.emit('第一条迟到')
    first.resolve('第一条旧结果')
    await Promise.resolve()
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(session.busy).toBe(true)
    second.emit('第二条正文')
    second.resolve('第二条结果')
    await newSend
    expect(session.messages.at(-1)?.text).toBe('第二条结果')
    expect(JSON.stringify(session.messages)).not.toContain('旧结果')
    expect(session.busy).toBe(false)
  })

  it('快跑本地短评只根据实际距离与历史最佳判断纪录' /**
   * 验证平纪录不是破纪录，且短评不会污染聊天记录。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    expect(await session.review(101, 100)).toMatchObject({ source: 'local', emotion: 'happy' })
    const tie = await session.review(100, 100)
    expect(tie?.text).toContain('100 米')
    expect(tie?.text).not.toContain('刷新纪录')
    expect(tie?.emotion).toBe('encouraging')
    expect(session.messages).toEqual([])
  })

  it('AI 短评只传递实际结算事实并限制结果长度' /**
   * 验证 AI 不接收对话或虚构碰撞原因。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    await session.send('私有聊天内容')
    const request = controlled()
    const reviewing = session.review(123, 99, request.transport)
    expect(request.context).toHaveLength(2)
    expect(request.context[1].content).toBe('本局 123 米，之前最佳 99 米。本局刷新纪录。')
    expect(JSON.stringify(request.context)).not.toContain('私有聊天内容')
    request.emit('不单独发布的短评增量')
    request.resolve('鼓励'.repeat(200))
    const review = await reviewing
    expect(review?.source).toBe('ai')
    expect(review?.text).toHaveLength(160)
    expect(session.messages).toHaveLength(2)
    expect(session.busy).toBe(false)
  })

  it('取消快跑短评返回 null，失败则保留实际距离本地短评' /**
   * 验证结算中断和错误均不伪造模型成功。
   * @returns 测试完成的 Promise。
   */, async () => {
    const session = new CompanionSession(vi.fn())
    const canceled = controlled()
    const reviewing = session.review(18, 30, canceled.transport)
    session.cancel()
    await expect(reviewing).resolves.toBeNull()
    canceled.resolve('迟到短评')
    const failed = controlled()
    const fallback = session.review(18, 30, failed.transport)
    failed.reject(new Error('private-key'))
    const result = await fallback
    expect(result?.source).toBe('local')
    expect(result?.text).toContain('18 米')
    expect(result?.text).not.toContain('刷新纪录')
    expect(session.notice).toContain('本地台词')
    expect(session.messages).toEqual([])
    expect(session.busy).toBe(false)
  })
})
