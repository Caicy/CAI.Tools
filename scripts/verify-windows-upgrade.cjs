/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node CommonJS CLI 使用 JSDoc 定义参数和返回合同。 */
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')
const { _electron: electron } = require('@playwright/test')
const asar = require('@electron/asar')
const execute = promisify(execFile)
const repository = 'https://github.com/Caicy/CAI.Tools'

/**
 * 禁止在日常电脑或自托管 runner 上安装验收包。
 * @param {NodeJS.ProcessEnv} env 当前进程环境。
 * @param {string} platform 当前操作系统。
 * @returns {string} GitHub 临时目录的绝对路径。
 * @throws {Error} 当前不是独立的 GitHub 托管 Windows runner 时拒绝执行。
 */
function assertHostedWindows(env, platform) {
  assert.equal(platform, 'win32', 'Windows runner required')
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions required')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Fresh GitHub-hosted VM required')
  assert.equal(env.RUNNER_OS, 'Windows', 'Windows runner required')
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), 'Absolute RUNNER_TEMP required')
  return path.resolve(env.RUNNER_TEMP)
}

/**
 * 检查仅用于本次验收的数字 local 版本。
 * @param {string} version 输入版本。
 * @returns {string} 经过校验的版本号。
 * @throws {Error} 非 local 数字版本时拒绝执行。
 */
function validateVersion(version) {
  assert.equal(version, version?.trim(), 'Whitespace in version is not allowed')
  assert.match(version || '', /^\d+\.\d+\.\d+-local\.(0|[1-9]\d*)$/)
  return version
}

/**
 * 等待真实安装或应用状态发生变化，保留最后一个失败原因。
 * @param {Function} check 返回满足条件的值或抛出暂时失败的检查。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @returns {Promise<unknown>} 首个满足条件的检查结果。
 * @throws {Error} 状态在期限内未就绪时报告最后错误。
 */
async function waitFor(check, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      if (error.fatal) throw error
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out: ${lastError?.message || 'state unavailable'}`)
}

/**
 * 从自有公开 Release 下载文件，不使用客户端凭据。
 * @param {string} version 目标版本。
 * @param {string} name Release 中的固定文件名。
 * @returns {Promise<Buffer>} 下载完成的原始字节。
 * @throws {Error} HTTP 失败或超时时拒绝继续。
 */
async function releaseBytes(version, name) {
  const response = await fetch(`${repository}/releases/download/v${version}/${name}`, {
    signal: AbortSignal.timeout(240000)
  })
  assert.ok(response.ok, `${name}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 校验下载的真实 NSIS 安装器与发布校验文件一致。
 * @param {string} version 目标版本。
 * @param {string} root 本次临时目录。
 * @returns {Promise<string>} 已验证安装器的路径。
 * @throws {Error} 缺少摘要或实际 SHA256 不匹配时拒绝安装。
 */
async function downloadInstaller(version, root) {
  const name = `CAI.Tools-${version}-win-x64-setup.exe`
  const checksums = (await releaseBytes(version, 'SHA256SUMS.txt'))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
  const line = checksums.split(/\r?\n/).find((item) => item.trim().endsWith(name))
  assert.ok(line, `Missing checksum: ${name}`)
  const bytes = await releaseBytes(version, name)
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(digest, line.trim().split(/\s+/)[0], 'Release installer checksum mismatch')
  const destination = path.join(root, name)
  await fs.writeFile(destination, bytes)
  console.log(`Verified installer ${version}: ${bytes.length} bytes, SHA256 ${digest}`)
  return destination
}

/**
 * 只查询或终止本次临时安装目录内的测试应用进程。
 * @param {string} executable 本次安装的可执行文件绝对路径。
 * @param {boolean} stop 是否结束已经观察到的自动重启测试进程。
 * @returns {Promise<number[]>} 当前匹配进程的 PID。
 * @throws {Error} PowerShell 查询或清理失败时报告错误。
 */
async function installedProcesses(executable, stop = false) {
  // 路径通过环境传参，禁止把路径拼接进 PowerShell 代码或匹配其他安装。
  const script =
    "$items = @(Get-Process -Name 'CAI.Tools' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:CAI_ACCEPTANCE_EXE }); @($items.Id) | ConvertTo-Json -Compress; if ($env:CAI_ACCEPTANCE_STOP -eq '1') { $items | Stop-Process -Force }"
  const result = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        CAI_ACCEPTANCE_EXE: executable,
        CAI_ACCEPTANCE_STOP: stop ? '1' : '0'
      },
      timeout: 30000
    }
  )
  const ids = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : []
  return Array.isArray(ids) ? ids.filter(Boolean) : ids ? [ids] : []
}

