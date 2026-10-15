import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import ts from 'typescript'

const ipc = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  httpRequest: vi.fn(),
  fetch: vi.fn(),
  openExternal: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: ipc,
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: () => '3.2.0-local.1' },
  net: { fetch: ipc.fetch },
  shell: { openExternal: ipc.openExternal }
}))
vi.mock('../../src/main/utils/httpRequest', () => ({ httpRequest: ipc.httpRequest }))
vi.mock('../../src/main/core/pluginWindowManager', () => ({
  default: { getPluginNameByWebContentsId: () => null }
}))

let tempRoot: string
const managers: Array<{ close: () => void }> = []

/**
 * 读取仓库内源文件，不执行其顶层副作用。
 * @param relativePath 仓库相对路径。
 * @returns UTF-8 源代码。
 */
function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

/**
 * 查找模拟 IPC 注册器中的唯一处理器，重复注册立即使测试失败。
 * @param mode 同步事件或异步请求。
 * @param channel 原有 IPC 通道。
 * @returns 注册的处理器。
 */
function handler(mode: 'on' | 'handle', channel: string): (...args: any[]) => any {
  const matches = ipc[mode].mock.calls.filter(([registered]) => registered === channel)
  expect(matches).toHaveLength(1)
  return matches[0][1]
}

/**
 * 收集运行时可达的本地模块，使用编译结果排除纯类型依赖。
 * @param entry 启动文件的仓库相对路径。
 * @returns 启动链可加载的模块绝对路径集合。
 */
function reachableModules(entry: string): Set<string> {
  const visited = new Set<string>()
  const pending = [path.resolve(entry)]
  while (pending.length) {
    const filename = pending.pop()!
    if (visited.has(filename)) continue
    visited.add(filename)
    // 只跟踪编译后的真实导入，避免把类型声明误判为运行时实例化。
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename
    }).outputText
    for (const match of compiled.matchAll(/(?:require\(|import\()['"]([^'"]+)['"]\)/g)) {
      const specifier = match[1]
      if (!specifier.startsWith('.') && !specifier.startsWith('@shared/')) continue
      const base = specifier.startsWith('@shared/')
        ? path.resolve('src/shared', specifier.slice('@shared/'.length))
        : path.resolve(path.dirname(filename), specifier)
      const stem = base.replace(/\.js$/, '')
      const resolved = [stem + '.ts', stem + '.js', path.join(stem, 'index.ts')].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      )
      if (resolved) pending.push(resolved)
    }
  }
  return visited
}

beforeEach(() => {
  // 所有动态模块必须在唯一的数据目录和旧数据目录设置完成后加载。
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-local-capabilities-'))
  vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(tempRoot, 'data'))
  vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(tempRoot, 'legacy'))
  vi.stubGlobal('fetch', ipc.fetch)
  vi.clearAllMocks()
  vi.resetModules()
})

