import './style.css'
import type { DesktopPetRunnerBridge, RunnerPhase } from '../../../../shared/desktopPetRunnerTypes'
import { validatePetManifest } from '../../../../shared/desktopPetManifest'
import manifestData from '../assets/manifest.json'
import atlasUrl from '../assets/atlas.png?url'
import { getPetFrame } from '../player'
import { RunnerEngine, RUNNER } from './engine'

declare global {
  interface Window {
    desktopPetRunner: DesktopPetRunnerBridge
  }
}

const bridge = window.desktopPetRunner
const engine = new RunnerEngine()
const game = document.querySelector<HTMLElement>('#game')!
const canvas = document.querySelector<HTMLCanvasElement>('#track')!
const ctx = canvas.getContext('2d')!
const overlay = document.querySelector<HTMLElement>('#overlay')!
const title = document.querySelector<HTMLElement>('#title')!
const subtitle = document.querySelector<HTMLElement>('#subtitle')!
const primary = document.querySelector<HTMLButtonElement>('#primary')!
const restart = document.querySelector<HTMLButtonElement>('#restart')!
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!
const status = document.querySelector<HTMLElement>('#save-status')!
const distanceLabel = document.querySelector<HTMLElement>('#distance')!
const bestLabel = document.querySelector<HTMLElement>('#best')!
let atlas: ImageBitmap | null = null
let manifest = manifestData
let best = 0
let raf = 0
let lastTime = 0
let shownPhase: RunnerPhase | undefined
let runId = 0
let disposed = false
let loaded = false

/**
 * 更新分数及状态层，仅状态变化时切换按钮以保留焦点。
 * @returns 无返回值。
 */
function updateUI(): void {
  game.dataset.phase = engine.phase
  game.dataset.pauseReason = engine.pauseReason
  game.dataset.playerY = String(engine.y)
  game.dataset.distance = String(engine.distance)
  distanceLabel.textContent = `${Math.floor(engine.distance).toString().padStart(4, '0')} m`
  bestLabel.textContent = best.toString().padStart(4, '0')
  if (shownPhase === engine.phase && engine.phase !== 'countdown') return
  shownPhase = engine.phase
  overlay.hidden = engine.phase === 'running'
  primary.hidden = engine.phase === 'countdown'
  restart.hidden = engine.phase !== 'paused'
  pauseButton.disabled = engine.phase === 'ready' || engine.phase === 'gameOver'
  pauseButton.setAttribute('aria-label', engine.phase === 'paused' ? '继续游戏' : '暂停游戏')
  pauseButton.textContent = engine.phase === 'paused' ? '▷' : 'Ⅱ'
  switch (engine.phase) {
    case 'ready':
      title.textContent = '小薄荷，出发！'
      subtitle.textContent = '跳过石块与仙人掌，看看今天能跑多远。'
      primary.textContent = '开始快跑'
      break
    case 'countdown':
      title.textContent = String(Math.max(1, Math.ceil(engine.countdown)))
      subtitle.textContent = '准备好 · 空格 / ↑ / 点击跑道跳跃'
      break
    case 'paused':
      title.textContent = '休息一下，等你回来'
      subtitle.textContent =
        engine.pauseReason === 'long-frame'
          ? '刚才画面有些卡顿，已暂停保护进度。'
          : '进度已暂停，继续前会重新倒计时。'
      primary.textContent = '继续快跑'
      break
    case 'gameOver':
      title.textContent = `跑了 ${Math.floor(engine.distance)} 米！`
      subtitle.textContent =
        engine.distance >= best ? '新的步伐，新的纪录。' : '差一点就过去了，再试一次吧。'
      primary.textContent = '再跑一次'
      break
  }
}

/**
 * 绘制可见跑道、障碍和复用精灵；碰撞盒独立于素材透明边界。
 * @returns 无返回值。
 */
