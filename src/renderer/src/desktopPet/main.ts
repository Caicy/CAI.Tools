import './style.css'
import type {
  DesktopPetBridge,
  PetAction,
  PetManifest,
  PetSnapshot
} from '../../../shared/desktopPetTypes'
import { validatePetManifest, PET_ACTIONS } from '../../../shared/desktopPetManifest'
import { getPetFrame } from './player'
import { PetClickArbiter } from './interaction'
import manifestData from './assets/manifest.json'
import atlasUrl from './assets/atlas.png?url'

declare global {
  interface Window {
    desktopPet: DesktopPetBridge
  }
}

const bridge = window.desktopPet
const canvas = document.querySelector<HTMLCanvasElement>('#pet')!
const ball = document.querySelector<HTMLDivElement>('#ball')!
const letter = document.querySelector<HTMLSpanElement>('#letter')!
const surface = document.querySelector<HTMLDivElement>('#surface')!
const ctx = canvas.getContext('2d')!
const clicks = new PetClickArbiter()
let snapshot: PetSnapshot
let manifest: PetManifest
let atlas: ImageBitmap | null = null
let loading: Promise<void> | null = null
let revision = 0
let gaze = { x: 0, y: 0 }
let gazeDirty = true
let action: PetAction = 'idle'
let elapsed = 0
let lastTime = performance.now()
let lastFrame = -1
let timer: ReturnType<typeof setTimeout> | undefined
let gesture: { pointer: number; x: number; y: number; lastX: number; dragging: boolean } | null =
  null

/**
 * 判断当前快照是否能够显示宠物。
 * @returns 是否为有效宠物模式。
 */
function isPetMode(): boolean {
  return snapshot?.config.mode === 'pet' && !snapshot.error
}

/**
 * 加载固定内置素材并生成低分辨率alpha掩码。
 * @returns 加载完成的 Promise。
 * @throws 图片或帧数据不合法时抛错。
 */
async function loadAtlas(): Promise<void> {
  if (atlas) return
  const response = await fetch(atlasUrl)
  if (!response.ok) throw new Error('宠物图片读取失败')
  const blob = await response.blob()
  if (blob.size > 20 * 1024 * 1024) throw new Error('宠物图片超过大小限制')
  const image = await createImageBitmap(blob)
  try {
    manifest = validatePetManifest(manifestData, image.width, image.height)
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = 48
    maskCanvas.height = 64
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })!
    const masks: Uint8Array[] = []
    for (let row = 0; row < manifest.rows; row++) {
      for (let col = 0; col < manifest.columns; col++) {
        maskContext.clearRect(0, 0, 48, 64)
        maskContext.drawImage(
          image,
          col * manifest.cell.width,
          row * manifest.cell.height,
          manifest.cell.width,
          manifest.cell.height,
          0,
          0,
          48,
          64
        )
        const pixels = maskContext.getImageData(0, 0, 48, 64).data
        const mask = new Uint8Array(48 * 64)
        for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3] > 16 ? 1 : 0
        const required = PET_ACTIONS.some(
          /**
           * 判断当前元素是否触及输入校验边界。
           * @param name 当前回调输入。
           * @returns 是否满足检查条件。
           */
          (name) => manifest.clips[name].row === row && col < manifest.clips[name].frames
        )
        const occupied = mask.reduce(
          /**
           * 累计帧时间或掩码占用量。
           * @param sum 当前回调输入。
           * @param alpha 当前回调输入。
           * @returns 更新后的累计值。
           */
          (sum, alpha) => sum + alpha,
          0
        )
        if (
          (required && occupied === 0) ||
          (!required && occupied > 0) ||
          occupied > mask.length * 0.9
        ) {
          throw new Error('宠物图片存在缺帧或不透明背景')
        }
        masks.push(mask)
      }
    }
    bridge.masks(masks, 48, 64)
    atlas = image
  } catch (error) {
    image.close()
    throw error
  }
}

/**
 * 按动作时钟绘制交互帧；待机固定首帧，正面动作保持当前视线。
 * @returns 无返回值。
 */
function render(): void {
  clearTimeout(timer)
  if (!atlas || !isPetMode() || document.hidden) return
  const now = performance.now()
  if (!snapshot.config.paused && action !== 'idle') elapsed += Math.max(0, now - lastTime)
  lastTime = now
  let selected = getPetFrame(manifest.clips[action], action === 'idle' ? 0 : elapsed)
  if (selected.done) {
    action = 'idle'
    elapsed = 0
    selected = getPetFrame(manifest.clips.idle, 0)
  }
  const index = manifest.clips[action].row * manifest.columns + selected.frame
  const frontFacing = action === 'idle' || action === 'waving'
  if (index !== lastFrame || (frontFacing && gazeDirty)) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(
      atlas,
      selected.frame * manifest.cell.width,
      manifest.clips[action].row * manifest.cell.height,
      manifest.cell.width,
      manifest.cell.height,
      0,
      0,
      canvas.width,
      canvas.height
    )
    // 已对齐的正面动作复用当前视线，避免点击时眼睛回正再跳回。
    if (frontFacing) drawGaze()
    gazeDirty = false
    lastFrame = index
    canvas.dataset.frame = String(index)
    canvas.dataset.action = action
    canvas.dataset.ready = 'true'
    bridge.send({ type: 'frame', index })
  }
  if (!snapshot.config.paused && action !== 'idle')
    timer = setTimeout(render, Math.max(16, selected.remainingMs))
}

