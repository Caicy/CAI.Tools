import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(__dirname, '../..')
const settingUrl = 'http://127.0.0.1:15177'

/**
 * 使用源码和隔离的新旧数据目录启动应用。
 * @param dataRoot 临时测试数据根目录。
 * @param clock 是否为专门截图用例启用受限固定步时钟。
 * @returns Electron 实例。
 */
async function launch(dataRoot: string, clock = false): Promise<ElectronApplication> {
  const legacy = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacy, { recursive: true })
  return electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      ZTOOLS_E2E: '1',
      ZTOOLS_E2E_DESKTOP_PET: '1',
      ZTOOLS_E2E_RUNNER_CLOCK: clock ? '1' : '0',
      ZTOOLS_DATA_ROOT: dataRoot,
      ZTOOLS_LEGACY_USER_DATA_PATH: legacy,
      ZTOOLS_SETTING_DEV_SERVER_URL: settingUrl
    }
  })
}

/**
 * 在设置插件的实际 WebContentsView 中调用授权设置 API。
 * @param app 隔离应用。
 * @param source 设置页面脚本。
 * @returns 页面脚本结果。
 */
async function settings(app: ElectronApplication, source: string): Promise<any> {
  return app.evaluate(
    /**
     * 定位设置插件后执行指定测试脚本。
     * @param electronApi Electron 主进程模块。
     * @param script 测试脚本。
     * @returns 脚本结果或尚未加载标记。
     */
    async ({ webContents }, script) => {
      const contents = webContents.getAllWebContents().find(
        /**
         * 识别设置开发服务页面。
         * @param item WebContents 实例。
         * @returns 是否匹配。
         */
        (item) => item.getURL().startsWith('http://127.0.0.1:15177')
      )
      if (!contents || contents.isLoading()) return null
      return contents.executeJavaScript(script)
    },
    source
  )
}

/**
 * 按页面入口识别 Electron 窗口，不依赖创建顺序。
 * @param app 隔离应用。
 * @param filename 页面入口。
 * @returns 已加载的页面。
 * @throws 窗口未在超时内出现时由断言抛错。
 */
async function pageFor(app: ElectronApplication, filename: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(
      /**
       * 持续查找目标窗口。
       * @returns 是否已找到。
       */
      () => {
        found = app.windows().find(
          /**
           * 比较页面文件名。
           * @param page 当前窗口页面。
           * @returns 是否匹配。
           */
          (page) => page.url().includes(filename)
        )
        return !!found
      }
    )
    .toBe(true)
  return found!
}

/**
 * 打开设置正文并启用桌宠。
 * @param app 隔离应用。
 * @returns 宠物页面。
 */
async function enablePet(app: ElectronApplication): Promise<Page> {
  const main = await pageFor(app, 'index.html')
  const input = main.locator('.search-input')
  await expect(input).toBeVisible()
  await input.fill('通用设置')
  await main.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first().click()
  await expect
    .poll(
      /**
       * 等待设置正文实际加载。
       * @returns 设置正文文本。
       */
      () => settings(app, 'document.body.innerText')
    )
    .toContain('小薄荷 · 桌面宠物')
  await settings(app, 'window.ztools.internal.setFloatingBallEnabled(true)')
  const pet = await pageFor(app, 'desktop-pet.html')
  await expect(pet.locator('#pet')).toHaveAttribute('data-ready', 'true')
  return pet
}

/**
 * 调用原生菜单中的真实 click handler，避免依赖操作系统菜单坐标。
 * @param app 隔离应用。
 * @param pet 宠物页面。
 * @returns 已准备好的游戏页面。
 */
async function openRunner(app: ElectronApplication, pet: Page): Promise<Page> {
  await app.evaluate(
    /**
     * 仅在隔离实例中将下次原生弹出替换为选择快跑菜单。
     * @param electronApi Electron 主进程模块。
     * @returns 无返回值。
     */
    ({ Menu }) => {
      const original = Menu.prototype.popup
      /**
       * 选择真实菜单项后立即恢复原生弹出方法。
       * @param options 原生菜单选项。
       * @returns 无返回值。
       */
      Menu.prototype.popup = function (options): void {
        Menu.prototype.popup = original
        const item = this.items.find(
          /**
           * 识别快跑入口。
           * @param candidate 菜单项。
           * @returns 是否匹配。
           */
          (candidate) => candidate.label === '开始桌面快跑'
        )
        if (item?.enabled) item.click(undefined as any, undefined as any, undefined as any)
        options?.callback?.()
      }
    }
  )
  await pet.evaluate(
    /**
     * 通过页面真实右键事件进入宿主菜单。
     * @returns 是否完成事件分发。
     */
    () =>
      document
        .querySelector('#surface')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  )
  const runner = await pageFor(app, 'desktop-pet-runner.html')
  await expect(runner.locator('#game')).toHaveAttribute('data-ready', 'true')
  await expect(runner.getByRole('button', { name: '开始快跑', exact: true })).toBeVisible()
  return runner
}

