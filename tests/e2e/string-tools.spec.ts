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
const pluginUrl = '/string-tools/public/index.html'

/**
 * 在字符串插件实际 WebContentsView 中执行界面操作。
 * @param app 隔离的 Electron 实例。
 * @param script 界面脚本。
 * @returns 脚本返回的可序列化结果，视图未加载时返回 null。
 */
async function inPlugin(app: ElectronApplication, script: string): Promise<any> {
  return app.evaluate(
    async ({ webContents }, { fragment, source }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(fragment))
      if (!contents || contents.isLoading()) return null
      return contents.executeJavaScript(source)
    },
    { fragment: pluginUrl, source: script }
  )
}

/**
 * 通过 Electron 原生文本输入将内容写入获得焦点的插件输入区。
 * @param app 隔离的 Electron 实例。
 * @param text 输入文本。
 * @returns 输入事件交付后结束的 Promise。
 */
async function enterText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, { fragment, value }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(fragment))
      if (!contents) throw new Error('字符串插件尚未加载')
      await contents.executeJavaScript(
        'document.querySelector("#source").focus(); document.querySelector("#source").select()'
      )
      await contents.insertText(value)
    },
    { fragment: pluginUrl, value: text }
  )
}

/**
 * 一次设置多个工具选项，并通过输入事件验证即时预览。
 * @param app 隔离的 Electron 实例。
 * @param settings 以控件 ID 为键的文本值或勾选状态。
 * @returns 更新完成后结束的 Promise。
 */
async function setOptions(
  app: ElectronApplication,
  settings: Record<string, string | boolean>
): Promise<void> {
  await inPlugin(
    app,
    `(() => {
    for (const [id, value] of Object.entries(${JSON.stringify(settings)})) {
      const field = document.getElementById(id)
      if (typeof value === 'boolean') field.checked = value
      else field.value = value
    }
    document.querySelector('.options input').dispatchEvent(new Event('input', { bubbles: true }))
  })()`
  )
}

/**
 * 只捕获插件 WebContentsView 的当前可见区域，保存并附加到测试结果。
 * @param app 隔离的 Electron 实例。
 * @param testInfo 当前测试的输出上下文。
 * @param name 截图名称。
 * @returns 截图保存完成后结束的 Promise。
 */
async function capturePlugin(
  app: ElectronApplication,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshot = await app.evaluate(async ({ webContents }, fragment) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes(fragment))
    if (!contents) throw new Error('未找到字符串插件视图')
    return (await contents.capturePage()).toPNG().toString('base64')
  }, pluginUrl)
  const body = Buffer.from(screenshot, 'base64')
  await fs.writeFile(testInfo.outputPath(`${name}.png`), body)
  await testInfo.attach(name, { body, contentType: 'image/png' })
}

/**
 * 为隔离实例注入剪贴板服务的文本响应，通过真实粘贴处理链进入文本匹配状态。
 * 此处验证服务响应后的匹配与传参，不作为操作系统剪贴板的验证证据。
 * @param app 隔离的 Electron 实例。
 * @param host 主窗口页面。
 * @param text 本次模拟的完整剪贴板文本。
 * @returns 粘贴上下文显示后结束的 Promise。
 */
async function pasteTextContext(app: ElectronApplication, host: Page, text: string): Promise<void> {
  const search = host.locator('.search-input')
  await search.fill('')
  await search.press('Backspace')
  // 只替换本测试实例的 IPC 数据源，不读写桌面剪贴板或真实用户数据。
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('get-last-copied-content')
    ipcMain.handle('get-last-copied-content', () => ({ type: 'text', data: value }))
  }, text)
  await search.dispatchEvent('paste')
  await expect(host.locator('.pasted-text')).toBeVisible()
}

/**
 * 点击承载精确命令标题的可交互卡片，避免不可交互标题自身拦截定位。
 * @param host 主窗口页面。
 * @param label 命令的完整显示名称。
 * @returns 点击交付后结束的 Promise。
 */
