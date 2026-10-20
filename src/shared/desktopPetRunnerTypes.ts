export type RunnerPhase = 'ready' | 'countdown' | 'running' | 'paused' | 'gameOver'

export interface RunnerRecord {
  version: 1
  bestDistance: number
}

export interface RunnerSaveResult {
  bestDistance: number
  saved: boolean
}

export interface DesktopPetRunnerBridge {
  ready(): Promise<RunnerRecord>
  save(distance: number): Promise<RunnerSaveResult>
  exit(): void
  failed(): void
  onPause(callback: () => void): () => void
}

export const MAX_RUNNER_DISTANCE = 10_000_000

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
