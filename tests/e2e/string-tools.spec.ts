import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
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

test('字符串内置插件支持 SQL、命名、Unicode、行整理与真实剪贴板', async ({
  browserName: _browserName
}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-string-tools-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  let app: ElectronApplication | null = null
  let originalClipboard: string | undefined
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
    originalClipboard = await app.evaluate(({ clipboard }) => {
      return clipboard.readText()
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
    expect(
      await app.evaluate(({ clipboard }) => {
        clipboard.writeText('123\n张三\n00123\n90071992547409931234')
        return clipboard.readText()
      })
    ).toBe('123\n张三\n00123\n90071992547409931234')
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
        output: "123,'张三','00123',90071992547409931234",
        clipboardReady: true,
        ztoolsReady: true
      })

    // 验证类型切换、数字精度和原生复制 IPC 的实际回读。
    await enterText(app, "42\nO'Reilly\n42\n\n001")
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe("42,'O''Reilly','001'")
    await inPlugin(
      app,
      'document.querySelector("#sql-wrap").click(); document.querySelector("#copy").click()'
    )
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "(42,'O''Reilly','001')"
    )
    expect(await inPlugin(app, 'document.querySelector("#status").textContent')).toBe(
      '已复制到剪贴板'
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
    const screenshot = await app.evaluate(async ({ webContents }, fragment) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(fragment))
      if (!contents) throw new Error('未找到字符串插件视图')
      return (await contents.capturePage()).toPNG().toString('base64')
    }, pluginUrl)
    await fs.writeFile(testInfo.outputPath('string-tools.png'), Buffer.from(screenshot, 'base64'))
    await testInfo.attach('string-tools', {
      body: Buffer.from(screenshot, 'base64'),
      contentType: 'image/png'
    })

    await inPlugin(app, 'document.querySelector("[data-tab=lines]").click()')
    await enterText(app, ' b \na\nb\nA\n\n')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('b\na\nA')
    await app.evaluate(({ clipboard }) => clipboard.writeText('from clipboard'))
    await inPlugin(app, 'document.querySelector("#paste").click()')
    await expect
      .poll(() => inPlugin(app!, 'document.querySelector("#output").value'))
      .toBe('from clipboard')
    await inPlugin(
      app,
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }))'
    )
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('from clipboard')
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
  } finally {
    // 恢复剪贴板并关闭实例后只清理本用例创建的隔离目录。
    if (app && originalClipboard !== undefined)
      await app
        .evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard)
        .catch(() => {})
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
