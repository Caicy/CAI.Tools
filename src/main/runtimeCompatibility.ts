export const EXPECTED_ELECTRON_VERSION = __ZTOOLS_TARGET_ELECTRON_VERSION__
export const LOCAL_RUNTIME_REBUILD_INSTRUCTIONS =
  '请从 CAI.Tools 本地版源码重新安装依赖并构建，以使用当前版本要求的 Electron 运行环境。'

export interface RuntimeCompatibilityInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  runtimeElectronVersion: string
  expectedElectronVersion?: string
}

export interface RuntimeCompatibilityResult {
  compatible: boolean
  blocked: boolean
  reason?: string
}

/**
 * 检查发行运行环境是否匹配构建时要求，保留原有平台与开发模式边界。
 * @param input 平台、运行模式及实际和预期 Electron 版本。
 * @returns 是否兼容以及阻止启动的原因。
 */
export function checkRuntimeCompatibility({
  platform,
  isPackaged,
  runtimeElectronVersion,
  expectedElectronVersion = EXPECTED_ELECTRON_VERSION
}: RuntimeCompatibilityInput): RuntimeCompatibilityResult {
  if (!isPackaged || (platform !== 'win32' && platform !== 'darwin')) {
    return { compatible: true, blocked: false }
  }

  if (runtimeElectronVersion === expectedElectronVersion) {
    return { compatible: true, blocked: false }
  }

  return {
    compatible: false,
    blocked: true,
    reason: `Electron 版本不匹配（当前 ${runtimeElectronVersion}，需要 ${expectedElectronVersion}）`
  }
}
