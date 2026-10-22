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
import http from 'node:http'

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
 * 调用原生菜单中的真实 click handler，避免依赖操作系统菜单坐标。
 * @param app 隔离应用。
 * @param pet 宠物页面。
 * @param game 是否选择快跑以验证结算点评。
 * @returns 已准备好的陪聊页面。
 */
async function openCompanion(app: ElectronApplication, pet: Page, game = false): Promise<Page> {
  await app.evaluate(
    /**
     * 仅在隔离实例中将下次原生弹出替换为选择陪聊菜单。
     * @param electronApi Electron 主进程模块。
     * @param label 要选择的真实菜单标题。
     * @returns 无返回值。
     */
    ({ Menu }, label) => {
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
           * 识别陪聊入口。
           * @param candidate 菜单项。
           * @returns 是否匹配。
           */
          (candidate) => candidate.label === label
        )
        if (item?.enabled) item.click(undefined as any, undefined as any, undefined as any)
        options?.callback?.()
      }
    },
    game ? '开始桌面快跑' : '和小薄荷聊聊'
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
  if (game) {
    const runner = await pageFor(app, 'desktop-pet-runner.html')
    await expect(runner.locator('#game')).toHaveAttribute('data-ready', 'true')
    return runner
  }
  const runner = await pageFor(app, 'desktop-pet-companion.html')
  await expect(runner.locator('#draft')).toBeEnabled()
  await expect(runner.getByRole('heading', { name: '小薄荷 · 陪你聊聊' })).toBeVisible()
  return runner
}

/**
 * 写入一个 OpenAI 兼容增量，只连接测试进程本地服务。
 * @param response 测试服务响应。
 * @param text 增量正文。
 * @returns 无返回值。
 */
function chunk(response: http.ServerResponse, text: string): void {
  if (!response.destroyed) {
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
    )
  }
}

/**
 * 主动完成测试响应，避免靠睡眠猜测流式时间。
 * @param response 待完成响应。
 * @param text 最后一个增量。
 * @returns 无返回值。
 */
function finish(response: http.ServerResponse, text: string): void {
  chunk(response, text)
  if (!response.destroyed) {
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
    )
    response.end('data: [DONE]\n\n')
  }
}

