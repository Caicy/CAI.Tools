import { expect, test } from 'vitest'
import {
  runnerBounds,
  clampRunnerBounds,
  restoreRunnerBounds
} from '../../src/main/core/desktopPet/runnerGeometry'
import { readRunnerRecord, readRunnerPosition } from '../../src/shared/desktopPetRunnerTypes'
import { getStorageScopeForKey, isAccountSyncDoc } from '../../src/main/core/storage/storageRouting'
import { HOST_STORAGE_KEYS, toHostDocId } from '../../src/shared/storageKeys'

test('跑道位于负坐标显示器工作区内，保留任务栏和边距' /**
 * 检查坐标与工作区下沿。
 * @returns 无返回值。
 */, () => {
  expect(runnerBounds({ x: -1280, y: -100, width: 1280, height: 984 })).toEqual({
    x: -1040,
    y: 628,
    width: 800,
    height: 240
  })
  const small = runnerBounds({ x: 0, y: 0, width: 640, height: 480 })
  expect(small.width).toBe(608)
  expect(small.height).toBe(182)
})

test('工作区太小则拒绝游戏，不生成不可操作窗口' /**
 * 验证边界失败明确可恢复。
 * @returns 无返回值。
 */, () => {
  expect(
    /**
     * 尝试在过小屏幕布局。
     * @returns 布局结果。
     */
    () => runnerBounds({ x: 0, y: 0, width: 400, height: 240 })
  ).toThrow('工作区太小')
})

test('损坏纪录回落为零，纪录限定在设备库且不进入账户同步' /**
 * 覆盖无穷值、负值、超限及未知版本。
 * @returns 无返回值。
 */, () => {
  for (const value of [
    null,
    {},
    { version: 2, bestDistance: 2 },
    { version: 1, bestDistance: -2 },
    { version: 1, bestDistance: Infinity },
    { version: 1, bestDistance: 1e20 }
  ])
    expect(readRunnerRecord(value).bestDistance).toBe(0)
  expect(readRunnerRecord({ version: 1, bestDistance: 25.9 }).bestDistance).toBe(25)
  const key = toHostDocId(HOST_STORAGE_KEYS.desktopPetRunner)
  expect(getStorageScopeForKey(key)).toBe('device')
  expect(isAccountSyncDoc(key)).toBe(false)
})

test('负坐标工作区夹取全窗口，保留有效当前位置；小屏等比缩放' /**
 * 检查四边夹取和热插拔，不重新居中。
 * @returns 无返回值。
 */, () => {
  const area = { x: -1280, y: -100, width: 1280, height: 984 }
  const size = { width: 800, height: 240 }
  expect(clampRunnerBounds({ ...size, x: -1500, y: 900 }, area)).toEqual({
    ...size,
    x: -1280,
    y: 644
  })
  expect(clampRunnerBounds({ ...size, x: -300, y: -200 }, area)).toEqual({
    ...size,
    x: -800,
    y: -100
  })
  const current = { ...size, x: -1100, y: 100 }
  expect(clampRunnerBounds(current, area)).toEqual(current)
  const small = clampRunnerBounds(current, { x: 0, y: 0, width: 640, height: 480 })
  expect(small).toEqual({ x: 0, y: 100, width: 608, height: 182 })
})

test('设备位置防御性解析、完整恢复、移除屏幕及边缘不适配回落' /**
 * 覆盖损坏文档、负屏幕、设备归属与默认恢复。
 * @returns 无返回值。
 */, () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const secondary = { x: -1280, y: -100, width: 1280, height: 984 }
  const saved = { version: 1, x: -1100, y: 100 }
  for (const value of [
    null,
    {},
    3,
    'x',
    { ...saved, version: 2 },
    { ...saved, x: NaN },
    { ...saved, y: Infinity },
    { ...saved, x: 1e20 },
    { ...saved, y: '100' },
    { ...saved, x: 2.5 }
  ])
    expect(readRunnerPosition(value)).toBeNull()
  expect(restoreRunnerBounds(saved, [primary, secondary], primary)).toEqual({
    width: 800,
    height: 240,
    x: -1100,
    y: 100
  })
  expect(restoreRunnerBounds(saved, [primary], primary)).toEqual(runnerBounds(primary))
  expect(restoreRunnerBounds({ ...saved, x: -400 }, [primary, secondary], primary)).toEqual(
    runnerBounds(primary)
  )
  const key = toHostDocId(HOST_STORAGE_KEYS.desktopPetRunnerPosition)
  expect(getStorageScopeForKey(key)).toBe('device')
  expect(isAccountSyncDoc(key)).toBe(false)
})
