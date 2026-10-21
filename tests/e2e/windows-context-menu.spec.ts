import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_URL = 'http://127.0.0.1:15178'

/**
 * 在右键菜单插件的独立 WebContentsView 中检查或操作测试页面。
 * @param application 隔离的 Electron 测试实例
 * @param script 在插件页面执行的测试代码
 * @returns 页面代码返回的值
 */
async function inspectPlugin(application: ElectronApplication, script: string): Promise<any> {
  return application.evaluate(
    async ({ webContents }, { source, url }) => {
      const plugin = webContents.getAllWebContents().find((view) => view.getURL().startsWith(url))
      if (!plugin) throw new Error('右键菜单插件未启动')
      return plugin.executeJavaScript(source)
    },
    { source: script, url: PLUGIN_URL }
  )
}

/**
 * 点击插件页面中文字完全匹配且可见的按钮。
 * @param application 隔离的 Electron 测试实例
 * @param text 按钮文字
 * @returns 点击完成后的 Promise
 */
async function clickButton(application: ElectronApplication, text: string): Promise<void> {
  await expect
    .poll(() =>
      inspectPlugin(
        application,
        `(() => {
          const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === ${JSON.stringify(text)} && item.offsetParent && !item.disabled);
          if (!button) return false;
          button.click();
          return true;
        })()`
      )
    )
    .toBe(true)
}

/**
 * 等待插件正文包含指定文字。
 * @param application 隔离的 Electron 测试实例
 * @param text 期望出现的文字
 * @returns 文字出现后结束的 Promise
 */
async function waitForText(application: ElectronApplication, text: string): Promise<void> {
  await expect.poll(() => inspectPlugin(application, 'document.body.innerText')).toContain(text)
}

/**
 * 读取指定名称菜单项当前显示的状态文字。
 * @param application 隔离的 Electron 测试实例
 * @param name 菜单项名称
 * @returns 状态文字
 */
async function statusOf(application: ElectronApplication, name: string): Promise<string> {
  return inspectPlugin(
    application,
    `Array.from(document.querySelectorAll('.entry')).find(row => row.querySelector('strong')?.textContent === ${JSON.stringify(name)})?.querySelector('.status')?.textContent`
  )
}

/**
 * 等待两帧绘制后仅截取插件视图的当前可见区域。
 * @param application 隔离的 Electron 测试实例
 * @param file 截图输出路径
 * @returns 截图写入完成后的 Promise
 */