/**
 * 在固定正面帧上移动眼睛，限制偏移始终留在面部内。
 * @returns 无返回值。
 */
function drawGaze(): void {
  if (!atlas) return
  ctx.save()
  ctx.scale(canvas.width / 192, canvas.height / 256)
  for (const x of [82, 126]) {
    // 用面部邻近的背景条覆盖原眼睛，再移动原图眼睛以保留画风。
    ctx.drawImage(atlas, x - 10, 135, 20, 5, x - 10, 141, 20, 32)
    ctx.drawImage(atlas, x - 7, 144, 14, 26, x - 7 + gaze.x * 5, 144 + gaze.y * 4, 14, 26)
  }
  ctx.restore()
  canvas.dataset.gazeX = String(gaze.x)
  canvas.dataset.gazeY = String(gaze.y)
}

/**
 * 切换动作并从第一帧开始，已选中动作不重置。
 * @param next 下一动作。
 * @returns 无返回值。
 */
function setAction(next: PetAction): void {
  if (action === next) return
  action = next
  elapsed = 0
  lastTime = performance.now()
  render()
}

/**
 * 仅在像素尺寸变化时重建等比例画布，保留正在播放的动作时钟。
 * @returns 无返回值。
 */
function resize(): void {
  if (!manifest) return
  // 按素材比例生成缓冲区；窗口临时改变比例时由 object-fit 等比例容纳。
  const scale = Math.min(innerWidth / manifest.cell.width, innerHeight / manifest.cell.height)
  const width = Math.max(1, Math.round(manifest.cell.width * scale * devicePixelRatio))
  const height = Math.max(1, Math.round(manifest.cell.height * scale * devicePixelRatio))
  if (canvas.width === width && canvas.height === height) {
    render()
    return
  }
  canvas.width = width
  canvas.height = height
  lastFrame = -1
  // render 自行累计经过的时间；移窗产生的 resize 不得吞掉帧间时间。
  render()
}

/**
 * 取消手势和延迟点击，释放原生拖动锁。
 * @returns 无返回值。
 */
function cancelGesture(): void {
  clicks.cancel()
  bridge.send({ type: 'press', active: false })
  bridge.send({ type: 'fileHover', active: false })
  if (gesture?.dragging) bridge.send({ type: 'dragEnd' })
  const pointer = gesture?.pointer
  gesture = null
  if (pointer !== undefined && surface.hasPointerCapture(pointer))
    surface.releasePointerCapture(pointer)
  surface.classList.remove('file-hover')
  setAction('idle')
}

/**
 * 应用最新快照，丢弃异步加载期间过期的设置。
 * @param next 主进程快照。
 * @returns 更新完成的 Promise。
 */
async function applySnapshot(next: PetSnapshot): Promise<void> {
  const current = ++revision
  // 暂停只冻结时钟；切换外观或尺寸才终止手势，避免暂停把动作重置为待机。
  if (
    !snapshot ||
    snapshot.config.mode !== next.config.mode ||
    snapshot.config.size !== next.config.size ||
    next.error
  ) {
    cancelGesture()
  } else if (!snapshot.config.paused) {
    elapsed += Math.max(0, performance.now() - lastTime)
  }
  snapshot = next
  lastTime = performance.now()
  clearTimeout(timer)
  letter.textContent = next.letter || 'Z'
  ball.hidden = isPetMode()
  canvas.hidden = !isPetMode()
  if (!isPetMode()) return
  try {
    loading ??= loadAtlas().finally(
      /**
       * 释放加载中的标记，允许后续请求重试。
       * @returns 无返回值。
       */
      () => {
        loading = null
      }
    )
    await loading
    if (current !== revision) return
    resize()
  } catch (error) {
    if (current === revision)
      bridge.send({
        type: 'failure',
        message: error instanceof Error ? error.message : '宠物加载失败'
      })
  }
}

