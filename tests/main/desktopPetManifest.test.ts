import { describe, expect, it } from 'vitest'
import { PET_ACTIONS, validatePetManifest } from '../../src/shared/desktopPetManifest'
import {
  DEFAULT_DESKTOP_PET_CONFIG,
  normalizeDesktopPetConfig,
  type PetManifest
} from '../../src/shared/desktopPetTypes'

/**
 * 创建满足 P0 网格约束的测试清单。
 * @param overrides 要覆盖的清单字段。
 * @returns 可供验证器使用的测试清单。
 */
function createManifest(overrides: Partial<PetManifest> = {}): PetManifest {
  const clip = {
    row: 0,
    frames: 8,
    durationsMs: Array.from({ length: 8 }, () => 120),
    loop: true
  }
  return {
    schemaVersion: 1,
    id: 'builtin-default',
    image: 'atlas.png',
    cell: { width: 192, height: 256 },
    columns: 8,
    rows: 4,
    clips: {
      idle: { ...clip, row: 0 },
      'running-right': { ...clip, row: 1 },
      'running-left': { ...clip, row: 2 },
      waving: { ...clip, row: 3, loop: false }
    },
    ...overrides
  }
}

describe('desktop pet manifest', () => {
  it('accepts the P0 8x4 atlas contract', () => {
    expect(validatePetManifest(createManifest(), 1536, 1024)).toEqual(createManifest())
    expect(PET_ACTIONS).toEqual(['idle', 'running-right', 'running-left', 'waving'])
  })

  it.each([
    ['absolute path', { image: 'C:\\pets\\atlas.png' }],
    ['remote URL', { image: 'https://example.test/atlas.png' }],
    ['path traversal', { image: '../atlas.png' }],
    ['wrong extension', { image: 'atlas.jpg' }]
  ])('rejects an unsafe image reference: %s', (_name, override) => {
    expect(() => validatePetManifest(createManifest(override), 1536, 1024)).toThrow()
  })

  it('rejects a decoded image whose dimensions do not match the declared grid', () => {
    expect(() => validatePetManifest(createManifest(), 1535, 1024)).toThrow(
      '宠物图片尺寸与网格不匹配'
    )
    expect(() => validatePetManifest(createManifest(), 1536, 1025)).toThrow()
  })

  it('rejects a decoded image over the pixel budget', () => {
    const manifest = createManifest({ cell: { width: 1000, height: 1000 }, columns: 4, rows: 4 })
    expect(() => validatePetManifest(manifest, 4000, 4000)).toThrow('宠物图片尺寸与网格不匹配')
  })

  it.each([
    [
      'missing action',
      (manifest: PetManifest) => {
        delete manifest.clips.idle
      }
    ],
    [
      'row outside grid',
      (manifest: PetManifest) => {
        manifest.clips.idle.row = 4
      }
    ],
    [
      'too many frames',
      (manifest: PetManifest) => {
        manifest.clips.idle.frames = 9
      }
    ],
    [
      'duration count mismatch',
      (manifest: PetManifest) => {
        manifest.clips.idle.durationsMs = [120]
      }
    ],
    [
      'duration below minimum',
      (manifest: PetManifest) => {
        manifest.clips.idle.durationsMs[0] = 49
      }
    ],
    [
      'duration above maximum',
      (manifest: PetManifest) => {
        manifest.clips.idle.durationsMs[0] = 2001
      }
    ]
  ])('rejects invalid clip data: %s', (_name, mutate) => {
    const manifest = createManifest()
    mutate(manifest)
    expect(() => validatePetManifest(manifest, 1536, 1024)).toThrow()
  })
})

describe('desktop pet configuration normalization', () => {
  it('uses pet mode by default for missing or invalid data', () => {
    expect(normalizeDesktopPetConfig(undefined)).toEqual(DEFAULT_DESKTOP_PET_CONFIG)
    expect(normalizeDesktopPetConfig({ mode: 'unknown', size: 'huge', paused: 'yes' })).toEqual(
      DEFAULT_DESKTOP_PET_CONFIG
    )
  })

  it('migrates a legacy ball record to pet mode while preserving size and pause', () => {
    expect(
      normalizeDesktopPetConfig({
        mode: 'ball',
        size: 'large',
        paused: true,
        petId: 'builtin-default',
        version: 1,
        lookEnabled: false
      })
    ).toEqual({ ...DEFAULT_DESKTOP_PET_CONFIG, mode: 'pet', size: 'large', paused: true })
  })

  it('accepts only the P0 mode, size and pause fields', () => {
    expect(
      normalizeDesktopPetConfig({ mode: 'pet', size: 'large', paused: true, lookEnabled: true })
    ).toEqual({ ...DEFAULT_DESKTOP_PET_CONFIG, mode: 'pet', size: 'large', paused: true })
  })

  it('does not share a mutable result with the default object', () => {
    const normalized = normalizeDesktopPetConfig(null)
    normalized.mode = 'ball'
    expect(DEFAULT_DESKTOP_PET_CONFIG.mode).toBe('pet')
  })
})