test('快跑：真实跳跃、失焦暂停、结算重开、返回恢复与重启纪录' /**
 * 在隔离源码 Electron 中验证用户完整流程。
 * @param fixtures Playwright 测试夹具。
 * @param testInfo 截图输出上下文。
 * @returns 完整验收 Promise。
 */, async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-runner-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(dataRoot)
    const pet = await enablePet(app)
    const original = await app.evaluate(
      /**
       * 读取宠物实际窗口边界。
       * @param electronApi Electron 模块。
       * @returns 宠物边界。
       */
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find(
            /**
             * 匹配宠物窗口。
             * @param window 原生窗口。
             * @returns 是否匹配。
             */
            (window) => window.webContents.getURL().includes('desktop-pet.html')
          )!
          .getBounds()
    )
    const runner = await openRunner(app, pet)
    const game = runner.locator('#game')
    expect(
      await runner.evaluate(
        /**
         * 普通窗口不暴露测试入口。
         * @returns 是否不存在测试时钟。
         */
        () => !('runnerTest' in window)
      )
    ).toBe(true)
    // 画面正文与角色就绪后，仅保存当前游戏窗口可见区。
    await runner.screenshot({ path: testInfo.outputPath('runner-ready.png') })
    await runner.getByRole('button', { name: '开始快跑', exact: true }).click()
    await expect(game).toHaveAttribute('data-phase', 'running')
    await runner.keyboard.press('Space')
    await expect
      .poll(
        /**
         * 读取跳跃后的逻辑高度。
         * @returns 角色高度。
         */
        async () => Number(await game.getAttribute('data-player-y'))
      )
      .toBeLessThan(-10)
    await runner.keyboard.press('Escape')
    await expect(game).toHaveAttribute('data-phase', 'paused')
    const pausedDistance = await game.getAttribute('data-distance')
    await runner.waitForTimeout(300)
    expect(await game.getAttribute('data-distance')).toBe(pausedDistance)
    await runner.screenshot({ path: testInfo.outputPath('runner-paused.png') })
    await runner.getByRole('button', { name: '继续快跑', exact: true }).click()
    await expect(game).toHaveAttribute('data-phase', 'running')
    await runner.locator('#pause').click()
    await expect(game).toHaveAttribute('data-phase', 'paused')
    await runner.locator('#pause').click()
    await expect(game).toHaveAttribute('data-phase', 'running')
    // 等前一次跳跃落地，验证顶部按钮的焦点不会吞掉后续空格。
    await expect(game).toHaveAttribute('data-player-y', '0')
    await runner.keyboard.press('Space')
    await expect
      .poll(
        /**
         * 检查继续后的空格仍触发跳跃。
         * @returns 角色高度。
         */
        async () => Number(await game.getAttribute('data-player-y'))
      )
      .toBeLessThan(-10)
    // 通过原生窗口焦点转移验证宿主 blur 事件，而不是仅发送页面事件。
    await app.evaluate(
      /**
       * 将焦点交给宿主窗口。
       * @param electronApi Electron 模块。
       * @returns 无返回值。
       */
      ({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(
          /**
           * 匹配宿主页面。
           * @param window 原生窗口。
           * @returns 是否匹配。
           */
          (window) => window.webContents.getURL().includes('index.html')
        )!
        host.show()
        host.focus()
      }
    )
    await expect(game).toHaveAttribute('data-phase', 'paused')
    await runner.bringToFront()
    await runner.getByRole('button', { name: '继续快跑', exact: true }).click()
    await expect(game).toHaveAttribute('data-phase', 'running')
    await expect(game).toHaveAttribute('data-phase', 'gameOver', { timeout: 15_000 })
    await expect(runner.locator('#save-status')).toHaveText('纪录已保存在本机')
    const best = Number(await runner.locator('#best').textContent())
    expect(best).toBeGreaterThan(0)
    await runner.screenshot({ path: testInfo.outputPath('runner-game-over.png') })
    await runner.getByRole('button', { name: '再跑一次', exact: true }).click()
    await expect(game).toHaveAttribute('data-phase', 'countdown')
    await runner.locator('#exit').click()
    await expect
      .poll(
        /**
         * 确认原生宠物已恢复。
         * @returns 是否可见且位置保持。
         */
        () =>
          app!.evaluate(
            /**
             * 检查宠物可见状态和位置。
             * @param electronApi Electron 模块。
             * @param expected 原始边界。
             * @returns 是否正确恢复。
             */
            ({ BrowserWindow }, expected) => {
              const petWindow = BrowserWindow.getAllWindows().find(
                /**
                 * 匹配宠物窗口。
                 * @param window 原生窗口。
                 * @returns 是否匹配。
                 */
                (window) => window.webContents.getURL().includes('desktop-pet.html')
              )!
              return (
                petWindow.isVisible() &&
                JSON.stringify(petWindow.getBounds()) === JSON.stringify(expected)
              )
            },
            original
          )
      )
      .toBe(true)
    await expect(pet.locator('#pet')).toHaveAttribute('data-action', 'idle')
    await app.close()
    app = await launch(dataRoot)
    const restoredPet = await pageFor(app, 'desktop-pet.html')
    await expect(restoredPet.locator('#pet')).toHaveAttribute('data-ready', 'true')
    const restoredGame = await openRunner(app, restoredPet)
    expect(Number(await restoredGame.locator('#best').textContent())).toBe(best)
    await restoredGame.locator('#exit').click()
  } finally {
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})

