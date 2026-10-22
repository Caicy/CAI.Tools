import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '../..')
const settingUrl = 'http://127.0.0.1:15177'
const atlasPath = path.join(projectRoot, 'src/renderer/src/desktopPet/assets/atlas.png')

/**
 * 在设置插件的真实 WebContentsView 中执行脚本。
 * @param app 隔离的 Electron 实例。
 * @param source 设置插件页面脚本。
 * @returns 页面脚本的可序列化结果，插件未加载时返回 null。
 */
async function inSettings(app: ElectronApplication, source: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { urlFragment, script }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(urlFragment))
      if (!contents || contents.isLoading()) return null
      return contents.executeJavaScript(script)
    },
    { urlFragment: settingUrl, script: source }
  )
}

/**
 * 在宠物浮窗 WebContentsView 中读取页面状态。
 * @param app 隔离的 Electron 实例。
 * @returns 宠物页面状态，浮窗未创建或仍在加载时返回 null。
 */
async function getPetPageState(app: ElectronApplication): Promise<{
  bridge: boolean
  ready: boolean
  action: string
  frame: string
  gazeX: string
  gazeY: string
  drink: string
  zzz: boolean
} | null> {
  return app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents || contents.isLoading()) return null
    return contents.executeJavaScript(`({
      bridge: Boolean(window.desktopPet),
      ready: document.querySelector('#pet')?.dataset.ready === 'true',
      action: document.querySelector('#pet')?.dataset.action || '',
      frame: document.querySelector('#pet')?.dataset.frame || '',
      gazeX: document.querySelector('#pet')?.dataset.gazeX || '',
      gazeY: document.querySelector('#pet')?.dataset.gazeY || '',
      drink: document.querySelector('#pet')?.dataset.drink || '0',
      zzz: document.querySelector('#pet')?.dataset.zzz === 'true'
    })`)
  })
}

/**
 * 向宠物页面发送模拟的归一化视线方向；不模拟操作系统光标采样。
 * @param app 隔离的 Electron 实例。
 * @param point 要发送给宠物渲染页的归一化方向。
 * @returns IPC 消息发送完成后的 Promise。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function sendPetGaze(
  app: ElectronApplication,
  point: { x: number; y: number }
): Promise<void> {
  // 等待恢复动画后的系统采样完成，避免其首条消息覆盖测试注入。
  await waitForAnimation(100)
  await app.evaluate(({ webContents }, gaze) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents) throw new Error('未找到宠物 WebContentsView')
    contents.send('desktop-pet:gaze', gaze)
  }, point)
}

/**
 * 截取稳定状态下的宠物 WebContentsView，并附加到测试结果。
 * @param app 隔离的 Electron 实例。
 * @param testInfo 当前测试的输出上下文。
 * @param name 截图名称。
 * @returns 截图保存完成后结束的 Promise。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function capturePetView(
  app: ElectronApplication,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshot = await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents) throw new Error('未找到宠物 WebContentsView')
    return (await contents.capturePage()).toPNG().toString('base64')
  })
  const body = Buffer.from(screenshot, 'base64')
  await fs.writeFile(testInfo.outputPath(`${name}.png`), body)
  await testInfo.attach(name, { body, contentType: 'image/png' })
}

/**
 * 保存待机画布像素并在视线更新后统计眼睛区域外的变化。
 * @param app 隔离的 Electron 实例。
 * @param operation 保存基线或比较基线的页面脚本。
 * @returns 页面计算得到的像素变化摘要。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function inspectPetCanvas(
  app: ElectronApplication,
  operation: 'save' | 'diff'
): Promise<{
  changedPixels?: number
  changedOutsideEyes?: number
}> {
  return app.evaluate(async ({ webContents }, mode) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents || contents.isLoading()) throw new Error('宠物 WebContentsView 尚未就绪')
    return contents.executeJavaScript(`(() => {
        const canvas = document.querySelector('#pet')
        const context = canvas.getContext('2d', { willReadFrequently: true })
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        if (${JSON.stringify(mode)} === 'save') {
          window.__desktopPetBaseline = { width: canvas.width, height: canvas.height, pixels: Array.from(pixels) }
          return {}
        }
        const baseline = window.__desktopPetBaseline
        if (!baseline || baseline.width !== canvas.width || baseline.height !== canvas.height)
          throw new Error('待机画布基线已经失效')
        const scaleX = canvas.width / 192
        const scaleY = canvas.height / 256
        const eyeRegions = [
          { left: 68 * scaleX, right: 96 * scaleX, top: 136 * scaleY, bottom: 179 * scaleY },
          { left: 110 * scaleX, right: 140 * scaleX, top: 136 * scaleY, bottom: 179 * scaleY }
        ]
        let changedPixels = 0
        let changedOutsideEyes = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === baseline.pixels[i] && pixels[i + 1] === baseline.pixels[i + 1] &&
              pixels[i + 2] === baseline.pixels[i + 2] && pixels[i + 3] === baseline.pixels[i + 3]) continue
          changedPixels++
          const x = (i / 4) % canvas.width
          const y = Math.floor(i / 4 / canvas.width)
          if (!eyeRegions.some((region) => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom)) {
            changedOutsideEyes++
          }
        }
        return { changedPixels, changedOutsideEyes }
      })()`)
  }, operation)
}

/**
 * 重载宠物 WebContentsView，以验证卸载后新页面重新订阅视线事件。
 * @param app 隔离的 Electron 实例。
 * @returns reload 调用完成后的 Promise。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function reloadPetPage(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents) throw new Error('未找到宠物 WebContentsView')
    contents.reload()
  })
}

/**
 * 点击桌宠并采集正面脸部中心，检查挥手对齐、失焦连续性与结束状态。
 * @param app 隔离的 Electron 实例。
 * @returns 待机与挥手脸部中心、实际帧号和动画结束后的状态。
 * @throws 宠物页面尚未创建或画布没有可识别的脸部时抛错。
 */
