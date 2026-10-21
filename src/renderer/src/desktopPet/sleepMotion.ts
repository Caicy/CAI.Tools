/**
 * 计算以落地点为锚的睡眠倾摆与天线反向摆动，供同一暂停时钟驱动。
 * @param elapsedMs 睡眠动作已累计的有效毫秒数。
 * @returns 身体剪切斜率、天线根部高度及反向剪切倍率。
 */
export function getSleepSway(elapsedMs: number): {
  slope: number
  antennaRootY: number
  antennaCounterRatio: number
} {
  // 一个往返与八帧呼吸同为 3200ms；约 1.4 度倾摆不改变落地基线。
  return {
    slope: Math.sin((Math.max(0, elapsedMs) / 3200) * Math.PI * 2) * 0.025,
    antennaRootY: 108,
    antennaCounterRatio: 6
  }
}
