import { app } from 'electron'
import { getZToolsRoot } from './appDataPaths'
import { LOCAL_PRODUCT_NAME } from '../../../shared/localEdition'

const LEGACY_USER_DATA_ENV = 'ZTOOLS_LEGACY_USER_DATA_PATH'

/**
 * 在业务模块加载前设置本地版身份和 Electron 数据目录。
 * @returns 无返回值。
 */
export function configureAppDataRoot(): void {
  // 静态导入早于入口正文执行，必须先设置本地身份再解析 Electron 路径。
  app.setName(LOCAL_PRODUCT_NAME)
  const root = getZToolsRoot()
  app.setPath('userData', root)

  // 兼容旧路径参数但不自动保存原版 userData，避免启动时探测官方数据。
  if (!process.env[LEGACY_USER_DATA_ENV]) {
    process.env[LEGACY_USER_DATA_ENV] = root
  }
}

configureAppDataRoot()
