import './style.css'
import type {
  DesktopPetCompanionBridge,
  PetCompanionSnapshot,
  PetDialogueEntry
} from '../../../../shared/desktopPetCompanionTypes'

declare global {
  interface Window {
    desktopPetCompanion: DesktopPetCompanionBridge
  }
}

const bridge = window.desktopPetCompanion
const messages = document.querySelector<HTMLElement>('#messages')!
const notice = document.querySelector<HTMLElement>('#notice')!
const model = document.querySelector<HTMLSelectElement>('#model')!
const reviews = document.querySelector<HTMLInputElement>('#reviews')!
const draft = document.querySelector<HTMLTextAreaElement>('#draft')!
const send = document.querySelector<HTMLButtonElement>('#send')!
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!
const clear = document.querySelector<HTMLButtonElement>('#clear')!
const pat = document.querySelector<HTMLButtonElement>('#pat')!
const feed = document.querySelector<HTMLButtonElement>('#feed')!
const count = document.querySelector<HTMLElement>('#count')!
const rows = new Map<string, { root: HTMLElement; label: HTMLElement; text: HTMLElement }>()
let state: PetCompanionSnapshot | null = null
let receivedPush = false
let submitting = false
let configuring = false
let localError = ''
let modelOptionsKey = ''

/**
 * 同步可用操作，不重建输入控件或移动焦点。
 * @returns 无返回值。
 */
function updateControls(): void {
  const busy = Boolean(state?.busy) || submitting
  draft.disabled = !state
  send.disabled = !state || busy || !draft.value.trim()
  model.disabled = !state || configuring || busy
  reviews.disabled = !state || configuring || busy
  pat.disabled = !state
  feed.disabled = !state
  clear.disabled = !state || (!state.messages.length && !busy)
  cancel.hidden = !state?.busy
  count.textContent = `${draft.value.length} / 1000`
  notice.textContent =
    localError || state?.notice || (busy ? '小薄荷正在想怎么回答…' : '慢慢说，我在听。')
  notice.classList.toggle('error', Boolean(localError))
}

/**
 * 创建安全的纯文本消息节点。
 * @param entry 对话消息。
 * @returns 可增量更新的节点集合。
 */
function createMessage(entry: PetDialogueEntry): {
  root: HTMLElement
  label: HTMLElement
  text: HTMLElement
} {
  const root = document.createElement('article')
  const label = document.createElement('div')
  const text = document.createElement('p')
  root.className = `message ${entry.role}`
  root.dataset.messageId = entry.id
  label.className = 'message-label'
  root.append(label, text)
  return { root, label, text }
}

/**
 * 应用状态快照，以文本节点更新流式消息并保留用户滚动位置。
 * @param next 主进程提供的最新状态。
 * @returns 无返回值。
 */
function render(next: PetCompanionSnapshot): void {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48
  state = next
  // 只在模型列表改变时重建选项，流式推送不会重置正在进行的配置。
  const key = JSON.stringify([next.models, next.modelRef])
  if (key !== modelOptionsKey) {
    const options = [new Option('本地陪伴 · 不调用 AI', '')]
    for (const item of next.models) {
      if (item.value) options.push(new Option(item.label, item.value))
    }
    // 保留失效引用的可见提示，让用户明确重新选择模型。
    if (
      next.modelRef &&
      !next.models.some(
        /**
         * 判断持久化的模型是否仍在可用列表中。
         * @param item 当前模型。
         * @returns 是否为已选模型。
         */
        (item) => item.value === next.modelRef
      )
    ) {
      const unavailable = new Option('已选模型不可用，请重新选择', next.modelRef)
      unavailable.disabled = true
      options.push(unavailable)
    }
    model.replaceChildren(...options)
    modelOptionsKey = key
  }
  if (!configuring) {
    model.value = next.modelRef
    reviews.checked = next.reviewsEnabled
  }
  // 模型文本一律使用 textContent，禁止将回复作为 HTML 插入。
  const retained = new Set<string>()
  if (next.messages.length) messages.querySelector('.empty-state')?.remove()
  for (const entry of next.messages) {
    retained.add(entry.id)
    let row = rows.get(entry.id)
    if (!row) {
      row = createMessage(entry)
      rows.set(entry.id, row)
      messages.append(row.root)
    }
    row.label.textContent =
      entry.role === 'user' ? '你' : `小薄荷 · ${entry.source === 'ai' ? 'AI 回复' : '本地陪伴'}`
    row.text.textContent = entry.text || '…'
  }
  for (const [id, row] of rows) {
    if (!retained.has(id)) {
      row.root.remove()
      rows.delete(id)
    }
  }
  if (!next.messages.length && !messages.querySelector('.empty-state')) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = '☘ 我在这里，陪你歇一会儿。'
    messages.append(empty)
  }
  if (nearBottom) messages.scrollTop = messages.scrollHeight
  updateControls()
}

