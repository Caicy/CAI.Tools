import type { Rectangle } from 'electron'

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
