import { useToast } from '@/components/common/Toast/Toast'

const toast = useToast()

/**
 * 将未知错误归一化为可直接展示的文案。
 * @param error 未知类型的错误对象或文本。
 * @param fallback 当无法从错误中提取有效文案时使用的回退提示。
 * @returns 格式化后的错误文案字符串。
 */
export function toDisplayMessage(error: unknown, fallback: string): string {
  // 字符串类型且非空时直接去除首尾空格返回。
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }

  // 标准 Error 实例且 message 非空时提取 message。
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  // 无法识别时使用预设的回退文案。
  return fallback
}

/**
 * 解析错误入参并生成最终展示的文案。
 * @param first 错误对象、错误文本或首个参数。
 * @param fallback 可选的回退文案。
 * @returns 最终用于提示的错误文案。
 */
function resolveErrorMessage(first: unknown, fallback?: string): string {
  // 指定了自定义回退文案时优先走归一化逻辑。
  if (typeof fallback === 'string') {
    return toDisplayMessage(first, fallback)
  }

  // 针对直接传入的非空字符串做去空处理。
  if (typeof first === 'string' && first.trim()) {
    return first.trim()
  }

  // 针对标准 Error 实例读取 message。
  if (first instanceof Error && first.message.trim()) {
    return first.message.trim()
  }

  // 默认兜底文案。
  return '操作失败'
}

/**
 * 统一展示错误提示。
 * @param error 错误对象或文本。
 * @param fallback 可选的回退文案或展示时长（毫秒）。
 * @param duration 气泡持续时间（毫秒），默认为 3000。
 * @returns 无返回值。
 */
export function showErrorMessage(
  error: unknown,
  fallback?: string | number,
  duration = 3000
): void {
  // 解析展示时长参数（兼容 fallback 重载为 number 的情况）。
  const nextDuration = typeof fallback === 'number' ? fallback : duration
  // 提取最终展示文案。
  const message = resolveErrorMessage(error, typeof fallback === 'string' ? fallback : undefined)
  // 通过全局 Toast 展示错误提示。
  toast.error(message, nextDuration)
}

/**
 * 统一展示成功提示。
 * @param message 成功提示文本。
 * @param duration 气泡持续时间（毫秒），默认为 3000。
 * @returns 无返回值。
 */
export function showSuccessMessage(message: string, duration = 3000): void {
  // 通过全局 Toast 展示成功提示。
  toast.success(message, duration)
}

/**
 * 统一展示警告提示。
 * @param message 警告提示文本。
 * @param duration 气泡持续时间（毫秒），默认为 3000。
 * @returns 无返回值。
 */
export function showWarningMessage(message: string, duration = 3000): void {
  // 通过全局 Toast 展示警告提示。
  toast.warning(message, duration)
}

/**
 * 统一展示信息提示。
 * @param message 信息提示文本。
 * @param duration 气泡持续时间（毫秒），默认为 3000。
 * @returns 无返回值。
 */
export function showInfoMessage(message: string, duration = 3000): void {
  // 通过全局 Toast 展示信息提示。
  toast.info(message, duration)
}
