import type { RunnerPhase } from '../../../../shared/desktopPetRunnerTypes'

export const RUNNER = {
  width: 800,
  height: 240,
  ground: 194,
  playerX: 114,
  gravity: 1800,
  jumpVelocity: -580,
  releaseVelocity: -360,
  step: 1 / 120,
  startSpeed: 240,
  maxSpeed: 460,
  duckScale: 0.7,
  duckTransition: 0.06
} as const

export const RUNNER_STAGES = [
  { level: 1, name: '热身', start: 0, end: 20, from: 240, to: 280, reaction: 0.5 },
  { level: 2, name: '加速', start: 20, end: 45, from: 280, to: 320, reaction: 0.4 },
  { level: 3, name: '飞行物', start: 45, end: 75, from: 320, to: 360, reaction: 0.32 },
  { level: 4, name: '组合', start: 75, end: 110, from: 360, to: 400, reaction: 0.26 },
  // 巡航给冲刺保留净加速空间；极限速度仍为 460，而非达到上限后只显示空提示。
  { level: 5, name: '极限', start: 110, end: 140, from: 400, to: 435, reaction: 0.22 }
] as const

export type RunnerObstacleKind =
  | 'rock'
  | 'cactus'
  | 'tall-cactus'
  | 'double-cactus'
  | 'low-bird'
  | 'mid-bird'
  | 'rolling-rock'
  | 'combo-short'
  | 'combo-long'

export interface RunnerObstacle {
  x: number
  width: number
  height: number
  kind: RunnerObstacleKind
  /** 离地高度；地面障碍省略时视为零。 */
  bottom?: number
  extraSpeed?: number
  pattern?: number
}

/** 无 DOM 的固定步长状态；输入、冲刺及生成器只使用存活时间。 */
export class RunnerEngine {
  phase: RunnerPhase = 'ready'
  pauseReason = ''
  y = 0
  velocity = 0
  distance = 0
  elapsed = 0
  countdown = 3
  obstacles: RunnerObstacle[] = []
  jumpHeld = false
  duckHeld = false
  private duckTime = 0
  private accumulator = 0
  private nextObstacle = 2
  private patternId = 0

  /**
   * 注入可回放随机源。
   * @param random 零到一随机源。
   * @returns 引擎实例。
   */
  constructor(private readonly random: () => number = Math.random) {}

  /**
   * 由实际存活时间选择阶段，倒计时和暂停不推进。
   * @returns 当前难度参数。
   */
  get stage(): (typeof RUNNER_STAGES)[number] {
    for (let i = RUNNER_STAGES.length - 1; i >= 0; i--)
      if (this.elapsed + 1e-8 >= RUNNER_STAGES[i].start) return RUNNER_STAGES[i]
    return RUNNER_STAGES[0]
  }

  /**
   * 给冲刺留出 1.5 秒预告；完全由固定步时钟决定。
   * @returns 冲刺提示或空字符串。
   */
  get sprint(): string {
    if (this.elapsed < 110) return ''
    const cycle = (this.elapsed - 110) % 18
    return cycle >= 10 && cycle < 11.5 ? '冲刺将至' : cycle >= 11.5 && cycle < 13.5 ? '冲刺！' : ''
  }

  /**
   * 阶段内线性加速，短冲刺同样受 460 上限约束。
   * @returns 每秒逻辑像素速度。
   */
  get speed(): number {
    const stage = this.stage
    const progress = Math.max(
      0,
      Math.min(1, (this.elapsed - stage.start) / (stage.end - stage.start))
    )
    return Math.min(
      RUNNER.maxSpeed,
      stage.from + (stage.to - stage.from) * progress + (this.sprint === '冲刺！' ? 35 : 0)
    )
  }

  /**
   * 下蹲需完成确定性的短过渡且必须落地。
   * @returns 是否使用下蹲碰撞盒及等比素材缩放。
   */
  get ducking(): boolean {
    return this.y === 0 && this.duckHeld && this.duckTime >= RUNNER.duckTransition
  }

