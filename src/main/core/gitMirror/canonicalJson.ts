import { createHash } from 'node:crypto'
import { MIRROR_LIMITS, type Json } from '../../../shared/gitMirrorTypes'

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 读取限额内的严格 JSON，并检查对象作用域中的重复键。
 * @param text 待校验的 UTF-8 JSON 文本。
 * @returns 无重复键、危险键及非有限数值的 JSON。
 * @throws 语法、大小、深度、键或数值不合法时抛错。
 */
export function strictParseJson(text: string): Json {
  if (Buffer.byteLength(text, 'utf8') > MIRROR_LIMITS.jsonBytes) throw new Error('JSON_TOO_LARGE')
  const value = JSON.parse(text) as Json
  const stack: (Set<string> | null)[] = []
  // 语法已由 JSON.parse 验证；逐个字符串 token 解码后检查真正的对象键。
  for (let index = 0; index < text.length; index++) {
    const token = text[index]
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set<string>() : null)
      if (stack.length > MIRROR_LIMITS.depth) throw new Error('JSON_TOO_DEEP')
    } else if (token === '}' || token === ']') {
      stack.pop()
    } else if (token === '"') {
      const start = index
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') {
          index++
          continue
        }
        if (text[index] === '"') break
      }
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] !== ':') continue
      const key = JSON.parse(text.slice(start, index + 1)) as string
      if (unsafeKeys.has(key)) throw new Error('UNSAFE_JSON_KEY')
      const keys = stack[stack.length - 1]
      if (!keys) throw new Error('INVALID_OBJECT_SCOPE')
      if (keys.has(key)) throw new Error('DUPLICATE_JSON_KEY')
      keys.add(key)
    }
  }
  // JSON.parse 会将 1e999 转成 Infinity，必须另外拒绝，不能让序列化改成 null。
  encodeJson(value, 0, new Set())
  return value
}

/**
 * 生成对象键有序、数组顺序不变且末尾为 LF 的稳定文本。
 * @param value 待序列化的 JSON。
 * @returns 稳定的 UTF-8 JSON 文本。
 * @throws 非 JSON 值、危险键、循环、深度或大小超限时抛错。
 */
export function canonicalJson(value: Json): string {
  const text = encodeJson(value, 0, new Set()) + '\n'
  if (Buffer.byteLength(text, 'utf8') > MIRROR_LIMITS.jsonBytes) throw new Error('JSON_TOO_LARGE')
  return text
}

/**
 * 为 JSON 业务内容生成与排版、换行无关的摘要。
 * @param text 原始 JSON 文本。
 * @returns SHA-256 十六进制摘要。
 * @throws JSON 不满足严格协议时抛错。
 */
export function jsonFingerprint(text: string): string {
  return createHash('sha256')
    .update(canonicalJson(strictParseJson(text)))
    .digest('hex')
}

/**
 * 递归编码 JSON，避免 JS 整数属性枚举重排破坏字典序。
 * @param value 当前值。
 * @param depth 当前容器深度。
 * @param ancestors 当前递归路径中的容器，用于检测循环。
 * @returns 当前值的稳定 JSON。
 * @throws 值、原型、深度、危险键或循环不合法时抛错。
 */
function encodeJson(value: Json, depth: number, ancestors: Set<object>): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_NUMBER')
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value)
  }
  if (!value || typeof value !== 'object') throw new Error('INVALID_JSON_VALUE')
  if (depth >= MIRROR_LIMITS.depth) throw new Error('JSON_TOO_DEEP')
  if (ancestors.has(value)) throw new Error('CYCLIC_JSON')
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw new Error('INVALID_JSON_OBJECT')
  }
  const keys = Object.keys(value)
  if (keys.some((key) => unsafeKeys.has(key))) throw new Error('UNSAFE_JSON_KEY')
  ancestors.add(value)
  try {
    // 不调用用户对象上的 toJSON；共享格式只接受普通 JSON 数据。
    const indent = '  '.repeat(depth + 1)
    const closing = '  '.repeat(depth)
    if (Array.isArray(value)) {
      const items = Array.from(value, (item) => encodeJson(item, depth + 1, ancestors))
      return items.length ? `[\n${indent}${items.join(',\n' + indent)}\n${closing}]` : '[]'
    }
    const items = keys
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${encodeJson(value[key], depth + 1, ancestors)}`)
    return items.length ? `{\n${indent}${items.join(',\n' + indent)}\n${closing}}` : '{}'
  } finally {
    // 同一对象出现在不同分支是合法引用，仅递归祖先构成循环。
    ancestors.delete(value)
  }
}
