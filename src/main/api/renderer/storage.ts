import { ipcMain } from 'electron'
import { storageManager } from '../../core/lmdb/lmdbInstance'
import { unavailableOfficialCapability } from '../../../shared/localEdition'

export class StorageAPI {
  /**
   * 注册本地存储状态和旧迁移入口的兼容响应。
   * @returns 无返回值。
   */
  public init(): void {
    ipcMain.handle('storage:get-init-state', async () => {
      try {
        return {
          success: true,
          state: storageManager.getInitState(),
          // 本地版直接使用新数据目录，绝不为状态查询探测旧版路径。
          legacy: {
            initialized: true,
            legacyLmdbFound: false,
            shouldPrompt: false,
            legacyLmdbPath: ''
          }
        }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    })

    ipcMain.handle('storage:start-fresh', async () => {
      try {
        // 启动链已初始化本地目录，旧界面的继续按钮仅确认该状态。
        storageManager.getInitState()
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    })

    // 保留通道并拒绝导入，避免第三方旧界面重新打开原版数据库。
    ipcMain.handle('storage:import-legacy', () => unavailableOfficialCapability('旧版数据迁移'))
  }
}

export default new StorageAPI()