/**
 * 显示请求失败信息，避免未处理的 IPC Promise。
 * @param error 请求错误。
 * @returns 无返回值。
 */
function reportError(error: unknown): void {
  localError = error instanceof Error ? error.message : '暂时没能完成，请再试一次。'
  updateControls()
}

/**
 * 提交消息，失败时在没有新草稿的情况下恢复原输入。
 * @param event 表单提交事件。
 * @returns 请求结束的 Promise。
 */
async function submit(event: Event): Promise<void> {
  event.preventDefault()
  const text = draft.value.trim()
  if (!state || state.busy || submitting || !text) return
  const original = draft.value
  submitting = true
  localError = ''
  draft.value = ''
  updateControls()
  try {
    await bridge.send(text)
  } catch (error) {
    if (!draft.value) draft.value = original
    reportError(error)
  } finally {
    submitting = false
    updateControls()
  }
}

/**
 * 在非输入法组字期间支持 Enter 发送。
 * @param event 键盘事件。
 * @returns 无返回值。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    document.querySelector<HTMLFormElement>('#composer')!.requestSubmit()
  }
}

/**
 * 保存用户配置，并在失败时恢复宿主确认的值。
 * @returns 配置结束的 Promise。
 */
async function configure(): Promise<void> {
  if (!state || configuring) return
  configuring = true
  localError = ''
  updateControls()
  try {
    await bridge.configure(model.value, reviews.checked)
  } catch (error) {
    reportError(error)
  } finally {
    configuring = false
    if (state) render(state)
  }
}

/**
 * 分发受限按钮操作并捕获 IPC 错误。
 * @param event 按钮点击事件。
 * @returns 操作结束的 Promise。
 */
async function onAction(event: Event): Promise<void> {
  const id = (event.currentTarget as HTMLElement).id
  localError = ''
  try {
    if (id === 'pat' || id === 'feed') await bridge.interact(id)
    else if (id === 'cancel') await bridge.cancel()
    else if (id === 'clear') await bridge.clear()
    else if (id === 'close') bridge.close()
  } catch (error) {
    reportError(error)
  }
  updateControls()
}

/**
 * 接收实时状态；标记推送优先于可能较旧的 ready 响应。
 * @param next 最新状态。
 * @returns 无返回值。
 */
function onState(next: PetCompanionSnapshot): void {
  receivedPush = true
  render(next)
}

/**
 * 订阅后再请求初始状态，避免启动期间漏掉回复。
 * @returns 初始化完成的 Promise。
 */
async function initialize(): Promise<void> {
  try {
    const unsubscribe = bridge.onState(onState)
    window.addEventListener('beforeunload', unsubscribe, { once: true })
    const initial = await bridge.ready()
    if (!receivedPush) render(initial)
  } catch (error) {
    reportError(error)
  }
}

document.querySelector('#composer')!.addEventListener('submit', submit)
draft.addEventListener('keydown', onKeydown)
draft.addEventListener('input', updateControls)
model.addEventListener('change', configure)
reviews.addEventListener('change', configure)
for (const id of ['pat', 'feed', 'cancel', 'clear', 'close']) {
  document.getElementById(id)!.addEventListener('click', onAction)
}
void initialize()
