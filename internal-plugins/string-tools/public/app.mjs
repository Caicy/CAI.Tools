import {
  buildSqlList,
  cleanLines,
  convertCase,
  decodeUnicode,
  encodeUnicode
} from './transforms.mjs'

const source = document.querySelector('#source')
const output = document.querySelector('#output')
const copy = document.querySelector('#copy')
const status = document.querySelector('#status')
let tab = 'sql'
let initialized = false
let currentWarning = ''

const hints = {
  sql: '按换行 / 制表符拆项，忽略空行。数字保留原值，前导零编号加引号；文本中的单引号自动转义。',
  case: '支持空格、下划线、短横线及已有驼峰；HTTPResponse 可转换为 httpResponse。',
  unicode: '支持 \\u4e2d\\u6587、\\u{1F600} 和 U+4E2D；仅转换 Unicode，其他内容保持原样。',
  lines: '按行整理，保留原有顺序和大小写。去重在去首尾空格之后执行。'
}

/**
 * 发布状态信息，避免错误和成功仅通过颜色表达。
 * @param {string} message 要显示的消息。
 * @param {string} state normal、error 或 warning。
 * @returns {void} 无返回值。
 */
function setStatus(message, state = 'normal') {
  status.textContent = message
  status.dataset.state = state
}

/**
 * 按当前页签重新计算结果，出错时清除旧结果并禁止复制。
 * @returns {void} 无返回值。
 */
function render() {
  currentWarning = ''
  document.querySelector('#source-count').textContent =
    `${Array.from(source.value).length} 字符 · ${source.value ? source.value.split(/\r\n|[\r\n]/).length : 0} 行`
  try {
    let result = ''
    let details = ''
    if (tab === 'sql') {
      const sql = buildSqlList(source.value, {
        mode: document.querySelector('#sql-mode').value,
        wrap: document.querySelector('#sql-wrap').checked,
        trim: document.querySelector('#sql-trim').checked,
        unique: document.querySelector('#sql-unique').checked
      })
      result = sql.output
      currentWarning = sql.warning
      details = `${sql.count} 项 · 忽略 ${sql.empty} 个空项 · 去重 ${sql.duplicates} 项`
    } else if (tab === 'case') {
      result = convertCase(source.value, document.querySelector('#case-mode').value)
    } else if (tab === 'unicode') {
      result =
        document.querySelector('#unicode-mode').value === 'decode'
          ? decodeUnicode(source.value)
          : encodeUnicode(source.value)
    } else {
      const lines = cleanLines(source.value, {
        trim: document.querySelector('#lines-trim').checked,
        unique: document.querySelector('#lines-unique').checked
      })
      result = lines.values.join('\n')
      details = `${lines.values.length} 行 · 忽略 ${lines.empty} 个空行 · 去重 ${lines.duplicates} 行`
    }
    // 仅在完整转换成功后发布结果，防止错误时误复制上一次输出。
    output.value = result
    copy.disabled = !result
    document.querySelector('#result-count').textContent =
      details || `${Array.from(result).length} 字符`
    setStatus(
      currentWarning || '内容仅在本机处理，不保存历史。',
      currentWarning ? 'warning' : 'normal'
    )
  } catch (error) {
    output.value = ''
    copy.disabled = true
    document.querySelector('#result-count').textContent = '请检查输入'
    setStatus(error.message, 'error')
  }
}

/**
 * 切换工具页签，保留输入和各工具选项。
 * @param {string} next 目标页签标识。
 * @returns {void} 无返回值。
 */
function selectTab(next) {
  tab = Object.hasOwn(hints, next) ? next : 'sql'
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === tab))
  }
  for (const panel of document.querySelectorAll('[data-options]'))
    panel.hidden = panel.dataset.options !== tab
  document.querySelector('#hint').textContent = hints[tab]
  source.placeholder = tab === 'sql' ? '粘贴数据表的一列，每行一个值…' : '在这里粘贴需要处理的文本…'
  render()
}

/**
 * 主动导入剪贴板，读取失败时保留原有草稿。
 * @returns {void} 无返回值。
 */
function readClipboard() {
  try {
    if (!window.stringTools) throw new Error('剪贴板服务未就绪，请重新打开插件')
    source.value = window.stringTools.readClipboard()
    render()
    source.focus()
  } catch (error) {
    setStatus(`读取失败：${error.message}`, 'error')
  }
}

/**
 * 将当前完整结果复制到剪贴板，并报告实际调用结果。
 * @returns {void} 无返回值。
 */
function copyResult() {
  if (copy.disabled) return
  try {
    if (!window.ztools?.copyText(output.value)) throw new Error('剪贴板暂不可用，请重试')
    setStatus(
      currentWarning ? `已复制。${currentWarning}` : '已复制到剪贴板',
      currentWarning ? 'warning' : 'normal'
    )
  } catch (error) {
    setStatus(`复制失败：${error.message}`, 'error')
  }
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab))
}
source.addEventListener('input', render)
document.querySelector('.options').addEventListener('change', render)
document.querySelector('#paste').addEventListener('click', readClipboard)
copy.addEventListener('click', copyResult)
document.querySelector('#clear').addEventListener('click', () => {
  source.value = ''
  render()
  source.focus()
})
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    copyResult()
  }
})

// 先建立默认界面，再注册可能立即回放的进入回调，避免覆盖直达页签。
selectTab('sql')

// 文本匹配入口优先采用用户选中的内容，普通重入保留当前草稿。
window.ztools?.onPluginEnter((action) => {
  if (['over', 'regex'].includes(action.type) && typeof action.payload === 'string') {
    source.value = action.payload
  } else if (!initialized) {
    readClipboard()
  }
  initialized = true
  // 直达指令明确设置方向，避免复用上次相反的 Unicode 模式。
  if (action.code === 'unicode' || action.code === 'unicode-encode') {
    document.querySelector('#unicode-mode').value =
      action.code === 'unicode-encode' ? 'encode' : 'decode'
  }
  selectTab(action.code === 'unicode-encode' ? 'unicode' : action.code)
  source.focus()
})
