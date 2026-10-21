import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopPetBridge, PetIdleState, PetSnapshot } from '../shared/desktopPetTypes'

const bridge: DesktopPetBridge = {
  /**
   * 订阅主进程的系统空闲状态，不向页面暴露系统输入或环境变量。
   * @param callback 空闲动作接收器。
   * @returns 解除订阅函数。
   */
  onIdle: (callback) => {
    /**
     * 转交当前循环状态。
     * @param _event IPC 事件。
     * @param state 受控动作与循环代号。
     * @returns 无返回值。
     */
    const listener = (_event: Electron.IpcRendererEvent, state: PetIdleState): void =>
      callback(state)
    ipcRenderer.on('desktop-pet:idle', listener)
    /**
     * 释放本次空闲状态监听。
     * @returns 无返回值。
     */
    const unsubscribe = (): void => {
      // 窗口重载必须释放旧监听，避免一次状态启动多个动作。
      ipcRenderer.removeListener('desktop-pet:idle', listener)
    }
    return unsubscribe
  },
  /**
   * 订阅相对宠物的光标方向，不暴露桌面绝对坐标。
   * @param callback 方向接收器。
   * @returns 解除订阅函数。
   */
  onGaze: (callback) => {
    /**
     * 转发受控方向。
     * @param _event IPC 事件。
     * @param point 归一化方向。
     * @returns 无返回值。
     */
    const listener = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }): void =>
      callback(point)
    ipcRenderer.on('desktop-pet:gaze', listener)
    /**
     * 释放方向监听。
     * @returns 无返回值。
     */
    const unsubscribe = (): void => {
      ipcRenderer.removeListener('desktop-pet:gaze', listener)
    }
    return unsubscribe
  },
  /**
   * 请求当前浮窗配置。
   * @returns 配置快照 Promise。
   */
  ready: () => ipcRenderer.invoke('desktop-pet:ready'),
  /**
   * 发送限定的交互意图，主进程继续校验发送者。
   * @param intent 交互意图。
   * @returns 无返回值。
   */
  send: (intent) => ipcRenderer.send('desktop-pet:intent', intent),
  /**
   * 提交本地素材的低分辨率命中掩码。
   * @param masks 按图集顺序排列的掩码。
   * @param width 掩码宽度。
   * @param height 掩码高度。
   * @returns 无返回值。
   */
  masks: (masks, width, height) => ipcRenderer.send('desktop-pet:masks', { masks, width, height }),
  /**
   * 只从真实 File 对象取得系统路径，不向页面暴露文件系统。
   * @param files 系统拖入的文件。
   * @returns 无返回值。
   */
  drop: (files) =>
    ipcRenderer.send(
      'desktop-pet:drop',
      files.slice(0, 100).map(
        /**
         * 转换当前元素，构造后续处理需要的数据。
         * @param file 当前回调输入。
         * @returns 转换后的元素。
         */
        (file) => webUtils.getPathForFile(file)
      )
    ),
  /**
   * 订阅配置更新并提供销毁解绑。
   * @param callback 页面接收器。
   * @returns 解绑函数。
   */
  onSnapshot: (callback) => {
    /**
     * 将受控快照转交页面。
     * @param _event Electron 事件。
     * @param snapshot 当前快照。
     * @returns 无返回值。
     */
    const listener = (_event: Electron.IpcRendererEvent, snapshot: PetSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('desktop-pet:snapshot', listener)
    /**
     * 解除本次页面订阅，避免窗口重建后累积监听器。
     * @returns 无返回值。
     */
    const unsubscribe = (): void => {
      ipcRenderer.removeListener('desktop-pet:snapshot', listener)
    }
    return unsubscribe
  }
}
contextBridge.exposeInMainWorld('desktopPet', bridge)
