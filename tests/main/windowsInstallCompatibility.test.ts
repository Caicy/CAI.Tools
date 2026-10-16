import { describe, expect, it } from 'vitest'
import {
  getWindowsReleaseUrl,
  validateWindowsInstall,
  WINDOWS_APP_ID,
  WINDOWS_ELECTRON_VERSION,
  WINDOWS_UPDATER_TYPE,
  type WindowsInstallInfo
} from '../../src/main/api/windowsInstallCompatibility'

const validInstallInfo: WindowsInstallInfo = {
  schemaVersion: 1,
  appId: WINDOWS_APP_ID,
  electronVersion: WINDOWS_ELECTRON_VERSION,
  updater: WINDOWS_UPDATER_TYPE
}

describe('validateWindowsInstall', () => {
  it('builds a version-specific download page for stable and prerelease versions', () => {
    expect(getWindowsReleaseUrl()).toBe('https://github.com/Caicy/CAI.Tools/releases')
    expect(getWindowsReleaseUrl('3.0.0')).toBe(
      'https://github.com/Caicy/CAI.Tools/releases/tag/v3.0.0'
    )
    expect(getWindowsReleaseUrl('3.0.0-beta.8')).toBe(
      'https://github.com/Caicy/CAI.Tools/releases/tag/v3.0.0-beta.8'
    )
  })

  it('accepts a complete NSIS installation with the expected runtime', () => {
    expect(validateWindowsInstall(WINDOWS_ELECTRON_VERSION, validInstallInfo, true)).toMatchObject({
      compatible: true,
      migrationRequired: false,
      reasons: []
    })
  })

  it('requires migration for an ASAR-only upgrade without an install marker', () => {
    const result = validateWindowsInstall(WINDOWS_ELECTRON_VERSION, null, true)

    expect(result.migrationRequired).toBe(true)
    expect(result.reasons).toContain('缺少完整安装标记')
  })

  it('requires migration when the Electron runtime does not match', () => {
    const result = validateWindowsInstall('40.0.0', validInstallInfo, true)

    expect(result.migrationRequired).toBe(true)
    expect(result.reasons[0]).toContain('Electron 版本不匹配')
  })

  it('requires migration when app identity or updater configuration does not match', () => {
    const result = validateWindowsInstall(
      WINDOWS_ELECTRON_VERSION,
      { ...validInstallInfo, appId: 'legacy.ztools' },
      false
    )

    expect(result.migrationRequired).toBe(true)
    expect(result.reasons).toContain('应用标识不匹配')
    expect(result.reasons).toContain('缺少 electron-updater 配置')
  })

  it('allows a current portable package to check updates without NSIS installation', () => {
    const result = validateWindowsInstall(WINDOWS_ELECTRON_VERSION, validInstallInfo, true, false)

    expect(result).toMatchObject({ compatible: false, portable: true, migrationRequired: false })
    expect(result.reasons).toEqual([])
  })

  it('does not treat an invalid legacy package as a current portable package', () => {
    const result = validateWindowsInstall(WINDOWS_ELECTRON_VERSION, null, false, false)

    expect(result.portable).toBe(false)
    expect(result.migrationRequired).toBe(true)
    expect(result.reasons).toContain('当前不是 NSIS 完整安装版')
  })
})
