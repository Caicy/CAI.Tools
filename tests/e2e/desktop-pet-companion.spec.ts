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
 * @returns Electron 实例。
 */
async function launch(dataRoot: string): Promise<ElectronApplication> {
  const legacy = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacy, { recursive: true })
  return electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      ZTOOLS_E2E: '1',
      ZTOOLS_E2E_DESKTOP_PET: '1',
      ZTOOLS_E2E_RUNNER_CLOCK: '1',
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
 * 从真实右键菜单启动快跑，并检查聊天入口已移除。
 * @param app 隔离应用。
 * @param pet 宠物页面。
 * @returns 已加载的游戏页面。
 */
async function openRunner(app: ElectronApplication, pet: Page): Promise<Page> {
  await app.evaluate(
    /**
     * 截获下一次原生菜单，记录真实菜单标题并选择快跑。
     * @param electronApi Electron 主进程模块。
     * @returns 无返回值。
     */
    ({ Menu }) => {
      const original = Menu.prototype.popup
      /**
       * 检查不存在文字聊天和按钮互动入口，再启动游戏。
       * @param options 原生菜单选项。
       * @returns 无返回值。
       * @throws 菜单仍包含已移除入口或缺少快跑入口时抛错。
       */
      Menu.prototype.popup = function (options): void {
        Menu.prototype.popup = original
        // 通过实际菜单验证移除结果，不依赖系统菜单坐标。
        for (const candidate of this.items) {
          if (['和小薄荷聊聊', '摸摸头', '喂点心'].includes(candidate.label)) {
            throw new Error('桌宠菜单仍包含已移除的聊天或按钮互动入口')
          }
        }
        const item = this.items.find(
          /**
           * 获取快跑入口。
           * @param candidate 当前菜单项。
           * @returns 是否为快跑入口。
           */
          (candidate) => candidate.label === '开始桌面快跑'
        )
        if (!item?.enabled) throw new Error('快跑入口不可用')
        item.click(undefined as any, undefined as any, undefined as any)
        options?.callback?.()
      }
    }
  )
  await pet.evaluate(
    /**
     * 使用真实右键事件打开宿主菜单。
     * @returns 是否完成分发。
     */
    () =>
      document
        .querySelector('#surface')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  )
  const runner = await pageFor(app, 'desktop-pet-runner.html')
  await expect(runner.locator('#game')).toHaveAttribute('data-ready', 'true')
  return runner
}

test('移除文字聊天面板后，桌宠菜单和快跑结算仍正常', /**
 * 验证聊天入口和 IPC 已删除，快跑离线短评与重开不受影响。
 * @param fixtures Playwright 测试夹具。
 * @param testInfo 截图上下文。
 * @returns 验证完成的 Promise。
 */ async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-pet-no-chat-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(dataRoot)
    const pet = await enablePet(app)
    const runner = await openRunner(app, pet)
    await runner.locator('#primary').click()
    await runner.evaluate(
      /**
       * 推进测试时钟直到实际引擎碰撞结算。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(30)
    )
    await expect(runner.locator('#game')).toHaveAttribute('data-phase', 'gameOver')
    await expect(runner.locator('#pet-review')).toContainText('小薄荷：')
    await expect(runner.locator('#pet-review')).toHaveAttribute('data-source', 'local')
    const removed = await app.evaluate(
      /**
       * 结算已初始化后台后，确认不存在聊天 IPC 与聊天窗口。
       * @param electronApi Electron 主进程模块。
       * @returns 残留入口摘要。
       */
      ({ ipcMain, BrowserWindow }) => {
        const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown>
        const channels: string[] = []
        for (const name of handlers.keys()) {
          if (name.startsWith('desktop-pet-companion:')) channels.push(name)
        }
        const windows: string[] = []
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.getURL().includes('desktop-pet-companion.html')) {
            windows.push(window.webContents.getURL())
          }
        }
        return {
          channels,
          windows,
          closeListeners: ipcMain.listenerCount('desktop-pet-companion:close')
        }
      }
    )
    expect(removed).toEqual({ channels: [], windows: [], closeListeners: 0 })
    await runner.screenshot({ path: testInfo.outputPath('runner-without-chat-panel.png') })
    await runner.locator('#primary').click()
    await expect(runner.locator('#pet-review')).toBeEmpty()
    await expect(runner.locator('#game')).toHaveAttribute('data-phase', 'countdown')
  } finally {
    // 先释放隔离实例，再删除本用例创建的临时数据目录。
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