async function inspectPetWave(app: ElectronApplication): Promise<{
  baseline: { x: number; y: number }
  centers: { x: number; y: number }[]
  frames: number[]
  blurred: boolean
  finalAction: string
}> {
  return app.evaluate(
    /**
     * 在桌宠 WebContentsView 内测量完整点击动画。
     * @param electron 当前 Electron 主进程模块。
     * @returns 页面采集的动画轨迹。
     * @throws 桌宠页面未创建或面板无法识别时抛错。
     */ async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(
        /**
         * 定位桌宠页面。
         * @param item 待检查的页面。
         * @returns 是否为桌宠页面。
         */
        (item) => item.getURL().includes('desktop-pet.html')
      )
      if (!contents) throw new Error('未找到宠物 WebContentsView')
      return contents.executeJavaScript(`(async () => {
      const canvas = document.querySelector('#pet')
      const surface = document.querySelector('#surface')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      /**
       * 从实际绘制像素中测量奶油色面板中心，坐标归一到素材单格。
       * @returns 脸部包围盒中心。
       * @throws 没有可识别的面板时抛错。
       */
      function faceCenter() {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let minX = 192, maxX = 0, minY = 256, maxY = 0
        // 排除天线和手脚，仅以面板颜色定位身体，眼睛跟随不影响包围盒。
        for (let y = 80; y < 205; y++) {
          for (let x = 45; x < 160; x++) {
            const px = Math.min(canvas.width - 1, Math.floor(x * canvas.width / 192))
            const py = Math.min(canvas.height - 1, Math.floor(y * canvas.height / 256))
            const i = (py * canvas.width + px) * 4
            if (pixels[i + 3] > 240 && pixels[i] > 220 && pixels[i + 1] > 210 &&
                pixels[i + 2] > 155 && pixels[i + 2] < 220) {
              minX = Math.min(minX, x); maxX = Math.max(maxX, x)
              minY = Math.min(minY, y); maxY = Math.max(maxY, y)
            }
          }
        }
        if (maxX < minX) throw new Error('未识别到桌宠脸部')
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
      }
      const baseline = faceCenter()
      const centers = [], frames = new Set()
      let blurred = false
      /**
       * 在画布帧属性更新后的微任务中采集，避免 20ms 轮询漏掉短暂呈现的末帧。
       * @returns 无返回值。
       */
      function sampleWave() {
        if (canvas.dataset.action !== 'waving') return
        const frame = Number(canvas.dataset.frame)
        if (!frames.has(frame)) { frames.add(frame); centers.push(faceCenter()) }
        // 模拟单击打开主窗口导致的失焦，动画应继续走完整个周期。
        if (!blurred) { blurred = true; window.dispatchEvent(new Event('blur')) }
      }
      const observer = new MutationObserver(sampleWave)
      observer.observe(canvas, { attributes: true, attributeFilter: ['data-frame', 'data-action'] })
      try {
        // 合成同位置按下和松开，只触发单击；不模拟原生鼠标硬件。
        surface.setPointerCapture = () => {}
        surface.hasPointerCapture = () => false
        for (const type of ['pointerdown', 'pointerup']) {
          surface.dispatchEvent(new PointerEvent(type, {
            bubbles: true, pointerId: 778, button: 0, screenX: 30, screenY: 30
          }))
        }
        await new Promise(/**
         * 保留完整动画观察窗口，仍检查结束后的待机状态。
         * @param resolve 观察结束回调。
         * @returns 定时器标识。
         */ resolve => setTimeout(resolve, 2000))
      } finally {
        // 无论动画脚本成功与否，释放页面观察器。
        observer.disconnect()
      }
      return { baseline, centers, frames: [...frames], blurred,
        finalAction: canvas.dataset.action }
    })()`)
    }
  )
}