/**
 * 在实际设置或测试插件视图中执行验收脚本。
 * @param {import('@playwright/test').ElectronApplication} application 实际安装版应用。
 * @param {string} fragment 已知插件 URL 特征。
 * @param {string} script 受控的验收脚本。
 * @returns {Promise<unknown>} 插件通过真实 preload 和 IPC 返回的结果。
 */
async function inPlugin(application, fragment, script) {
  return application.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(input.fragment))
      return view ? view.executeJavaScript(input.script) : null
    },
    { fragment, script }
  )
}

/**
 * 启动已安装版本并打开实际设置插件。
 * @param {string} executable 验收安装目录内的程序。
 * @param {string} dataRoot 隔离数据目录。
 * @returns {Promise<{application: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page}>} 应用与宿主页面。
 * @throws {Error} 实际安装版无法就绪或数据路径错误时拒绝继续。
 */
async function launchInstalled(executable, dataRoot) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ZTOOLS_SETTING_DEV_SERVER_URL
  const application = await electron.launch({ executablePath: executable, env, timeout: 90000 })
  // 保留实际安装版的进程输出，CI 启动失败时可定位原生模块或主进程错误。
  application.process().stdout?.on('data', (chunk) => process.stdout.write(chunk))
  application.process().stderr?.on('data', (chunk) => process.stderr.write(chunk))
  const page = await application.firstWindow()
  await page.locator('.search-input').waitFor({ state: 'visible', timeout: 90000 })
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), dataRoot)
  await page.locator('.search-input').fill('通用设置')
  await page.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first().click()
  await waitFor(async () =>
    String(await inPlugin(application, '/setting/', 'document.body.innerText')).includes(
      '开机自动启动'
    )
  )
  return { application, page }
}

/**
 * 使用设置内部 API 启动已安装的第三方验收插件。
 * @param {import('@playwright/test').ElectronApplication} application 实际安装版。
 * @returns {Promise<unknown>} 插件注册信息。
 * @throws {Error} 第三方插件丢失或启动失败时拒绝验收。
 */
async function launchFixture(application) {
  const plugin = await inPlugin(
    application,
    '/setting/',
    `(async () => {
    const plugins = await window.ztools.internal.getAllPlugins()
    const plugin = plugins.find(item => item.name === 'upgrade-retention__dev')
    if (!plugin) throw new Error('Installed fixture plugin missing')
    const launched = await window.ztools.internal.launch({ path: plugin.path, type: 'plugin', name: 'Upgrade Retention', param: { code: 'retention', type: 'text', payload: '' } })
    if (!launched.success) throw new Error(launched.error || 'Plugin launch failed')
    return plugin
  })()`
  )
  await waitFor(async () =>
    String(
      await inPlugin(application, 'upgrade-retention/index.html', 'document.body.innerText')
    ).includes('Retention Ready')
  )
  return plugin
}

/**
 * 完成两个已发布 Windows NSIS 版本之间的真实应用内升级并回读数据。
 * @returns {Promise<void>} 验收及报告写入完成后的 Promise。
 * @throws {Error} 任一安装、下载、版本或数据保留断言失败时使 CI 失败。
 */