async function clickContextCommand(host: Page, label: string): Promise<void> {
  await host
    .locator('.app-item, .list-item')
    .filter({ has: host.getByText(label, { exact: true }) })
    .first()
    .click()
}

test('字符串工具支持 SQL、命名、Unicode、拼接替换与行排序筛选', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-string-tools-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  let app: ElectronApplication | null = null
  await fs.mkdir(legacyRoot)
  try {
    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_E2E: '1',
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })

    // 从宿主真实搜索入口启动内置插件，等待正文结果而不只等待标题。
    app.context().on('page', (page) => {
      page.on('pageerror', (error) => console.error('[string-tools page error]', error.message))
      page.on('console', (message) => {
        if (message.type() === 'error')
          console.error('[string-tools console error]', message.text())
      })
    })
    const host = await app.firstWindow()
    const search = host.locator('.search-input')
    await expect(search).toBeVisible()
    await search.fill('字符串处理')
    const command = host.locator('.app-item, .list-item').filter({ hasText: '字符串处理' }).first()
    await expect(command).toBeVisible()
    await command.click()
    await expect
      .poll(
        () =>
          inPlugin(
            app!,
            `({
        output: document.querySelector('#output')?.value,
        hint: document.querySelector('#hint')?.textContent,
        status: document.querySelector('#status')?.textContent,
        clipboardReady: Boolean(window.stringTools),
        ztoolsReady: Boolean(window.ztools)
      })`
          ),
        { timeout: 15_000 }
      )
      .toMatchObject({
        clipboardReady: true,
        ztoolsReady: true
      })

    // 通过原生文本输入验证类型切换、长数字精度和实时预览。
    await enterText(app, '123\n张三\n00123\n90071992547409931234')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe("123,'张三','00123',90071992547409931234")
    await enterText(app, "42\nO'Reilly\n42\n\n001")
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe("42,'O''Reilly','001'")
    await inPlugin(app, 'document.querySelector("#sql-wrap").click()')
    expect(await inPlugin(app, 'document.querySelector("#output").value')).toBe(
      "(42,'O''Reilly','001')"
    )
    await inPlugin(
      app,
      'document.querySelector("#sql-mode").value="number"; document.querySelector("#sql-mode").dispatchEvent(new Event("change",{bubbles:true}))'
    )
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)
    expect(await inPlugin(app, 'document.querySelector("#output").value')).toBe('')

    // 同一份输入可在页签之间切换，命名转换逐行保留边界。
    await inPlugin(
      app,
      'document.querySelector("[data-tab=case]").click(); document.querySelector("#case-mode").value="camel"; document.querySelector("#case-mode").dispatchEvent(new Event("change",{bubbles:true}))'
    )
    await enterText(app, 'HTTPResponse user_id\nsecond-name')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('httpResponseUserId\nsecondName')

    await inPlugin(app, 'document.querySelector("[data-tab=unicode]").click()')
    await enterText(app, String.raw`\u4e2d\u6587\uD83D\uDE00`)
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('中文😀')
    await enterText(app, String.raw`\uD800`)
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#status").textContent'))
      .toContain('未配对')
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)
    await inPlugin(
      app,
      'document.querySelector("#unicode-mode").value="encode"; document.querySelector("#unicode-mode").dispatchEvent(new Event("change",{bubbles:true}))'
    )
    await enterText(app, '中文😀')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe(String.raw`\u4e2d\u6587\ud83d\ude00`)

    // Playwright 会覆盖页面媒体偏好，清除覆盖后验证宿主原生主题传播。
    const pluginPage = app
      .context()
      .pages()
      .find((page) => page.url().includes(pluginUrl))
    expect(pluginPage).toBeTruthy()
    await pluginPage!.emulateMedia({ colorScheme: null })
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect
      .poll(() => inPlugin(app!, 'matchMedia("(prefers-color-scheme: dark)").matches'))
      .toBe(true)
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect
      .poll(() => inPlugin(app!, 'matchMedia("(prefers-color-scheme: dark)").matches'))
      .toBe(false)
    await inPlugin(
      app,
      'document.querySelector("[data-tab=sql]").click(); document.querySelector("#sql-mode").value="auto"; document.querySelector("#sql-mode").dispatchEvent(new Event("change",{bubbles:true}))'
    )
    await enterText(app, "123\n456\n张三\nO'Reilly\n00123\n90071992547409931234\n123")
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#result-count").textContent'))
      .toContain('6 项')
    await capturePlugin(app, testInfo, 'string-tools')

    await inPlugin(app, 'document.querySelector("[data-tab=lines]").click()')
    await enterText(app, ' b \na\nb\nA\n\n')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('b\na\nA')

    // 在既有行整理页验证自然排序、关键词筛选、倒序和错误恢复。
    await inPlugin(app, 'document.querySelector("[data-options=lines] summary").click()')
    expect(
      await inPlugin(
        app,
        'document.querySelector("#lines-keyword").getBoundingClientRect().height > 0'
      )
    ).toBe(true)
    await setOptions(app, { 'lines-sort': 'natural', 'lines-keyword': 'item' })
    await enterText(app, 'item10\nother\nitem2\nitem2')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('item2\nitem10')
    await setOptions(app, { 'lines-reverse': true })
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('item10\nitem2')
    await capturePlugin(app, testInfo, 'string-tools-lines')
    await setOptions(app, {
      'lines-filter': 'exclude',
      'lines-ignore-case': true,
      'lines-reverse': false
    })
    await enterText(app, 'ITEM2\nother\nitem10')
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#output").value')).toBe('other')
    await setOptions(app, { 'lines-keyword': '', 'lines-sort': 'number' })
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)
    expect(await inPlugin(app, 'document.querySelector("#output").value')).toBe('')
    await enterText(app, '9007199254740993\n9007199254740992\n-2')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('-2\n9007199254740992\n9007199254740993')

    // 拼接控件的输入事件应立即更新，空分隔符报错后可继续恢复。
    await inPlugin(app, 'document.querySelector("[data-tab=join]").click()')
    await setOptions(app, {
      'join-input': 'comma',
      'join-separator': ';',
      'join-prefix': '[',
      'join-suffix': ']',
      'join-unique': true
    })
    await enterText(app, ' a,b,a ,, ')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('[a];[b]')
    await capturePlugin(app, testInfo, 'string-tools-join')
    await setOptions(app, { 'join-input': 'custom', 'join-custom': '' })
    expect(await inPlugin(app, 'document.querySelector("#status").textContent')).toContain(
      '分隔符不能为空'
    )
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)
    await setOptions(app, { 'join-custom': '|', 'join-separator': String.raw`\n` })
    await enterText(app, 'a|b')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('[a]\n[b]')

    // 普通模式保持美元占位符原样，正则支持捕获组并阻断非法表达式。
    await inPlugin(app, 'document.querySelector("[data-tab=replace]").click()')
    await inPlugin(app, 'document.querySelector("[data-options=replace] summary").click()')
    expect(
      await inPlugin(
        app,
        'document.querySelector("#replace-regex").getBoundingClientRect().height > 0'
      )
    ).toBe(true)
    await setOptions(app, { 'replace-search': 'a.b', 'replace-value': '$1' })
    await enterText(app, 'a.b aXb a.b')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('$1 aXb $1')
    await setOptions(app, { 'replace-all': false })
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('$1 aXb a.b')
    await setOptions(app, {
      'replace-search': '(\\w+)-(\\d+)',
      'replace-value': '$2:$1',
      'replace-regex': true,
      'replace-all': true
    })
    await enterText(app, 'item-12 thing-34')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('12:item 34:thing')
    await capturePlugin(app, testInfo, 'string-tools-replace')
    await setOptions(app, { 'replace-search': '[' })
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#status").textContent'))
      .toContain('正则表达式无效')
    expect(await inPlugin(app, 'document.querySelector("#output").value')).toBe('')
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)

    // 耗时表达式必须能够终止，恢复输入和切换页签不能被旧任务覆盖。
    await setOptions(app, { 'replace-search': '(a+)+$' })
    await enterText(app, 'a'.repeat(60) + '!')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#status").textContent'))
      .toContain('正则处理超时')
    expect(await inPlugin(app, 'document.querySelector("#copy").disabled')).toBe(true)
    await setOptions(app, { 'replace-search': 'a', 'replace-value': 'b' })
    await enterText(app, 'aaa')
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#output").value')).toBe('bbb')
    await setOptions(app, { 'replace-search': '(a+)+$' })
    await enterText(app, 'a'.repeat(60) + '!')
    await inPlugin(app, 'document.querySelector("[data-tab=case]").click()')
    await enterText(app, 'hello-world')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('helloWorld')
    await inPlugin(app, 'document.querySelector("[data-tab=replace]").click()')
    await setOptions(app, {
      'replace-search': '^foo$',
      'replace-value': 'bar',
      'replace-ignore-case': true,
      'replace-multiline': true
    })
    await enterText(app, 'foo\nFOO')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('bar\nbar')

    // 直接缩窄插件视图，避免宿主固定宽度使窄窗口测试实际没有改变正文宽度。
    const originalBounds = await app.evaluate(({ BrowserWindow }, fragment) => {
      const views = BrowserWindow.getAllWindows().flatMap((win) => win.contentView.children)
      const view = views.find(
        (item) =>
          'webContents' in item &&
          (item as import('electron').WebContentsView).webContents.getURL().includes(fragment)
      ) as import('electron').WebContentsView
      const bounds = view.getBounds()
      view.setBounds({ ...bounds, width: 560, height: 440 })
      return bounds
    }, pluginUrl)
    await expect.poll(() => inPlugin(app!, 'innerWidth')).toBe(560)
    await expect.poll(() => inPlugin(app!, 'innerHeight')).toBe(440)
    await expect
      .poll(() =>
        inPlugin(
          app!,
          `(() => {
      const footer = document.querySelector('footer').getBoundingClientRect()
      const copy = document.querySelector('#copy').getBoundingClientRect()
      const source = document.querySelector('#source').getBoundingClientRect()
      return footer.right <= innerWidth && footer.bottom <= innerHeight &&
        copy.right <= innerWidth && copy.bottom <= innerHeight &&
        source.height >= 60 && document.documentElement.scrollWidth <= innerWidth
    })()`
        )
      )
      .toBe(true)
    await capturePlugin(app, testInfo, 'string-tools-replace-narrow')
    await app.evaluate(
      ({ BrowserWindow }, { fragment, bounds }) => {
        const views = BrowserWindow.getAllWindows().flatMap((win) => win.contentView.children)
        const view = views.find(
          (item) =>
            'webContents' in item &&
            (item as import('electron').WebContentsView).webContents.getURL().includes(fragment)
        ) as import('electron').WebContentsView
        view.setBounds(bounds)
      },
      { fragment: pluginUrl, bounds: originalBounds }
    )
    await inPlugin(app, 'document.querySelector("[data-tab=lines]").click()')
    await setOptions(app, {
      'lines-sort': 'original',
      'lines-filter': 'include',
      'lines-ignore-case': false
    })
    await inPlugin(app, 'document.querySelector("#clear").click()')
    expect(
      await inPlugin(
        app,
        '[document.querySelector("#source").value, document.querySelector("#output").value, document.querySelector("#copy").disabled]'
      )
    ).toEqual(['', '', true])

    // 从宿主直达两个 Unicode 方向，验证复用插件时不会遗留相反模式。
    await inPlugin(app, 'window.ztools.outPlugin()')
    await search.fill('中文转Unicode')
    await host.locator('.app-item, .list-item').filter({ hasText: '中文转Unicode' }).first().click()
    await enterText(app, '中文')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe(String.raw`\u4e2d\u6587`)
    await inPlugin(app, 'window.ztools.outPlugin()')
    await search.fill('Unicode转中文')
    await host.locator('.app-item, .list-item').filter({ hasText: 'Unicode转中文' }).first().click()
    await enterText(app, String.raw`\u4e2d\u6587`)
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#output").value')).toBe('中文')

    // 新指令从宿主搜索直达对应页签，复用插件时保留选项。
    for (const [query, tab] of [
      ['自定义拼接', 'join'],
      ['查找替换', 'replace'],
      ['行排序', 'lines']
    ]) {
      await inPlugin(app, 'window.ztools.outPlugin()')
      await search.fill(query)
      await host.locator('.app-item, .list-item').filter({ hasText: query }).first().click()
      await expect
        .poll(() =>
          inPlugin(
            app!,
            `document.querySelector('[data-tab="${tab}"]').getAttribute('aria-pressed')`
          )
        )
        .toBe('true')
    }
  } finally {
    // 关闭实例后只清理本用例创建的隔离目录。
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('字符串工具真实剪贴板导入、复制和快捷键', async ({ browserName: _browserName }) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-string-clipboard-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot)
  let app: ElectronApplication | null = null
  let previousClipboard: string | undefined
  try {
    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_E2E: '1',
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })
    const host = await app.firstWindow()
    const search = host.locator('.search-input')
    await expect(search).toBeVisible()
    await search.fill('自定义拼接')
    const command = host.locator('.app-item, .list-item').filter({ hasText: '自定义拼接' }).first()
    await expect(command).toBeVisible()
    previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
    // 独立检查系统能力；不可用时明确跳过，不能用模拟剪贴板冒充真实验证。
    const clipboardAvailable = await app.evaluate(({ clipboard }) => {
      clipboard.writeText('a\nb')
      return clipboard.readText() === 'a\nb'
    })
    test.skip(!clipboardAvailable, '当前桌面会话的 Electron 系统剪贴板写入回读不可用')
    await command.click()
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#output")?.value')).toBe('a,b')
    await inPlugin(app, 'document.querySelector("#copy").click()')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('a,b')
    expect(await inPlugin(app, 'document.querySelector("#status").textContent')).toBe(
      '已复制到剪贴板'
    )

    await app.evaluate(({ clipboard }) => clipboard.writeText('c\nd'))
    await inPlugin(app, 'document.querySelector("#paste").click()')
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#output").value')).toBe('c,d')
    await inPlugin(
      app,
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }))'
    )
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('c,d')

    await inPlugin(app, 'document.querySelector("[data-tab=sql]").click()')
    await enterText(app, "42\nO'Reilly\n001")
    await inPlugin(
      app,
      'document.querySelector("#sql-wrap").click(); document.querySelector("#copy").click()'
    )
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "(42,'O''Reilly','001')"
    )
  } finally {
    // 恢复原纯文本剪贴板，再关闭实例并清理隔离数据。
    if (app && previousClipboard !== undefined)
      await app
        .evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard)
        .catch(() => {})
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('字符串上下文推荐携带原文直达工具，主窗口与超级面板顺序一致', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-string-context-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot)
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_E2E: '1',
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })
    const host = await app.firstWindow()
    await expect(host.locator('.search-input')).toBeVisible()
    const names = host.locator('.app-name, .item-title')

    // 多行英文叠加三个工具，点击行整理带入本次完整原文并保留清理结果。
    const lines = '  user_name\norder_id\nuser_name  '
    await pasteTextContext(app, host, lines)
    await expect(names.filter({ hasText: /^SQL IN 拼接$/ }).first()).toBeVisible()
    await expect(names.filter({ hasText: /^行整理$/ }).first()).toBeVisible()
    await expect(names.filter({ hasText: /^大小写与命名$/ }).first()).toBeVisible()
    await expect(names.filter({ hasText: /^自定义拼接$/ })).toHaveCount(0)
    await clickContextCommand(host, '行整理')
    await expect.poll(() => inPlugin(app!, 'document.querySelector("#source")?.value')).toBe(lines)
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output")?.value'))
      .toBe('user_name\norder_id')
    expect(
      await inPlugin(app, 'document.querySelector("[data-tab=lines]").getAttribute("aria-pressed")')
    ).toBe('true')
    expect(await inPlugin(app, 'document.querySelector("[data-options=lines] details").open')).toBe(
      false
    )

    // 手动重入保留草稿；随后新的匹配入口必须覆盖上一份草稿。
    await enterText(app, '保留的草稿')
    await inPlugin(app, 'window.ztools.outPlugin()')
    await host.locator('.search-input').fill('')
    await host.locator('.search-input').press('Backspace')
    await host.locator('.search-input').fill('大小写转换')
    await clickContextCommand(host, '大小写转换')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#source")?.value'))
      .toBe('保留的草稿')
    await inPlugin(app, 'window.ztools.outPlugin()')
    await pasteTextContext(app, host, 'HTTPResponse')
    await expect(names.filter({ hasText: /^大小写与命名$/ }).first()).toBeVisible()
    await expect(names.filter({ hasText: /^行整理$/ })).toHaveCount(0)
    await clickContextCommand(host, '大小写与命名')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#source")?.value'))
      .toBe('HTTPResponse')

    // 先切到编码方向，再从 Unicode 匹配入口重入，模式与可见分段按钮都必须回到解码。
    await inPlugin(
      app,
      'document.querySelector("[data-tab=unicode]").click(); document.querySelector("[data-mode-value=encode]").click()'
    )
    await inPlugin(app, 'window.ztools.outPlugin()')
    const escaped = String.raw`\u4e2d` + '\n' + String.raw`\u6587`
    await pasteTextContext(app, host, escaped)
    const ownLabels = ['Unicode 解码', 'SQL IN 拼接', '行整理', '大小写与命名']
    await expect
      .poll(async () => (await names.allTextContents()).filter((name) => ownLabels.includes(name)))
      .toEqual(['Unicode 解码', 'SQL IN 拼接', '行整理'])
    await clickContextCommand(host, 'Unicode 解码')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output")?.value'))
      .toBe('中\n文')
    expect(await inPlugin(app, 'document.querySelector("#source").value')).toBe(escaped)
    expect(
      await inPlugin(
        app,
        'document.querySelector("[data-mode-value=decode]").getAttribute("aria-pressed")'
      )
    ).toBe('true')
    await capturePlugin(app, testInfo, 'string-tools-compact-unicode')
    await inPlugin(app, 'window.ztools.outPlugin()')

    // 直接走超级面板使用的真实 IPC 事件，验证匹配、排序与同 feature 去重后的输出。
    const panelMatches = await app.evaluate(async ({ BrowserWindow, ipcMain }, text) => {
      const win = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().includes('/out/renderer/')
      )
      if (!win) throw new Error('未找到宿主窗口')
      return new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          ipcMain.removeListener('super-panel-search-result', receive)
          reject(new Error('超级面板搜索未返回结果'))
        }, 10_000)
        /**
         * 收取主渲染进程返回的真实搜索结果，仅提取本插件的文本匹配项。
         * @param _event IPC 事件。
         * @param data 命令与输入上下文。
         * @returns 无返回值。
         */
        function receive(
          _event: unknown,
          data: { results: Array<{ pluginName?: string; cmdType?: string; name: string }> }
        ): void {
          clearTimeout(timer)
          ipcMain.removeListener('super-panel-search-result', receive)
          resolve(
            data.results
              .filter(
                (item) =>
                  item.pluginName === 'string-tools' &&
                  ['regex', 'over'].includes(item.cmdType ?? '')
              )
              .map((item) => item.name)
          )
        }
        ipcMain.on('super-panel-search-result', receive)
        win.webContents.send('super-panel-search', {
          text,
          clipboardContent: { type: 'text', text }
        })
      })
    }, escaped)
    expect(panelMatches).toEqual(['Unicode 解码', 'SQL IN 拼接', '行整理'])

    // 单行末尾换行不产生多行工具；普通中文仍保留通用字符串入口。
    await pasteTextContext(app, host, '中文\n')
    await expect(names.filter({ hasText: /^字符串处理$/ }).first()).toBeVisible()
    await expect(names.filter({ hasText: /^行整理$/ })).toHaveCount(0)
    await expect(names.filter({ hasText: /^大小写与命名$/ })).toHaveCount(0)
  } finally {
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