test('游戏期间关闭桌宠设置不会恢复隐藏宠物' /**
 * 覆盖最新启用状态优先于游戏前快照。
 * @returns 验收 Promise。
 */, async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-runner-disable-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(dataRoot)
    const pet = await enablePet(app)
    await openRunner(app, pet)
    await settings(app, 'window.ztools.internal.setFloatingBallEnabled(false)')
    await expect
      .poll(
        /**
         * 读取原生游戏和宠物窗口数量。
         * @returns 剩余窗口数量。
         */
        () =>
          app!.evaluate(
            /**
             * 查找残留桌宠相关窗口。
             * @param electronApi Electron 模块。
             * @returns 窗口数量。
             */
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().filter(
                /**
                 * 筛选桌宠或游戏页面。
                 * @param window 原生窗口。
                 * @returns 是否属于桌宠。
                 */
                (window) => /desktop-pet(?:-runner)?\.html/.test(window.webContents.getURL())
              ).length
          )
      )
      .toBe(0)
  } finally {
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})

/**
 * 读取游戏原生边界，仅查询不绕过页面拖动处理器。
 * @param app 隔离应用。
 * @returns 原生窗口边界。
 */
async function runnerPosition(
  app: ElectronApplication
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(
    /**
     * 通过页面识别目标窗口。
     * @param api Electron 主进程模块。
     * @returns 原生边界。
     */
    ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        /**
         * 筛选游戏窗口。
         * @param item 窗口。
         * @returns 是否匹配。
         */
        (item) => item.webContents.getURL().includes('desktop-pet-runner.html')
      )!
      return win.getBounds()
    }
  )
}

