/**
 * 仲裁单击和双击，拖拽或销毁时可取消待执行单击。
 */
export class PetClickArbiter {
  private timer: ReturnType<typeof setTimeout> | undefined
  /**
   * 注册一次松开；第二次点击仅执行双击。
   * @param single 单击回调。
   * @param double 双击回调。
   * @returns 无返回值。
   */
  public click(single: () => void, double: () => void): void {
    if (this.timer !== undefined) {
      this.cancel()
      double()
      return
    }
    this.timer = setTimeout(
      /**
       * 完成延迟操作并清理对应计时状态。
       * @returns 无返回值。
       */
      () => {
        this.timer = undefined
        single()
      },
      300
    )
  }
  /**
   * 取消尚未执行的点击，避免拖拽后误打开主窗口。
   * @returns 无返回值。
   */
  public cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
