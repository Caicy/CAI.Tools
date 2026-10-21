import type { Rectangle } from 'electron'
import { readRunnerPosition } from '../../../shared/desktopPetRunnerTypes'

/**
 * 在工作区底部放置等比例跑道，过小工作区拒绝启动。
 * @param area 显示器可用工作区，单位 DIP。
 * @returns 跑道窗口边界。
 * @throws 工作区不足以提供可读画面时抛错。
 */
export function runnerBounds(area: Rectangle): Rectangle {
  const scale = Math.min(1, (area.width - 32) / 800, (area.height - 32) / 240)
  if (!Number.isFinite(scale) || scale < 0.6) throw new Error('屏幕工作区太小，无法展开快跑跑道')
  const width = Math.floor(800 * scale)
  const height = Math.floor(240 * scale)
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + area.height - height - 16
  }
}

/**
 * 将当前位置完整夹取到工作区；只在尺寸不再合适时等比缩小。
 * @param bounds 当前窗口边界。
 * @param area 当前显示器工作区。
 * @returns 可操作窗口边界。
 * @throws 工作区太小无法保持可读时抛错。
 */
export function clampRunnerBounds(bounds: Rectangle, area: Rectangle): Rectangle {
  // 热插拔保留原位置而非重新居中；仅尺寸超界才重新选择缩放比例。
  const size =
    bounds.width <= area.width && bounds.height <= area.height ? bounds : runnerBounds(area)
  return {
    width: size.width,
    height: size.height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - size.width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - size.height))
  }
}

/**
 * 仅恢复仍完整落在已连接工作区的设备位置，否则使用默认布局。
 * @param value 未知设备文档。
 * @param areas 已连接工作区。
 * @param fallback 宠物当前显示器工作区。
 * @returns 恢复或默认窗口边界。
 * @throws 默认工作区过小时抛错。
 */
export function restoreRunnerBounds(
  value: unknown,
  areas: Rectangle[],
  fallback: Rectangle
): Rectangle {
  const position = readRunnerPosition(value)
  if (position) {
    for (const area of areas) {
      // 旧设备/DPI位置必须完整可见，不把已移除显示器的位置静默搬到另一屏。
      try {
        const size = runnerBounds(area)
        if (
          position.x >= area.x &&
          position.y >= area.y &&
          position.x + size.width <= area.x + area.width &&
          position.y + size.height <= area.y + area.height
        )
          return { ...size, x: position.x, y: position.y }
      } catch {
        /* 不可读显示器不作为恢复目标。 */
      }
    }
  }
  return runnerBounds(fallback)
}
