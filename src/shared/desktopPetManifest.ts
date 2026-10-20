import type { PetAction, PetManifest } from './desktopPetTypes'

export const PET_ACTIONS: PetAction[] = ['idle', 'running-right', 'running-left', 'waving']

/**
 * 验证静态精灵图清单与实际解码尺寸，拒绝越界及远程素材。
 * @param value 待验证清单。
 * @param imageWidth 实际图片宽度。
 * @param imageHeight 实际图片高度。
 * @returns 已通过边界检查的清单。
 * @throws 清单、网格或帧时长不合法时抛错。
 */
export function validatePetManifest(
  value: unknown,
  imageWidth: number,
  imageHeight: number
): PetManifest {
  const m = value as PetManifest
  if (
    !m ||
    m.schemaVersion !== 1 ||
    typeof m.id !== 'string' ||
    typeof m.image !== 'string' ||
    !/^[\w-]+\.(png|webp)$/.test(m.image)
  ) {
    throw new Error('宠物素材清单无效')
  }
  // 先约束解码面积与整数网格，防止后续切片越界。
  const dimensions = [m.columns, m.rows, m.cell?.width, m.cell?.height]
  if (
    dimensions.some(
      /**
       * 判断当前元素是否触及输入校验边界。
       * @param n 当前回调输入。
       * @returns 是否满足检查条件。
       */
      (n) => !Number.isInteger(n) || n <= 0
    ) ||
    imageWidth * imageHeight > 4_000_000 ||
    imageWidth !== m.columns * m.cell.width ||
    imageHeight !== m.rows * m.cell.height ||
    m.columns * m.rows > 128
  ) {
    throw new Error('宠物图片尺寸与网格不匹配')
  }
  for (const action of PET_ACTIONS) {
    const clip = m.clips?.[action]
    if (
      !clip ||
      !Number.isInteger(clip.row) ||
      clip.row < 0 ||
      clip.row >= m.rows ||
      !Number.isInteger(clip.frames) ||
      clip.frames < 1 ||
      clip.frames > m.columns ||
      typeof clip.loop !== 'boolean' ||
      !Array.isArray(clip.durationsMs) ||
      clip.durationsMs.length !== clip.frames ||
      clip.durationsMs.some(
        /**
         * 判断当前元素是否触及输入校验边界。
         * @param ms 当前回调输入。
         * @returns 是否满足检查条件。
         */
        (ms) => !Number.isFinite(ms) || ms < 50 || ms > 2000
      )
    ) {
      throw new Error(`宠物动作无效：${action}`)
    }
  }
  return m
}