function draw(): void {
  ctx.clearRect(0, 0, RUNNER.width, RUNNER.height)
  ctx.strokeStyle = '#698c73'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(20, RUNNER.ground + 0.5)
  ctx.lineTo(780, RUNNER.ground + 0.5)
  ctx.stroke()
  ctx.fillStyle = '#4b6b57'
  const offset = (engine.distance * 10) % 65
  for (let x = 20 - offset; x < 780; x += 65) ctx.fillRect(x, 201, 12, 1)
  for (const obstacle of engine.obstacles) {
    ctx.fillStyle = obstacle.kind === 'cactus' ? '#9bcc8a' : '#a2ada1'
    ctx.beginPath()
    ctx.roundRect(
      obstacle.x,
      RUNNER.ground - obstacle.height,
      obstacle.width,
      obstacle.height,
      obstacle.kind === 'cactus' ? 7 : [15, 18, 3, 3]
    )
    ctx.fill()
    if (obstacle.kind === 'cactus') {
      ctx.strokeStyle = '#446a42'
      ctx.beginPath()
      ctx.moveTo(obstacle.x + 12, RUNNER.ground - 40)
      ctx.lineTo(obstacle.x + 12, RUNNER.ground - 4)
      ctx.stroke()
    } else {
      ctx.fillStyle = '#d2d5bf'
      ctx.fillRect(obstacle.x + 9, RUNNER.ground - 21, 9, 3)
    }
  }
  if (atlas) {
    const clip = manifest.clips['running-right']
    const frame = engine.y < 0 ? 2 : getPetFrame(clip, engine.elapsed * 1000).frame
    ctx.save()
    ctx.translate(RUNNER.playerX, RUNNER.ground + engine.y)
    if (engine.phase === 'gameOver') ctx.rotate(-0.18)
    // 图集每格底部含约 30px 留白，将实际脚底对齐地面。
    ctx.drawImage(atlas, frame * 192, clip.row * 256, 192, 256, -38, -90, 76, 102)
    ctx.restore()
  }
  updateUI()
}

/**
 * 单次结算持久化，过期异步结果不覆盖新一局。
 * @param id 结算对应的局号。
 * @param distance 本局距离。
 * @returns 保存结束的 Promise。
 */
async function saveResult(id: number, distance: number): Promise<void> {
  try {
    const result = await bridge.save(distance)
    if (disposed) return
    best = Math.max(best, result.bestDistance)
    if (id === runId)
      status.textContent = result.saved ? '纪录已保存在本机' : '纪录未保存，可以继续游戏或返回桌宠'
    draw()
  } catch {
    if (!disposed && id === runId) status.textContent = '纪录未保存，可以继续游戏或返回桌宠'
  }
}

/**
 * 在活动状态推进画面，暂停与结算不持续占用动画循环。
 * @param now 浏览器单调时钟。
 * @returns 无返回值。
 */
function tick(now: number): void {
  raf = 0
  const previous = engine.phase
  game.dataset.frameGap = String(lastTime ? now - lastTime : 0)
  engine.advance(lastTime ? (now - lastTime) / 1000 : 0)
  lastTime = now
  draw()
  if (previous !== 'gameOver' && engine.phase === 'gameOver')
    void saveResult(runId, Math.floor(engine.distance))
  if (engine.phase === 'running' || engine.phase === 'countdown') raf = requestAnimationFrame(tick)
}

/**
 * 从用户输入启动或恢复动画时钟，丢弃后台经过的时间。
 * @returns 无返回值。
 */
function animate(): void {
  cancelAnimationFrame(raf)
  // 继续游戏后释放按钮焦点，让空格恢复跳跃语义而非再次点击暂停。
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
  lastTime = 0
  draw()
  raf = requestAnimationFrame(tick)
}

/**
 * 创建新一局并清空结算提示。
 * @returns 无返回值。
 */
function newRun(): void {
  if (!loaded) return
  runId++
  status.textContent = ''
  engine.restart()
  animate()
}

/**
 * 响应主按钮：暂停时继续，其余状态开启新一局。
 * @returns 无返回值。
 */
function activate(): void {
  if (!loaded) return
  if (engine.phase === 'paused') {
    engine.resume()
    animate()
  } else if (engine.phase === 'ready' || engine.phase === 'gameOver') newRun()
}

