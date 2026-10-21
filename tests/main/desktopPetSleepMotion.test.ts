import { describe, expect, it } from 'vitest'
import { getSleepSway } from '../../src/renderer/src/desktopPet/sleepMotion'

describe('sleep sway', /**
 * 验证摆动方向、连续衔接与冻结时钟契约。
 * @returns 无返回值。
 */ () => {
  it('sways both ways, keeps the ground fixed and moves the antenna tip against the body', /**
   * 检查半周期对称及天线顶端实际位移方向，避免仅反转局部角度却仍同向移动。
   * @returns 无返回值。
   */ () => {
    for (const time of [800, 2400]) {
      const { slope, antennaRootY, antennaCounterRatio } = getSleepSway(time)
      const rootOffset = (230 - antennaRootY) * slope
      const tipOffset = rootOffset + (80 - antennaRootY) * slope * antennaCounterRatio
      expect(rootOffset * tipOffset).toBeLessThan(0)
      expect(Math.abs(rootOffset)).toBeLessThan(5)
      expect(Math.abs(tipOffset)).toBeLessThan(5)
      // 上下切片在根部拥有同一位移，避免天线断开。
      expect(rootOffset + (antennaRootY - antennaRootY) * slope * antennaCounterRatio).toBe(
        rootOffset
      )
    }
    expect(getSleepSway(800).slope).toBeCloseTo(-getSleepSway(2400).slope)
    expect(getSleepSway(0).slope).toBeCloseTo(getSleepSway(3200).slope)
  })
})
