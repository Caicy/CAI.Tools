import { describe, expect, it } from 'vitest'
import { PetIdleCycle } from '../../src/main/core/desktopPet/idleCycle'

describe('desktop pet system idle cycle', /**
 * 验证可注入的系统输入来源、计时、确认和冻结边界。
 * @returns 无返回值。
 */ () => {
  it('drinks at 5, 15, 25 seconds and sleeps only after the third animation finishes', /**
   * 验证生产默认时间线，不依赖鼠标焦点或真实计时器。
   * @returns 无返回值。
   */ () => {
    let seconds = 0
    const cycle = new PetIdleCycle(
      /**
       * 提供当前测试空闲秒数。
       * @returns 系统空闲秒数。
       */ () => seconds
    )
    expect(cycle.sample()).toBeNull()
    for (let drink = 1; drink <= 3; drink++) {
      seconds = 5 + (drink - 1) * 10 - 0.001
      expect(cycle.sample()).toBeNull()
      seconds += 0.001
      const request = cycle.sample()!
      expect(request).toMatchObject({ action: 'coffee', drink })
      // 同一阈值不能重复请求；未完成的第三杯不能提前睡眠。
      expect(cycle.sample()).toBeNull()
      expect(cycle.snapshot().action).toBe('coffee')
      expect(cycle.finish(request.cycle, drink)?.action).toBe(drink === 3 ? 'sleeping' : 'idle')
      expect(cycle.finish(request.cycle, drink)).toBeNull()
    }
    seconds = 300
    expect(cycle.sample()).toBeNull()
    expect(cycle.snapshot().action).toBe('sleeping')
    // 秒数下降是系统鼠标或键盘输入，睡眠必须重置整个周期。
    seconds = 0
    expect(cycle.sample()).toMatchObject({ action: 'idle', drink: 0 })
    seconds = 4
    expect(cycle.sample()).toBeNull()
    seconds = 5
    expect(cycle.sample()).toMatchObject({ action: 'coffee', drink: 1 })
  })

  it('rejects stale completions after input and skips paused/hidden idle increments', /**
   * 验证旧确认失效、冻结和明确手势重置。
   * @returns 无返回值。
   */ () => {
    let seconds = 0
    const cycle = new PetIdleCycle(
      /**
       * 提供可控系统采样。
       * @returns 当前空闲秒数。
       */ () => seconds
    )
    cycle.sample()
    seconds = 5
    const old = cycle.sample()!
    seconds = 0
    expect(cycle.sample()?.action).toBe('idle')
    expect(cycle.finish(old.cycle, old.drink)).toBeNull()
    seconds = 2
    cycle.sample()
    cycle.suspend()
    seconds = 60
    expect(cycle.sample()).toBeNull()
    seconds = 62.999
    expect(cycle.sample()).toBeNull()
    seconds = 63
    expect(cycle.sample()?.drink).toBe(1)
    // 合成按压不一定更新操作系统来源，因此显式重置必须重新锚定当前采样。
    cycle.reset()
    expect(cycle.sample()).toBeNull()
    seconds = 68
    expect(cycle.sample()?.drink).toBe(1)
  })

  it('detects input during a long pause even when the new idle seconds exceed the old sample', /**
   * 验证系统空闲起点而不是单纯的秒数大小，防止长暂停后仍保持旧睡眠。
   * @returns 无返回值。
   */ () => {
    let seconds = 0,
      now = 0
    const cycle = new PetIdleCycle(
      /**
       * 提供受控系统来源。
       * @returns 空闲秒数。
       */ () => seconds,
      1,
      /**
       * 提供与系统采样独立的测试时钟。
       * @returns 采样毫秒数。
       */ () => now
    )
    cycle.sample()
    seconds = 5
    now = 5000
    const request = cycle.sample()!
    cycle.finish(request.cycle, request.drink)
    cycle.suspend()
    // 暂停持续 60s，但期间输入使系统仅空闲了 10s（仍大于旧值 5s）。
    now = 65000
    seconds = 10
    expect(cycle.sample()).toMatchObject({ action: 'idle', drink: 0 })
    seconds = 15
    now = 70000
    expect(cycle.sample()).toMatchObject({ action: 'coffee', drink: 1 })
  })

  it('scales thresholds for tests but falls back safely for invalid overrides', /**
   * 验证生产默认值不受非法测试参数影响。
   * @returns 无返回值。
   */ () => {
    let seconds = 0
    const fast = new PetIdleCycle(
      /**
       * 提供缩短时间线的空闲来源。
       * @returns 当前空闲秒数。
       */ () => seconds,
      0.2
    )
    fast.sample()
    seconds = 1
    expect(fast.sample()?.action).toBe('coffee')
    for (const scale of [0, NaN, -1, Infinity]) {
      seconds = 0
      const normal = new PetIdleCycle(
        /**
         * 提供非法比例验证的空闲来源。
         * @returns 当前空闲秒数。
         */ () => seconds,
        scale
      )
      normal.sample()
      seconds = 1
      expect(normal.sample()).toBeNull()
      seconds = 5
      expect(normal.sample()?.action).toBe('coffee')
    }
  })
})