surface.addEventListener(
  'pointerdown',
  /**
   * 处理 pointerdown 事件，维护对应的窗口或页面状态。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    if (event.button !== 0) return
    bridge.send({ type: 'press', active: true })
    gesture = {
      pointer: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      lastX: event.screenX,
      dragging: false
    }
    surface.setPointerCapture(event.pointerId)
  }
)
surface.addEventListener(
  'pointermove',
  /**
   * 达到拖动阈值后立即播放跑步，水平位移决定朝向。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    if (!gesture) return
    if (!gesture.dragging && Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) > 5) {
      gesture.dragging = true
      clicks.cancel()
      bridge.send({ type: 'dragStart', x: gesture.x, y: gesture.y })
      // 纯垂直拖动也进入跑步，避免必须先横向移动才能播放动画。
      setAction(event.screenX < gesture.x ? 'running-left' : 'running-right')
    }
    if (gesture.dragging && Math.abs(event.screenX - gesture.lastX) > 2) {
      setAction(event.screenX > gesture.lastX ? 'running-right' : 'running-left')
      gesture.lastX = event.screenX
    }
  }
)
surface.addEventListener(
  'pointerup',
  /**
   * 处理 pointerup 事件，维护对应的窗口或页面状态。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    if (!gesture || gesture.pointer !== event.pointerId) return
    const dragged = gesture.dragging
    bridge.send({ type: 'press', active: false })
    gesture = null
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    if (dragged) {
      bridge.send({ type: 'dragEnd' })
      setAction('idle')
    } else
      clicks.click(
        /**
         * 处理当前回调并同步桌面入口状态。
         * @returns 当前表达式的计算结果。
         */
        () => {
          setAction('waving')
          bridge.send({ type: 'click' })
        },
        /**
         * 处理当前回调并同步桌面入口状态。
         * @returns 当前表达式的计算结果。
         */
        () => bridge.send({ type: 'doubleClick' })
      )
  }
)
surface.addEventListener('pointercancel', cancelGesture)
surface.addEventListener(
  'lostpointercapture',
  /**
   * 处理 lostpointercapture 事件，维护对应的窗口或页面状态。
   * @returns 无返回值。
   */
  () => {
    if (gesture) cancelGesture()
  }
)
surface.addEventListener(
  'contextmenu',
  /**
   * 处理 contextmenu 事件，维护对应的窗口或页面状态。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    event.preventDefault()
    cancelGesture()
    bridge.send({ type: 'contextMenu' })
  }
)
surface.addEventListener(
  'dragover',
  /**
   * 处理 dragover 事件，维护对应的窗口或页面状态。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    bridge.send({ type: 'fileHover', active: true })
    surface.classList.add('file-hover')
  }
)
surface.addEventListener(
  'dragleave',
  /**
   * 处理 dragleave 事件，维护对应的窗口或页面状态。
   * @returns 当前表达式的计算结果。
   */
  () => {
    surface.classList.remove('file-hover')
    bridge.send({ type: 'fileHover', active: false })
  }
)
surface.addEventListener(
  'drop',
  /**
   * 处理 drop 事件，维护对应的窗口或页面状态。
   * @param event 当前事件及其调用上下文。
   * @returns 无返回值。
   */
  (event) => {
    event.preventDefault()
    cancelGesture()
    if (event.dataTransfer) bridge.drop(Array.from(event.dataTransfer.files))
  }
)
window.addEventListener(
  'blur',
  /**
   * 失焦仅取消未结束的按压或拖动，保留点击切换主窗口后的挥手。
   * @returns 无返回值。
   */
  () => {
    // 单击交付前已释放手势；主窗口获得焦点不应中断已开始的动画。
    if (gesture) cancelGesture()
  }
)
window.addEventListener('resize', resize)
document.addEventListener(
  'visibilitychange',
  /**
   * 处理 visibilitychange 事件，维护对应的窗口或页面状态。
   * @returns 无返回值。
   */
  () => {
    clearTimeout(timer)
    lastTime = performance.now()
    if (document.hidden) cancelGesture()
    else render()
  }
)
const unsubscribe = bridge.onSnapshot(
  /**
   * 处理当前回调并同步桌面入口状态。
   * @param value 当前回调输入。
   * @returns 无返回值。
   */
  (value) => {
    void applySnapshot(value)
  }
)
const unsubscribeGaze = bridge.onGaze(
  /**
   * 接收系统光标方向，待机按需重绘，暂停时保持当前眼睛位置。
   * @param point 归一化方向。
   * @returns 无返回值。
   */
  (point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || snapshot?.config.paused) return
    const next = { x: Math.max(-1, Math.min(1, point.x)), y: Math.max(-1, Math.min(1, point.y)) }
    if (next.x === gaze.x && next.y === gaze.y) return
    gaze = next
    gazeDirty = true
    if (action === 'idle') render()
  }
)
window.addEventListener(
  'beforeunload',
  /**
   * 处理 beforeunload 事件，维护对应的窗口或页面状态。
   * @returns 无返回值。
   */
  () => {
    cancelGesture()
    clearTimeout(timer)
    unsubscribe()
    unsubscribeGaze()
    atlas?.close()
  }
)
void bridge.ready().then(applySnapshot)
