import { expect, test } from 'vitest'
import { RunnerEngine, RUNNER } from '../../src/renderer/src/desktopPet/runner/engine'

/**
 * 以正常刷新率推进指定时长，不触发长帧保护。
 * @param engine 被测引擎。
 * @param seconds 推进秒数。
 * @param fps 模拟帧率。
 * @returns 无返回值。
 */
function advance(engine: RunnerEngine, seconds: number, fps = 60): void {
  for (let i = 0; i < Math.round(seconds * fps); i++) engine.advance(1 / fps)
}

/**
 * 构造使用稳定随机源并完成倒计时的引擎。
 * @returns 正在运行的游戏引擎。
 */
function running(): RunnerEngine {
  const engine = new RunnerEngine(
    /**
     * 固定生成石块和最小间隔。
     * @returns 固定随机样本。
     */
    () => 0
  )
  engine.restart()
  advance(engine, 3)
  return engine
}

test('准备、倒计时不计分，开始输入不触发跳跃' /**
 * 验证进入游戏的状态边界。
 * @returns 无返回值。
 */, () => {
  const engine = new RunnerEngine()
  expect(engine.jump()).toBe(false)
  engine.restart()
  advance(engine, 2)
  expect(engine.distance).toBe(0)
  expect(engine.phase).toBe('countdown')
  advance(engine, 1)
  expect(engine.phase).toBe('running')
  expect(engine.y).toBe(0)
})

test('落地才能跳，滞空高度与时间符合单段跳设计' /**
 * 验证重复输入、最高点及落地。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  expect(engine.jump()).toBe(true)
  expect(engine.jump()).toBe(false)
  advance(engine, 0.3)
  expect(engine.y).toBeLessThan(-85)
  expect(engine.y).toBeGreaterThan(-98)
  expect(engine.jump()).toBe(false)
  advance(engine, 0.4)
  expect(engine.y).toBe(0)
  expect(engine.velocity).toBe(0)
  expect(engine.jump()).toBe(true)
})

test('暂停、后台长帧及继续倒计时均不增加距离' /**
 * 验证后台恢复不会瞬间推进物理。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  advance(engine, 1)
  engine.jump()
  advance(engine, 0.1)
  const distance = engine.distance
  const y = engine.y
  engine.advance(20)
  expect(engine.phase).toBe('paused')
  expect(engine.pauseReason).toBe('long-frame')
  advance(engine, 10)
  expect(engine.distance).toBe(distance)
  expect(engine.y).toBe(y)
  engine.resume()
  advance(engine, 3)
  expect(engine.distance).toBe(distance)
  advance(engine, 0.2)
  expect(engine.distance).toBeGreaterThan(distance)
})

test('不同帧率保持相同物理和计分' /**
 * 验证固定步长不会随刷新率改变游戏速度。
 * @returns 无返回值。
 */, () => {
  const slow = running()
  const fast = running()
  slow.jump()
  fast.jump()
  advance(slow, 1.5, 30)
  advance(fast, 1.5, 144)
  expect(slow.distance).toBeCloseTo(fast.distance, 6)
  expect(slow.y).toBe(fast.y)
  expect(slow.phase).toBe('running')
})

test('最高速度下障碍不会穿过角色，结束后冻结并可重开' /**
 * 使用外部可见赛况构造高速碰撞。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  engine.elapsed = 120
  engine.obstacles = [{ x: 145, width: 25, height: 48, kind: 'cactus' }]
  engine.advance(0.2)
  expect(engine.speed).toBe(RUNNER.maxSpeed)
  expect(engine.phase).toBe('gameOver')
  const distance = engine.distance
  advance(engine, 5)
  expect(engine.distance).toBe(distance)
  engine.restart()
  expect(engine.obstacles).toHaveLength(0)
  expect(engine.distance).toBe(0)
  expect(engine.phase).toBe('countdown')
})

test('提前起跳可以跨过仙人掌，碰撞盒不会使用整个透明图格' /**
 * 验证障碍通过过程包含实际物理运动。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  engine.obstacles = [{ x: 184, width: 25, height: 48, kind: 'cactus' }]
  engine.jump()
  advance(engine, 0.8)
  expect(engine.phase).toBe('running')
  expect(engine.y).toBe(0)
})

test('首个障碍延迟生成，连续障碍留出落地余量' /**
 * 在最高速度下采集生成序列并检查空间下限。
 * @returns 无返回值。
 */, () => {
  const engine = running()
  advance(engine, 1.9)
  expect(engine.obstacles).toHaveLength(0)
  engine.elapsed = 120
  let pairs = 0
  for (let i = 0; i < 1200; i++) {
    // 本用例隔离生成器，主动保持角色在碰撞区域上方。
    engine.y = -150
    engine.velocity = 0
    engine.advance(1 / 120)
    for (let j = 1; j < engine.obstacles.length; j++) {
      expect(engine.obstacles[j].x - engine.obstacles[j - 1].x).toBeGreaterThan(480)
      pairs++
    }
  }
  expect(pairs).toBeGreaterThan(0)
  expect(engine.phase).toBe('running')
})

test('固定种子的变化障碍序列可以重复回放' /**
 * 验证随机类型、宽度与间隔均受注入种子控制。
 * @returns 无返回值。
 */, () => {
  /**
   * 产生固定种子的可复现随机源。
   * @param seed 初始种子。
   * @returns 随机数函数。
   */
  function seeded(seed: number): () => number {
    /**
     * 更新线性同余状态并映射到零到一。
     * @returns 当前随机数。
     */
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
  }
  const a = new RunnerEngine(seeded(20261020))
  const b = new RunnerEngine(seeded(20261020))
  a.restart()
  b.restart()
  advance(a, 3)
  advance(b, 3)
  const kinds = new Set<string>()
  for (let i = 0; i < 1800; i++) {
    // 本用例只观测生成器，碰撞通过独立用例验证。
    a.y = b.y = -150
    a.velocity = b.velocity = 0
    a.advance(1 / 60)
    b.advance(1 / 60)
    expect(a.obstacles).toEqual(b.obstacles)
    for (const obstacle of a.obstacles) kinds.add(obstacle.kind)
  }
  expect(kinds.size).toBe(2)
})
