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
      gazeY: document.querySelector('#pet')?.dataset.gazeY || ''
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
 * 发送合成拖动指针事件，验证拖动动作的动画时钟；不作为物理鼠标验收。
 * @param app 隔离的 Electron 实例。
 * @returns 页面当前动作及帧号。
 * @throws 宠物 WebContentsView 尚未创建时抛错。
 */
async function startSyntheticPetDrag(app: ElectronApplication): Promise<{
  action: string
  frame: string
}> {
  return app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('desktop-pet.html'))
    if (!contents || contents.isLoading()) throw new Error('宠物 WebContentsView 尚未就绪')
    return contents.executeJavaScript(`(() => {
      const surface = document.querySelector('#surface')
      surface.setPointerCapture = () => {}
      surface.hasPointerCapture = () => false
      surface.releasePointerCapture = () => {}
      const pointer = (type, screenX) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 777, button: 0, screenX, screenY: 30
      }))
      pointer('pointerdown', 10)
      pointer('pointermove', 30)
      const canvas = document.querySelector('#pet')
      return { action: canvas.dataset.action, frame: canvas.dataset.frame }
    })()`)
  })
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
 * 启动带浮窗模块的源码 Electron 测试实例。
 * @param dataRoot 本次测试的隔离数据目录。
 * @returns 已启动的 Electron 应用。
 */
async function launchApp(dataRoot: string): Promise<ElectronApplication> {
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot, { recursive: true })
  return electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
      ),
      ZTOOLS_DATA_ROOT: dataRoot,
      ZTOOLS_E2E: '1',
      ZTOOLS_E2E_DESKTOP_PET: '1',
      ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
      ZTOOLS_SETTING_DEV_SERVER_URL: settingUrl
    }
  })
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

      // 合成拖动进入 running-right 后帧号推进，松开后回到固定待机帧。
      const dragStart = await startSyntheticPetDrag(app)
      expect(dragStart.action).toBe('running-right')
      await waitForAnimation(180)
      const dragNext = await getPetPageState(app)
      expect(dragNext?.action).toBe('running-right')
      expect(dragNext?.frame).not.toBe(dragStart.frame)
      await endSyntheticPetDrag(app)
      await expect.poll(async () => getPetPageState(app)).toMatchObject({ action: 'idle' })
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
