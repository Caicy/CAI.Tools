import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopPetCompanionBridge,
  PetCompanionSnapshot
} from '../shared/desktopPetCompanionTypes'

const bridge: DesktopPetCompanionBridge = {
  /**
   * 读取当前陪伴状态。
   * @returns 状态快照 Promise。
   */
  ready: () => ipcRenderer.invoke('desktop-pet-companion:ready'),
  /**
   * 提交用户消息。
   * @param text 用户输入的纯文本。
   * @returns 请求处理完成的 Promise。
   */
  send: (text) => ipcRenderer.invoke('desktop-pet-companion:send', text),
  /**
   * 请求一次轻互动。
   * @param kind 互动类型。
   * @returns 请求处理完成的 Promise。
   */
  interact: (kind) => ipcRenderer.invoke('desktop-pet-companion:interact', kind),
  /**
   * 保存模型及快跑短评偏好。
   * @param modelRef 模型引用，空字符串表示本地模式。
   * @param reviewsEnabled 是否允许快跑 AI 短评。
   * @returns 配置完成的 Promise。
   */
  configure: (modelRef, reviewsEnabled) =>
    ipcRenderer.invoke('desktop-pet-companion:configure', { modelRef, reviewsEnabled }),
  /**
   * 取消正在生成的回复。
   * @returns 取消完成的 Promise。
   */
  cancel: () => ipcRenderer.invoke('desktop-pet-companion:cancel'),
  /**
   * 清空当前对话。
   * @returns 清理完成的 Promise。
   */
  clear: () => ipcRenderer.invoke('desktop-pet-companion:clear'),
  /**
   * 收起陪聊窗口。
   * @returns 无返回值。
   */
  close: () => ipcRenderer.send('desktop-pet-companion:close'),
  /**
   * 订阅状态变化，隔离原始 Electron 事件。
   * @param callback 状态消费者。
   * @returns 解除订阅函数。
   */
  onState: (callback) => {
    /**
     * 转交可序列化状态。
     * @param _event IPC 事件。
     * @param state 宿主快照。
     * @returns 无返回值。
     */
    const listener = (_event: IpcRendererEvent, state: PetCompanionSnapshot): void =>
      callback(state)
    ipcRenderer.on('desktop-pet-companion:state', listener)
    /**
     * 在页面销毁时释放监听。
     * @returns 无返回值。
     */
    return () => ipcRenderer.removeListener('desktop-pet-companion:state', listener)
  }
}

contextBridge.exposeInMainWorld('desktopPetCompanion', bridge)
