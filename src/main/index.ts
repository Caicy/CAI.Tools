import { app, dialog } from 'electron'
import './core/appData/configureAppDataRoot'
import { LOCAL_APP_ID, LOCAL_PRODUCT_NAME } from '../shared/localEdition'
import {
  checkRuntimeCompatibility,
  EXPECTED_ELECTRON_VERSION,
  LOCAL_RUNTIME_REBUILD_INSTRUCTIONS
} from './runtimeCompatibility'

app.setName(LOCAL_PRODUCT_NAME)
if (process.platform === 'win32') app.setAppUserModelId(LOCAL_APP_ID)

const gotTheLock = app.requestSingleInstanceLock()
const runtimeCompatibility = checkRuntimeCompatibility({
  platform: process.platform,
  isPackaged: app.isPackaged,
  runtimeElectronVersion: process.versions.electron
})

/**
 * 解释本地版运行环境不兼容的处理方式，并在用户关闭提示后结束启动。
 * @returns 提示关闭并结束应用后的 Promise。
 */
async function showBlockingRuntimePrompt(): Promise<void> {
  try {
    // 阻止加载业务入口，直到用户使用与本地源码匹配的 Electron 环境重建。
    await app.whenReady()
    await dialog.showMessageBox({
      type: 'warning',
      title: '需要重新构建 CAI.Tools',
      message: '当前运行环境与本地版要求不兼容',
      detail: LOCAL_RUNTIME_REBUILD_INSTRUCTIONS,
      buttons: ['退出应用'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
  } catch (error) {
    console.error('[Bootstrap] 显示 Electron 兼容性提示失败:', error)
  } finally {
    // 兼容检查失败时不继续初始化数据库、插件或后台服务。
    app.exit(0)
  }
}

if (!gotTheLock) {
  app.exit(0)
} else if (runtimeCompatibility.blocked) {
  console.error(
    `[Bootstrap] 阻止启动: ${runtimeCompatibility.reason}; target=${EXPECTED_ELECTRON_VERSION}`
  )
  void showBlockingRuntimePrompt()
} else {
  void import('./appMain').catch((error) => {
    console.error('[Bootstrap] 加载主程序失败:', error)
    app.exit(1)
  })
}
