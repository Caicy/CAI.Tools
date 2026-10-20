import { nextTick, reactive } from 'vue'

interface ConfirmOptions {
  title: string
  message: string
  confirmText: string
}
const dialog = reactive({ visible: false, title: '', message: '', confirmText: '' })
const notice = reactive({ message: '', type: 'success' })
let resolveDialog: ((accepted: boolean) => void) | undefined

/**
 * 提供独立内置插件的确认和反馈状态，不依赖设置插件或其路由。
 * @returns 确认、提示及对话框控制方法
 */
export function useDialogs(): {
  dialog: typeof dialog
  notice: typeof notice
  confirm: (options: ConfirmOptions) => Promise<boolean>
  finish: (accepted: boolean) => void
  success: (message: string) => void
  error: (message: string) => void
} {
  /**
   * 展示操作确认，同一时刻仅保留一个待确认请求。
   * @param options 确认标题、内容和按钮文字
   * @returns 用户是否确认操作
   */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    resolveDialog?.(false)
    Object.assign(dialog, options, { visible: true })
    // 默认聚焦取消，避免键盘确认落到背景菜单的操作按钮。
    void nextTick(() => document.querySelector<HTMLButtonElement>('.modal button')?.focus())
    return new Promise((resolve) => {
      resolveDialog = resolve
    })
  }
  /**
   * 完成或取消待确认操作。
   * @param accepted 是否确认
   * @returns 无返回值
   */
  function finish(accepted: boolean): void {
    dialog.visible = false
    resolveDialog?.(accepted)
    resolveDialog = undefined
  }
  /**
   * 展示成功结果，供用户核对。
   * @param message 成功说明
   * @returns 无返回值
   */
  function success(message: string): void {
    Object.assign(notice, { message, type: 'success' })
  }
  /**
   * 保留失败说明，避免短暂提示导致用户遗漏还原失败。
   * @param message 错误说明
   * @returns 无返回值
   */
  function error(message: string): void {
    Object.assign(notice, { message, type: 'error' })
  }
  return { dialog, notice, confirm, finish, success, error }
}
