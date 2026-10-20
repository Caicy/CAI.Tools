import type { RunnerPhase } from '../../../../shared/desktopPetRunnerTypes'

export const RUNNER = {
  width: 800,
  height: 240,
  ground: 194,
  playerX: 114,
  gravity: 1800,
  jumpVelocity: -580,
  step: 1 / 120,
  startSpeed: 240,
  maxSpeed: 420
} as const

export interface RunnerObstacle {
  x: number
  width: number
  height: number
  kind: 'rock' | 'cactus'
}

/** 无 DOM 的固定步长游戏状态；坐标使用逻辑像素。 */
export class RunnerEngine {
  phase: RunnerPhase = 'ready'
  pauseReason = ''
  y = 0
  velocity = 0
  distance = 0
  elapsed = 0
  countdown = 3
  obstacles: RunnerObstacle[] = []
  private accumulator = 0
  private nextObstacle = 2

  /**
   * 注入可复现随机源，生产默认使用浏览器随机数。
   * @param random 返回零到一之间数值的随机源。
   * @returns 游戏引擎实例。
   */
  constructor(private readonly random: () => number = Math.random) {}

  /**
   * 根据有效游玩时间缓慢加速并设置上限。
   * @returns 当前逻辑像素每秒速度。
   */
  get speed(): number {
    return Math.min(RUNNER.maxSpeed, RUNNER.startSpeed + this.elapsed * 3)
  }

  /**
   * 建立全新一局，准备时间不计入分数。
   * @returns 无返回值。
   */
  restart(): void {
    this.y = this.velocity = this.distance = this.elapsed = this.accumulator = 0
    this.obstacles = []
    this.nextObstacle = 2
    this.countdown = 3
    this.pauseReason = ''
    this.phase = 'countdown'
  }

  /**
   * 只允许落地且正在游玩时跳跃。
   * @returns 是否成功起跳。
   */
  jump(): boolean {
    if (this.phase !== 'running' || this.y !== 0) return false
    this.velocity = RUNNER.jumpVelocity
    // 立即标记离地，防止同一帧多次输入重复起跳。
    this.y = -0.001
    return true
  }

  /**
   * 冻结物理及倒计时，丢弃未执行的时间。
   * @param reason 暂停来源，供界面反馈和诊断。
   * @returns 无返回值。
   */
  pause(reason = 'user'): void {
    if (this.phase !== 'running' && this.phase !== 'countdown') return
    this.phase = 'paused'
    this.pauseReason = reason
    this.accumulator = 0
  }

  /**
   * 用户主动继续时重新给予倒计时，不重置当前赛况。
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
   * 推进可见帧；长时间卡顿触发暂停，避免恢复后瞬间死亡。
   * @param seconds 与上一帧间隔的秒数。
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
   * 推进一次固定物理步长，先运动再判定碰撞。
   * @returns 无返回值。
   */
  private step(): void {
    const dt = RUNNER.step
    this.elapsed += dt
    const movement = this.speed * dt
    this.distance += movement / 10
    if (this.y < 0 || this.velocity < 0) {
      this.velocity += RUNNER.gravity * dt
      this.y = Math.min(0, this.y + this.velocity * dt)
      if (this.y === 0) this.velocity = 0
    }
    for (const obstacle of this.obstacles) obstacle.x -= movement
    this.obstacles = this.obstacles.filter(
      /**
       * 保留仍可能显示或碰撞的障碍。
       * @param obstacle 当前障碍。
       * @returns 是否保留。
       */
      (obstacle) => obstacle.x + obstacle.width > 0
    )
    this.nextObstacle -= dt
    if (this.nextObstacle <= 0) this.spawn()
    // 身体碰撞盒忽略耳朵、尾巴、透明边缘，脚底也留少量容错。
    const left = RUNNER.playerX - 15
    const right = RUNNER.playerX + 15
    const bottom = RUNNER.ground + this.y - 5
    const top = bottom - 50
    for (const obstacle of this.obstacles) {
      if (
        right > obstacle.x + 3 &&
        left < obstacle.x + obstacle.width - 3 &&
        bottom > RUNNER.ground - obstacle.height + 3 &&
        top < RUNNER.ground
      ) {
        this.phase = 'gameOver'
        this.accumulator = 0
        break
      }
    }
  }

  /**
   * 生成单个可跳过障碍，以最高速度保证连续障碍间有落地恢复余量。
   * @returns 无返回值。
   */
  private spawn(): void {
    const cactus = this.random() >= 0.5
    const width = cactus ? 25 : 36
    const flight = (-2 * RUNNER.jumpVelocity) / RUNNER.gravity
    // 用最高速度计算空间下限，后续加速也不会压缩到不可通过。
    const spacing = RUNNER.maxSpeed * (flight + 0.35) + 36 + 30
    const previous = this.obstacles[this.obstacles.length - 1]
    const x = Math.max(RUNNER.width + 24, previous ? previous.x + spacing : 0)
    this.obstacles.push({ x, width, height: cactus ? 48 : 28, kind: cactus ? 'cactus' : 'rock' })
    this.nextObstacle = spacing / this.speed + Math.max(0, Math.min(1, this.random())) * 0.65
  }
}
