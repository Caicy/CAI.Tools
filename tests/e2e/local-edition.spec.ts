import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { UPSTREAM_BASE_VERSION } from '../../src/shared/localEdition'

const projectRoot = path.resolve(__dirname, '../..')

/**
 * 在匹配 URL 的真实插件视图内执行受控脚本。
 * @param application 隔离 Electron 实例。
 * @param fragment 插件 URL 特征。
 * @param script 页面脚本。
 * @returns 页面脚本的执行结果。
 */
async function inPlugin(
  application: ElectronApplication,
  fragment: string,
  script: string
): Promise<any> {
  return application.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(input.fragment))
      if (!contents) return null
      return contents.executeJavaScript(input.script)
    },
    { fragment, script }
  )
}

/**
 * 创建只验证兼容 API 的最小开发插件。
 * @param root 当前用例的临时目录。
 * @returns 插件清单路径。
 */
async function createLocalPlugin(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true })
  await fs.copyFile(path.join(projectRoot, 'resources/icons/icon.png'), path.join(root, 'logo.png'))
  await fs.writeFile(
    path.join(root, 'plugin.json'),
    JSON.stringify({
      name: 'local-api-e2e',
      title: 'Local API E2E',
      version: '1.0.0',
      main: 'index.html',
      preload: 'preload.js',
      logo: 'logo.png',
      features: [{ code: 'local-api-e2e', explain: 'Local API E2E', cmds: ['Local API E2E'] }]
    })
  )
  await fs.writeFile(path.join(root, 'preload.js'), "'use strict'\n")
  await fs.writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><body><main>Local API E2E Ready</main></body></html>'
  )
  return path.join(root, 'plugin.json')
}

