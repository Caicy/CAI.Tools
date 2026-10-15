/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node 直接运行 JavaScript，返回类型写在 JSDoc 中。 */
import { _electron as electron, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const minutesArg = process.argv.find((arg) => arg.startsWith('--minutes='))
const minutes = minutesArg ? Number(minutesArg.split('=')[1]) : 35
if (!Number.isFinite(minutes) || minutes < 0)
  throw new Error('--minutes must be a non-negative number')
const installMarket = process.argv.includes('--market-install')
const runId = `local-runtime-${Date.now()}`
const output = path.resolve(projectRoot, 'test-results/local-runtime', runId)
const screenshotOutput = path.resolve(projectRoot, 'test-results/playwright', runId)
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-runtime-audit-'))
const logPath = path.join(output, 'network.jsonl')
const settingsUrl = 'http://127.0.0.1:15177'
let electronApp
let electronProcess
let devServer
let heartbeat
let probeServer
let phase = 'starting'
let idleStartedAt
const status = { output, screenshotOutput, minutes, installMarket, tempRoot, result: 'running' }
await fs.mkdir(output, { recursive: true })
await fs.mkdir(path.join(tempRoot, 'legacy'))
await fs.writeFile(logPath, '')

/**
 * 将可回读的观察进度写入文件，避免长观察依赖终端连接。
 * @returns {Promise<void>} 写入完成后的 Promise。
 */
async function writeStatus() {
  await fs.writeFile(
    path.join(output, 'status.json'),
    JSON.stringify(
      {
        ...status,
        phase,
        updatedAt: new Date().toISOString(),
        idleStartedAt,
        elapsedIdleSeconds: idleStartedAt
          ? ((status.idleEndedAt ? Date.parse(status.idleEndedAt) : Date.now()) -
              Date.parse(idleStartedAt)) /
            1000
          : 0
      },
      null,
      2
    )
  )
}

/**
 * 给外部操作设置失败边界，超时后交由 finally 关闭本工具拥有的进程。
 * @param {Promise<unknown>} operation 已开始的异步操作。
 * @param {number} milliseconds 最大等待毫秒数。
 * @param {string} label 操作名称，不包含请求内容。
 * @returns {Promise<unknown>} 操作结果。
 * @throws 操作失败或超过时限时抛错。
 */
async function bounded(operation, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 等待完整静置时长，应用提前退出时立即失败。
 * @param {number} milliseconds 静置时长。
 * @returns {Promise<void>} 完整观察结束后的 Promise。
 * @throws 应用在观察期间退出时抛错。
 */
async function observeIdle(milliseconds) {
  let timer
  let onClose
  try {
    await new Promise((resolve, reject) => {
      onClose = () => reject(new Error('Electron exited during passive observation'))
      electronApp.on('close', onClose)
      timer = setTimeout(resolve, milliseconds)
      if (electronProcess.exitCode !== null) onClose()
    })
    // 定时器走完还需确认主进程和设置正文存活，避免空观察产生通过状态。
    expect(await inSettings('document.body.innerText')).toContain('开机自动启动')
  } finally {
    clearTimeout(timer)
    electronApp.off('close', onClose)
  }
}

/**
 * 在真实设置插件中调用公开的内部接口。
 * @param {string} script 受控页面脚本。
 * @returns {Promise<unknown>} 页面执行结果。
 */
async function inSettings(script) {
  return bounded(
    electronApp.evaluate(async ({ webContents }, source) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith('http://127.0.0.1:15177'))
      if (!contents || contents.isLoading()) return null
      return contents.executeJavaScript(source)
    }, script),
    120_000,
    'Settings operation'
  )
}

/**
 * 读取只含网络目标元数据的完整观察日志。
 * @returns {Promise<object[]>} 已落盘事件。
 */
