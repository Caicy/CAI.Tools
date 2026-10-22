import type { PetUtterance } from './desktopPetCompanionTypes'

export type PetAction = 'idle' | 'running-right' | 'running-left' | 'waving' | 'coffee' | 'sleeping'

export interface PetIdleState {
  action: 'idle' | 'coffee' | 'sleeping'
  drink: number
  cycle: number
}
export type PetSize = 'small' | 'medium' | 'large'

export interface DesktopPetConfig {
  version: 1
  mode: 'ball' | 'pet'
  petId: 'builtin-default'
  size: PetSize
  paused: boolean
  lookEnabled: false
}

export interface PetClip {
  row: number
  frames: number
  durationsMs: number[]
  loop: boolean
}

export interface PetManifest {
  schemaVersion: 1
  id: string
  image: string
  cell: { width: number; height: number }
  columns: number
  rows: number
  clips: Record<PetAction, PetClip>
}

export interface PetSnapshot {
  config: DesktopPetConfig
  letter: string
  error: string | null
  idle: PetIdleState
}

export type PetIntent =
  | { type: 'press'; active: boolean }
  | { type: 'fileHover'; active: boolean }
  | { type: 'click' | 'doubleClick' | 'dragEnd' | 'contextMenu' }
  | { type: 'dragStart'; x: number; y: number }
  | { type: 'frame'; index: number }
  | { type: 'coffeeFinished'; cycle: number; drink: number }
  | { type: 'failure'; message: string }

export interface DesktopPetBridge {
  ready(): Promise<PetSnapshot>
  send(intent: PetIntent): void
  masks(masks: Uint8Array[], width: number, height: number): void
  drop(files: File[]): void
  onSnapshot(callback: (snapshot: PetSnapshot) => void): () => void
  onIdle(callback: (state: PetIdleState) => void): () => void
  onGaze(callback: (point: { x: number; y: number }) => void): () => void
  onReaction(callback: (line: PetUtterance) => void): () => void
}

export const DEFAULT_DESKTOP_PET_CONFIG: DesktopPetConfig = {
  version: 1,
  mode: 'pet',
  petId: 'builtin-default',
  size: 'medium',
  paused: false,
  lookEnabled: false
}

/**
 * 将设备配置规范为桌面宠物配置，兼容旧悬浮球数据。
 * @param value 数据库或设置页输入。
 * @returns 不共享引用的规范配置。
 */
export function normalizeDesktopPetConfig(value: unknown): DesktopPetConfig {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  // 统一使用小薄荷；保留旧版尺寸和暂停偏好，球形仅供加载失败时应急使用。
  return {
    ...DEFAULT_DESKTOP_PET_CONFIG,
    mode: 'pet',
    size: data.size === 'small' || data.size === 'large' ? data.size : 'medium',
    paused: data.paused === true
  }
}
