export interface PetRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 将浮窗夹取到相交面积最大的工作区；失去原屏幕时回到主屏。
 * @param bounds 期望窗口矩形，单位为 DIP。
 * @param areas 当前显示器工作区，主屏应放在第一项。
 * @returns 完整夹取后的窗口矩形。
 */
export function clampPetBounds(bounds: PetRect, areas: PetRect[]): PetRect {
  if (!areas.length) return bounds
  let target = areas[0]
  let best = 0
  for (const area of areas) {
    const overlap =
      Math.max(
        0,
        Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
      ) *
      Math.max(
        0,
        Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
      )
    if (overlap > best) {
      target = area
      best = overlap
    }
  }
  return {
    ...bounds,
    x: Math.round(
      Math.max(target.x, Math.min(bounds.x, target.x + Math.max(0, target.width - bounds.width)))
    ),
    y: Math.round(
      Math.max(target.y, Math.min(bounds.y, target.y + Math.max(0, target.height - bounds.height)))
    )
  }
}