async function capture(application: ElectronApplication, file: string): Promise<void> {
  await inspectPlugin(
    application,
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
  const image = await application.evaluate(async ({ webContents }, url) => {
    const plugin = webContents.getAllWebContents().find((view) => view.getURL().startsWith(url))
    if (!plugin) throw new Error('右键菜单插件未启动')
    return (await plugin.capturePage()).toPNG().toString('base64')
  }, PLUGIN_URL)
  await fs.writeFile(file, Buffer.from(image, 'base64'))
}

// Electron 测试不请求浏览器 fixture，避免启动额外浏览器。
// eslint-disable-next-line no-empty-pattern
test('右键菜单搜索入口打开工具，并按平台展示内容', async ({}, testInfo) => {
  test.setTimeout(300_000)
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
        ZTOOLS_CONTEXT_MENU_DEV_SERVER_URL: PLUGIN_URL,
        ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
      }
    })
    const page = await application.firstWindow()
    await page.locator('.search-input').fill('右键菜单管理')
    await page.locator('.app-item, .list-item').filter({ hasText: '右键菜单管理' }).first().click()
    const stableContent = process.platform === 'win32' ? '全部位置' : '此工具仅支持 Windows'
    await expect
      .poll(() =>
        application!.evaluate(async ({ webContents }, url) => {
          const plugin = webContents
            .getAllWebContents()
            .find((view) => view.getURL().startsWith(url))
          if (!plugin || plugin.isLoading()) return ''
          return plugin.executeJavaScript('document.body.innerText')
        }, PLUGIN_URL)
      )
      .toContain(stableContent)
    if (process.platform === 'win32') {
      // Windows 会真正枚举注册表与新式菜单；必须等首次读取完成，不能只等提前出现的筛选栏。
      await expect
        .poll(() =>
          inspectPlugin(
            application!,
            `(() => {
        const refresh = document.querySelector('.header-actions button:last-child');
        return !!refresh && !refresh.disabled && document.querySelectorAll('.entry').length > 0;
      })()`
          )
        )
        .toBe(true)
      expect(
        await inspectPlugin(application, 'document.querySelectorAll("[role=alert]").length')
      ).toBe(0)
    }
    await capture(application, testInfo.outputPath('windows-context-menu.png'))
    if (process.platform !== 'win32') {
      // 真实 IPC 必须识别右键菜单插件，再由服务返回平台限制；不能被鉴权错误拦截。
      const unsupported = { success: false, error: '此工具仅支持 Windows。' }
      for (const call of [
        'listWindowsContextMenus()',
        'getWindowsContextMenuBackups()',
        "restoreWindowsContextMenus(['invalid'])",
        "applyWindowsContextMenuStates([{ id: 'invalid', state: 'disabled' }])",
        'setWindowsClassicContextMenu(true)',
        'restartWindowsExplorer()'
      ]) {
        expect(await inspectPlugin(application, `window.ztools.internal.${call}`)).toEqual(
          unsupported
        )
      }
    }

    // 使用明确标注的示例数据覆盖界面分支；替换全部写入接口，不修改注册表也不重启资源管理器。
    const verb = (id: string, name: string, extra: Record<string, unknown> = {}): object => ({
      id: `HKCU\\Software\\Classes\\Directory\\shell\\${id}`,
      kind: 'verb',
      name,
      hive: 'HKCU',
      locations: ['Directory'],
      command: '示例命令（不会执行）',
      state: 'shown',
      system: false,
      group: '示例工具',
      ...extra
    })
    const samples = [
      verb('CaiPreviewCode', '使用 Code 打开', {
        command: '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"',
        group: 'Visual Studio Code'
      }),
      verb('CaiPreviewMachine', '所有用户示例', {
        id: 'HKLM\\Software\\Classes\\*\\shell\\CaiPreviewMachine',
        hive: 'HKLM',
        locations: ['*']
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        verb(`CaiPreview${index}`, index === 7 ? '只读失败示例' : `示例工具 ${index}`, {
          state: index === 2 ? 'disabled' : 'shown'
        })
      ),
      {
        id: 'SHELLEX\\{23170F69-40C1-278A-1000-000100020000}',
        kind: 'shellex',
        name: '7-Zip',
        locations: ['*', 'Directory', 'Folder'],
        command: 'C:\\Program Files\\7-Zip\\7-zip.dll',
        clsid: '{23170F69-40C1-278A-1000-000100020000}',
        state: 'shown',
        blockedBy: [],
        system: false,
        group: '7-Zip'
      },
      {
        id: 'PACKAGED\\{CA6CC9F1-867A-481E-951E-A28C5E4F01EA}',
        kind: 'packaged',
        name: '记事本 · OpenInNotepad',
        locations: ['*', 'Directory'],
        command: 'Microsoft.WindowsNotepad（示例）',
        clsid: '{CA6CC9F1-867A-481E-951E-A28C5E4F01EA}',
        state: 'shown',
        blockedBy: [],
        system: false,
        group: 'Windows 记事本'
      },
      {
        id: 'SHELLEX\\{474C98EE-CF3D-41F5-80E3-4AAB0AB04301}',
        kind: 'shellex',
        name: '脱机文件',
        locations: ['AllFilesystemObjects', 'Folder', 'Directory'],
        command: '%SystemRoot%\\System32\\cscui.dll',
        clsid: '{474C98EE-CF3D-41F5-80E3-4AAB0AB04301}',
        state: 'shown',
        blockedBy: [],
        system: true,
        group: 'Windows 系统'
      }
    ]
    await inspectPlugin(
      application,
      `
      window.__samples = ${JSON.stringify(samples)};
      window.__env = { build: 26100, win11: true, classicMenu: false, isAdmin: false };
      window.__backups = [];
      window.__seq = 0;
      window.__writes = 0;
      window.__restarts = 0;
      window.__fail = false;
      window.__restoreFail = false;
      window.__record = (entryId, label, op, fromState, toState) => window.__backups.unshift({
        backupId: 'preview-' + (++window.__seq), entryId, label, op, fromState, toState,
        createdAt: new Date().toISOString(), backupPath: '示例备份.reg', canRestore: true
      });
      const internal = window.ztools.internal;
      internal.getPlatform = () => 'win32';
      internal.listWindowsContextMenus = async () => ({ success: true, environment: { ...window.__env }, entries: window.__samples.map(entry => ({ ...entry })) });
      internal.getWindowsContextMenuBackups = async () => ({ success: true, backups: window.__backups.map(entry => ({ ...entry })) });
      internal.applyWindowsContextMenuStates = async (changes) => {
        if (window.__fail) return { success: false, error: '模拟备份失败，未修改菜单项。' };
        window.__writes += changes.length;
        const results = changes.map(change => {
          const entry = window.__samples.find(item => item.id === change.id);
          if (entry.name === '只读失败示例') return { id: change.id, success: false, error: '模拟拒绝访问' };
          window.__record(entry.id, entry.name, entry.kind === 'verb' ? 'verb-state' : 'block', entry.state, change.state);
          entry.state = change.state;
          return { id: change.id, success: true, changed: true, backupPath: '示例备份.reg' };
        });
        return { success: results.every(item => item.success), results };
      };
      internal.restoreWindowsContextMenus = async (ids) => {
        const results = ids.map(id => {
          if (window.__restoreFail) return { id, success: false, error: '模拟还原失败，记录保留' };
          const record = window.__backups.find(item => item.backupId === id);
          if (record.entryId === 'CLASSIC_MENU') window.__env.classicMenu = record.fromState === 'on';
          else window.__samples.find(item => item.id === record.entryId).state = record.fromState;
          record.restoredAt = new Date().toISOString(); record.canRestore = false;
          return { id, success: true };
        });
        return { success: results.every(item => item.success), results };
      };
      internal.setWindowsClassicContextMenu = async (enabled) => {
        window.__record('CLASSIC_MENU', 'Windows 11 经典右键菜单', 'classic-menu', window.__env.classicMenu ? 'on' : 'off', enabled ? 'on' : 'off');
        window.__env.classicMenu = enabled;
        return { success: true, changed: true };
      };
      internal.restartWindowsExplorer = async () => { window.__restarts++; return { success: true }; };
      window.dispatchEvent(new Event('focus'));
    `
    )
    await waitForText(application, '使用 Code 打开')
    await waitForText(application, '经典右键菜单')
    expect(
      await inspectPlugin(
        application,
        `(() => {
      const page = document.querySelector('.context-menu-page');
      return page.scrollHeight > page.clientHeight && getComputedStyle(page).overflowY === 'auto';
    })()`
      )
    ).toBe(true)
    // 系统组件分组排在第三方程序之后，所有用户项在未提权时只读。
    expect(
      await inspectPlugin(
        application,
        `Array.from(document.querySelectorAll('.group-title label')).map(item => item.textContent.trim())`
      )
    ).toEqual(['7-Zip', '示例工具', 'Visual Studio Code', 'Windows 记事本', 'Windows 系统'])
    expect(
      await inspectPlugin(
        application,
        `document.querySelector('[aria-label="选择 所有用户示例"]').disabled`
      )
    ).toBe(true)
    expect(
      await inspectPlugin(
        application,
        `!!document.querySelector('[aria-label="设为仅 Shift 显示 7-Zip"]')`
      )
    ).toBe(false)
    await inspectPlugin(
      application,
      `(() => {
      const banner = document.createElement('p');
      banner.textContent = '界面预览 · 示例数据，未连接 Windows 注册表';
      banner.style.cssText = 'padding:10px;background:#fff3c4;color:#574300;border-radius:6px';
      document.querySelector('.context-menu-page').prepend(banner);
    })()`
    )
    await capture(application, testInfo.outputPath('windows-context-menu-sample.png'))

    // 单项：搜索筛选、取消不写入、确认后刷新，以及备份失败保持原状态。
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
    await inspectPlugin(
      application,
      `document.querySelector('[aria-label="禁用 使用 Code 打开"]').click()`
    )
    await waitForText(application, '备份并禁用')
    await clickButton(application, '取消')
    expect(await inspectPlugin(application, 'window.__writes')).toBe(0)
    await inspectPlugin(
      application,
      `document.querySelector('[aria-label="禁用 使用 Code 打开"]').click()`
    )
    await clickButton(application, '备份并禁用')
    await expect.poll(() => statusOf(application!, '使用 Code 打开')).toBe('已禁用')
    expect(await inspectPlugin(application, 'window.__writes')).toBe(1)
    await waitForText(application, '立即重启资源管理器')
    await inspectPlugin(
      application,
      `window.__fail = true; document.querySelector('[aria-label="显示 使用 Code 打开"]').click()`
    )
    await clickButton(application, '备份并显示')
    await waitForText(application, '模拟备份失败')
    expect(await statusOf(application, '使用 Code 打开')).toBe('已禁用')
    expect(await inspectPlugin(application, 'window.__writes')).toBe(1)

    // 批量：全选不含系统组件和只读项，跳过已禁用项，单项失败不影响其他项。
    await inspectPlugin(
      application,
      `(() => {
      window.__fail = false;
      const input = document.querySelector('[aria-label="搜索菜单"]');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
    )
    await expect
      .poll(() => inspectPlugin(application!, `document.querySelectorAll('.entry-check').length`))
      .toBe(samples.length)
    await inspectPlugin(
      application,
      `document.querySelector('[aria-label="全选当前结果"]').click()`
    )
    await waitForText(application, '已选 11 项')
    await clickButton(application, '批量禁用')
    await waitForText(application, '按 CLSID 屏蔽')
    await clickButton(application, '备份并禁用')
    await waitForText(application, '失败 1 项')
    expect(await inspectPlugin(application, 'window.__writes')).toBe(10)
    expect(await statusOf(application, '7-Zip')).toBe('已禁用')
    expect(await statusOf(application, '脱机文件')).toBe('显示中')
    expect(await statusOf(application, '只读失败示例')).toBe('显示中')
    await capture(application, testInfo.outputPath('windows-context-menu-batch-sample.png'))

    // 经典菜单开关与重启资源管理器均需确认，且只调用替换后的接口。
    await clickButton(application, '启用经典菜单')
    await clickButton(application, '备份并启用')
    await waitForText(application, '恢复新式菜单')
    await clickButton(application, '立即重启资源管理器')
    await waitForText(application, '任务栏和桌面会短暂消失')
    await clickButton(application, '立即重启')
    await waitForText(application, '资源管理器已重启')
    expect(await inspectPlugin(application, 'window.__restarts')).toBe(1)

    // 还原全部：失败时保留记录，重试成功后菜单与经典菜单都回到修改前状态。
    const restoreAll = await inspectPlugin(
      application,
      `Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim().startsWith('还原全部')).textContent.trim()`
    )
    expect(restoreAll).toBe('还原全部（10）')
    await inspectPlugin(application, 'window.__restoreFail = true')
    await clickButton(application, restoreAll)
    await clickButton(application, '确认还原')
    await waitForText(application, '模拟还原失败')
    expect(await statusOf(application, '7-Zip')).toBe('已禁用')
    await inspectPlugin(application, 'window.__restoreFail = false')
    await clickButton(application, restoreAll)
    await clickButton(application, '确认还原')
    await waitForText(application, '已还原 10 条修改')
    await waitForText(application, '还原全部（0）')
    expect(await statusOf(application, '使用 Code 打开')).toBe('显示中')
    expect(await statusOf(application, '7-Zip')).toBe('显示中')
    expect(await statusOf(application, '示例工具 2')).toBe('已禁用')
    await waitForText(application, '启用经典菜单')
    await inspectPlugin(
      application,
      `(() => {
      const section = document.querySelector('.restore-history');
      const label = document.createElement('p');
      label.textContent = '还原流程预览 · 示例数据，非 Windows 注册表实测';
      label.style.cssText = 'padding:10px;background:#fff3c4;color:#574300';
      section.prepend(label);
      document.querySelector('[aria-label="查看修改记录"]').click();
    })()`
    )
    await capture(application, testInfo.outputPath('windows-context-menu-restore-sample.png'))
  } finally {
    await application?.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