/**
 * 冻结游戏并停止帧调度。
 * @param reason 暂停来源。
 * @returns 无返回值。
 */
function pause(reason = 'user'): void {
  engine.pause(reason)
  cancelAnimationFrame(raf)
  raf = 0
  lastTime = 0
  draw()
}

/**
 * 明确用户请求时切换暂停/继续。
 * @returns 无返回值。
 */
function togglePause(): void {
  if (engine.phase === 'paused') activate()
  else pause()
}

/**
 * 按工作区缩放固定逻辑画布，DPR 只影响清晰度。
 * @returns 无返回值。
 */
function resize(): void {
  const scale = Math.min(innerWidth / RUNNER.width, innerHeight / RUNNER.height)
  game.style.transform = `scale(${scale})`
  const density = devicePixelRatio * scale
  canvas.width = Math.round(RUNNER.width * density)
  canvas.height = Math.round(RUNNER.height * density)
  ctx.setTransform(canvas.width / RUNNER.width, 0, 0, canvas.height / RUNNER.height, 0, 0)
  draw()
}

/**
 * 只处理游戏窗口按键，按钮聚焦时保留原生空格激活行为。
 * @param event 当前键盘事件。
 * @returns 无返回值。
 */
function keydown(event: KeyboardEvent): void {
  if (event.code === 'Escape') {
    event.preventDefault()
    if (!event.repeat) togglePause()
    return
  }
  if (!['Space', 'ArrowUp'].includes(event.code)) return
  if (event.repeat) {
    event.preventDefault()
    return
  }
  if (event.target instanceof HTMLButtonElement) return
  event.preventDefault()
  if (engine.phase === 'running') engine.jump()
  else if (engine.phase === 'ready') activate()
}

primary.addEventListener('click', activate)
restart.addEventListener('click', newRun)
pauseButton.addEventListener('click', togglePause)
document.querySelector('#exit')!.addEventListener('click', bridge.exit)
document.querySelector('#return')!.addEventListener('click', bridge.exit)
canvas.addEventListener(
  'pointerdown',
  /**
   * 跑道点击立即跳跃，不使用桌宠单双击仲裁。
   * @param event 指针事件。
   * @returns 无返回值。
   */
  (event) => {
    if (event.button !== 0) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (engine.phase === 'ready') activate()
    else engine.jump()
  }
)
window.addEventListener('keydown', keydown)
window.addEventListener(
  'blur',
  /**
   * 记录窗口焦点导致的暂停。
   * @returns 无返回值。
   */
  () => pause('window-blur')
)
window.addEventListener('resize', resize)
document.addEventListener(
  'visibilitychange',
  /**
   * 页面被隐藏时冻结赛况，显示后仍等待主动继续。
   * @returns 无返回值。
   */
  () => {
    if (document.hidden) pause('hidden')
  }
)
overlay.addEventListener(
  'pointerdown',
  /**
   * 准备画面空白区域点击也能开始；按钮保留各自行为。
   * @param event 指针事件。
   * @returns 无返回值。
   */
  (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button')))
      return
    if (engine.phase === 'ready') activate()
  }
)
const unsubscribe = bridge.onPause(
  /**
   * 接收宿主挂起或失焦通知。
   * @returns 无返回值。
   */
  () => pause('host')
)
window.addEventListener(
  'unload',
  /**
   * 释放动画、位图与宿主订阅。
   * @returns 无返回值。
   */
  () => {
    disposed = true
    cancelAnimationFrame(raf)
    unsubscribe()
    atlas?.close()
  }
)

/**
 * 加载可信图集并完成窗口握手，任何失败均回滚到桌宠。
 * @returns 初始化结束的 Promise。
 */
async function initialize(): Promise<void> {
  try {
    const response = await fetch(atlasUrl)
    if (!response.ok) throw new Error('素材加载失败')
    atlas = await createImageBitmap(await response.blob())
    manifest = validatePetManifest(manifestData, atlas.width, atlas.height)
    const record = await bridge.ready()
    best = record.bestDistance
    loaded = true
    resize()
    game.dataset.ready = 'true'
  } catch {
    bridge.failed()
  }
}
void initialize()
