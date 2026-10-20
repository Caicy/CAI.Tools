import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 在右键菜单插件的独立 WebContentsView 中检查或操作测试页面。
 * @param application 隔离的 Electron 测试实例
 * @param script 在插件页面执行的测试代码
 * @returns 页面代码返回的值
 */
async function inspectPlugin(application: ElectronApplication, script: string): Promise<any> {
  return application.evaluate(async ({ webContents }, source) => {
    const plugin = webContents
      .getAllWebContents()
      .find((view) => view.getURL().startsWith('http://127.0.0.1:15178'))
    if (!plugin) throw new Error('右键菜单插件未启动')
    return plugin.executeJavaScript(source)
  }, script)
}

// Electron 测试不请求浏览器 fixture，避免启动额外浏览器。
// eslint-disable-next-line no-empty-pattern
test('右键菜单搜索入口打开工具，并按平台展示内容', async ({}, testInfo) => {
  const root = path.resolve(__dirname, '../..')
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-context-menu-'))
  const legacyRoot = path.join(dataRoot, 'legacy')
  let application: ElectronApplication | null = null
  await fs.mkdir(legacyRoot, { recursive: true })
  try {
    // 启动源码项目并隔离数据，不访问真实用户目录。
    application = await electron.launch({
      args: [root],
      cwd: root,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        ZTOOLS_DATA_ROOT: dataRoot,
        ZTOOLS_LEGACY_USER_DATA_PATH: legacyRoot,
        ZTOOLS_E2E: '1',
        ZTOOLS_CONTEXT_MENU_DEV_SERVER_URL: 'http://127.0.0.1:15178',
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })
    const page = await application.firstWindow()
    await page.locator('.search-input').fill('右键菜单管理')
    await page.locator('.app-item, .list-item').filter({ hasText: '右键菜单管理' }).first().click()
    const stableContent = process.platform === 'win32' ? '全部位置' : '此工具仅支持 Windows'
    await expect
      .poll(() =>
        application!.evaluate(async ({ webContents }) => {
          const plugin = webContents
            .getAllWebContents()
            .find((view) => view.getURL().startsWith('http://127.0.0.1:15178'))
          if (!plugin || plugin.isLoading()) return ''
          return plugin.executeJavaScript('document.body.innerText')
        })
      )
      .toContain(stableContent)
    // 等待工具正文后，仅截取插件视图的当前可见区域。
    const screenshot = await application.evaluate(async ({ webContents }) => {
      const plugin = webContents
        .getAllWebContents()
        .find((view) => view.getURL().startsWith('http://127.0.0.1:15178'))
      if (!plugin) throw new Error('右键菜单插件未启动')
      return (await plugin.capturePage()).toPNG().toString('base64')
    })
    await fs.writeFile(
      testInfo.outputPath('windows-context-menu.png'),
      Buffer.from(screenshot, 'base64')
    )
    if (process.platform !== 'win32') {
      // 真实 IPC 必须识别右键菜单插件，再由服务返回平台限制；不能被鉴权错误拦截。
      expect(
        await inspectPlugin(application, 'window.ztools.internal.listWindowsContextMenus()')
      ).toEqual({
        success: false,
        error: '此工具仅支持 Windows。'
      })
      expect(
        await inspectPlugin(application, 'window.ztools.internal.getWindowsContextMenuBackups()')
      ).toEqual({ success: false, error: '此工具仅支持 Windows。' })
      expect(
        await inspectPlugin(
          application,
          "window.ztools.internal.restoreWindowsContextMenu('invalid')"
        )
      ).toEqual({ success: false, error: '此工具仅支持 Windows。' })
    }

    // 使用明确标注的示例数据覆盖界面分支；不调用 Windows 注册表或运行菜单命令。
    const samples = Array.from({ length: 12 }, (_, index) => ({
      id: `HKCU\\Software\\Classes\\Directory\\shell\\CaiPreview${index}`,
      name: index === 0 ? '使用 Code 打开' : `示例工具 ${index}`,
      hive: index === 1 ? 'HKLM' : 'HKCU',
      location: index === 1 ? '*' : 'Directory',
      command:
        index === 0
          ? '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"'
          : '示例命令（不会执行）',
      enabled: index !== 2
    }))
    await inspectPlugin(
      application,
      `
      window.__contextMenuSamples = ${JSON.stringify(samples)};
      window.__contextMenuWrites = 0;
      window.__contextMenuFail = false;
      window.__contextMenuBackups = [];
      window.__contextMenuRestoreFail = false;
      window.ztools.internal.getPlatform = () => 'win32';
      window.ztools.internal.listWindowsContextMenus = async () => ({ success: true, entries: window.__contextMenuSamples.map(entry => ({ ...entry })) });
      window.ztools.internal.getWindowsContextMenuBackups = async () => ({ success: true, backups: window.__contextMenuBackups.map(entry => ({ ...entry })) });
      window.ztools.internal.restoreWindowsContextMenu = async (backupId) => {
        if (window.__contextMenuRestoreFail) return { success: false, error: '模拟还原失败，记录保留' };
        const record = window.__contextMenuBackups.find(entry => entry.backupId === backupId);
        window.__contextMenuSamples.find(entry => entry.id === record.entryId).enabled = true;
        record.restoredAt = new Date().toISOString(); record.canRestore = false;
        return { success: true };
      };
      window.ztools.internal.setWindowsContextMenuEnabled = async (id, enabled) => {
        if (window.__contextMenuFail) return { success: false, error: '模拟备份失败，未修改菜单项。' };
        window.__contextMenuWrites++;
        window.__contextMenuSamples.find(entry => entry.id === id).enabled = enabled;
        if (!enabled) window.__contextMenuBackups.push({ backupId: 'preview-backup', entryId: id, createdAt: new Date().toISOString(), backupPath: '示例禁用备份.reg', canRestore: true });
        return { success: true, backupPath: 'C:\\\\CAI.Tools\\\\示例备份.reg' };
      };
      window.dispatchEvent(new Event('focus'));
    `
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('使用 Code 打开')
    expect(
      await inspectPlugin(
        application,
        `(() => {
      const page = document.querySelector('.context-menu-page');
      return page.scrollHeight > page.clientHeight && getComputedStyle(page).overflowY === 'auto';
    })()`
      )
    ).toBe(true)
    await inspectPlugin(
      application,
      `(() => {
      const banner = document.createElement('p');
      banner.textContent = '界面预览 · 示例数据，未连接 Windows 注册表';
      banner.style.cssText = 'padding:10px;background:#fff3c4;color:#574300;border-radius:6px';
      document.querySelector('.context-menu-page').prepend(banner);
    })()`
    )
    // 等待新路由正文和示例标识完成绘制，避免截到上一个设置页面的合成帧。
    await inspectPlugin(
      application,
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    const preview = await application.evaluate(async ({ webContents }) => {
      const plugin = webContents
        .getAllWebContents()
        .find((view) => view.getURL().startsWith('http://127.0.0.1:15178'))!
      return (await plugin.capturePage()).toPNG().toString('base64')
    })
    await fs.writeFile(
      testInfo.outputPath('windows-context-menu-sample.png'),
      Buffer.from(preview, 'base64')
    )

    // 验证筛选、取消不写入、确认后刷新，以及备份失败保持原状态。
    await inspectPlugin(
      application,
      `(() => {
      const input = document.querySelector('[aria-label="搜索菜单"]');
      input.value = 'Code'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
    )
    await expect
      .poll(() => inspectPlugin(application!, `document.querySelectorAll('.entry').length`))
      .toBe(1)
    await inspectPlugin(application, `document.querySelector('.entry button').click()`)
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('备份并禁用')
    await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '取消' && button.offsetParent).click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, `document.querySelector('.entry button').disabled`))
      .toBe(false)
    expect(await inspectPlugin(application, 'window.__contextMenuWrites')).toBe(0)
    await inspectPlugin(application, `document.querySelector('.entry button').click()`)
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('备份并禁用')
    await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '备份并禁用').click()`
    )
    await expect
      .poll(() =>
        inspectPlugin(application!, `document.querySelector('.entry .status').textContent`)
      )
      .toBe('已禁用')
    expect(await inspectPlugin(application, 'window.__contextMenuWrites')).toBe(1)
    await inspectPlugin(
      application,
      `window.__contextMenuFail = true; document.querySelector('.entry button').click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('备份并启用')
    await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '备份并启用').click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('模拟备份失败')
    expect(
      await inspectPlugin(application, `document.querySelector('.entry .status').textContent`)
    ).toBe('已禁用')
    expect(await inspectPlugin(application, 'window.__contextMenuWrites')).toBe(1)
    // 还原失败保留记录及状态，重试成功后由重新读取的记录禁用还原按钮。
    await inspectPlugin(
      application,
      `window.__contextMenuRestoreFail = true; document.querySelector('.restore-history button').click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('确认还原')
    await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '确认还原').click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('模拟还原失败')
    expect(
      await inspectPlugin(application, `document.querySelector('.entry .status').textContent`)
    ).toBe('已禁用')
    await expect
      .poll(() =>
        inspectPlugin(application!, `document.querySelector('.restore-history button').disabled`)
      )
      .toBe(false)
    await inspectPlugin(
      application,
      `window.__contextMenuRestoreFail = false; document.querySelector('.restore-history button').click()`
    )
    await expect
      .poll(() => inspectPlugin(application!, 'document.body.innerText'))
      .toContain('确认还原')
    await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '确认还原').click()`
    )
    await expect
      .poll(() =>
        inspectPlugin(application!, `document.querySelector('.entry .status').textContent`)
      )
      .toBe('已启用')
    await expect
      .poll(() =>
        inspectPlugin(application!, `document.querySelector('.restore-history button').disabled`)
      )
      .toBe(true)
    // 明确展示还原结果区域；截图仍只截取插件当前可见区域，并标注示例数据。
    await inspectPlugin(
      application,
      `(() => {
      const section = document.querySelector('.restore-history');
      const label = document.createElement('p');
      label.textContent = '还原流程预览 · 示例数据，非 Windows 注册表实测';
      label.style.cssText = 'padding:10px;background:#fff3c4;color:#574300';
      section.prepend(label);
      document.querySelector('[aria-label="查看还原记录"]').click();
    })()`
    )
    await inspectPlugin(
      application,
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    const restoredPreview = await application.evaluate(async ({ webContents }) => {
      const plugin = webContents
        .getAllWebContents()
        .find((view) => view.getURL().startsWith('http://127.0.0.1:15178'))!
      return (await plugin.capturePage()).toPNG().toString('base64')
    })
    await fs.writeFile(
      testInfo.outputPath('windows-context-menu-restore-sample.png'),
      Buffer.from(restoredPreview, 'base64')
    )
  } finally {
    await application?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