test('本地版首次免登录、旧入口收敛、插件存储与主题快捷键可用', async ({
  browserName: _browserName
}, testInfo) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-local-edition-e2e-'))
  const dataRoot = path.join(root, 'data')
  const legacyRoot = path.join(root, 'legacy')
  await fs.mkdir(legacyRoot)
  await fs.writeFile(path.join(legacyRoot, 'sentinel'), 'untouched')
  const configPath = await createLocalPlugin(path.join(root, 'local-api-e2e'))
  let application: ElectronApplication | undefined
  let previousShortcut: string | undefined
  try {
    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        ZTOOLS_E2E: '1',
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })
    const page = await application.firstWindow()
    await expect(page.locator('.search-input')).toBeVisible()
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(dataRoot)
    await page.locator('.search-input').fill('通用设置')
    await page.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first().click()
    /**
     * 对当前隔离设置视图执行脚本。
     * @param script 受控脚本。
     * @returns 执行结果。
     */
    const settings = (script: string): Promise<any> =>
      inPlugin(application!, '127.0.0.1:15177', script)
    await expect.poll(() => settings('document.body.innerText')).toContain('开机自动启动')
    // 内部界面保留构建标识，第三方插件则按声明的上游 API 基线检查兼容性。
    const buildVersion = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ).version
    expect(await application.evaluate(({ app }) => app.getVersion())).toBe(buildVersion)
    expect(await settings('window.ztools.internal.getAppVersion()')).toBe(buildVersion)
    expect(await settings('window.ztools.internal.accountGetSession()')).toBeNull()
    const menus = await settings(
      '[...document.querySelectorAll(".menu-item")].map(item => item.textContent)'
    )
    for (const label of ['账号', '数据同步', '通知']) expect(menus.join('')).not.toContain(label)
    // 历史收藏和深链接必须返回本地通用设置，不重新激活旧账号组件。
    for (const route of ['account', 'sync', 'notifications']) {
      await settings(`location.hash = '#/${route}'; true`)
      await expect.poll(() => settings('location.hash')).toBe('#/generalSetting')
      await expect.poll(() => settings('document.body.innerText')).toContain('开机自动启动')
    }
    expect(
      await settings(
        `window.ztools.internal.accountSaveSession({ username: 'ignored', token: 'ignored', refreshToken: '' })`
      )
    ).toMatchObject({ success: false, code: 'OFFICIAL_CAPABILITY_UNAVAILABLE' })

    // 设置写入只经过隔离数据库，并在退出前恢复全局快捷键注册。
    previousShortcut = await settings('window.ztools.internal.getCurrentShortcut()')
    const shortcut = 'Ctrl+Alt+Shift+F11'
    expect(
      await settings(`window.ztools.internal.updateShortcut(${JSON.stringify(shortcut)})`)
    ).toMatchObject({ success: true })
    await settings(`window.ztools.internal.setTheme('dark')`)
    await settings(
      `(() => { const old = window.ztools.db.get('settings-general'); return window.ztools.db.put({ ...(old || {}), _id: 'settings-general', data: { ...(old?.data || {}), hotkey: ${JSON.stringify(shortcut)}, theme: 'dark' } }) })()`
    )
    expect(await settings('window.ztools.internal.getCurrentShortcut()')).toBe(shortcut)
    expect(
      await application.evaluate(({ globalShortcut, nativeTheme }) => ({
        registered: globalShortcut.isRegistered('Ctrl+Alt+Shift+F11'),
        theme: nativeTheme.themeSource
      }))
    ).toEqual({ registered: true, theme: 'dark' })
    expect(await settings(`window.ztools.db.get('settings-general')`)).toMatchObject({
      data: { hotkey: shortcut, theme: 'dark' }
    })
    const screenshot = await application.evaluate(async ({ webContents }) =>
      (
        await webContents
          .getAllWebContents()
          .find((item) => item.getURL().startsWith('http://127.0.0.1:15177'))!
          .capturePage()
      )
        .toPNG()
        .toString('base64')
    )
    await fs.writeFile(testInfo.outputPath('local-settings.png'), Buffer.from(screenshot, 'base64'))

    // 从真实设置 API 安装并启动开发插件，验证兼容层在第三方视图中的实际行为。
    expect(
      await settings(`window.ztools.internal.importDevPlugin(${JSON.stringify(configPath)})`)
    ).toMatchObject({ success: true })
    expect(
      await settings(`window.ztools.internal.installDevPlugin('local-api-e2e')`)
    ).toMatchObject({ success: true })
    const plugins = await settings('window.ztools.internal.getAllPlugins()')
    const plugin = plugins.find((item: any) => item.name === 'local-api-e2e__dev')
    expect(plugin).toBeTruthy()
    expect(
      await settings(
        `window.ztools.internal.launch(${JSON.stringify({ path: plugin.path, type: 'plugin', name: 'Local API E2E', param: { code: 'local-api-e2e', type: 'text', payload: '' } })})`
      )
    ).toMatchObject({ success: true })
    await expect
      .poll(() => inPlugin(application!, 'local-api-e2e', 'document.body.innerText'))
      .toContain('Local API E2E Ready')
    expect(await inPlugin(application, 'local-api-e2e', 'window.ztools.getAppVersion()')).toBe(
      UPSTREAM_BASE_VERSION
    )
    const results = await inPlugin(
      application,
      'local-api-e2e',
      `(async () => {
      const failures = []
      for (const name of ['getUserTempToken', 'requestPayment', 'getPaymentRecords']) {
        try {
          if (name === 'requestPayment') await window.ztools.requestPayment({ productId: 'local-test', orderNo: 'local-test-order' }, () => {})
          else await window.ztools[name]({})
          failures.push('unexpected-success')
        } catch (error) { failures.push(String(error)) }
      }
      const saved = window.ztools.db.put({ _id: 'local-document', data: { value: 42 } })
      window.ztools.dbStorage.setItem('local-storage', { value: 'persisted' })
      const attachment = window.ztools.db.postAttachment('local-attachment', new Uint8Array([1, 2, 3, 255]), 'application/octet-stream')
      return { user: window.ztools.getUser(), failures, saved, document: window.ztools.db.get('local-document'), storage: window.ztools.dbStorage.getItem('local-storage'), attachment, bytes: Array.from(window.ztools.db.getAttachment('local-attachment')), type: window.ztools.db.getAttachmentType('local-attachment') }
    })()`
    )
    expect(results.user).toBeNull()
    expect(results.failures).toHaveLength(3)
    for (const failure of results.failures)
      expect(failure).toContain('OFFICIAL_CAPABILITY_UNAVAILABLE')
    expect(results).toMatchObject({
      saved: { ok: true },
      document: { data: { value: 42 } },
      storage: { value: 'persisted' },
      attachment: { ok: true },
      bytes: [1, 2, 3, 255],
      type: { type: 'application/octet-stream', length: 4 }
    })
    expect(await fs.readdir(legacyRoot)).toEqual(['sentinel'])
    expect(await fs.readFile(path.join(legacyRoot, 'sentinel'), 'utf8')).toBe('untouched')
    // 自配 AI 的 OpenAI Chat/Responses/Anthropic 实际流式调用复用 aiChat.spec.ts；真实匿名市场安装见 local-runtime-audit.mjs --market-install。
  } finally {
    if (application && previousShortcut)
      await inPlugin(
        application,
        '127.0.0.1:15177',
        `window.ztools.internal.updateShortcut(${JSON.stringify(previousShortcut)})`
      ).catch(() => {})
    await application?.close()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