async function readEvents() {
  return (await fs.readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

try {
  const builtEntry = await fs.readFile(path.join(projectRoot, 'out/main/index.js'))
  status.builtEntrySha256 = crypto.createHash('sha256').update(builtEntry).digest('hex')
  status.builtMainFiles = {}
  for (const file of await fs.readdir(path.join(projectRoot, 'out/main'), { recursive: true })) {
    if (file.endsWith('.js'))
      status.builtMainFiles[file] = crypto
        .createHash('sha256')
        .update(await fs.readFile(path.join(projectRoot, 'out/main', file)))
        .digest('hex')
  }
  status.buildRequirement =
    'Run pnpm exec electron-vite build immediately before this script; no packaging'
  await writeStatus()
  console.log(`AUDIT_OUTPUT=${output}`)
  // 独立启动可直接终止的 Vite 子进程，不复用可能属于其它测试的端口。
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
  devServer = spawn(
    process.execPath,
    [vite, '--host', '127.0.0.1', '--port', '15177', '--strictPort'],
    { cwd: path.join(projectRoot, 'internal-plugins/setting'), windowsHide: true, stdio: 'ignore' }
  )
  await expect
    .poll(
      async () => {
        if (devServer.exitCode !== null)
          throw new Error('Settings server exited; port may already be occupied')
        return fetch(settingsUrl)
          .then((response) => response.ok)
          .catch(() => false)
      },
      { timeout: 120_000 }
    )
    .toBe(true)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined)
  )
  delete env.ZTOOLS_E2E
  delete env.NODE_OPTIONS
  electronApp = await electron.launch({
    args: ['-r', path.join(projectRoot, 'scripts/local-runtime-network-hook.cjs'), projectRoot],
    cwd: projectRoot,
    env: {
      ...env,
      ZTOOLS_DATA_ROOT: path.join(tempRoot, 'data'),
      ZTOOLS_LEGACY_USER_DATA_PATH: path.join(tempRoot, 'legacy'),
      ZTOOLS_SETTING_DEV_SERVER_URL: settingsUrl,
      CAI_RUNTIME_AUDIT_LOG: logPath
    },
    timeout: 120_000
  })
  electronProcess = electronApp.process()
  const initialized = (await readEvents()).find((event) => event.source === 'audit.initialized')
  expect(initialized).toMatchObject({ e2e: null, businessLoaded: false })
  status.hookBeforeBusiness = true
  const isolation = await electronApp.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    data: process.env.ZTOOLS_DATA_ROOT,
    legacy: process.env.ZTOOLS_LEGACY_USER_DATA_PATH,
    e2e: process.env.ZTOOLS_E2E || null
  }))
  expect(isolation).toEqual({
    userData: path.join(tempRoot, 'data'),
    data: path.join(tempRoot, 'data'),
    legacy: path.join(tempRoot, 'legacy'),
    e2e: null
  })
  status.isolation = isolation
  const page = await electronApp.firstWindow()
  // 普通模式不强制显示窗口；由观察控制器显式展示，不修改应用业务分支。
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await expect(page.locator('.search-input')).toBeVisible({ timeout: 120_000 })
  await page.locator('.search-input').fill('通用设置')
  await page.locator('.app-item, .list-item').filter({ hasText: '通用设置' }).first().click()
  await expect
    .poll(() => inSettings('document.body.innerText'), { timeout: 120_000 })
    .toContain('开机自动启动')

  // 本机自检逐一覆盖 Node、Electron net 与新会话，不能用“空日志”冒充断网证据。
  phase = 'self-check'
  probeServer = http.createServer((_request, response) => response.end('ok'))
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
  const probeUrl = `http://127.0.0.1:${probeServer.address().port}`
  await bounded(
    electronApp.evaluate(async (_electron, base) => globalThis.__caiAuditSelfCheck(base), probeUrl),
    30_000,
    'Network self-check'
  )
  const events = await readEvents()
  const sources = [
    'node.fetch',
    'node.http.get',
    'node.http.request',
    'node.https.get',
    'node.https.request',
    'electron.net.fetch',
    'electron.net.request',
    'session.webRequest'
  ]
  for (const source of sources)
    expect(
      events.some((event) => event.source === source && event.origin?.includes('127.0.0.1')),
      source
    ).toBe(true)
  expect(
    events.some((event) => event.source === 'session.webRequest' && event.path === '/new-session')
  ).toBe(true)
  expect(await fs.readFile(logPath, 'utf8')).not.toContain('must-not-be-logged')
  status.selfCheckSources = sources
  phase = 'idle'
  idleStartedAt = new Date().toISOString()
  await writeStatus()
  heartbeat = setInterval(() => void writeStatus(), 10_000)
  console.log(`IDLE_STARTED=${idleStartedAt}`)
  await observeIdle(minutes * 60_000)
  clearInterval(heartbeat)
  heartbeat = undefined
  const idleEndedAt = new Date().toISOString()
  const passiveEvents = await readEvents()
  const external = passiveEvents.filter(
    (event) =>
      event.origin &&
      !['null'].includes(event.origin) &&
      !/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(event.origin) &&
      !/^wss?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(event.origin)
  )
  status.idleEndedAt = idleEndedAt
  status.passiveExternalRequests = external
  status.passiveObservation = {
    startedAt: idleStartedAt,
    endedAt: idleEndedAt,
    durationSeconds: (Date.parse(idleEndedAt) - Date.parse(idleStartedAt)) / 1000,
    passed: external.length === 0,
    fullDuration: Date.parse(idleEndedAt) - Date.parse(idleStartedAt) >= 35 * 60_000
  }
  await writeStatus()
  expect(external, '启动、设置通用页及静置期间出现非本机请求').toEqual([])

  // 观察结束后才进行用户主动允许的市场与上游查询。
  phase = 'active-allowed-network'
  await writeStatus()
  const market = await inSettings('window.ztools.internal.fetchPluginMarket()')
  status.market = {
    success: Array.isArray(market) || market?.success === true,
    count: Array.isArray(market) ? market.length : market?.data?.length
  }
  expect(status.market.success).toBe(true)
  const upstream = await inSettings('window.ztools.internal.checkUpstreamUpdate()')
  status.upstream = upstream
  expect(['available', 'up-to-date', 'unavailable']).toContain(upstream.kind)
  if (installMarket) {
    const installed = await inSettings(
      `window.ztools.internal.installPluginFromMarket({ name: 'code-snippets', version: '1.2.0' })`
    )
    expect(installed.success, JSON.stringify(installed)).toBe(true)
    const plugins = await inSettings('window.ztools.internal.getAllPlugins()')
    const plugin = plugins.find((item) => item.name === 'code-snippets')
    expect(plugin).toBeTruthy()
    expect(plugin.version).toBe('1.2.0')
    status.installedPlugin = { name: plugin.name, version: plugin.version, opened: false }
    await writeStatus()
    const launch = await inSettings(
      `window.ztools.internal.launch(${JSON.stringify({ path: plugin.path, type: 'plugin', name: plugin.title || plugin.name, param: { payload: '', type: 'text', code: plugin.features?.[0]?.code || 'code-snippets' } })})`
    )
    expect(launch.success).toBe(true)
    await expect
      .poll(
        () =>
          electronApp.evaluate(async ({ webContents }) => {
            const plugin = webContents
              .getAllWebContents()
              .find((item) => item.getURL().includes('code-snippets'))
            return plugin?.executeJavaScript('document.body?.innerText || ""') || ''
          }),
        { timeout: 120_000 }
      )
      .toContain('暂无模板，点击新建添加')
    const png = await electronApp.evaluate(async ({ webContents }) =>
      (
        await webContents
          .getAllWebContents()
          .find((item) => item.getURL().includes('code-snippets'))
          .capturePage()
      )
        .toPNG()
        .toString('base64')
    )
    await fs.mkdir(screenshotOutput, { recursive: true })
    await fs.writeFile(path.join(screenshotOutput, 'market-plugin.png'), Buffer.from(png, 'base64'))
    status.installedPlugin = { name: plugin.name, version: plugin.version, opened: true }
  }
  status.result = status.passiveObservation.fullDuration
    ? 'passed-35-minute-observation'
    : 'passed-smoke-only'
} catch (error) {
  status.result = 'failed'
  status.error = String(error)
  process.exitCode = 1
} finally {
  await writeStatus()
  // 强制退出仅属于本脚本的隔离实例，绕过普通关闭隐藏窗口的行为；不终止用户进程。
  clearInterval(heartbeat)
  if (electronApp) {
    const closed = electronApp.waitForEvent('close', { timeout: 15_000 }).catch(() => {})
    await electronApp
      .evaluate(({ app, globalShortcut }) => {
        globalShortcut.unregisterAll()
        app.exit(0)
      })
      .catch(() => {})
    await closed
    if (electronProcess.exitCode === null) electronProcess.kill()
  }
  devServer?.kill()
  probeServer?.closeAllConnections()
  if (probeServer) await new Promise((resolve) => probeServer.close(resolve))
  await fs
    .rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    .catch((error) => {
      status.cleanupError = String(error)
    })
  phase = 'complete'
  await writeStatus()
  console.log(JSON.stringify(status, null, 2))
}