test('陪聊：本地互动、模拟流式、取消清空、关闭和配置恢复' /**
 * 验证真实 UI 到宿主再到本地模拟供应商的完整链路。
 * @param fixtures Playwright 测试夹具。
 * @param testInfo 当前测试输出目录。
 * @returns 验收结束的 Promise。
 */, async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-companion-e2e-'))
  const pending: http.ServerResponse[] = []
  const requests: string[] = []
  const server = http.createServer(
    /**
     * 接收测试请求并留住流，以便测试精确控制后续增量。
     * @param request 本地 HTTP 请求。
     * @param response 本地 HTTP 响应。
     * @returns 无返回值。
     */
    (request, response) => {
      let body = ''
      request.on(
        'data',
        /**
         * 收集请求以检查模型只收到用户提交的消息。
         * @param data 请求数据块。
         * @returns 无返回值。
         */
        (data: Buffer) => {
          body += data.toString()
        }
      )
      request.on(
        'end',
        /**
         * 首段立即返回，其余由测试显式释放。
         * @returns 无返回值。
         */
        () => {
          requests.push(body)
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache'
          })
          pending.push(response)
          chunk(response, '模拟开头')
        }
      )
    }
  )
  let app: ElectronApplication | undefined
  try {
    // 随机回环端口与虚拟密钥确保不会触发真实供应商或计费。
    await new Promise<void>(
      /**
       * 等待本地测试服务开始监听。
       * @param resolve 完成回调。
       * @returns 无返回值。
       */
      (resolve) => {
        server.listen(0, '127.0.0.1', resolve)
      }
    )
    const address = server.address() as { port: number }
    app = await launch(dataRoot)
    let pet = await enablePet(app)
    const added = await settings(
      app,
      `window.ztools.internal.aiProviders.add(${JSON.stringify({
        name: '陪聊 E2E 本机模拟',
        apiUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'e2e-not-a-secret',
        apiFormat: 'openai-chat',
        selectedModels: [{ modelId: 'mock-companion' }]
      })})`
    )
    expect(added.success).toBe(true)
    let panel = await openCompanion(app, pet)
    await expect(panel.locator('#model')).toHaveValue('')
    await panel.locator('#pat').click()
    await expect(panel.locator('#messages')).toContainText('摸摸头')
    // 两次轻互动需满足宿主冷却；聊天操作穿插其中避免合成时间。
    await panel.locator('#draft').fill('今天想歇一会儿')
    await panel.locator('#draft').press('Enter')
    await expect(panel.locator('#messages')).toContainText('我在这里陪着你')
    await expect(panel.locator('#messages')).toContainText('本地陪伴')
    expect(requests).toHaveLength(0)
    await expect(
      /**
       * 冷却结束后重试一次本地喂食。
       * @returns 断言结束的 Promise。
       */
      async () => {
        await panel.locator('#feed').click()
        await expect(panel.locator('#messages')).toContainText('小点心', { timeout: 200 })
      }
    ).toPass({ timeout: 5000 })

    // 主窗口不能越权调用只授予陪聊窗口的 IPC handler。
    const denied = await app.evaluate(
      /**
       * 用主窗口发送者调用真实 handler，验证授权边界。
       * @param electronApi Electron 主进程模块。
       * @returns 是否被拒绝。
       */
      async ({ ipcMain, BrowserWindow }) => {
        const sender = BrowserWindow.getAllWindows().find(
          /**
           * 获取没有陪聊授权的主窗口。
           * @param window 原生窗口。
           * @returns 是否为主窗口。
           */
          (window) => window.webContents.getURL().includes('/index.html')
        )!.webContents
        const handler = (ipcMain as any)._invokeHandlers.get('desktop-pet-companion:send')
        try {
          await handler({ sender, senderFrame: sender.mainFrame }, '越权测试')
          return false
        } catch {
          return true
        }
      }
    )
    expect(denied).toBe(true)
    await panel.locator('#model').selectOption({ index: 1 })
    await expect(panel.locator('#model')).toBeEnabled()
    const selectedModel = await panel.locator('#model').inputValue()
    await panel.locator('#reviews').check()
    await expect(panel.locator('#reviews')).toBeEnabled()
    await panel.locator('#draft').fill('流式测试')
    await panel.locator('#draft').press('Enter')
    await expect(panel.locator('#messages')).toContainText('模拟开头')
    await panel.locator('#draft').fill('保留草稿')
    await expect(panel.locator('#draft')).toBeFocused()
    chunk(pending[0], '<img src=x onerror=alert(1)>')
    await expect(panel.locator('#messages')).toContainText('<img src=x onerror=alert(1)>')
    await expect(panel.locator('#messages img')).toHaveCount(0)
    await expect(panel.locator('#draft')).toHaveValue('保留草稿')
    await expect(panel.locator('#draft')).toBeFocused()
    finish(pending[0], '，模拟完成')
    await expect(panel.locator('#messages')).toContainText('模拟完成')
    await expect(panel.locator('#cancel')).toBeHidden()
    expect(JSON.parse(requests[0]).model).toBe('mock-companion')
    await panel.screenshot({ path: testInfo.outputPath('companion-streamed.png') })

    await panel.locator('#draft').fill('取消测试')
    await panel.locator('#draft').press('Enter')
    await expect(panel.locator('#cancel')).toBeVisible()
    await expect
      .poll(
        /**
         * 等待第二次请求到达本地服务。
         * @returns 接收数量。
         */
        () => pending.length
      )
      .toBe(2)
    await panel.locator('#cancel').click()
    finish(pending[1], '不应出现的迟到回复')
    await expect(panel.locator('#cancel')).toBeHidden()
    await expect(panel.locator('#messages')).not.toContainText('不应出现的迟到回复')

    await panel.locator('#draft').fill('清空测试')
    await panel.locator('#draft').press('Enter')
    await expect
      .poll(
        /**
         * 等待清空目标请求开始。
         * @returns 接收数量。
         */
        () => pending.length
      )
      .toBe(3)
    await panel.locator('#clear').click()
    finish(pending[2], '清空后迟到')
    await expect(panel.locator('.message')).toHaveCount(0)

    await expect(panel.locator('#cancel')).toBeHidden()

    await panel.locator('#draft').fill('关闭测试')
    await panel.locator('#draft').press('Enter')
    await expect
      .poll(
        /**
         * 等待关闭目标请求开始。
         * @returns 接收数量。
         */
        () => pending.length
      )
      .toBe(4)
    await panel.locator('#close').click()
    finish(pending[3], '关闭后迟到')
    panel = await openCompanion(app, pet)
    await expect(panel.locator('#messages')).not.toContainText('关闭后迟到')
    await expect(panel.locator('#cancel')).toBeHidden()
    await expect(panel.locator('#model')).toHaveValue(selectedModel)
    await expect(panel.locator('#reviews')).toBeChecked()
    await app.close()
    app = await launch(dataRoot)
    pet = await pageFor(app, 'desktop-pet.html')
    await expect(pet.locator('#pet')).toHaveAttribute('data-ready', 'true')
    panel = await openCompanion(app, pet)
    await expect(panel.locator('#model')).toHaveValue(selectedModel)
    await expect(panel.locator('#reviews')).toBeChecked()
    await expect(panel.locator('.message')).toHaveCount(0)
    // 协议中断使用真实适配器的失败路径，页面必须清楚标识本地兜底。
    await panel.locator('#draft').fill('网络失败测试')
    await panel.locator('#draft').press('Enter')
    await expect
      .poll(
        /**
         * 等待失败目标请求到达。
         * @returns 请求数量。
         */
        () => pending.length
      )
      .toBe(5)
    pending[4].end('data: [DONE]\n\n')
    await expect(panel.locator('#notice')).toContainText('已使用本地台词')
    await expect(panel.locator('#messages')).toContainText('这次没能连上我的 AI')
    await panel.locator('#close').click()
    const runner = await openCompanion(app, pet, true)
    await runner.locator('#primary').click()
    await runner.evaluate(
      /**
       * 用受限测试时钟推进真实引擎直至碰撞结算。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(30)
    )
    await expect(runner.locator('#game')).toHaveAttribute('data-phase', 'gameOver')
    await expect(runner.locator('#pet-review')).toContainText('小薄荷：')
    await expect
      .poll(
        /**
         * 等待结算独立发起短评请求。
         * @returns 请求数量。
         */
        () => pending.length
      )
      .toBe(6)
    const reviewMessages = JSON.parse(requests[5]).messages
    expect(reviewMessages).toHaveLength(2)
    expect(reviewMessages[1].content).toContain('之前最佳')
    expect(JSON.stringify(reviewMessages)).not.toContain('网络失败测试')
    finish(pending[5], '，这局跑得真棒')
    await expect(runner.locator('#pet-review')).toContainText('这局跑得真棒')
    await expect(runner.locator('#pet-review')).toHaveAttribute('data-source', 'ai')
    await runner.screenshot({ path: testInfo.outputPath('companion-runner-review.png') })
    await runner.locator('#primary').click()
    await expect(runner.locator('#pet-review')).toBeEmpty()
    await runner.evaluate(
      /**
       * 再次结束一局以验证重开取消。
       * @returns 无返回值。
       */
      () => (window as any).runnerTest.advance(30)
    )
    await expect
      .poll(
        /**
         * 等待第二局短评开始。
         * @returns 请求数量。
         */
        () => pending.length
      )
      .toBe(7)
    await runner.locator('#primary').click()
    finish(pending[6], '重开后不该出现')
    await expect(runner.locator('#pet-review')).toBeEmpty()
    await expect(runner.locator('#game')).toHaveAttribute('data-phase', 'countdown')
  } finally {
    // 先退出隔离实例并释放所有流，再删除唯一测试临时目录。
    await app?.close()
    for (const response of pending) response.destroy()
    server.closeAllConnections()
    await new Promise<void>(
      /**
       * 等待测试服务释放监听端口。
       * @param resolve 完成回调。
       * @returns 无返回值。
       */
      (resolve) => {
        server.close(
          /**
           * 通知服务已关闭。
           * @returns 无返回值。
           */
          () => resolve()
        )
      }
    )
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
