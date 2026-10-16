import {
  buildSqlList,
  convertCase,
  decodeUnicode,
  encodeUnicode,
  joinText,
  replaceText,
  organizeLines
} from './transforms.mjs'

const source = document.querySelector('#source')
const output = document.querySelector('#output')
const copy = document.querySelector('#copy')
const status = document.querySelector('#status')
let tab = 'sql'
let initialized = false
let currentWarning = ''
let replacementWorker = null
let replacementTimer = null

const hints = {
  sql: '按换行 / 制表符拆项，忽略空行。数字保留原值，前导零编号加引号；文本中的单引号自动转义。',
  case: '支持空格、下划线、短横线及已有驼峰；HTTPResponse 可转换为 httpResponse。',
  unicode: '支持 \\u4e2d\\u6587、\\u{1F600} 和 U+4E2D；仅转换 Unicode，其他内容保持原样。',
  join: '按分隔符拆项，忽略空项。输入自定义分隔符和输出分隔符支持 \\n 换行、\\t 制表符、\\r 回车、\\\\ 反斜杠；前后缀按原文添加。',
  replace:
    '普通模式按原文替换；正则模式支持 $1、$2、$&，表达式无需 / 包裹。空查找保留原文，清空替换内容可删除匹配项。',
  lines:
    '依次去空行、去首尾空格、去重、关键词筛选、排序，最后可倒序。文本按字符顺序，数字支持十进制，自然排序使 item2 排在 item10 前。'
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
 * 终止上一次替换任务，防止过时结果覆盖新输入或其他页签。
 * @returns {void} 无返回值。
 */
function cancelReplacement() {
  replacementWorker?.terminate()
  replacementWorker = null
  clearTimeout(replacementTimer)
  replacementTimer = null
}

/**
 * 发布完整结果与统计，只允许复制当前已计算成功的内容。
 * @param {string} result 当前完整结果。
 * @param {string} details 可选的清理统计。
 * @returns {void} 无返回值。
 */
function publishResult(result, details = '') {
  output.value = result
  copy.disabled = !result
  document.querySelector('#result-count').textContent =
    details || `${Array.from(result).length} 字符`
  setStatus(
    currentWarning || '内容仅在本机处理，不保存历史。',
    currentWarning ? 'warning' : 'normal'
  )
}

/**
 * 清除旧结果并公布错误，避免失败后复制到过期内容。
 * @param {string} message 用户可据此修改输入的错误提示。
 * @returns {void} 无返回值。
 */
function showError(message) {
  output.value = ''
  copy.disabled = true
  document.querySelector('#result-count').textContent = '请检查输入'
  setStatus(message, 'error')
}

/**
 * 在可终止的线程执行正则替换，限定耗时并仅接收当前任务结果。
 * @param {object} options 当前替换选项的快照。
 * @returns {void} 无返回值，结果由当前任务回调发布。
 */
function startReplacement(options) {
  // 计算期间立即撤回旧输出，切换输入和工具仍可终止任务。
  output.value = ''
  copy.disabled = true
  document.querySelector('#result-count').textContent = '处理中…'
  setStatus('正在查找替换…')
  const worker = new Worker(new URL('./replace-worker.mjs', import.meta.url), { type: 'module' })
  replacementWorker = worker

  /**
   * 接收单次任务的结果；已被替换的任务不能修改当前界面。
   * @param {{output?: string, error?: string}} result 完整结果或错误。
   * @returns {void} 无返回值。
   */
  function finish(result) {
    if (replacementWorker !== worker) return
    cancelReplacement()
    if (result.error) showError(result.error)
    else publishResult(result.output)
  }

  worker.onmessage = (event) => finish(event.data)
  worker.onerror = () => finish({ error: '替换执行失败，请修改表达式后重试' })
  replacementTimer = setTimeout(
    () => finish({ error: '正则处理超时，请简化表达式或缩短文本后重试' }),
    1000
  )
  worker.postMessage({ text: source.value, options })
}

/**
 * 根据底层选项同步分段按钮，兼容程序设值和直达指令进入。
 * @returns {void} 无返回值。
 */
function syncModeButtons() {
  // select 继续作为转换逻辑的唯一状态来源，按钮只展示并修改同一份值。
  for (const button of document.querySelectorAll('[data-mode-select]')) {
    const mode = document.getElementById(button.dataset.modeSelect)
    button.setAttribute('aria-pressed', String(mode.value === button.dataset.modeValue))
  }
}

/**
 * 将用户选择的分段模式写入原有控件并重新计算结果。
 * @param {MouseEvent} event 选项区的点击事件。
 * @returns {void} 无返回值。
 */
function selectMode(event) {
  const button = event.target instanceof Element ? event.target.closest('[data-mode-select]') : null
  if (!button) return
  // 复用原有 select 值，使快捷入口、自动化调用和鼠标选择保持一致。
  document.getElementById(button.dataset.modeSelect).value = button.dataset.modeValue
  render()
}

/**
 * 按当前页签重新计算结果，出错时清除旧结果并禁止复制。
 * @returns {void} 无返回值。
 */
function render() {
  // 每次输入或工具切换都撤销旧任务，只有本次计算可以发布结果。
  cancelReplacement()
  syncModeButtons()
  currentWarning = ''
  document.querySelector('#join-custom-field').hidden =
    document.querySelector('#join-input').value !== 'custom'
  document.querySelector('#replace-multiline').disabled =
    !document.querySelector('#replace-regex').checked
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
    } else if (tab === 'join') {
      const joined = joinText(source.value, {
        input: document.querySelector('#join-input').value,
        delimiter: document.querySelector('#join-custom').value,
        separator: document.querySelector('#join-separator').value,
        prefix: document.querySelector('#join-prefix').value,
        suffix: document.querySelector('#join-suffix').value,
        trim: document.querySelector('#join-trim').checked,
        unique: document.querySelector('#join-unique').checked
      })
      result = joined.output
      details = `${joined.count} 项 · 忽略 ${joined.empty} 个空项 · 去重 ${joined.duplicates} 项`
    } else if (tab === 'replace') {
      const options = {
        search: document.querySelector('#replace-search').value,
        replacement: document.querySelector('#replace-value').value,
        regex: document.querySelector('#replace-regex').checked,
        all: document.querySelector('#replace-all').checked,
        ignoreCase: document.querySelector('#replace-ignore-case').checked,
        multiline: document.querySelector('#replace-multiline').checked
      }
      // 普通字面替换直接预览，用户正则交给可终止任务执行。
      if (options.regex && options.search) {
        startReplacement(options)
        return
      }
      result = replaceText(source.value, options)
    } else {
      const lines = organizeLines(source.value, {
        trim: document.querySelector('#lines-trim').checked,
        unique: document.querySelector('#lines-unique').checked,
        keyword: document.querySelector('#lines-keyword').value,
        filter: document.querySelector('#lines-filter').value,
        ignoreCase: document.querySelector('#lines-ignore-case').checked,
        sort: document.querySelector('#lines-sort').value,
        reverse: document.querySelector('#lines-reverse').checked
      })
      result = lines.values.join('\n')
      details = `${lines.values.length} 行 · 忽略 ${lines.empty} 个空行 · 去重 ${lines.duplicates} 行 · 筛除 ${lines.filtered} 行`
    }
    // 仅在完整转换成功后发布结果，防止错误时误复制上一次输出。
    publishResult(result, details)
  } catch (error) {
    cancelReplacement()
    showError(error.message)
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
document.querySelector('.options').addEventListener('click', selectMode)
document.querySelector('.options').addEventListener('change', render)
document.querySelector('.options').addEventListener('input', render)
window.addEventListener('pagehide', cancelReplacement)
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

/**
 * 接收进入上下文并选择工具，文本匹配使用本次原文，普通重入保留草稿。
 * @param {{type?: string, payload?: unknown, code?: string}} action 宿主提供的进入动作。
 * @returns {void} 无返回值。
 */
function handlePluginEnter(action) {
  // 只有文本匹配明确提供新原文；首次普通进入才尝试读取真实剪贴板。
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
}

window.ztools?.onPluginEnter(handlePluginEnter)
