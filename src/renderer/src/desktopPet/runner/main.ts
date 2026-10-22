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
    runnerTest?: { advance(seconds: number, bot?: boolean): void; previewBird(duck: boolean): void }
  }
}

const bridge = window.desktopPetRunner
const engine = new RunnerEngine()
// 单格脚底 y=230；按像素下缘 231/256 对齐地面，蹲姿仍以地面为锚。
const SPRITE_DESTINATION = { x: -38, y: -(231 * 76) / 192, width: 76 } as const
let gesture: { id: number; x: number; y: number; moving: boolean } | null = null
let testClock = false
const heldKeys = new Set<string>()
let pointerJump = false
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
  game.dataset.level = String(engine.stage.level)
  game.dataset.ducking = String(engine.ducking)
  const levelText = `LV ${engine.stage.level} · ${engine.stage.name}`
  document.querySelector('#level')!.textContent = levelText
  document.querySelector('#sprint')!.textContent = engine.sprint
  const banner = document.querySelector<HTMLElement>('#level-banner')!
  banner.textContent = levelText
  banner.hidden = engine.phase !== 'running' || engine.elapsed - engine.stage.start >= 2.2
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
      subtitle.textContent = '按住跳更高 · ↓ / S 下蹲，空中按下快速落地。'
      primary.textContent = '开始快跑'
      break
    case 'countdown':
      title.textContent = String(Math.max(1, Math.ceil(engine.countdown)))
      subtitle.textContent = '空格 / ↑ / 跑道 · 按住跳更高，↓ 下蹲'
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
  // 天色随存活阶段渐暗；不依赖墙钟或随机颜色，障碍始终使用高对比色。
  const dark = Math.min(1, engine.elapsed / 140)
  const sky = ctx.createLinearGradient(0, 0, 0, RUNNER.height)
  sky.addColorStop(
    0,
    `rgb(${Math.round(40 - dark * 27)}, ${Math.round(72 - dark * 46)}, ${Math.round(62 - dark * 24)})`
  )
  sky.addColorStop(1, '#152b29')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, RUNNER.width, RUNNER.height)
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
    const bottom = RUNNER.ground - (obstacle.bottom ?? 0)
    const top = bottom - obstacle.height
    const bird = obstacle.kind.includes('bird')
    const cactus = obstacle.kind.includes('cactus')
    ctx.fillStyle = bird ? '#f0c896' : cactus ? '#9bcc8a' : '#a2ada1'
    if (bird) {
      // 两帧翅膀只改变装饰，向下帧不越过身体底面，避免误导下蹲净空。
      const wing = Math.floor(engine.elapsed * 6) % 2 === 0 ? -22 : 8
      ctx.beginPath()
      ctx.ellipse(
        obstacle.x + obstacle.width / 2,
        top + 10,
        obstacle.width / 2,
        10,
        0,
        0,
        Math.PI * 2
      )
      ctx.fill()
      ctx.fillStyle = '#d9ab78'
      ctx.beginPath()
      ctx.moveTo(obstacle.x + 12, top + 9)
      ctx.lineTo(obstacle.x + 24, top + 9 + wing)
      ctx.lineTo(obstacle.x + 30, top + 9)
      ctx.fill()
      ctx.fillStyle = '#283a35'
      ctx.fillRect(obstacle.x + 6, top + 6, 3, 3)
      ctx.fillStyle = '#ffdca0'
      ctx.beginPath()
      ctx.moveTo(obstacle.x, top + 8)
      ctx.lineTo(obstacle.x - 6, top + 12)
      ctx.lineTo(obstacle.x + 2, top + 14)
      ctx.fill()
      ctx.font = '12px "Segoe UI"'
      ctx.fillText(obstacle.kind === 'mid-bird' ? '↓' : '↑', obstacle.x + 13, top - 18)
    } else {
      ctx.beginPath()
      ctx.roundRect(obstacle.x, top, obstacle.width, obstacle.height, cactus ? 7 : [15, 18, 3, 3])
      ctx.fill()
      if (cactus) {
        ctx.strokeStyle = '#446a42'
        // 双仙人掌的分隔线让宽障碍与单株明确区分。
        for (let x = obstacle.x + 12; x < obstacle.x + obstacle.width; x += 29) {
          ctx.beginPath()
          ctx.moveTo(x, top + 7)
          ctx.lineTo(x, bottom - 4)
          ctx.stroke()
        }
      } else if (obstacle.kind === 'rolling-rock') {
        ctx.save()
        ctx.translate(obstacle.x + 15, bottom - 15)
        ctx.rotate(-engine.elapsed * 9)
        ctx.strokeStyle = '#d2d5bf'
        ctx.beginPath()
        ctx.moveTo(-10, 0)
        ctx.lineTo(10, 0)
        ctx.moveTo(0, -10)
        ctx.lineTo(0, 10)
        ctx.stroke()
        ctx.restore()
      } else {
        ctx.fillStyle = '#d2d5bf'
        ctx.fillRect(obstacle.x + 7, top + 7, 9, 3)
      }
    }
  }
  if (atlas) {
    const clip = manifest.clips['running-right']
    const frame = engine.y < 0 ? 2 : getPetFrame(clip, engine.elapsed * 1000).frame
    ctx.save()
    ctx.translate(RUNNER.playerX, RUNNER.ground + engine.y)
    if (engine.phase === 'gameOver') ctx.rotate(-0.18)
    // 下蹲整体等比缩小，不挤压圆形；来源单元和行号完全由 manifest 决定。
    if (engine.ducking) ctx.scale(RUNNER.duckScale, RUNNER.duckScale)
    const cell = manifest.cell
    const destination = SPRITE_DESTINATION
    ctx.drawImage(
      atlas,
      frame * cell.width,
      clip.row * cell.height,
      cell.width,
      cell.height,
      destination.x,
      destination.y,
      destination.width,
      (destination.width * cell.height) / cell.width
    )
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
  // 短评先于保存请求取得旧纪录，独立等待，不阻塞结算与再来一次。
  void showReview(id, distance)
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
 * 显示本局短评，重开、退出或取消后丢弃旧结果。
 * @param id 本局代号。
 * @param distance 本局距离。
 * @returns 短评处理完成后的 Promise。
 */
async function showReview(id: number, distance: number): Promise<void> {
  const review = document.querySelector<HTMLElement>('#pet-review')!
  review.dataset.source = 'local'
  review.textContent = '小薄荷：跑得不错，先歇一会儿吧。'
  try {
    const line = await bridge.review(distance)
    if (disposed || id !== runId || !line) return
    review.textContent = `小薄荷：${line.text}`
    review.dataset.source = line.source
  } catch {
    // 保留即时本地台词，不影响保存或再开一局。
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
  if (!testClock) raf = requestAnimationFrame(tick)
}

/**
 * 创建新一局并清空结算提示。
 * @returns 无返回值。
 */
function newRun(): void {
  if (!loaded) return
  bridge.cancelReview()
  document.querySelector<HTMLElement>('#pet-review')!.textContent = ''
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
  // 失焦或拖动后遗失 keyup 时也不保留旧按键状态。
  heldKeys.clear()
  pointerJump = false
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
  if (!['Space', 'ArrowUp', 'ArrowDown', 'KeyS'].includes(event.code)) return
  if (event.target instanceof HTMLButtonElement) return
  event.preventDefault()
  if (event.repeat) return
  heldKeys.add(event.code)
  if (event.code === 'ArrowDown' || event.code === 'KeyS') engine.setDuck(true)
  else if (engine.phase === 'running') engine.setJump(true)
  else if (engine.phase === 'ready') activate()
  draw()
}

/**
 * 释放按键时记录输入，另一个跳跃键仍按住时不截断。
 * @param event 键盘释放事件。
 * @returns 无返回值。
 */
function keyup(event: KeyboardEvent): void {
  heldKeys.delete(event.code)
  engine.setJump(pointerJump || heldKeys.has('Space') || heldKeys.has('ArrowUp'))
  engine.setDuck(heldKeys.has('ArrowDown') || heldKeys.has('KeyS'))
  draw()
}

/**
 * 判断 HUD 和跑道外围空白，按钮及实际跑道从不作为拖动区。
 * @param event 指针事件。
 * @returns 是否可拖动。
 */
function dragRegion(event: PointerEvent): boolean {
  if (event.target instanceof Element && event.target.closest('button')) return false
  if (event.target instanceof Element && event.target.closest('header')) return true
  const rect = canvas.getBoundingClientRect()
  const x = ((event.clientX - rect.left) * RUNNER.width) / rect.width
  const y = ((event.clientY - rect.top) * RUNNER.height) / rect.height
  return x < 20 || x > 780 || y < 47 || y > 207
}

/**
 * 释放指针手势并让主进程夹取及持久化。
 * @returns 无返回值。
 */
function endPointer(): void {
  if (gesture) {
    gesture = null
    bridge.drag({ type: 'end' })
  }
  pointerJump = false
  engine.setJump(heldKeys.has('Space') || heldKeys.has('ArrowUp'))
  draw()
}

game.addEventListener(
  'pointerdown',
  /**
   * HUD/边距只捕获拖动，点按不会暂停或起跳。
   * @param event 指针事件。
   * @returns 无返回值。
   */
  (event) => {
    if (event.button !== 0 || !dragRegion(event)) return
    gesture = { id: event.pointerId, x: event.screenX, y: event.screenY, moving: false }
    bridge.drag({ type: 'start', x: event.screenX, y: event.screenY })
    game.setPointerCapture(event.pointerId)
  }
)
game.addEventListener(
  'pointermove',
  /**
   * 达到拖动阈值后暂停，继续始终走正常倒计时。
   * @param event 指针事件。
   * @returns 无返回值。
   */
  (event) => {
    if (!gesture || event.pointerId !== gesture.id) return
    if (!gesture.moving && Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 4) {
      gesture.moving = true
      pause('drag')
    }
    if (gesture.moving) bridge.drag({ type: 'move', x: event.screenX, y: event.screenY })
  }
)
window.addEventListener('pointerup', endPointer)
window.addEventListener('pointercancel', endPointer)
game.addEventListener('lostpointercapture', endPointer)

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
    if (event.button !== 0 || dragRegion(event)) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    canvas.setPointerCapture(event.pointerId)
    if (engine.phase === 'ready') activate()
    else {
      pointerJump = true
      engine.setJump(true)
    }
    draw()
  }
)
window.addEventListener('keydown', keydown)
window.addEventListener('keyup', keyup)
window.addEventListener(
  'blur',
  /**
   * 记录窗口焦点导致的暂停。
   * @returns 无返回值。
   */
  () => {
    if (!gesture) pause('window-blur')
  }
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
    if (
      event.button !== 0 ||
      dragRegion(event) ||
      (event.target instanceof Element && event.target.closest('button'))
    )
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
    if (gesture) bridge.drag({ type: 'end' })
    cancelAnimationFrame(raf)
    unsubscribe()
    atlas?.close()
  }
)

