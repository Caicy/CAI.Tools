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

/**
 * 仅解释分隔符中约定的排版转义，未知转义保持原样。
 * @param {string} value 分隔符输入。
 * @returns {string} 可用于字面拆分或拼接的分隔符。
 */
function decodeSeparator(value) {
  const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\' }
  return value.replace(/\\([nrt\\])/g, (_match, character) => escapes[character])
}

/**
 * 按指定字面分隔符拆项、清理并为每项添加前后缀后拼接。
 * @param {string} text 原始文本。
 * @param {{input?: string, delimiter?: string, separator?: string, prefix?: string, suffix?: string, trim?: boolean, unique?: boolean}} options 拼接与清理选项。
 * @returns {{output: string, count: number, empty: number, duplicates: number}} 输出及清理统计。
 * @throws {Error} 输入分隔方式无效或自定义输入分隔符为空。
 */
export function joinText(text, options = {}) {
  // 自定义分隔符按字面匹配，避免把用户输入误当正则。
  const input = options.input || 'newline'
  const delimiters = { newline: /\r\n|[\r\n]/, comma: ',', semicolon: ';', tab: '\t' }
  let delimiter
  if (input === 'custom') {
    delimiter = decodeSeparator(options.delimiter ?? '')
    if (!delimiter) throw new Error('自定义输入分隔符不能为空')
  } else {
    if (!Object.hasOwn(delimiters, input)) throw new Error('不支持的输入分隔方式')
    delimiter = delimiters[input]
  }
  const values = []
  const seen = new Set()
  let empty = 0
  let duplicates = 0
  for (const item of text === '' ? [] : text.split(delimiter)) {
    const value = options.trim === false ? item : item.trim()
    if (!value.trim()) {
      empty++
      continue
    }
    if (options.unique && seen.has(value)) {
      duplicates++
      continue
    }
    seen.add(value)
    values.push(`${options.prefix ?? ''}${value}${options.suffix ?? ''}`)
  }
  // 仅分隔符解释排版转义，前后缀中的反斜杠和美元符号保持原文。
  return {
    output: values.join(decodeSeparator(options.separator ?? ',')),
    count: values.length,
    empty,
    duplicates
  }
}

/**
 * 执行普通字面替换或正则替换，空查找不改变输入。
 * @param {string} text 原始文本。
 * @param {{search?: string, replacement?: string, regex?: boolean, all?: boolean, ignoreCase?: boolean, multiline?: boolean}} options 查找及替换选项。
 * @returns {string} 替换后的完整文本。
 * @throws {Error} 正则表达式无效。
 */
export function replaceText(text, options = {}) {
  const search = options.search ?? ''
  const replacement = options.replacement ?? ''
  if (!search) return text
  // 普通模式转义所有正则元字符，替换回调避免解释 $1、$& 等占位符。
  const pattern = options.regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = `${options.all === false ? '' : 'g'}${options.ignoreCase ? 'i' : ''}${options.multiline ? 'm' : ''}`
  let expression
  try {
    expression = new RegExp(pattern, flags)
  } catch {
    throw new Error('正则表达式无效，请检查括号、转义和字符范围')
  }
  return text.replace(expression, options.regex ? replacement : () => replacement)
}

/**
 * 拆解十进制文本供精确排序，长 ID 和小数不经过浮点数转换。
 * @param {string} value 原始行文本。
 * @returns {{negative: boolean, integer: string, fraction: string}} 规范化数值部分。
 * @throws {Error} 不是普通十进制数字。
 */
function decimalParts(value) {
  const text = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error('数字排序仅支持普通十进制数字，请检查非数字行或改用自然排序')
  }
  const [whole, decimal = ''] = text.replace(/^[+-]/, '').split('.')
  const integer = whole.replace(/^0+/, '') || '0'
  const fraction = decimal.replace(/0+$/, '')
  return {
    negative: text.startsWith('-') && (integer !== '0' || fraction !== ''),
    integer,
    fraction
  }
}

/**
 * 比较已规范化的十进制数，零与相等数值保持稳定顺序。
 * @param {{negative: boolean, integer: string, fraction: string}} left 左侧数值。
 * @param {{negative: boolean, integer: string, fraction: string}} right 右侧数值。
 * @returns {number} 负值、零或正值表示大小关系。
 */
function compareDecimals(left, right) {
  if (left.negative !== right.negative) return left.negative ? -1 : 1
  const size = left.integer.length - right.integer.length
  const integer = left.integer < right.integer ? -1 : left.integer > right.integer ? 1 : 0
  // 尾随零已经移除，小数字符串的字典顺序等价于补零后的数值顺序。
  const fraction = left.fraction < right.fraction ? -1 : left.fraction > right.fraction ? 1 : 0
  return (left.negative ? -1 : 1) * (size || integer || fraction)
}

/**
 * 清理行后应用关键词筛选和排序，最终可将结果倒序。
 * @param {string} text 原始多行文本。
 * @param {{trim?: boolean, unique?: boolean, keyword?: string, filter?: string, ignoreCase?: boolean, sort?: string, reverse?: boolean}} options 清理、字面筛选和排序选项。
 * @returns {{values: string[], total: number, empty: number, duplicates: number, filtered: number}} 最终行及各阶段统计。
 * @throws {Error} 排序／筛选方式无效或数字排序包含非十进制行。
 */
export function organizeLines(text, options = {}) {
  const sort = options.sort || 'original'
  const filter = options.filter || 'include'
  if (!['original', 'text', 'number', 'natural'].includes(sort)) throw new Error('不支持的排序方式')
  if (!['include', 'exclude'].includes(filter)) throw new Error('不支持的筛选方式')
  const cleaned = cleanLines(text, options)
  const keyword = options.keyword ?? ''
  const needle = options.ignoreCase ? keyword.toLowerCase() : keyword
  let values = cleaned.values
  // 空关键词不筛选；关键词按字面包含匹配，独立于去重的大小写规则。
  if (keyword) {
    values = values.filter((value) => {
      const haystack = options.ignoreCase ? value.toLowerCase() : value
      const matches = haystack.includes(needle)
      return filter === 'exclude' ? !matches : matches
    })
  }
  const filtered = cleaned.values.length - values.length
  if (sort === 'number') {
    // 先校验全部保留行，再排序，只有完整成功才发布结果。
    values = values
      .map((value) => ({ value, parts: decimalParts(value) }))
      .sort((left, right) => compareDecimals(left.parts, right.parts))
      .map((item) => item.value)
  } else if (sort === 'natural') {
    const collator = new Intl.Collator('zh-CN', { numeric: true })
    values.sort(collator.compare)
  } else if (sort === 'text') {
    values.sort()
  }
  if (options.reverse) values.reverse()
  return { ...cleaned, values, filtered }
}
