import { expect, test } from 'vitest'
import {
  RunnerEngine,
  RUNNER,
  RUNNER_STAGES
} from '../../src/renderer/src/desktopPet/runner/engine'

/**
 * 正常帧间隔推进时钟，不绕过长帧保护。
 * @param engine 被测引擎。
 * @param seconds 秒数。
 * @param fps 刷新率。
 * @returns 无返回值。
 */
function advance(engine: RunnerEngine, seconds: number, fps = 120): void {
  for (let i = 0; i < Math.round(seconds * fps); i++) engine.advance(1 / fps)
}

/**
 * 构造可复现随机源。
 * @param seed 种子。
 * @returns 随机数函数。
 */
function seeded(seed: number): () => number {
  /**
   * 推进 LCG 状态。
   * @returns 零到一随机样本。
   */
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
}

/**
 * 完成倒计时并返回运行中引擎。
 * @param seed 随机种子。
 * @returns 引擎。
 */
function running(seed = 1): RunnerEngine {
  const engine = new RunnerEngine(seeded(seed))
  engine.restart()
  advance(engine, 3)
  return engine
}

/**
 * 仅依据可见状态作出起跳/下蹲决定；不修改物理、不删障碍、不忽略碰撞。
 * @param engine 引擎。
 * @returns 无返回值。
 */
function perfectBot(engine: RunnerEngine): void {
  let next: (typeof engine.obstacles)[number] | undefined
  // 以站姿左缘确认完全离开；提前恢复站姿会扩大身体并撞上刚经过的鸟尾。
  for (const obstacle of engine.obstacles)
    if (obstacle.x + obstacle.width - 3 > RUNNER.playerX - 15 && (!next || obstacle.x < next.x))
      next = obstacle
  if (!next) {
    engine.setDuck(false)
    engine.setJump(false)
    return
  }
  const until = (next.x + 3 - (RUNNER.playerX + 15)) / (engine.speed + (next.extraSpeed ?? 0))
  engine.setDuck(next.kind === 'mid-bird' && until < 0.55)
  if (next.kind !== 'mid-bird' && until <= 0.18 && engine.y === 0) {
    engine.setJump(false)
    engine.setJump(true)
  }
}

test('倒计时、暂停及后台长帧不计分，恢复清除输入' /**
 * 验证生命周期边界。
 * @returns 无返回值。
 */, () => {
  const engine = new RunnerEngine()
  expect(engine.jump()).toBe(false)
  engine.restart()
  advance(engine, 2)
  expect(engine.distance).toBe(0)
  expect(engine.phase).toBe('countdown')
  advance(engine, 1)
  engine.setJump(true)
  advance(engine, 0.1)
  const distance = engine.distance
  engine.advance(10)
  expect(engine.phase).toBe('paused')
  expect(engine.jumpHeld).toBe(false)
  expect(engine.pauseReason).toBe('long-frame')
  advance(engine, 5)
  engine.resume()
  advance(engine, 3)
  expect(engine.distance).toBe(distance)
  expect(engine.phase).toBe('running')
})

test('阶段边界、线性速度、冲刺预告和 460 封顶' /**
 * 检查所有边界及阶段内插值。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  for (const stage of RUNNER_STAGES) {
    engine.elapsed = stage.start
    expect(engine.stage.level).toBe(stage.level)
    expect(engine.speed).toBe(stage.from)
    engine.elapsed = stage.end - 0.001
    if (stage.level < 5) expect(engine.speed).toBeCloseTo(stage.to, 2)
    if (stage.level > 1) {
      engine.elapsed = stage.start - 0.001
      expect(engine.stage.level).toBe(stage.level - 1)
    }
  }
  engine.elapsed = 120
  expect(engine.sprint).toBe('冲刺将至')
  engine.elapsed = 122
  expect(engine.sprint).toBe('冲刺！')
  expect(engine.speed).toBe(449)
  engine.elapsed = 140
  expect(engine.speed).toBe(460)
  engine.elapsed = 142
  expect(engine.speed).toBe(435)
  engine.elapsed = 158
  expect(engine.speed).toBe(460)
  engine.elapsed = 160
  expect(engine.speed).toBe(435)
  expect(engine.stage.reaction).toBeGreaterThanOrEqual(0.22)
})

test('点按最低跳高小于长按，固定步保持不同刷新率一致' /**
 * 使用真实按下/释放输入测量两种最高点。
 * @returns 无返回值。
 */, () => {
  const tap = running(),
    hold = running(),
    fast = running()
  tap.setJump(true)
  tap.setJump(false)
  hold.setJump(true)
  fast.setJump(true)
  let tapApex = 0,
    holdApex = 0
  for (let i = 0; i < 90; i++) {
    tap.advance(RUNNER.step)
    hold.advance(RUNNER.step)
    tapApex = Math.min(tapApex, tap.y)
    holdApex = Math.min(holdApex, hold.y)
  }
  advance(fast, 0.75, 144)
  expect(tapApex).toBeLessThan(-30)
  expect(tapApex).toBeGreaterThan(-40)
  expect(holdApex).toBeLessThan(-85)
  expect(tapApex).toBeGreaterThan(holdApex + 45)
  expect(fast.distance).toBeCloseTo(hold.distance, 6)
  expect(fast.y).toBe(hold.y)
  expect(hold.jump()).toBe(true)
  expect(hold.jump()).toBe(false)
})

