import { replaceText } from './transforms.mjs'

/**
 * 在可终止的线程执行替换，将完整结果或错误发回插件界面。
 * @param {MessageEvent<{text: string, options: object}>} event 当前替换任务。
 * @returns {void} 无返回值。
 */
self.onmessage = (event) => {
  // 仅发布完整转换结果，错误不携带输入正文。
  try {
    self.postMessage({ output: replaceText(event.data.text, event.data.options) })
  } catch (error) {
    self.postMessage({ error: error.message })
  }
}
