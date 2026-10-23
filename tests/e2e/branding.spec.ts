import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { GITHUB_REPOSITORY_URL, GITHUB_ISSUES_URL } from '../../src/shared/updateSource'

const root = path.resolve(__dirname, '../..')
const settingUrl = 'http://127.0.0.1:15177'

/**
 * 在实际设置插件视图中运行测试脚本，不访问宿主页面 DOM。
 * @param app 隔离 Electron 应用。
 * @param source 测试脚本。
 * @returns 脚本结果或尚未加载标记。
 */
async function inSettings(app: ElectronApplication, source: string): Promise<any> {
  return app.evaluate(
    /**
     * 查找设置 WebContentsView 并执行脚本。
     * @param electronApi Electron 主进程模块。
     * @param script 待执行脚本。
     * @returns 插件页面脚本结果。
     */
    async ({ webContents }, script) => {
      const contents = webContents.getAllWebContents().find(
        /**
         * 识别真实设置开发页面。
         * @param item 当前 WebContents。
         * @returns 是否为设置页面。
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
 * 截取当前可见的设置插件区域。
 * @param app 隔离 Electron 应用。
 * @param filename 截图输出绝对路径。
 * @returns 截图保存完成的 Promise。
 */
async function captureSettings(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(
    /**
     * 仅捕获设置插件，不拼接宿主窗口。
     * @param electronApi Electron 主进程模块。
     * @returns PNG 的 base64 编码。
     * @throws 设置视图未加载时抛错。
     */
    async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(
        /**
         * 识别设置视图。
         * @param item 当前 WebContents。
         * @returns 是否匹配。
         */
        (item) => item.getURL().startsWith('http://127.0.0.1:15177')
      )
      if (!contents) throw new Error('设置视图未加载')
      return (await contents.capturePage()).toPNG().toString('base64')
    }
  )
  await fs.writeFile(filename, Buffer.from(png, 'base64'))
}

test('CAI.Tools 品牌、Caicy 项目信息与原作者致谢', /**
 * 验证真实关于指令、页面品牌及外链目标，保留原作者与许可信息。
 * @param fixtures Playwright 测试夹具。
 * @param testInfo 截图输出上下文。
 * @returns 验证完成的 Promise。
 */ async ({}, testInfo) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-branding-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  await fs.mkdir(legacyRoot)
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [root],
      cwd: root,
      env: {
        ...(process.env as Record<string, string>),
        ZTOOLS_E2E: '1',
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_SETTING_DEV_SERVER_URL: settingUrl
      }
    })
    const main = await app.firstWindow()
    await expect(main.locator('.search-input')).toBeVisible()
    await expect(main).toHaveTitle('CAI.Tools')
    // 验证真正显示的主窗口设置入口，不能只检查关于页和安装包图标。
    const settingsIcon = main.locator('.avatar-wrapper img.search-btn')
    await expect(settingsIcon).toBeVisible()
    await expect
      .poll(
        /**
         * 等待懒加载图标完成解码，排除透明占位图。
         * @returns 已显示的图像 URL 或空字符串。
         */
        () =>
          settingsIcon.evaluate(
            /**
             * 回读主窗口设置入口实际加载的资源。
             * @param image 设置入口图像元素。
             * @returns 完整加载的图像 URL，尚未加载则为空。
             */
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 1 ? image.currentSrc : ''
          )
      )
      .toMatch(/^file:/)
    const displayedIconUrl = await settingsIcon.getAttribute('src')
    expect(displayedIconUrl).not.toBeNull()
    const expectedIcon = await fs.readFile(path.join(root, 'resources/icons/icon-ztools.png'))
    const displayedIcon = await fs.readFile(fileURLToPath(displayedIconUrl!))
    expect(createHash('sha256').update(displayedIcon).digest('hex')).toBe(
      createHash('sha256').update(expectedIcon).digest('hex')
    )
    await main.screenshot({ path: testInfo.outputPath('cai-tools-launcher.png') })
    // 外链通过真实 IPC 交付到 shell，但测试拦截后不会打开外部浏览器。
    await app.evaluate(
      /**
       * 在隔离进程记录外链请求。
       * @param electronApi Electron 主进程模块。
       * @returns 无返回值。
       */
      ({ shell }) => {
        ;(globalThis as any).__brandingLinks = []
        /**
         * 记录链接目标，不执行外部跳转。
         * @param url 请求打开的 URL。
         * @returns 完成的 Promise。
         */
        shell.openExternal = async (url: string): Promise<void> => {
          ;(globalThis as any).__brandingLinks.push(url)
        }
      }
    )
    await main.locator('.search-input').fill('关于 CAI.Tools')
    await main
      .locator('.app-item, .list-item')
      .filter({ hasText: '关于 CAI.Tools' })
      .first()
      .click()
    await expect.poll(() => inSettings(app!, 'document.body.innerText')).toContain('原作者与致谢')
    const body = await inSettings(app, 'document.body.innerText')
    for (const text of [
      '维护者',
      'Caicy',
      '项目反馈',
      'Zing',
      'lzx8589561',
      'ZToolsCenter',
      'MIT'
    ]) {
      expect(body).toContain(text)
    }
    expect(body).not.toContain('1076942619')
    expect(await inSettings(app, "document.querySelector('.about-title').textContent")).toBe(
      'CAI.Tools'
    )
    await captureSettings(app, testInfo.outputPath('cai-tools-about.png'))
    for (const label of ['项目反馈', 'CAI.Tools 源码', '原始项目', '支持原作者 Zing']) {
      await inSettings(
        app,
        `(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent.includes(${JSON.stringify(label)}));
        if (!button) throw new Error('未找到关于页链接');
        button.click(); return true;
      })()`
      )
    }
    await expect
      .poll(() =>
        app!.evaluate(
          /**
           * 回读经过宿主 shell 的实际目标。
           * @returns 已捕获的 URL 列表。
           */
          () => (globalThis as any).__brandingLinks
        )
      )
      .toEqual([
        GITHUB_ISSUES_URL,
        GITHUB_REPOSITORY_URL,
        'https://github.com/ZToolsCenter/ZTools',
        'https://afdian.com/a/ZTools'
      ])
    // 明确验证致谢区的当前可见区域，避免误把只有侧栏的截图当作正文。
    await inSettings(
      app,
      "document.querySelector('.about-credits').scrollIntoView({ block: 'start' }); true"
    )
    await expect
      .poll(() =>
        inSettings(
          app!,
          `(() => {
      const box = document.querySelector('.about-credits').getBoundingClientRect();
      return box.top >= 0 && box.top < innerHeight;
    })()`
        )
      )
      .toBe(true)
    await captureSettings(app, testInfo.outputPath('cai-tools-credits.png'))
  } finally {
    // 先退出测试应用，确保 LMDB 和窗口资源释放后再清理独立目录。
    await app?.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
