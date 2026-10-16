import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const projectRoot = path.resolve(__dirname, '../..')

/**
 * 在设置插件的实际 WebContentsView 内执行受控脚本。
 * @param application 使用隔离目录的源码 Electron。
 * @param script 测试脚本。
 * @returns 插件脚本执行结果。
 */
async function inSettings(application: ElectronApplication, script: string): Promise<any> {
  return application.evaluate(async ({ webContents }, source) => {
    const view = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('127.0.0.1:15177'))
    return view ? view.executeJavaScript(source) : null
  }, script)
}

/**
 * 打开源码应用和设置页，所有业务数据写入当前用例目录。
 * @param root 当前用例的临时根目录。
 * @returns 已就绪的 Electron 实例。
 */
async function launchSettings(root: string): Promise<ElectronApplication> {
  const application = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ZTOOLS_E2E: '1',
      ZTOOLS_DATA_ROOT: path.join(root, 'data'),
      ZTOOLS_LEGACY_USER_DATA_PATH: path.join(root, 'legacy'),
      ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
    }
  })
  const main = await application.firstWindow()
  await expect(main.locator('.search-input')).toBeVisible()
  await main.locator('.search-input').fill('通用设置')
  await main.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first().click()
  await expect
    .poll(() => inSettings(application, 'document.body.innerText'))
    .toContain('开机自动启动')
  return application
}

test('自有更新窗口、开发安装边界及设置与插件目录重启保留', async ({ browserName: _ }, testInfo) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-auto-update-e2e-'))
  await fs.mkdir(path.join(root, 'legacy'))
  await fs.writeFile(path.join(root, 'legacy/sentinel'), 'untouched')
  let application: ElectronApplication | undefined
  try {
    application = await launchSettings(root)
    const app = application
    // 保留实际 IPC、窗口与状态机，仅替换外部 GitHub 检查传输。
    await app.evaluate(({ app, dialog }) => {
      const load = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const { autoUpdater } = load('electron-updater')
      autoUpdater.checkForUpdates = async () => {
        const updateInfo = {
          version: '3.2.0-local.999',
          releaseNotes: 'CAI.Tools update fixture body ready'
        }
        autoUpdater.emit('update-available', updateInfo)
        return { updateInfo }
      }
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await inSettings(app, `location.hash = '#/about'; true`)
    await expect
      .poll(() => inSettings(app, 'document.body.innerText'))
      .toContain('检查 CAI.Tools 更新')
    // 使用可见按钮文字定位，避免依赖关于页布局样式。
    await inSettings(
      app,
      `[...document.querySelectorAll('button')].find(item => item.textContent.includes('检查 CAI.Tools 更新'))?.click(); true`
    )
    await expect
      .poll(() => app.windows().some((win) => win.url().includes('updater.html')))
      .toBe(true)
    const updateWindow = app.windows().find((win) => win.url().includes('updater.html'))!
    await expect(updateWindow.locator('.changelog')).toContainText(
      'CAI.Tools update fixture body ready'
    )
    await expect(updateWindow.locator('.subtitle')).toContainText('CAI.Tools')
    await updateWindow.screenshot({ path: testInfo.outputPath('cai-update-window.png') })
    await updateWindow.getByRole('button', { name: '下载并安装' }).click()
    await expect(updateWindow.locator('.update-status')).toContainText('开发环境不支持升级')
    await updateWindow.getByRole('button', { name: '稍后更新' }).click()

    // 通过真实设置 UI 保存偏好；插件清单和 LMDB 值在第二次启动后回读。
    await inSettings(
      app,
      `(() => { const input = document.querySelector('input[type="checkbox"]'); input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
    )
    await expect
      .poll(() =>
        inSettings(
          app,
          `window.ztools.internal.dbGet('settings-general').then(data => data?.autoCheckUpdate)`
        )
      )
      .toBe(false)
    const pluginsBefore = await inSettings(app, 'window.ztools.internal.getAllPlugins()')
    await inSettings(
      app,
      `window.ztools.db.put({ _id: 'update-retention-sentinel', data: { value: 'preserved' } })`
    )
    const pluginDirectory = path.join(root, 'data/plugins/update-retention-fixture')
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'sentinel'), 'plugin files preserved')
    await app.close()
    application = undefined

    application = await launchSettings(root)
    expect(
      await inSettings(
        application,
        `window.ztools.internal.dbGet('settings-general').then(data => data?.autoCheckUpdate)`
      )
    ).toBe(false)
    expect(
      await inSettings(application, `window.ztools.db.get('update-retention-sentinel')`)
    ).toMatchObject({ data: { value: 'preserved' } })
    expect(await inSettings(application, 'window.ztools.internal.getAllPlugins()')).toEqual(
      pluginsBefore
    )
    expect(await fs.readFile(path.join(pluginDirectory, 'sentinel'), 'utf8')).toBe(
      'plugin files preserved'
    )
    expect(await fs.readdir(path.join(root, 'legacy'))).toEqual(['sentinel'])
  } finally {
    await application?.close()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