  /**
   * 身体碰撞盒排除耳朵、尾巴和脚底容错。
   * @returns 身体逻辑边界。
   */
  get hitbox(): { left: number; right: number; top: number; bottom: number } {
    const scale = this.ducking ? RUNNER.duckScale : 1
    const bottom = RUNNER.ground + this.y - 5
    return {
      left: RUNNER.playerX - 15 * scale,
      right: RUNNER.playerX + 15 * scale,
      top: bottom - 50 * scale,
      bottom
    }
  }

  /**
   * 重置局号内所有物理、输入和生成状态。
   * @returns 无返回值。
   */
  restart(): void {
    // 清除旧输入，重开不会因仍按着按钮自动起跳。
    this.y = this.velocity = this.distance = this.elapsed = this.accumulator = this.duckTime = 0
    this.jumpHeld = this.duckHeld = false
    this.obstacles = []
    this.nextObstacle = 2
    this.patternId = 0
    this.countdown = 3
    this.pauseReason = ''
    this.phase = 'countdown'
  }

  /**
   * 记录跳跃按下/释放；释放截断上升速度，固定步负责物理。
   * @param held 是否按住跳跃。
   * @returns 是否在本次输入起跳。
   */
  setJump(held: boolean): boolean {
    const pressed = held && !this.jumpHeld
    this.jumpHeld = held
    return pressed ? this.jump() : false
  }

  /**
   * 记录下蹲输入，空中输入在下一固定步触发快落。
   * @param held 是否按住下蹲。
   * @returns 无返回值。
   */
  setDuck(held: boolean): void {
    this.duckHeld = held
    if (!held) this.duckTime = 0
  }

  /**
   * 只允许运行中落地起跳；直接调用默认视为长按。
   * @returns 是否起跳。
   */
  jump(): boolean {
    if (this.phase !== 'running' || this.y !== 0 || this.duckHeld) return false
    // 同一可见帧的重复输入不得重置初速度。
    this.jumpHeld = true
    this.velocity = RUNNER.jumpVelocity
    this.y = -0.001
    return true
  }

  /**
   * 冻结赛况并清除输入，恢复后不会粘键。
   * @param reason 暂停来源。
   * @returns 无返回值。
   */
  pause(reason = 'user'): void {
    if (this.phase !== 'running' && this.phase !== 'countdown') return
    this.phase = 'paused'
    this.pauseReason = reason
    this.jumpHeld = this.duckHeld = false
    this.duckTime = this.accumulator = 0
  }

  /**
   * 用倒计时继续同一赛况。
   * @returns 无返回值。
   */
  resume(): void {
    if (this.phase !== 'paused') return
    this.phase = 'countdown'
    this.pauseReason = ''
    this.countdown = 3
    this.accumulator = 0
  }