/**
 * 发送合成拖动指针事件，验证拖动动作的动画时钟；不作为物理鼠标验收。
 * @param app 隔离的 Electron 实例。
 * @param vertical 是否只沿垂直方向拖动。
 * @returns 页面当前动作及帧号。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function startSyntheticPetDrag(
  app: ElectronApplication,
  vertical = false
): Promise<{
  action: string
  frame: string
}> {
  return app.evaluate(
    /**
     * 在宠物页面注入指定方向的指针手势。
     * @param electron 当前 Electron 主进程模块。
     * @param vertical 是否仅注入垂直位移。
     * @returns 手势开始后的动作与帧号。
     * @throws 宠物页面未就绪时抛错。
     */ async ({ webContents }, vertical) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes('desktop-pet.html'))
      if (!contents || contents.isLoading()) throw new Error('宠物 WebContentsView 尚未就绪')
      return contents.executeJavaScript(`(/**
     * 发起合成指针手势并读取渲染状态。
     * @returns 当前动作与帧号。
     */ () => {
      const surface = document.querySelector('#surface')
      surface.setPointerCapture = () => {}
      surface.hasPointerCapture = () => false
      surface.releasePointerCapture = () => {}
      /**
       * 派发具有明确屏幕坐标的合成指针事件。
       * @param type 指针事件类型。
       * @param screenX 水平屏幕坐标。
       * @param screenY 垂直屏幕坐标。
       * @returns 事件是否未被取消。
       */
      const pointer = (type, screenX, screenY) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 777, button: 0, screenX, screenY
      }))
      pointer('pointerdown', 10, 30)
      pointer('pointermove', ${vertical ? 10 : 30}, ${vertical ? 50 : 30})
      const canvas = document.querySelector('#pet')
      return { action: canvas.dataset.action, frame: canvas.dataset.frame }
    })()`)
    },
    vertical
  )
}

/**
 * 结束此前启动的合成拖动并释放宠物窗口手势状态。
 * @param app 隔离的 Electron 实例。
 * @returns 页面事件派发完成后的 Promise。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function endSyntheticPetDrag(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents || contents.isLoading()) throw new Error('宠物 WebContentsView 尚未就绪')
    await contents.executeJavaScript(`document.querySelector('#surface').dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 777, button: 0, screenX: 30, screenY: 30
    }))`)
  })
}

/**
 * 启动带浮窗模块、固定系统光标输入的源码 Electron 测试实例。
 * @param dataRoot 本次测试的隔离数据目录。
 * @param idleScale 主进程空闲阈值比例，默认不缩短。
 * @returns 已启动的 Electron 应用。
 * @throws Electron 启动或系统采样注入失败时抛错。
 */
async function launchApp(dataRoot: string, idleScale = 1): Promise<ElectronApplication> {
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot, { recursive: true })
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
      ),
      ZTOOLS_DATA_ROOT: dataRoot,
      ZTOOLS_E2E: '1',
      ZTOOLS_E2E_DESKTOP_PET: '1',
      ZTOOLS_DESKTOP_PET_IDLE_SCALE: String(idleScale),
      ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
      ZTOOLS_SETTING_DEV_SERVER_URL: settingUrl
    }
  })
  try {
    // 等待首个原生窗口出现后再注入采样，避免连接建立阶段的执行上下文竞争。
    await app.firstWindow()
    // 合成手势测试固定系统采样输入，避免测试期间用户移动鼠标造成竞争。
    await app.evaluate(
      /**
       * 固定隔离实例的系统光标输入。
       * @param electron 当前 Electron 主进程模块。
       * @returns 无返回值。
       */
      ({ screen, powerMonitor }) => {
        /**
         * 返回合成拖动测试的稳定光标位置。
         * @returns DIP 屏幕坐标。
         */
        screen.getCursorScreenPoint = () => ({ x: 400, y: 300 })
        // 交互专项默认系统一直有输入；空闲专项再注入可控来源，不依赖测试者的桌面输入。
        /**
         * 返回持续有系统输入的测试来源。
         * @returns 空闲秒数零。
         */
        powerMonitor.getSystemIdleTime = () => 0
      }
    )
  } catch (error) {
    // 初始化失败也关闭已创建的隔离进程，避免锁住临时数据目录。
    try {
      await app.close()
    } catch {
      // 保留原始初始化异常，关闭失败由测试进程退出完成最终回收。
    }
    throw error
  }
  return app
}