/**
 * 只为双环境标记的非打包测试窗口安装固定步时钟与视觉夹具。
 * @returns 无返回值。
 */
function installTestClock(): void {
  if (!bridge.testEnabled) return
  // 生产窗口不携带标记，不创建此对象；不改变生产帧保护、分数或输入行为。
  window.runnerTest = {
    /**
     * 通过真实固定步和可选状态机器人快进，冻结墙钟便于截图。
     * @param seconds 有限推进秒数，单次最多 300 秒。
     * @param bot 是否通过引擎输入避障。
     * @returns 无返回值。
     */
    advance(seconds: number, bot = false): void {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) return
      testClock = true
      cancelAnimationFrame(raf)
      const previous = engine.phase
      for (let i = 0; i < Math.round(seconds / RUNNER.step); i++) {
        if (bot && engine.phase === 'running') {
          let next: (typeof engine.obstacles)[number] | undefined
          for (const obstacle of engine.obstacles)
            if (
              obstacle.x + obstacle.width - 3 > RUNNER.playerX - 15 &&
              (!next || obstacle.x < next.x)
            )
              next = obstacle
          engine.setDuck(
            !!next && next.kind === 'mid-bird' && (next.x - RUNNER.playerX) / engine.speed < 0.55
          )
          if (
            next &&
            next.kind !== 'mid-bird' &&
            engine.y === 0 &&
            (next.x + 3 - (RUNNER.playerX + 15)) / (engine.speed + (next.extraSpeed ?? 0)) <= 0.18
          ) {
            engine.setJump(false)
            engine.setJump(true)
          }
        }
        engine.advance(RUNNER.step)
      }
      draw()
      if (previous !== 'gameOver' && engine.phase === 'gameOver')
        void saveResult(runId, Math.floor(engine.distance))
    },
    /**
     * 在真实进入 LV3 后固定鸟的位置与站/蹲姿，截图不依赖随机落点。
     * @param duck 是否显示下蹲。
     * @returns 无返回值。
     */
    previewBird(duck: boolean): void {
      if (engine.stage.level < 3) return
      testClock = true
      cancelAnimationFrame(raf)
      engine.y = engine.velocity = 0
      engine.setJump(false)
      engine.setDuck(duck)
      engine.obstacles = [
        { x: 330, width: 38, height: 20, bottom: 44, kind: 'mid-bird' },
        { x: 530, width: 34, height: 20, bottom: 12, kind: 'low-bird' }
      ]
      if (duck) engine.advance(0.08)
      draw()
    }
  }
}

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
    installTestClock()
    resize()
    game.dataset.ready = 'true'
  } catch {
    bridge.failed()
  }
}
void initialize()