  /**
   * 推进可见帧，长帧暂停以保护用户而非瞬移到障碍。
   * @param seconds 帧间秒数。
   * @returns 无返回值。
   */
  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return
    if (seconds > 0.25) {
      this.pause('long-frame')
      return
    }
    if (this.phase === 'countdown') {
      this.countdown = Math.max(0, this.countdown - seconds)
      if (this.countdown <= 0.000001) this.phase = 'running'
      return
    }
    if (this.phase !== 'running') return
    this.accumulator += seconds
    while (this.accumulator + 1e-10 >= RUNNER.step && this.phase === 'running') {
      this.accumulator -= RUNNER.step
      this.step()
    }
  }

  /**
   * 推进输入过渡、物理和碰撞，所有时钟均为固定步。
   * @returns 无返回值。
   */
  private step(): void {
    const dt = RUNNER.step
    this.elapsed += dt
    const movement = this.speed * dt
    this.distance += movement / 10
    this.duckTime = this.duckHeld ? this.duckTime + dt : 0
    // 快点按也有约 34px 的最小跳高；长按最高约 91px。
    if (this.y < 0 || this.velocity < 0) {
      if (!this.jumpHeld && this.velocity < RUNNER.releaseVelocity)
        this.velocity = RUNNER.releaseVelocity
      if (this.duckHeld) this.velocity = Math.max(240, this.velocity)
      this.velocity += RUNNER.gravity * (this.duckHeld ? 2.5 : 1) * dt
      this.y = Math.min(0, this.y + this.velocity * dt)
      if (this.y === 0) this.velocity = 0
    }
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const obstacle = this.obstacles[i]
      obstacle.x -= movement + (obstacle.extraSpeed ?? 0) * dt
      if (obstacle.x + obstacle.width <= 0) this.obstacles.splice(i, 1)
    }
    this.nextObstacle -= dt
    if (this.nextObstacle <= 0) this.spawn()
    // 飞鸟使用独立离地高度；中鸟的底面高于蹲姿但低于站姿头顶。
    const body = this.hitbox
    for (const obstacle of this.obstacles) {
      const bottom = RUNNER.ground - (obstacle.bottom ?? 0)
      if (
        body.right > obstacle.x + 3 &&
        body.left < obstacle.x + obstacle.width - 3 &&
        body.bottom > bottom - obstacle.height + 3 &&
        body.top < bottom - 3
      ) {
        this.phase = 'gameOver'
        this.accumulator = 0
        break
      }
    }
  }

  /**
   * 生成已解锁模式；用当前速度、物理恢复及相对运动保护后继模式。
   * @returns 无返回值。
   */
  private spawn(): void {
    const kinds: RunnerObstacleKind[] = ['rock', 'cactus']
    if (this.stage.level >= 2) kinds.push('tall-cactus', 'double-cactus')
    if (this.stage.level >= 3) kinds.push('low-bird', 'mid-bird')
    if (this.stage.level >= 4) kinds.push('combo-short', 'combo-long', 'rolling-rock')
    const sample = Math.max(0, Math.min(0.999999, this.random()))
    const kind = kinds[Math.floor(sample * kinds.length)]
    const extraSpeed = kind === 'rolling-rock' ? 65 : 0
    const flight = (-2 * RUNNER.jumpVelocity) / RUNNER.gravity
    // 最大增长率 2px/s²，加上一次冲刺 35px/s；不是按全局最高速度排距。
    let clearTime = 0
    for (const previous of this.obstacles) {
      const minimumSpeed = Math.max(240, this.speed - (this.sprint === '冲刺！' ? 35 : 0))
      clearTime = Math.max(
        clearTime,
        (previous.x + previous.width - (RUNNER.playerX - 15)) /
          (minimumSpeed + (previous.extraSpeed ?? 0))
      )
    }
    const recovery = flight + RUNNER.duckTransition + this.stage.reaction
    const horizon = Math.max(0, clearTime) + recovery
    const boostAllowance = this.stage.level === 5 ? 35 : 0
    const travel = (this.speed + extraSpeed + boostAllowance) * horizon + horizon * horizon
    const x = Math.max(RUNNER.width + 24, RUNNER.playerX + 15 + travel)
    const pattern = ++this.patternId
    const obstacle: RunnerObstacle = { x, width: 36, height: 28, kind, extraSpeed, pattern }
    switch (kind) {
      case 'cactus':
        obstacle.width = 25
        obstacle.height = 36
        break
      case 'tall-cactus':
        obstacle.width = 25
        obstacle.height = 60
        break
      case 'double-cactus':
        obstacle.width = 58
        obstacle.height = 42
        break
      case 'low-bird':
        obstacle.width = 34
        obstacle.height = 20
        obstacle.bottom = 12
        break
      case 'mid-bird':
        obstacle.width = 38
        obstacle.height = 20
        obstacle.bottom = 44
        break
      case 'rolling-rock':
        obstacle.width = 30
        obstacle.height = 30
        break
      case 'combo-short':
      case 'combo-long': {
        // 两块紧邻障碍作为一个模式，内部净跨越宽度满足短/长跳清空窗口。
        const gap = kind === 'combo-short' ? 14 : 48
        obstacle.width = 22
        obstacle.height = kind === 'combo-short' ? 18 : 30
        this.obstacles.push({ ...obstacle, x: x + obstacle.width + gap })
        break
      }
    }
    this.obstacles.push(obstacle)
    // 随机附加空隙逐阶段减小；模式间始终有一次完整落地及反应余量。
    this.nextObstacle =
      recovery +
      obstacle.width / this.speed +
      Math.max(0, Math.min(1, this.random())) * (this.stage.level === 1 ? 0.7 : 0.25)
  }
}