/**
 * 从 Electron 多窗口中定位宿主搜索页，避免启用宠物时误选最先创建的浮窗。
 * @param app 当前隔离 Electron 实例。
 * @returns 包含宿主搜索框的页面。
 * @throws 等待期间宿主搜索页未出现时抛错。
 */
async function findMainWindow(app: ElectronApplication): Promise<Page> {
  let mainWindow: Page | undefined
  await expect
    .poll(
      async () => {
        // 以宿主专属搜索框识别窗口，不依赖 BrowserWindow 创建顺序。
        for (const window of app.windows()) {
          if (await window.locator('.search-input').isVisible()) {
            mainWindow = window
            return true
          }
        }
        return false
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  if (!mainWindow) throw new Error('宿主搜索窗口未找到')
  return mainWindow
}

/**
 * 通过宿主搜索界面打开通用设置。
 * @param app 隔离的 Electron 实例。
 * @returns 设置插件正文加载完成后的 Promise。
 */
async function openGeneralSettings(app: ElectronApplication): Promise<void> {
  const host = await findMainWindow(app)
  const search = host.locator('.search-input')
  await expect(search).toBeVisible()
  await search.fill('通用设置')
  const command = host.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first()
  await expect(command).toBeVisible()
  await command.click()
  await expect
    .poll(() => inSettings(app, 'document.body.innerText'), { timeout: 15_000 })
    .toContain('小薄荷 · 桌面宠物')
}

/**
 * 先关闭浮窗再结束 Electron，避免 enabled 状态下的 close 拦截阻塞测试清理。
 * @param app 隔离的 Electron 实例。
 * @returns 清理完成后结束的 Promise。
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  await inSettings(
    app,
    'window.ztools.internal.setFloatingBallEnabled(false).catch(() => undefined)'
  ).catch(() => undefined)
  await app.close()
}

/**
 * 等待宠物页面经过指定的动画观察窗口。
 * @param milliseconds 观察窗口长度。
 * @returns 等待结束后完成的 Promise。
 */
async function waitForAnimation(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

test('桌面宠物配置、待机视线和交互动画在隔离源码 Electron 实例中工作', async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-desktop-pet-'))
  let app: ElectronApplication | null = null

  try {
    app = await launchApp(dataRoot)
    await openGeneralSettings(app)

    const initial = await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')
    expect(initial).toMatchObject({
      config: { mode: 'pet', petId: 'builtin-default', size: 'medium', paused: false }
    })

    expect(await inSettings(app, 'window.ztools.internal.getFloatingBallEnabled()')).toBe(false)

    // 关闭状态下保留宠物尺寸和暂停偏好，验证新默认配置的持久化。
    const preparedClosedConfig = await inSettings(
      app,
      `(async () => {
        const current = await window.ztools.internal.getDesktopPetConfig()
        return window.ztools.internal.setDesktopPetConfig({
          ...current.config,
          mode: 'pet',
          size: 'large',
          paused: true,
          lookEnabled: false
        })
      })()`
    )
    expect(preparedClosedConfig.config).toMatchObject({ mode: 'pet', size: 'large', paused: true })

    // 关闭状态也必须保持关闭，避免重启过程意外创建浮窗。
    await app.close()
    app = null
    app = await launchApp(dataRoot)
    await openGeneralSettings(app)
    const restoredClosed = await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')
    expect(restoredClosed).toMatchObject({
      config: { mode: 'pet', petId: 'builtin-default', size: 'large', paused: true }
    })
    expect(await inSettings(app, 'window.ztools.internal.getFloatingBallEnabled()')).toBe(false)

    const enabled = await inSettings(
      app,
      '(async () => { await window.ztools.internal.setFloatingBallEnabled(true); return window.ztools.internal.getDesktopPetConfig() })()'
    )
    expect(enabled.config).toMatchObject({ mode: 'pet', size: 'large', paused: true })

    const configured = await inSettings(
      app,
      `(async () => {
        const current = await window.ztools.internal.getDesktopPetConfig()
        return window.ztools.internal.setDesktopPetConfig({
          ...current.config,
          mode: 'pet',
          size: 'large',
          paused: false,
          lookEnabled: false
        })
      })()`
    )
    expect(configured.config).toMatchObject({ mode: 'pet', size: 'large', paused: false })

    // 旧版通用设置表单可能不带 desktopPet；宿主写入时仍须保留最新宠物配置。
    await inSettings(
      app,
      `window.ztools.internal.dbPut('settings-general', { floatingBallEnabled: true, floatingBallLetter: 'Q' })`
    )
    const afterStaleSettings = await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')
    expect(afterStaleSettings.config).toMatchObject({ mode: 'pet', size: 'large', paused: false })

    await expect
      .poll(
        async () => {
          const state = await getPetPageState(app!)
          const snapshot = await inSettings(app!, 'window.ztools.internal.getDesktopPetConfig()')
          return Boolean(state?.ready || snapshot?.error)
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    const pageState = await getPetPageState(app)
    const snapshot = await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')
    expect(pageState?.bridge).toBe(true)
    if (await fileExists(atlasPath)) {
      expect(pageState).toMatchObject({ ready: true })
      expect(snapshot.error).toBeNull()
      expect(pageState?.action).toBe('idle')
      expect(pageState?.frame).not.toBe('')

      // 待机固定首帧，不因无输入而播放动画；稳定后截取宠物 WebContentsView 供视觉检查。
      const idleFrame = pageState!.frame
      const idleGaze = { gazeX: pageState!.gazeX, gazeY: pageState!.gazeY }
      await waitForAnimation(500)
      const stableIdle = await getPetPageState(app)
      expect(stableIdle).toMatchObject({ action: 'idle', frame: idleFrame, ...idleGaze })
      await capturePetView(app, testInfo, 'desktop-pet-idle')

      // 模拟 renderer 收到主进程的归一化视线方向；只允许画布眼睛区域变化。
      await inspectPetCanvas(app, 'save')
      await sendPetGaze(app, { x: 0.8, y: -0.5 })
      await expect
        .poll(async () => getPetPageState(app))
        .toMatchObject({ action: 'idle', frame: idleFrame, gazeX: '0.8', gazeY: '-0.5' })
      const gazePixels = await inspectPetCanvas(app, 'diff')
      await capturePetView(app, testInfo, 'desktop-pet-gaze')
      expect(gazePixels.changedPixels).toBeGreaterThan(0)
      expect(gazePixels.changedOutsideEyes).toBeLessThanOrEqual(gazePixels.changedPixels! * 0.05)

      // 同一视线在静止期间保持稳定，待机帧也不推进。
      await waitForAnimation(500)
      expect(await getPetPageState(app)).toMatchObject({
        action: 'idle',
        frame: idleFrame,
        gazeX: '0.8',
        gazeY: '-0.5'
      })

      // 暂停时拒绝新视线；恢复后重新响应视线变化。
      await inSettings(
        app,
        `(async () => { const current = await window.ztools.internal.getDesktopPetConfig(); return window.ztools.internal.setDesktopPetConfig({ ...current.config, paused: true }) })()`
      )
      await sendPetGaze(app, { x: -0.8, y: 0.5 })
      await waitForAnimation(200)
      expect(await getPetPageState(app)).toMatchObject({
        action: 'idle',
        frame: idleFrame,
        gazeX: '0.8',
        gazeY: '-0.5'
      })
      await inSettings(
        app,
        `(async () => { const current = await window.ztools.internal.getDesktopPetConfig(); return window.ztools.internal.setDesktopPetConfig({ ...current.config, paused: false }) })()`
      )
      await sendPetGaze(app, { x: -0.8, y: 0.5 })
      await expect
        .poll(async () => getPetPageState(app))
        .toMatchObject({ gazeX: '-0.8', gazeY: '0.5', action: 'idle', frame: idleFrame })

      // 页面重载会移除旧监听并重新订阅；新页面仍能接收视线更新。
      await reloadPetPage(app)
      await expect
        .poll(async () => getPetPageState(app))
        .toMatchObject({
          bridge: true,
          ready: true,
          action: 'idle',
          frame: '0'
        })
      await sendPetGaze(app, { x: 0.4, y: 0.6 })
      await expect
        .poll(async () => getPetPageState(app))
        .toMatchObject({ gazeX: '0.4', gazeY: '0.6', action: 'idle', frame: '0' })

      // 点击不应让身体跳位，主窗口切换引起的失焦也不能截断挥手。
      const wave = await inspectPetWave(app)
      expect(wave.blurred).toBe(true)
      expect(wave.frames.length).toBeGreaterThanOrEqual(6)
      expect(wave.frames).toContain(31)
      expect(wave.finalAction).toBe('idle')
      for (const center of wave.centers) {
        expect(Math.abs(center.x - wave.baseline.x)).toBeLessThanOrEqual(2)
        expect(Math.abs(center.y - wave.baseline.y)).toBeLessThanOrEqual(2)
      }

      // 合成拖动进入 running-right 后帧号推进，松开后回到固定待机帧。
      const dragStart = await startSyntheticPetDrag(app)
      expect(dragStart.action).toBe('running-right')
      await waitForAnimation(180)
      const dragNext = await getPetPageState(app)
      expect(dragNext?.action).toBe('running-right')
      expect(dragNext?.frame).not.toBe(dragStart.frame)
      // Windows 移窗期间可能重复通知 resize；这些通知不能重置动画时钟。
      const framesDuringMove = await app.evaluate(
        /**
         * 在重复布局通知期间采集动画帧。
         * @param electron 当前 Electron 主进程模块。
         * @returns 实际绘制过的不同帧号。
         */
        async ({ webContents }) => {
          const contents = webContents.getAllWebContents().find(
            /**
             * 识别宠物页面。
             * @param item 待检查的页面。
             * @returns 是否为宠物页面。
             */
            (item) => item.getURL().includes('desktop-pet.html')
          )!
          return contents.executeJavaScript(`(/**
         * 重复通知窗口布局并记录绘制结果。
         * @returns 观察期间出现的帧号。
         */ async () => {
          const canvas = document.querySelector('#pet')
          const frames = new Set()
          for (let i = 0; i < 30; i++) {
            window.dispatchEvent(new Event('resize'))
            frames.add(canvas.dataset.frame)
            await new Promise(/**
             * 等待下一次布局通知。
             * @param resolve 等待完成回调。
             * @returns 定时器标识。
             */ resolve => setTimeout(resolve, 16))
          }
          return [...frames]
        })()`)
        }
      )
      expect(framesDuringMove.length).toBeGreaterThan(2)
      await capturePetView(app, testInfo, 'desktop-pet-drag')
      await endSyntheticPetDrag(app)
      await expect.poll(async () => getPetPageState(app)).toMatchObject({ action: 'idle' })
      const verticalDrag = await startSyntheticPetDrag(app, true)
      expect(verticalDrag.action).toBe('running-right')
      await waitForAnimation(180)
      expect((await getPetPageState(app))?.frame).not.toBe(verticalDrag.frame)
      await endSyntheticPetDrag(app)

      // 模拟原生窗口暂时产生不同比例，画布必须仍按素材比例绘制。
      const petWindow = await app.evaluate(
        /**
         * 改变浮窗宽高比以验证素材比例保护。
         * @param electron 当前 Electron 主进程模块。
         * @returns 待恢复的窗口标识及原边界。
         */
        ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(
            /**
             * 识别宠物浮窗。
             * @param item 待检查的窗口。
             * @returns 是否承载宠物页面。
             */
            (item) => item.webContents.getURL().includes('desktop-pet.html')
          )!
          const bounds = win.getBounds()
          win.setBounds({ ...bounds, width: 240, height: 240 })
          return { id: win.id, bounds }
        }
      )
      await expect
        .poll(
          /**
           * 等待窗口调整后的实际画布状态。
           * @returns 画布比例及 CSS 缩放模式。
           */
          async () =>
            app!.evaluate(
              /**
               * 读取指定宠物窗口的画布布局。
               * @param electron 当前 Electron 主进程模块。
               * @param id 宠物窗口标识。
               * @returns 页面计算的布局信息。
               */
              async ({ BrowserWindow }, id) => {
                return BrowserWindow.fromId(id)!.webContents.executeJavaScript(`(/**
             * 读取像素缓冲区比例和显示模式。
             * @returns 当前画布布局。
             */ () => {
          const canvas = document.querySelector('#pet')
          return { ratio: canvas.width / canvas.height, fit: getComputedStyle(canvas).objectFit }
        })()`)
              },
              petWindow.id
            )
        )
        .toMatchObject({ ratio: 0.75, fit: 'contain' })
      await capturePetView(app, testInfo, 'desktop-pet-aspect-ratio')
      await app.evaluate(
        /**
         * 恢复测试前的窗口布局。
         * @param electron 当前 Electron 主进程模块。
         * @param saved 保存的窗口标识和边界。
         * @returns 无返回值。
         */
        ({ BrowserWindow }, saved) => {
          BrowserWindow.fromId(saved.id)!.setBounds(saved.bounds)
        },
        petWindow
      )
    } else {
      // atlas 尚未落盘时只验收安全降级，素材加载成功路径待资源加入后由同一断言覆盖。
      expect(snapshot.error).toEqual(expect.any(String))
      expect(pageState?.ready).toBe(false)
    }

    // 暂停只冻结动画时钟，页面和窗口仍应保持可用。
    const pausedSnapshot = await inSettings(
      app,
      `(async () => {
        const current = await window.ztools.internal.getDesktopPetConfig()
        return window.ztools.internal.setDesktopPetConfig({ ...current.config, paused: true })
      })()`
    )
    expect(pausedSnapshot.config.paused).toBe(true)
    const pausedFrame = await getPetPageState(app)
    await waitForAnimation(500)
    const pausedFrameAfterWait = await getPetPageState(app)
    expect(pausedFrameAfterWait?.frame).toBe(pausedFrame?.frame)

    // 恢复后仍保持固定待机首帧，并将最终配置恢复为可重启状态。
    const resumedSnapshot = await inSettings(
      app,
      `(async () => {
        const current = await window.ztools.internal.getDesktopPetConfig()
        return window.ztools.internal.setDesktopPetConfig({ ...current.config, paused: false })
      })()`
    )
    expect(resumedSnapshot.config.paused).toBe(false)
    await waitForAnimation(500)
    const resumedFrame = await getPetPageState(app)
    expect(resumedFrame).toMatchObject({ action: 'idle', frame: pausedFrame?.frame })

    // 保留 enabled 状态直接关闭，验证 appMain 的退出清理不会被浮窗 close 拦截。
    await app.close()
    app = null
    app = await launchApp(dataRoot)
    await openGeneralSettings(app)
    const restored = await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')
    expect(restored).toMatchObject({
      config: { mode: 'pet', petId: 'builtin-default', size: 'large', paused: false }
    })
    await expect
      .poll(() => inSettings(app!, 'window.ztools.internal.getFloatingBallEnabled()'))
      .toBe(true)
  } finally {
    if (app) await closeApp(app)
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})

/**
 * 判断正式图集是否已经进入工作树。
 * @param filePath 图集绝对路径。
 * @returns 文件存在时为 true。
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 只在隔离主进程替换系统空闲来源，并计数验证暂停/隐藏不会采样。
 * @param app 隔离的 Electron 应用。
 * @param ticking 是否模拟持续没有任何系统输入。
 * @returns 来源替换完成的 Promise。
 */
async function setIdleSource(app: ElectronApplication, ticking: boolean): Promise<void> {
  await app.evaluate(
    /**
     * 注入可控系统来源，不向宠物页面暴露测试能力。
     * @param electron 当前 Electron 主进程模块。
     * @param advance 是否让系统空闲量随真实时钟增长。
     * @returns 无返回值。
     */ ({ powerMonitor }, advance) => {
      const source = powerMonitor as typeof powerMonitor & { __petIdleReads: number }
      source.__petIdleReads = 0
      const start = Date.now()
      /**
       * 模拟系统鼠标和键盘共同空闲时间，零值模拟任一输入。
       * @returns 系统空闲秒数。
       */
      source.getSystemIdleTime = () => {
        source.__petIdleReads++
        return advance ? (Date.now() - start) / 1000 : 0
      }
    },
    ticking
  )
}

/**
 * 读取系统空闲 API 采样次数。
 * @param app 隔离的 Electron 应用。
 * @returns 主进程采样次数。
 */
async function idleReads(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    /**
     * 查询测试注入来源的计数。
     * @param electron 当前 Electron 主进程模块。
     * @returns API 调用次数。
     */ ({ powerMonitor }) =>
      (powerMonitor as typeof powerMonitor & { __petIdleReads: number }).__petIdleReads
  )
}

/**
 * 确认睡眠头部上方有实际绘制的 zzz 像素，而不只检查数据属性。
 * @param app 隔离的 Electron 应用。
 * @returns 头部上方区域的非透明像素数量。
 * @throws 宠物页面尚未创建时抛错。
 */
async function zzzPixels(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    /**
     * 从真实宠物画布读取文字区域。
     * @param electron 当前 Electron 主进程模块。
     * @returns 非透明像素数量。
     * @throws 没有宠物页面时抛错。
     */ async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(
        /**
         * 定位宠物页面。
         * @param item 页面实例。
         * @returns 是否为宠物页面。
         */ (item) => item.getURL().includes('desktop-pet.html')
      )
      if (!contents) throw new Error('没有宠物页面')
      return contents.executeJavaScript(`(/**
     * 统计头部上方（素材坐标 y=75..130）实际文字像素。
     * @returns 可见像素数。
     */ () => {
      const canvas = document.querySelector('#pet')
      const scale = canvas.width / 192
      const data = canvas.getContext('2d').getImageData(Math.round(40 * scale), Math.round(75 * scale), Math.round(70 * scale), Math.round(55 * scale)).data
      let visible = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 16) visible++
      return visible
    })()`)
    }
  )
}

test('系统空闲三杯咖啡后睡眠，zzz 可见，输入唤醒且暂停和隐藏不采样', /**
 * 通过缩短的主进程阈值验收完整循环、实际截图和生命周期边界。
 * @param fixtures 当前 Playwright fixture。
 * @param testInfo 截图输出上下文。
 * @returns 验收结束的 Promise。
 */ async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-pet-idle-'))
  let app: ElectronApplication | null = null
  try {
    app = await launchApp(dataRoot, 0.2)
    await openGeneralSettings(app)
    await inSettings(
      app,
      `(async () => {
      const current = await window.ztools.internal.getDesktopPetConfig()
      await window.ztools.internal.setDesktopPetConfig({ ...current.config, size: 'large', paused: false })
      await window.ztools.internal.setFloatingBallEnabled(true)
    })()`
    )
    await expect
      .poll(
        /**
         * 等待素材和画布真正就绪。
         * @returns 宠物页面状态。
         */ () => getPetPageState(app!)
      )
      .toMatchObject({ ready: true, action: 'idle' })
    await capturePetView(app, testInfo, 'idle')
    await setIdleSource(app, true)
    await expect
      .poll(
        /**
         * 等待第一杯的中间啜饮帧。
         * @returns 是否为中间啜饮帧。
         */ async () => {
          const state = await getPetPageState(app!)
          return (
            state?.action === 'coffee' &&
            state.drink === '1' &&
            [35, 36, 37].includes(Number(state.frame))
          )
        },
        { intervals: [30], timeout: 15_000 }
      )
      .toBe(true)
    await capturePetView(app, testInfo, 'coffee-mid-sip')
    // 暂停同时冻结画布与主进程采样，不靠页面定时器自行推进系统空闲。
    await inSettings(
      app,
      `(async () => { const s = await window.ztools.internal.getDesktopPetConfig(); return window.ztools.internal.setDesktopPetConfig({ ...s.config, paused: true }) })()`
    )
    const paused = await getPetPageState(app)
    const reads = await idleReads(app)
    await waitForAnimation(1200)
    expect(await getPetPageState(app)).toMatchObject({ action: 'coffee', frame: paused!.frame })
    expect(await idleReads(app)).toBe(reads)
    await inSettings(
      app,
      `(async () => { const s = await window.ztools.internal.getDesktopPetConfig(); return window.ztools.internal.setDesktopPetConfig({ ...s.config, paused: false }) })()`
    )
    for (const drink of ['2', '3']) {
      await expect
        .poll(
          /**
           * 等待同一循环的下一杯，不能跳过完整动作。
           * @returns 宠物页面状态。
           */ () => getPetPageState(app!),
          { intervals: [50], timeout: 15_000 }
        )
        .toMatchObject({ action: 'coffee', drink })
    }
    await expect
      .poll(
        /**
         * 第三杯真正结束后等待睡眠和文字。
         * @returns 宠物页面状态。
         */ () => getPetPageState(app!),
        { intervals: [50], timeout: 15_000 }
      )
      .toMatchObject({ action: 'sleeping', drink: '3', zzz: true })
    expect(await zzzPixels(app)).toBeGreaterThan(20)
    await capturePetView(app, testInfo, 'sleep-with-zzz')
    await waitForAnimation(1000)
    expect(await getPetPageState(app)).toMatchObject({ action: 'sleeping', drink: '3' })
    // 零系统空闲模拟系统任意鼠标/键盘输入（不是只向宠物页发送一个唤醒动作）。
    await setIdleSource(app, false)
    await expect
      .poll(
        /**
         * 等待系统采样将睡眠唤醒并重置饮用次数。
         * @returns 宠物页面状态。
         */ () => getPetPageState(app!)
      )
      .toMatchObject({ action: 'idle', drink: '0', zzz: false })
    await app.evaluate(
      /**
       * 注入宿主轻互动，随后立即用真实页面手势打断动画。
       * @param electron 当前 Electron 主进程模块。
       * @returns 无返回值。
       */
      ({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.webContents.getURL().includes('desktop-pet.html')) {
            win.webContents.send('desktop-pet:reaction', {
              id: 'interrupted-feed',
              text: '测试喂食',
              source: 'local',
              emotion: 'happy',
              action: 'coffee'
            })
          }
        }
      }
    )
    await expect
      .poll(
        /**
         * 确认轻互动已获得动作优先权。
         * @returns 宠物页面状态。
         */
        () => getPetPageState(app!)
      )
      .toMatchObject({ action: 'coffee' })
    const drag = await startSyntheticPetDrag(app)
    expect(drag.action).toBe('running-right')
    await capturePetView(app, testInfo, 'running-right')
    await endSyntheticPetDrag(app)
    await setIdleSource(app, true)
    await expect
      .poll(
        /**
         * 输入唤醒后的循环从第一杯重新开始。
         * @returns 宠物页面状态。
         */ () => getPetPageState(app!),
        { intervals: [50] }
      )
      .toMatchObject({ action: 'coffee', drink: '1' })
    await app.evaluate(
      /**
       * 隐藏桌宠，模拟快跑占用桌面入口期间的生命周期。
       * @param electron 当前 Electron 主进程模块。
       * @returns 无返回值。
       */ ({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.webContents.getURL().includes('desktop-pet.html')) win.hide()
        }
      }
    )
    const hiddenReads = await idleReads(app)
    await waitForAnimation(1500)
    expect(await idleReads(app)).toBe(hiddenReads)
    expect(
      (await inSettings(app, 'window.ztools.internal.getDesktopPetConfig()')).idle
    ).toMatchObject({ action: 'idle', drink: 0 })
  } finally {
    if (app) await closeApp(app)
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
