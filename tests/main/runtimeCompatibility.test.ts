import { describe, expect, it } from 'vitest'
import {
  checkRuntimeCompatibility,
  EXPECTED_ELECTRON_VERSION,
  LOCAL_RUNTIME_REBUILD_INSTRUCTIONS
} from '../../src/main/runtimeCompatibility'

describe('checkRuntimeCompatibility', () => {
  it('directs incompatible local builds to rebuild from local edition source', () => {
    expect(LOCAL_RUNTIME_REBUILD_INSTRUCTIONS).toContain('CAI.Tools 本地版源码')
    expect(LOCAL_RUNTIME_REBUILD_INSTRUCTIONS).toContain('重新安装依赖并构建')
    expect(LOCAL_RUNTIME_REBUILD_INSTRUCTIONS).not.toContain('https://')
  })

  it.each(['win32', 'darwin'] as const)(
    'allows the packaged %s app on the exact target Electron version',
    (platform) => {
      expect(
        checkRuntimeCompatibility({
          platform,
          isPackaged: true,
          runtimeElectronVersion: EXPECTED_ELECTRON_VERSION
        })
      ).toEqual({ compatible: true, blocked: false })
    }
  )

  it.each(['win32', 'darwin'] as const)(
    'blocks the packaged %s app on an older Electron version',
    (platform) => {
      const result = checkRuntimeCompatibility({
        platform,
        isPackaged: true,
        runtimeElectronVersion: '40.0.0'
      })

      expect(result.blocked).toBe(true)
      expect(result.reason).toContain('Electron 版本不匹配')
    }
  )

  it('also blocks a newer Electron version because compatibility requires an exact match', () => {
    expect(
      checkRuntimeCompatibility({
        platform: 'darwin',
        isPackaged: true,
        runtimeElectronVersion: '42.0.0'
      }).blocked
    ).toBe(true)
  })

  it('does not block development or unsupported platforms', () => {
    expect(
      checkRuntimeCompatibility({
        platform: 'win32',
        isPackaged: false,
        runtimeElectronVersion: '40.0.0'
      }).blocked
    ).toBe(false)
    expect(
      checkRuntimeCompatibility({
        platform: 'linux',
        isPackaged: true,
        runtimeElectronVersion: '40.0.0'
      }).blocked
    ).toBe(false)
  })
})