async function main() {
  const runnerTemp = assertHostedWindows(process.env, process.platform)
  const baseline = validateVersion(process.argv[2])
  const target = validateVersion(process.argv[3])
  assert.notEqual(baseline, target)
  const root = await fs.mkdtemp(path.join(runnerTemp, 'cai-tools-upgrade-'))
  const dataRoot = path.join(root, 'data')
  const legacyRoot = path.join(root, 'legacy')
  const installRoot = path.join(root, 'installed')
  const executable = path.join(installRoot, 'CAI.Tools.exe')
  const output = path.resolve('test-results/windows-upgrade')
  await fs.mkdir(output, { recursive: true })
  await fs.mkdir(legacyRoot)
  await fs.writeFile(path.join(legacyRoot, 'sentinel'), 'untouched')
  const defaultRoot = path.join(os.homedir(), '.cai-tools')
  const defaultRootBefore = await fs.stat(defaultRoot).then(
    () => true,
    () => false
  )
  // 安装器和自动重启进程必须继承隔离目录，不能写入默认账户的数据根。
  process.env.ZTOOLS_DATA_ROOT = dataRoot
  process.env.ZTOOLS_LEGACY_USER_DATA_PATH = legacyRoot
  process.env.ZTOOLS_E2E = '1'
  delete process.env.ZTOOLS_SETTING_DEV_SERVER_URL
  const report = { baseline, target, root, checks: {}, status: 'running' }
  let application
  try {
    const installer = await downloadInstaller(baseline, root)
    await execute(installer, ['/S', `/D=${installRoot}`], { env: process.env, timeout: 300000 })
    await fs.access(path.join(installRoot, 'resources/.ztools-nsis-installed'))
    await installedProcesses(executable, true)
    const initial = await launchInstalled(executable, dataRoot)
    application = initial.application
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), baseline)
    report.checks.baselineInstalled = true
    const savedSettings = await initial.page.evaluate(async () => {
      const existing = await window.ztools.dbGet('settings-general')
      return window.ztools.dbPut('settings-general', {
        ...(existing || {}),
        autoCheckUpdate: false,
        theme: 'dark',
        upgradeSentinel: 'preserved'
      })
    })
    assert.equal(savedSettings.ok, true)
    const fixture = path.join(root, 'fixture/upgrade-retention')
    await fs.mkdir(fixture, { recursive: true })
    await fs.copyFile(path.resolve('resources/icons/icon.png'), path.join(fixture, 'logo.png'))
    await fs.writeFile(
      path.join(fixture, 'plugin.json'),
      JSON.stringify({
        name: 'upgrade-retention',
        title: 'Upgrade Retention',
        version: '1.0.0',
        main: 'index.html',
        preload: 'preload.js',
        logo: 'logo.png',
        features: [{ code: 'retention', cmds: ['Upgrade Retention'] }]
      })
    )
    await fs.writeFile(path.join(fixture, 'preload.js'), "'use strict'\n")
    await fs.writeFile(
      path.join(fixture, 'index.html'),
      '<!doctype html><html><body><main>Retention Ready</main></body></html>'
    )
    const config = path.join(fixture, 'plugin.json')
    assert.equal(
      (
        await inPlugin(
          application,
          '/setting/',
          `window.ztools.internal.importDevPlugin(${JSON.stringify(config)})`
        )
      ).success,
      true
    )
    assert.equal(
      (
        await inPlugin(
          application,
          '/setting/',
          "window.ztools.internal.installDevPlugin('upgrade-retention')"
        )
      ).success,
      true
    )
    await launchFixture(application)
    const before = await inPlugin(
      application,
      'upgrade-retention/index.html',
      `(() => {
      const saved = window.ztools.db.put({ _id: 'sentinel', data: { value: 42 } })
      window.ztools.dbStorage.setItem('survival', { value: 'persisted' })
      const attachment = window.ztools.db.postAttachment('attachment', new Uint8Array([1, 2, 3, 255]), 'application/octet-stream')
      return { saved, attachment }
    })()`
    )
    assert.equal(before.saved.ok, true)
    assert.equal(before.attachment.ok, true)
    const checked = await initial.page.evaluate(() => window.ztools.updater.checkUpdate())
    assert.equal(checked.success, true)
    assert.equal(checked.latestVersion, target)
    assert.equal(checked.updateInfo.sources[0].feedUrl, `${repository}/releases`)
    report.checks.realGitHubCheck = true
    const updateWindow = await waitFor(() =>
      application.windows().find((win) => win.url().includes('updater.html'))
    )
    await updateWindow.locator('.changelog').filter({ hasText: 'CAI.Tools' }).waitFor()
    await updateWindow.screenshot({ path: path.join(output, 'before-download.png') })
    let baselineExited = false
    application.process().once('exit', () => {
      baselineExited = true
    })
    // 首次真实下载立即取消，确认应用仍停留在基线版本且能够重新开始下载。
    await updateWindow.getByRole('button', { name: '下载并安装' }).click()
    await updateWindow.getByRole('button', { name: '取消下载' }).click()
    await updateWindow.getByRole('button', { name: '下载并安装' }).waitFor()
    assert.equal(baselineExited, false)
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), baseline)
    report.checks.realDownloadCancelledAndRetryOffered = true
    await updateWindow.getByRole('button', { name: '下载并安装' }).click()
    // 只观察真实安装包替换；不修改更新器、下载事件或安装 API。
    await waitFor(async () => {
      if (!baselineExited && !updateWindow.isClosed()) {
        const errorStatus = updateWindow.locator('.update-status.error')
        if (await errorStatus.isVisible()) {
          throw Object.assign(new Error(`Updater error: ${await errorStatus.textContent()}`), {
            fatal: true
          })
        }
      }
      const pkg = JSON.parse(
        asar.extractFile(path.join(installRoot, 'resources/app.asar'), 'package.json').toString()
      )
      return pkg.version === target
    }, 600000)
    report.checks.installerReplacedApplication = true
    await waitFor(() => baselineExited)
    report.checks.baselineExitedForInstall = true
    await waitFor(async () => (await installedProcesses(executable)).length > 0)
    report.checks.autoRestartObserved = true
    // 记录自动启动后结束本次临时应用，再通过调试连接重新打开进行确定性回读。
    await installedProcesses(executable, true)
    application = undefined
    const upgraded = await launchInstalled(executable, dataRoot)
    application = upgraded.application
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), target)
    const settings = await upgraded.page.evaluate(() => window.ztools.dbGet('settings-general'))
    assert.equal(settings.upgradeSentinel, 'preserved')
    assert.equal(settings.autoCheckUpdate, false)
    assert.equal(settings.theme, 'dark')
    const plugin = await launchFixture(application)
    assert.equal(plugin.name, 'upgrade-retention__dev')
    const restored = await inPlugin(
      application,
      'upgrade-retention/index.html',
      `({ document: window.ztools.db.get('sentinel'), storage: window.ztools.dbStorage.getItem('survival'), bytes: Array.from(window.ztools.db.getAttachment('attachment')) })`
    )
    assert.deepEqual(restored.document.data, { value: 42 })
    assert.deepEqual(restored.storage, { value: 'persisted' })
    assert.deepEqual(restored.bytes, [1, 2, 3, 255])
    assert.equal(await fs.readFile(path.join(legacyRoot, 'sentinel'), 'utf8'), 'untouched')
    assert.equal(
      await fs.stat(defaultRoot).then(
        () => true,
        () => false
      ),
      defaultRootBefore
    )
    const rechecked = await upgraded.page.evaluate(() => window.ztools.updater.checkUpdate())
    assert.equal(rechecked.success, true)
    assert.equal(rechecked.hasUpdate, false)
    report.checks.settingsPreserved = true
    report.checks.pluginAndLmdbAttachmentPreserved = true
    report.checks.dataRootAndInstallDirectoryPreserved = true
    report.checks.sameVersionNotOffered = true
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack || error.message
    throw error
  } finally {
    await application?.close().catch(() => {})
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}

module.exports = { assertHostedWindows, validateVersion }
if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
