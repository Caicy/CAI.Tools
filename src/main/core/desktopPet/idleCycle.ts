import type { PetIdleState } from '../../../shared/desktopPetTypes'

/** 根据系统空闲采样驱动喝咖啡与睡眠，不依赖页面焦点或真实时钟。 */
export class PetIdleCycle {
  private state: PetIdleState = { action: 'idle', drink: 0, cycle: 0 }
  private previous: number | null = null
  private sampledAt = 0
  private idleMs = 0
  private suspended = false
  private completed = 0

  /**
   * 注入系统空闲来源和测试时间比例，生产阈值保持 5 秒与 10 秒。
   * @param readIdleSeconds 系统级鼠标及键盘空闲秒数来源。
   * @param scale 阈值比例；无效值退回生产默认值 1。
   * @param nowMs 可注入采样时钟，用于检测暂停期间被系统输入重置的空闲起点。
   * @returns 初始化后的状态机实例。
   */
  constructor(
    private readonly readIdleSeconds: () => number,
    private readonly scale = 1,
    private readonly nowMs: () => number = Date.now
  ) {
    // 测试覆盖只改变阈值，动画仍按清单播放完整的一次。
    if (!Number.isFinite(scale) || scale < 0.01 || scale > 10) this.scale = 1
  }

  /**
   * 返回不共享引用的运行态，供初始快照和 IPC 发布使用。
   * @returns 当前动作、饮用次数和唤醒代号。
   */
  snapshot(): PetIdleState {
    return { ...this.state }
  }

  /**
   * 采样系统输入空闲时间；暂停或隐藏后不计入被冻结的时间。
   * @returns 状态发生变化时的新快照，否则返回 null。
   */
  sample(): PetIdleState | null {
    const seconds = this.readIdleSeconds()
    if (!Number.isFinite(seconds) || seconds < 0) return null
    const now = this.nowMs()
    // 空闲起点前移也代表输入：长时间暂停后秒数可能比旧采样大，不能只比较下降。
    // 允许系统整秒精度带来最多 1s 的量化差，避免相邻采样误判输入。
    const originMoved =
      this.previous !== null &&
      seconds * 1000 < this.previous * 1000 + Math.max(0, now - this.sampledAt) - 1100
    const input =
      this.previous !== null && (seconds < this.previous || seconds === 0 || originMoved)
    if (input && (this.idleMs > 0 || this.state.action !== 'idle' || this.state.drink > 0)) {
      this.reset()
      this.previous = seconds
      this.suspended = false
      return this.snapshot()
    }
    if (this.previous === null) this.idleMs = seconds * 1000
    else if (!this.suspended) this.idleMs += Math.max(0, seconds - this.previous) * 1000
    this.previous = seconds
    this.sampledAt = now
    this.suspended = false
    // 一次饮用必须由渲染器确认完成，不能仅因超过第三个阈值而提前睡觉。
    if (this.state.action !== 'idle' || this.completed >= 3) return null
    // 亚毫秒采样可能产生浮点舍入；只容忍百万分之一毫秒，不提前触发动画。
    if (this.idleMs + 1e-6 < (5000 + this.completed * 10000) * this.scale) return null
    this.state = { ...this.state, action: 'coffee', drink: this.completed + 1 }
    return this.snapshot()
  }

  /**
   * 确认当前非循环咖啡动画结束，拒绝唤醒前或重复的确认。
   * @param cycle 渲染器收到的唤醒代号。
   * @param drink 本次饮用次数。
   * @returns 确认有效时的新状态，否则返回 null。
   */
  finish(cycle: number, drink: number): PetIdleState | null {
    if (this.state.action !== 'coffee' || cycle !== this.state.cycle || drink !== this.state.drink)
      return null
    // 第三次必须真正播放完，之后保持睡眠直至输入唤醒。
    this.completed = drink
    this.state = { ...this.state, action: drink === 3 ? 'sleeping' : 'idle' }
    return this.snapshot()
  }

  /**
   * 冻结系统空闲增量，恢复采样时只检查期间是否发生过输入。
   * @returns 无返回值。
   */
  suspend(): void {
    this.suspended = true
  }

  /**
   * 重置循环并使尚未完成的旧动画确认失效。
   * @returns 无返回值。
   */
  reset(): void {
    // 代号单调递增，禁止关闭窗口前的旧确认污染新页面。
    this.state = { action: 'idle', drink: 0, cycle: this.state.cycle + 1 }
    this.completed = 0
    this.idleMs = 0
    // 明确交互也可能来自合成指针；不把之前的系统空闲量加回新循环。
    this.previous = this.readIdleSeconds()
    this.sampledAt = this.nowMs()
  }
}