test('中空鸟站姿碰撞，下蹲等比小身体可通过；空中下蹲快落' /**
 * 验证离地障碍和下蹲过渡都经过真实物理。
 * @returns 无返回值。
 */, () => {
  const standing = running(),
    duck = running()
  duck.setDuck(true)
  advance(duck, 0.08)
  expect(duck.ducking).toBe(true)
  expect(duck.hitbox.bottom - duck.hitbox.top).toBe(35)
  for (const engine of [standing, duck]) {
    engine.obstacles = [{ x: 130, width: 38, height: 20, bottom: 44, kind: 'mid-bird' }]
    advance(engine, 0.5)
  }
  expect(standing.phase).toBe('gameOver')
  expect(duck.phase).toBe('running')
  const normal = running(),
    drop = running()
  normal.jump()
  drop.jump()
  advance(normal, 0.16)
  advance(drop, 0.16)
  drop.setDuck(true)
  advance(drop, 0.15)
  advance(normal, 0.15)
  expect(drop.y).toBe(0)
  expect(normal.y).toBeLessThan(-85)
})

test('首障碍延迟；高速碰撞结算冻结，重开完全重置' /**
 * 保护开始体验并验证死亡不是穿透。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  advance(engine, 1.9)
  expect(engine.obstacles).toHaveLength(0)
  engine.elapsed = 150
  engine.obstacles = [{ x: 145, width: 25, height: 60, kind: 'tall-cactus' }]
  advance(engine, 0.2)
  expect(engine.phase).toBe('gameOver')
  const distance = engine.distance
  advance(engine, 5)
  expect(engine.distance).toBe(distance)
  engine.restart()
  expect(engine.obstacles).toEqual([])
  expect(engine.distance).toBe(0)
})

test('20 个种子各存活 300 秒，解锁顺序正确且涵盖每种模式与冲刺' /**
 * 回放真实生成、输入、碰撞，作为通过性的长期见证，不使用无敌或清除障碍。
 * @returns 无返回值。
 * @throws 机器人碰撞时携带种子与赛况抛错。
 */, () => {
  const all = new Set<string>()
  for (let seed = 1; seed <= 20; seed++) {
    const engine = running(seed)
    const observed = new Set<number>()
    for (let i = 0; i < 300 * 120; i++) {
      perfectBot(engine)
      engine.advance(RUNNER.step)
      for (const obstacle of engine.obstacles) {
        // 解锁只在生成时检查一次，避免对同一个障碍重复数百次断言。
        if (observed.has(obstacle.pattern!)) continue
        observed.add(obstacle.pattern!)
        all.add(obstacle.kind)
        if (engine.elapsed < 20) expect(['rock', 'cactus']).toContain(obstacle.kind)
        if (engine.elapsed < 45) expect(obstacle.kind).not.toContain('bird')
        if (engine.elapsed < 75) expect(obstacle.kind).not.toContain('combo')
      }
      if (engine.phase !== 'running')
        throw new Error(
          `seed=${seed} time=${engine.elapsed} y=${engine.y} obstacles=${JSON.stringify(engine.obstacles)}`
        )
    }
    expect(engine.elapsed).toBeCloseTo(300, 5)
  }
  expect(all.size).toBe(9)
}, 30_000)

test('相同种子与输入可以精确回放到 LV5' /**
 * 确认随机、输入、生成和鸟动作所用时钟与墙钟无关。
 * @returns 无返回值。
 */, () => {
  const a = running(20261021),
    b = running(20261021)
  for (let i = 0; i < 150 * 120; i++) {
    perfectBot(a)
    perfectBot(b)
    a.advance(RUNNER.step)
    b.advance(RUNNER.step)
  }
  expect(a.phase).toBe('running')
  expect(a.obstacles).toEqual(b.obstacles)
  expect(a.distance).toBe(b.distance)
  expect(a.y).toBe(b.y)
})
