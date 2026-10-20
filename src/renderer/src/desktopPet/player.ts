import type { PetClip } from '../../../shared/desktopPetTypes'

/**
 * 按累计播放时间计算当前帧，非循环动画在末帧结束。
 * @param clip 当前动作。
 * @param elapsedMs 从本次动作开始累计的有效毫秒数。
 * @returns 帧号、剩余时长及是否播放结束。
 */
export function getPetFrame(
  clip: PetClip,
  elapsedMs: number
): { frame: number; remainingMs: number; done: boolean } {
  const total = clip.durationsMs.reduce(
    /**
     * 累计帧时间或掩码占用量。
     * @param sum 当前回调输入。
     * @param ms 当前回调输入。
     * @returns 更新后的累计值。
     */
    (sum, ms) => sum + ms,
    0
  )
  if (!clip.loop && elapsedMs >= total)
    return { frame: clip.frames - 1, remainingMs: 0, done: true }
  let offset = Math.max(0, elapsedMs) % total
  for (let frame = 0; frame < clip.frames; frame++) {
    if (offset < clip.durationsMs[frame])
      return { frame, remainingMs: clip.durationsMs[frame] - offset, done: false }
    offset -= clip.durationsMs[frame]
  }
  return { frame: 0, remainingMs: clip.durationsMs[0], done: false }
}
