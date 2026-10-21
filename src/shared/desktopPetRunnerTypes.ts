export type RunnerPhase = 'ready' | 'countdown' | 'running' | 'paused' | 'gameOver'

export interface RunnerRecord {
  version: 1
  bestDistance: number
}

export interface RunnerSaveResult {
  bestDistance: number
  saved: boolean
}

export type RunnerDragIntent = { type: 'start' | 'move'; x: number; y: number } | { type: 'end' }

export interface RunnerPosition {
  version: 1
  x: number
  y: number
}

export interface DesktopPetRunnerBridge {
  ready(): Promise<RunnerRecord>
  save(distance: number): Promise<RunnerSaveResult>
  drag(intent: RunnerDragIntent): void
  /** 仅隔离源码 E2E 窗口传入，生产窗口恒为 false。 */
  testEnabled: boolean
  exit(): void
  failed(): void
  onPause(callback: () => void): () => void
}

export const MAX_RUNNER_DISTANCE = 10_000_000

/**
 * 防御性读取设备位置，未知版本、非整数或异常坐标均不恢复。
 * @param value 未知数据库文档。
 * @returns 有效位置或 null。
 */
export function readRunnerPosition(value: unknown): RunnerPosition | null {
  // 只接受有限整数 DIP；合理上限足够多显示器且拒绝异常文档。
  const position = value as Partial<RunnerPosition> | null
  if (
    position?.version !== 1 ||
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    !Number.isSafeInteger(position.x) ||
    !Number.isSafeInteger(position.y) ||
    Math.abs(position.x) > 1_000_000 ||
    Math.abs(position.y) > 1_000_000
  )
    return null
  return { version: 1, x: position.x, y: position.y }
}

/**
 * 读取版本化本地纪录，损坏或旧格式回落为零。
 * @param value 数据库中的未知文档。
 * @returns 已校验的距离纪录。
 */
export function readRunnerRecord(value: unknown): RunnerRecord {
  const record = value as Partial<RunnerRecord> | null
  const best = record?.bestDistance
  return {
    version: 1,
    bestDistance:
      record?.version === 1 &&
      typeof best === 'number' &&
      Number.isFinite(best) &&
      best >= 0 &&
      best <= MAX_RUNNER_DISTANCE
        ? Math.floor(best)
        : 0
  }
}