test('拖动设备位置恢复与 LV1/LV3 飞鸟、圆形下蹲、阶段横幅截图' /**
 * 验证原生移窗、HUD 输入隔离与确定性晚期画面。
 * @param fixtures 测试夹具。
 * @param testInfo 截图上下文。
 * @returns 验收完成的 Promise。
 */, async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-runner-drag-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(dataRoot, true)
    const pet = await enablePet(app)
    let runner = await openRunner(app, pet)
    const game = runner.locator('#game')
    await runner.locator('#primary').click()
    await runner.evaluate(
      /**
       * 冻结墙钟并完成真实倒计时。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(3.1)
    )
    await expect(game).toHaveAttribute('data-phase', 'running')
    await expect(game).toHaveAttribute('data-level', '1')
    await expect(runner.locator('#level-banner')).toHaveText('LV 1 · 热身')
    await runner.screenshot({ path: testInfo.outputPath('runner-lv1.png') })
    // HUD 点按不跳跃、不暂停；拖动仅在越过阈值后暂停。
    await runner.locator('.brand').click()
    await expect(game).toHaveAttribute('data-player-y', '0')
    await expect(game).toHaveAttribute('data-phase', 'running')
    // 实际跑道仍消费点击为短跳，而不是移动窗口。
    await runner.mouse.click(600, 140)
    await runner.evaluate(
      /**
       * 点击释放后按固定步推进短跳。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(0.15)
    )
    expect(Number(await game.getAttribute('data-player-y'))).toBeLessThan(-10)
    await runner.evaluate(
      /**
       * 等待真实落地以隔离接下来的拖动验证。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(0.5)
    )
    await expect(game).toHaveAttribute('data-player-y', '0')
    const original = await runnerPosition(app)
    const header = (await runner.locator('header').boundingBox())!
    await runner.mouse.move(header.x + 40, header.y + 12)
    await runner.mouse.down()
    await runner.mouse.move(header.x + 110, header.y - 68)
    await runner.mouse.up()
    await expect(game).toHaveAttribute('data-phase', 'paused')
    await expect(game).toHaveAttribute('data-pause-reason', 'drag')
    await expect(game).toHaveAttribute('data-player-y', '0')
    await expect
      .poll(
        /**
         * 等待受限拖动 IPC 完成原生移窗。
         * @returns 是否移动。
         */
        async () => JSON.stringify(await runnerPosition(app!)) !== JSON.stringify(original)
      )
      .toBe(true)
    const hudMoved = await runnerPosition(app)
    // 左边空白同样能拖动；这次在暂停态验证不会意外起跳。
    await runner.mouse.move(10, 180)
    await runner.mouse.down()
    await runner.mouse.move(40, 160)
    await runner.mouse.up()
    await expect
      .poll(
        /**
         * 等待边距手势更新实际原生位置。
         * @returns 是否再次移动。
         */
        async () => JSON.stringify(await runnerPosition(app!)) !== JSON.stringify(hudMoved)
      )
      .toBe(true)
    await expect(game).toHaveAttribute('data-player-y', '0')
    const moved = await runnerPosition(app)
    await app.evaluate(
      /**
       * 确认完整窗口落在当前工作区，不读写任何真实配置。
       * @param api Electron 模块。
       * @param bounds 读回边界。
       * @returns 无返回值。
       * @throws 窗口未完整位于工作区时抛错。
       */
      ({ screen }, bounds) => {
        const area = screen.getDisplayMatching(bounds).workArea
        if (
          bounds.x < area.x ||
          bounds.y < area.y ||
          bounds.x + bounds.width > area.x + area.width ||
          bounds.y + bounds.height > area.y + area.height
        )
          throw new Error('拖动超出工作区')
      },
      moved
    )
    // 继续仍走正常倒计时；随后用相同物理与输入快进到 LV3。
    await runner.locator('#primary').click()
    await runner.evaluate(
      /**
       * 通过状态机器人进入飞鸟阶段而非禁用碰撞。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(48.05, true)
    )
    await expect(game).toHaveAttribute('data-phase', 'running')
    await expect(game).toHaveAttribute('data-level', '3')
    await runner.evaluate(
      /**
       * 固定已解锁飞鸟的可读截图位置。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.previewBird(false)
    )
    await expect(runner.locator('#level-banner')).toHaveText('LV 3 · 飞行物')
    await expect(runner.locator('#level-banner')).toBeVisible()
    await runner.screenshot({ path: testInfo.outputPath('runner-lv-banner.png') })
    await runner.screenshot({ path: testInfo.outputPath('runner-lv3-bird.png') })
    await runner.keyboard.down('ArrowDown')
    await runner.evaluate(
      /**
       * 下蹲过渡使用真实输入和固定步而不是强制设置蹲姿。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(0.08)
    )
    await expect(game).toHaveAttribute('data-ducking', 'true')
    await runner.screenshot({ path: testInfo.outputPath('runner-duck.png') })
    await runner.keyboard.up('ArrowDown')
    await runner.locator('#exit').click()
    runner = await openRunner(app, pet)
    expect(await runnerPosition(app)).toEqual(moved)
    await runner.locator('#exit').click()
    await app.close()
    app = await launch(dataRoot)
    const restoredPet = await pageFor(app, 'desktop-pet.html')
    await expect(restoredPet.locator('#pet')).toHaveAttribute('data-ready', 'true')
    runner = await openRunner(app, restoredPet)
    expect(await runnerPosition(app)).toEqual(moved)
    await runner.locator('#exit').click()
  } finally {
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
