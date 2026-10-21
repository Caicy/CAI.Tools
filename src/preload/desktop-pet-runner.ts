import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopPetRunnerBridge } from '../shared/desktopPetRunnerTypes'

const bridge: DesktopPetRunnerBridge = {
  testEnabled: process.argv.includes('--runner-e2e-clock'),
  /**
   * 发送受限拖动意图，不能访问任意窗口或 IPC 通道。
   * @param intent 拖动阶段和屏幕 DIP 坐标。
   * @returns 无返回值。
   */
  drag: (intent) => ipcRenderer.send('desktop-pet-runner:drag', intent),
  /**
   * 通知素材加载完成并读取纪录。
   * @returns 本地纪录 Promise。
   */
  ready: () => ipcRenderer.invoke('desktop-pet-runner:ready'),
  /**
   * 提交本局距离，由主进程校验并保存。
   * @param distance 本局有效距离。
   * @returns 保存状态 Promise。
   */
  save: (distance) => ipcRenderer.invoke('desktop-pet-runner:save', distance),
  /**
   * 返回桌宠。
   * @returns 无返回值。
   */
  exit: () => ipcRenderer.send('desktop-pet-runner:exit'),
  /**
   * 请求加载失败回滚。
   * @returns 无返回值。
   */
  failed: () => ipcRenderer.send('desktop-pet-runner:failed'),
  /**
   * 订阅宿主失焦或系统挂起通知。
   * @param callback 暂停处理函数。
   * @returns 解除订阅函数。
   */
  onPause: (callback) => {
    /**
     * 转交暂停通知，不暴露 Electron 事件。
     * @returns 无返回值。
     */
    const listener = (): void => callback()
    ipcRenderer.on('desktop-pet-runner:pause', listener)
    /**
     * 页面卸载时释放订阅。
     * @returns 无返回值。
     */
    return () => {
      ipcRenderer.removeListener('desktop-pet-runner:pause', listener)
    }
  }
}
contextBridge.exposeInMainWorld('desktopPetRunner', bridge)
