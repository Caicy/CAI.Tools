/**
 * 按表格单元格或文本行拆项，并保留顺序应用清理选项。
 * @param {string} text 原始输入。
 * @param {{trim?: boolean, unique?: boolean, splitTabs?: boolean}} options 清理选项。
 * @returns {{values: string[], total: number, empty: number, duplicates: number}} 有效项和统计。
 */
export function cleanLines(text, options = {}) {
  // 空白输入不产生一个虚假的空行；SQL 模式同时接收表格制表符。
  const lines = text === '' ? [] : text.split(options.splitTabs ? /\r\n|[\r\n\t]/ : /\r\n|[\r\n]/)
  const seen = new Set()
  const values = []
  let empty = 0
  let duplicates = 0
  for (const line of lines) {
    const value = options.trim === false ? line : line.trim()
    if (!value.trim()) {
      empty++
      continue
    }
    if (options.unique && seen.has(value)) {
      duplicates++
      continue
    }
    seen.add(value)
    values.push(value)
  }
  return { values, total: lines.length, empty, duplicates }
}

/**
 * 将列值格式化为 SQL IN 列表，直接保留数字文本以避免精度损失。
 * @param {string} text 表格列或多行文本。
 * @param {{mode?: string, trim?: boolean, unique?: boolean, wrap?: boolean}} options 类型与清理选项。
 * @returns {{output: string, count: number, empty: number, duplicates: number, warning: string}} SQL 列表及统计。
 * @throws {Error} 全部数字模式出现非普通十进制值或模式不受支持。
 */
export function buildSqlList(text, options = {}) {
  const mode = options.mode || 'auto'
  if (!['auto', 'text', 'number'].includes(mode)) throw new Error('不支持的 SQL 类型模式')
  const { values, empty, duplicates } = cleanLines(text, { ...options, splitTabs: true })
  const formatted = []
  for (const value of values) {
    // 前导零和指数形式按编号处理；不将输入转为 JavaScript 数字。
    const numeric = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    if (mode === 'number' && !numeric) {
      throw new Error('存在非普通数字或前导零编号，请使用自动识别或全部文本')
    }
    formatted.push(mode !== 'text' && numeric ? value : `'${value.replace(/'/g, "''")}'`)
  }
  const joined = formatted.join(',')
  return {
    output: options.wrap && joined ? `(${joined})` : joined,
    count: values.length,
    empty,
    duplicates,
    warning: values.some((value) => value.includes('\\'))
      ? '含反斜杠：单引号按 SQL 标准转义，请确认数据库的反斜杠转义模式后使用。'
      : ''
  }
}

/**
 * 拆分驼峰、缩写和分隔符，按每行转换命名或大小写。
 * @param {string} text 输入文本。
 * @param {string} mode lower、upper、pascal、camel、snake 或 kebab。
 * @returns {string} 保留换行结构的转换结果。
 * @throws {Error} 不支持的命名模式。
 */
export function convertCase(text, mode) {
  if (mode === 'lower') return text.toLowerCase()
  if (mode === 'upper') return text.toUpperCase()
  if (!['pascal', 'camel', 'snake', 'kebab'].includes(mode)) throw new Error('不支持的命名模式')
  // 缩写边界先于普通驼峰拆分，例如 HTTPResponse → HTTP Response。
  return text
    .split(/\r\n|[\r\n]/)
    .map((line) => {
      const words =
        line
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z\d])([A-Z])/g, '$1 $2')
          .match(/[\p{L}\p{N}]+/gu) || []
      const lower = words.map((word) => word.toLowerCase())
      if (mode === 'snake' || mode === 'kebab') return lower.join(mode === 'snake' ? '_' : '-')
      return lower
        .map((word, index) =>
          mode === 'camel' && index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join('')
    })
    .join('\n')
}

/**
 * 拒绝孤立 UTF-16 代理项，避免发布表面成功但已损坏的文本。
 * @param {string} text 待校验文本。
 * @returns {string} 校验后的原文本。
 * @throws {Error} 存在孤立代理项。
 */
function validateSurrogates(text) {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('存在未配对的 Unicode 高代理项')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('存在未配对的 Unicode 低代理项')
    }
  }
  return text
}

/**
 * 解码常见 Unicode 转义及码点标记，仅转换 Unicode，不执行输入代码。
 * @param {string} text 含 Unicode 转义的文本。
 * @returns {string} 解码后的完整文本。
 * @throws {Error} 转义格式不完整、码点越界或代理项未配对。
 */
export function decodeUnicode(text) {
  // 逐个扫描，错误时不发布部分转换结果，也不顺带解释 \n 等其他转义。
  const decoded = text.replace(/\\u(?:\{[^}]*\}?|[\s\S]{0,4})|\bU\+[0-9a-z]+/gi, (token) => {
    let digits
    let codePoint = false
    if (/^U\+/i.test(token)) {
      digits = token.slice(2)
      codePoint = true
      if (!/^[\da-f]{4,6}$/i.test(digits)) throw new Error('U+ 码点需要 4–6 位十六进制数字')
    } else if (token.startsWith('\\u{') || token.startsWith('\\U{')) {
      if (!/^\\u\{[\da-f]{1,6}\}$/i.test(token)) throw new Error('Unicode 花括号码点格式不正确')
      digits = token.slice(3, -1)
      codePoint = true
    } else {
      if (!/^\\u[\da-f]{4}$/i.test(token)) throw new Error('Unicode 转义需要 4 位十六进制数字')
      digits = token.slice(2)
    }
    const point = parseInt(digits, 16)
    if (point > 0x10ffff || (codePoint && point >= 0xd800 && point <= 0xdfff)) {
      throw new Error('Unicode 码点无效或超出范围')
    }
    return String.fromCodePoint(point)
  })
  return validateSurrogates(decoded)
}

/**
 * 将非 ASCII 字符编码为 UTF-16 Unicode 转义，保留英文和排版。
 * @param {string} text 中文或混合文本。
 * @returns {string} 可用于常见 JSON/JavaScript 文本的转义片段。
 * @throws {Error} 输入含孤立代理项。
 */
export function encodeUnicode(text) {
  validateSurrogates(text)
  return text.replace(
    /[\u0080-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}
