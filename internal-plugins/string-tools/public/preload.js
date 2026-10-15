const { clipboard } = require('electron')

window.stringTools = {
  /**
   * 读取当前剪贴板纯文本供用户在插件内处理。
   * @returns {string} 剪贴板文本，不写入日志或持久化。
   */
  readClipboard() {
    return clipboard.readText()
  }
}
