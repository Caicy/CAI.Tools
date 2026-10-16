import { app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import yaml from 'yaml'
import { getGitHubReleaseUrl, GITHUB_LATEST_RELEASE_URL } from '@shared/updateSource'
import { EXPECTED_ELECTRON_VERSION } from '../runtimeCompatibility'
import { LOCAL_APP_ID } from '../../shared/localEdition'

export const WINDOWS_APP_ID = LOCAL_APP_ID
export const WINDOWS_ELECTRON_VERSION = EXPECTED_ELECTRON_VERSION
export const WINDOWS_UPDATER_TYPE = 'electron-updater-nsis'
export const WINDOWS_INSTALL_INFO_FILE = 'ztools-install-info.json'
export const WINDOWS_NSIS_INSTALL_MARKER_FILE = '.ztools-nsis-installed'
export const WINDOWS_RELEASE_URL = GITHUB_LATEST_RELEASE_URL

export interface WindowsInstallInfo {
  schemaVersion: number
  appId: string
  electronVersion: string
  updater: string
}

export interface WindowsInstallCompatibility {
  compatible: boolean
  portable: boolean
  migrationRequired: boolean
  reasons: string[]
  installInfo?: WindowsInstallInfo
}

/**
 * 生成指定 Windows 版本对应的 GitHub Release 下载页面地址。
 * @param version 检查更新返回的目标版本号。
 * @returns 指定版本的 Release 页面地址；版本为空时返回包含预发布版的列表。
 */
export function getWindowsReleaseUrl(version?: string): string {
  return getGitHubReleaseUrl(version)
}

/**
 * 判断 Windows 应用是否具备 NSIS 自动更新条件，或是否为可检查更新的新版便携包。
 * @param runtimeElectronVersion 当前运行时 Electron 版本。
 * @param installInfo 完整打包阶段写入的安装信息。
 * @param hasUpdateConfig 是否存在有效的 electron-updater 配置。
 * @param hasNsisInstallMarker 是否执行过当前版本的 NSIS 安装程序。
 * @returns Windows 安装类型及其更新兼容性结果。
 */
export function validateWindowsInstall(
  runtimeElectronVersion: string,
  installInfo: WindowsInstallInfo | null,
  hasUpdateConfig: boolean,
  hasNsisInstallMarker = true
): WindowsInstallCompatibility {
  const reasons: string[] = []

  if (runtimeElectronVersion !== WINDOWS_ELECTRON_VERSION) {
    reasons.push(
      `Electron 版本不匹配（当前 ${runtimeElectronVersion}，需要 ${WINDOWS_ELECTRON_VERSION}）`
    )
  }

  if (!installInfo) {
    reasons.push('缺少完整安装标记')
  } else {
    if (installInfo.schemaVersion !== 1) reasons.push('安装标记版本不受支持')
    if (installInfo.appId !== WINDOWS_APP_ID) reasons.push('应用标识不匹配')
    if (installInfo.electronVersion !== WINDOWS_ELECTRON_VERSION) {
      reasons.push('安装包 Electron 版本不匹配')
    }
    if (installInfo.updater !== WINDOWS_UPDATER_TYPE) reasons.push('更新方式不兼容')
  }

  if (!hasUpdateConfig) reasons.push('缺少 electron-updater 配置')

  // 新版 ZIP 包具备检查更新所需配置，仅缺少由 NSIS 安装阶段写入的标记。
  const portable = !hasNsisInstallMarker && reasons.length === 0
  if (!hasNsisInstallMarker && !portable) reasons.push('当前不是 NSIS 完整安装版')

  return {
    compatible: !portable && reasons.length === 0,
    portable,
    migrationRequired: !portable && reasons.length > 0,
    reasons,
    installInfo: installInfo ?? undefined
  }
}

/**
 * 读取当前 Windows 应用的安装标记与更新配置并执行兼容校验。
 * @returns Windows 安装类型及其更新兼容性结果。
 */
export async function getWindowsInstallCompatibility(): Promise<WindowsInstallCompatibility> {
  if (process.platform !== 'win32') {
    return {
      compatible: false,
      portable: false,
      migrationRequired: false,
      reasons: ['当前不是 Windows 平台']
    }
  }

  // 开发环境只复用更新器的版本检查能力，不将本地运行目录识别为便携版。
  if (!app.isPackaged) {
    return {
      compatible: true,
      portable: false,
      migrationRequired: false,
      reasons: []
    }
  }

  const installInfoPath = path.join(process.resourcesPath, WINDOWS_INSTALL_INFO_FILE)
  const updateConfigPath = path.join(process.resourcesPath, 'app-update.yml')
  const nsisInstallMarkerPath = path.join(process.resourcesPath, WINDOWS_NSIS_INSTALL_MARKER_FILE)
  let installInfo: WindowsInstallInfo | null = null
  let hasUpdateConfig = false
  let hasNsisInstallMarker = false

  try {
    installInfo = JSON.parse(await fs.readFile(installInfoPath, 'utf8')) as WindowsInstallInfo
  } catch {
    installInfo = null
  }

  try {
    const updateConfig = yaml.parse(await fs.readFile(updateConfigPath, 'utf8'))
    hasUpdateConfig =
      updateConfig?.provider === 'github' &&
      updateConfig?.owner === 'Caicy' &&
      updateConfig?.repo === 'CAI.Tools' &&
      updateConfig?.channel === 'local' &&
      !updateConfig?.token &&
      !updateConfig?.private
  } catch {
    hasUpdateConfig = false
  }

  try {
    await fs.access(nsisInstallMarkerPath)
    hasNsisInstallMarker = true
  } catch {
    hasNsisInstallMarker = false
  }

  return validateWindowsInstall(
    process.versions.electron,
    installInfo,
    hasUpdateConfig,
    hasNsisInstallMarker
  )
}