afterEach(() => {
  // 释放真实 LMDB 句柄后才移除本测试创建的目录。
  for (const manager of managers.splice(0)) manager.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('local capability compatibility boundary', () => {
  it('keeps getUser synchronous and rejects token/payment through the real dispatcher with zero HTTP', async () => {
    const { initPluginApiDispatcher } =
      await import('../../src/main/api/plugin/pluginApiDispatcher')
    const { registerLocalUserCapabilities } =
      await import('../../src/main/api/plugin/localUserCapabilities')
    initPluginApiDispatcher()
    registerLocalUserCapabilities()
    const event = { returnValue: undefined, sender: { id: 1 } }
    handler('on', 'plugin.api')(event, 'getUser')
    expect(event.returnValue).toBeNull()
    for (const name of ['getUserTempToken', 'requestPayment', 'getPaymentRecords']) {
      await expect(handler('handle', 'plugin.api')(event, name, {})).rejects.toThrow(
        'OFFICIAL_CAPABILITY_UNAVAILABLE'
      )
    }
    expect(ipc.httpRequest).not.toHaveBeenCalled()
    expect(ipc.fetch).not.toHaveBeenCalled()
    expect(ipc.openExternal).not.toHaveBeenCalled()
  })

  it('covers every old account/sync channel and keeps local database writes functional', async () => {
    const { registerLocalCapabilities } =
      await import('../../src/main/api/renderer/localCapabilities')
    registerLocalCapabilities()
    const oldChannels = [
      ...source('src/main/api/renderer/sync.ts').matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)
    ].map((match) => ({ mode: match[1] as 'handle' | 'on', channel: match[2] }))
    expect(oldChannels.length).toBeGreaterThan(40)
    const preloadChannels = [
      ...source('resources/preload.js').matchAll(
        /ipcRenderer\.(invoke|sendSync|send)\(\s*'((?:account|sync):[^']+)'/g
      )
    ].map((match) => match[2])
    for (const { mode, channel } of oldChannels) {
      const result = await handler(mode, channel)({ sender: { id: 1 } }, { token: 'ignored' })
      if (channel === 'account:get-session') expect(result).toBeNull()
      else expect(result).toMatchObject({ success: false, code: 'OFFICIAL_CAPABILITY_UNAVAILABLE' })
    }
    for (const channel of preloadChannels)
      expect(oldChannels.some((old) => old.channel === channel)).toBe(true)
    const { storageManager } = await import('../../src/main/core/lmdb/lmdbInstance')
    managers.push(storageManager)
    const { default: database } = await import('../../src/main/api/shared/database')
    database.init({ getPluginInfoByWebContents: () => null } as any)
    const event = { sender: { id: 1 } }
    expect(
      await handler('handle', 'db:put')(event, { _id: 'local-test', data: { value: 42 } })
    ).toMatchObject({ ok: true })
    expect(await handler('handle', 'db:get')(event, 'local-test')).toMatchObject({
      data: { value: 42 }
    })
    expect(storageManager.getCurrentAccountUid()).toBeNull()
    expect(ipc.httpRequest).not.toHaveBeenCalled()
    expect(ipc.fetch).not.toHaveBeenCalled()
  })

  it('does not probe legacy paths and refuses the legacy import entry', async () => {
    const { storageManager } = await import('../../src/main/core/lmdb/lmdbInstance')
    managers.push(storageManager)
    const exists = vi.spyOn(fs, 'existsSync')
    const { StorageAPI } = await import('../../src/main/api/renderer/storage')
    new StorageAPI().init()
    const state = await handler('handle', 'storage:get-init-state')({})
    expect(state).toMatchObject({
      success: true,
      legacy: { legacyLmdbFound: false, shouldPrompt: false }
    })
    expect(await handler('handle', 'storage:import-legacy')({}, { mode: 'full' })).toMatchObject({
      success: false,
      code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
    })
    expect(
      exists.mock.calls.some(([target]) => String(target).startsWith(path.join(tempRoot, 'legacy')))
    ).toBe(false)
  })

  it('keeps internal sender checks and routes only authorized version checks through the local facade', async () => {
    const { unavailableOfficialCapability } = await import('../../src/shared/localEdition')
    const { default: localUpdater } = await import('../../src/main/api/localUpdater')
    const compiled = ts.transpileModule(source('src/main/api/plugin/internal.ts'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText
    const exports: Record<string, any> = {}
    const imported: string[] = []
    // 对外围服务使用惰性替身，只执行实际 IPC 注册与权限逻辑。
    vm.runInNewContext(compiled, {
      exports,
      require: (specifier: string) => {
        imported.push(specifier)
        if (specifier === 'electron') return { ipcMain: ipc }
        if (specifier.includes('localEdition')) return { unavailableOfficialCapability }
        if (specifier === '../localUpdater') return { default: localUpdater }
        return { default: {} }
      }
    })
    const manager = {
      getPluginInfoByWebContents: (sender: { trusted: boolean }) => ({
        canUseInternalApi: sender.trusted
      })
    }
    new exports.InternalPluginAPI().init({}, manager)
    const channels = [
      'notification-summary',
      'notification-list',
      'notification-mark-read',
      'notification-mark-all-read',
      'notification-archive',
      'updater-check-update',
      'updater-start-update',
      'updater-set-auto-check'
    ]
    for (const suffix of channels) {
      const call = handler('handle', 'internal:' + suffix)
      await expect(call({ sender: { trusted: false } })).rejects.toThrow('仅限内置插件调用')
    }
    expect(ipc.fetch).not.toHaveBeenCalled()
    for (const suffix of channels.filter((channel) => channel.startsWith('notification-'))) {
      const call = handler('handle', 'internal:' + suffix)
      expect(await call({ sender: { trusted: true } })).toMatchObject({
        success: false,
        code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
      })
    }
    expect(
      await handler('handle', 'internal:updater-start-update')({ sender: { trusted: true } }, 1)
    ).toMatchObject({
      success: false,
      code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
    })
    expect(
      await handler('handle', 'internal:updater-set-auto-check')(
        { sender: { trusted: true } },
        true
      )
    ).toEqual({
      success: true,
      enabled: false
    })
    expect(ipc.fetch).not.toHaveBeenCalled()
    // 只有已授权的主动检查可请求固定上游接口，返回值不包含官方安装包信息。
    ipc.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v3.3.0',
        html_url: 'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0',
        draft: false,
        prerelease: false
      })
    })
    expect(
      await handler('handle', 'internal:updater-check-update')({ sender: { trusted: true } })
    ).toMatchObject({
      success: true,
      updateAvailable: true,
      hasUpdate: true,
      updateInfo: { version: '3.3.0' }
    })
    expect(ipc.fetch).toHaveBeenCalledTimes(1)
    expect(ipc.httpRequest).not.toHaveBeenCalled()
    expect(ipc.openExternal).not.toHaveBeenCalled()
    expect(imported).toContain('../localUpdater')
    expect(imported.some((specifier) => /notifications|\/updater(?:\.js)?$/.test(specifier))).toBe(
      false
    )
  })

  // 全图需要逐文件编译以过滤类型导入，Windows 实测约 6–8 秒；只为该扫描设置独立上限。
  it('cannot instantiate heartbeat, sync, user/payment or original updater modules from startup imports', () => {
    const reachable = reachableModules('src/main/index.ts')
    for (const forbidden of [
      'src/main/core/activity/heartbeatService.ts',
      'src/main/core/sync/syncClient.ts',
      'src/main/api/renderer/sync.ts',
      'src/main/api/renderer/notifications.ts',
      'src/main/api/plugin/user.ts',
      'src/main/api/plugin/payment.ts',
      'src/main/api/updater.ts',
      'src/main/core/firstRunStorageImport.ts',
      'src/main/core/storage/legacyImportService.ts'
    ])
      expect(reachable.has(path.resolve(forbidden)), forbidden).toBe(false)
    expect(reachable.has(path.resolve('src/main/api/plugin/localUserCapabilities.ts'))).toBe(true)
    expect(reachable.has(path.resolve('src/main/api/renderer/localCapabilities.ts'))).toBe(true)
    // 本机 HTTP/MCP 继续沿用现有启停配置，不在本地版启动修改中移除。
    expect(reachable.has(path.resolve('src/main/core/httpServer.ts'))).toBe(true)
    expect(reachable.has(path.resolve('src/main/core/mcpServer.ts'))).toBe(true)
  }, 20_000)
})
