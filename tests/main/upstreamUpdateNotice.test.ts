import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  fetch: vi.fn(),
  openExternal: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: mocks, shell: { openExternal: mocks.openExternal } }))

let tempRoot: string
let notice: typeof import('../../src/main/core/localEdition/upstreamUpdateNotice')
let localUpdater: (typeof import('../../src/main/api/localUpdater'))['default']
const releaseUrl = 'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0'

/**
 * 查找真实兼容层注册的唯一 IPC 入口，重复注册同样判为失败。
 * @param mode 异步请求或旧式事件。
 * @param channel 需要调用的通道。
 * @returns 对应处理函数。
 */
function handler(mode: 'handle' | 'on', channel: string): (...args: any[]) => any {
  const matches = mocks[mode].mock.calls.filter(([registered]) => registered === channel)
  expect(matches).toHaveLength(1)
  return matches[0][1]
}

/**
 * 准备 GitHub 最新稳定版接口的有效响应。
 * @param overrides 用于验证不可信字段的响应覆盖项。
 * @returns 无返回值。
 */
function respond(overrides: Record<string, unknown> = {}): void {
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v3.3.0',
      html_url: releaseUrl,
      draft: false,
      prerelease: false,
      ...overrides
    })
  })
}

beforeEach(async () => {
  // 在导入实际模块前隔离数据路径，防止未来依赖变动影响个人数据。
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-upstream-notice-'))
  vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(tempRoot, 'data'))
  vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(tempRoot, 'legacy'))
  vi.resetAllMocks()
  vi.resetModules()
  vi.stubGlobal('fetch', mocks.fetch)
  vi.useFakeTimers()
  notice = await import('../../src/main/core/localEdition/upstreamUpdateNotice')
  localUpdater = (await import('../../src/main/api/localUpdater')).default
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('upstream stable version notice', () => {
  it('compares each safe numeric component and excludes the local suffix', () => {
    expect(notice.parseStableVersion('v3.2.0')).toEqual([3, 2, 0])
    expect(notice.parseStableVersion('9007199254740991.0.0')).toEqual([
      Number.MAX_SAFE_INTEGER,
      0,
      0
    ])
    for (const [candidate, baseline, expected] of [
      ['3.10.0', '3.9.9', true],
      ['4.0.0', '3.999.999', true],
      ['3.2.1', '3.2.0', true],
      ['v3.2.0', '3.2.0', false],
      ['3.1.999', '3.2.0', false]
    ] as const) {
      expect(notice.isNewerStableVersion(candidate, baseline)).toBe(expected)
    }
    for (const invalid of [
      '3.2.0-local.1',
      '3.2.0-rc.1',
      '3.2.0+build',
      '3.2',
      'V3.2.0',
      ' 3.2.0',
      '3.2.0\n',
      '-1.2.3',
      '9007199254740992.0.0',
      '3.9007199254740992.0',
      '3.2.9007199254740992'
    ]) {
      expect(() => notice.parseStableVersion(invalid)).toThrow('INVALID_STABLE_VERSION')
    }
    expect(() => notice.isNewerStableVersion('3.3.0', '3.2.0-local.1')).toThrow(
      'INVALID_STABLE_VERSION'
    )
  })

  it('does not fetch or schedule timers on import, init, auto-check enable or cleanup', async () => {
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    localUpdater.init({} as any)
    localUpdater.init({} as any)
    expect(localUpdater.setAutoCheck(true)).toEqual({ success: true, enabled: false })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    localUpdater.cleanup()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(handler('handle', 'local-edition:get-info')({})).toEqual({
      product: 'CAI.Tools',
      upstreamBase: '3.2.0',
      officialAccount: false,
      cloudSync: false
    })
  })

  it('fetches only the fixed GitHub endpoint when the user checks and returns release metadata', async () => {
    respond()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    localUpdater.init({} as any)
    expect(await handler('handle', 'local-edition:check-upstream')({})).toEqual({
      kind: 'available',
      version: '3.3.0',
      releaseUrl
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/ZToolsCenter/ZTools/releases/latest',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) })
    )
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it.each(['3.2.0', '3.1.9'])(
    'reports upstream %s as up-to-date against the upstream baseline',
    async (version) => {
      respond({
        tag_name: version,
        html_url: `https://github.com/ZToolsCenter/ZTools/releases/tag/${version}`
      })
      expect(await notice.checkUpstreamUpdate()).toMatchObject({ kind: 'up-to-date', version })
    }
  )

  it('preserves the old explicit check contract without opening an updater window', async () => {
    respond()
    localUpdater.init({} as any)
    expect(await handler('handle', 'updater:check-update')({})).toMatchObject({
      success: true,
      updateAvailable: true,
      hasUpdate: true,
      updateInfo: { version: '3.3.0', releaseUrl }
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it.each([403, 429, 500])('returns unavailability for HTTP %s', async (status) => {
    mocks.fetch.mockResolvedValue({ ok: false, status })
    expect(await notice.checkUpstreamUpdate()).toMatchObject({
      kind: 'unavailable',
      message: expect.any(String)
    })
    expect(await localUpdater.checkUpdate()).toMatchObject({
      success: false,
      updateAvailable: false,
      hasUpdate: false
    })
  })

  it.each(['TimeoutError', 'AbortError', 'TypeError'])(
    'returns unavailability for %s',
    async (name) => {
      mocks.fetch.mockRejectedValue(Object.assign(new Error('request failed'), { name }))
      expect(await notice.checkUpstreamUpdate()).toMatchObject({
        kind: 'unavailable',
        message: expect.any(String)
      })
    }
  )

  it.each([
    { draft: true },
    { prerelease: true },
    { draft: undefined },
    { tag_name: 'v3.3.0-rc.1' },
    { tag_name: '3.2.0-local.1' },
    { tag_name: '9007199254740992.0.0' },
    { tag_name: null },
    { html_url: 'https://attacker.example/release' },
    { html_url: 'https://github.com/ZToolsCenter/ZTools/releases/download/v3.3.0/setup.exe' },
    { html_url: 'https://github.com/ZToolsCenter/ZTools/releases/tag/v9.0.0' }
  ])('rejects untrusted release metadata %j', async (fields) => {
    respond(fields)
    expect(await notice.checkUpstreamUpdate()).toMatchObject({ kind: 'unavailable' })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('returns unavailability when JSON is malformed', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('invalid json')
      }
    })
    expect(await notice.checkUpstreamUpdate()).toMatchObject({ kind: 'unavailable' })
  })

  it('covers every legacy handler/event and blocks installation, download and old windows', async () => {
    localUpdater.init({} as any)
    const source = fs.readFileSync(path.resolve('src/main/api/updater.ts'), 'utf8')
    const oldChannels = [...source.matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)]
    expect(oldChannels).toHaveLength(11)
    for (const [, mode, channel] of oldChannels) {
      const call = handler(mode as 'handle' | 'on', channel)
      if (channel === 'updater:check-update') continue
      if (mode === 'on') {
        // sendSync 读取事件字段；普通 send 不接收监听器的 JavaScript 返回值。
        const event = { returnValue: undefined }
        expect(call(event, 1)).toBeUndefined()
        expect(event.returnValue).toMatchObject({
          success: false,
          code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
        })
        continue
      }
      const result = await call({}, 1)
      if (channel === 'updater:get-download-status') {
        expect(result).toMatchObject({ status: 'idle', hasDownloaded: false, hasUpdate: false })
      } else {
        expect(result).toMatchObject({ success: false, code: 'OFFICIAL_CAPABILITY_UNAVAILABLE' })
      }
    }
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.handle.mock.calls.some(([channel]) => channel.startsWith('internal:'))).toBe(false)
  })

  it.each([
    'http://github.com/ZToolsCenter/ZTools/releases/latest',
    'https://github.com.evil.example/ZToolsCenter/ZTools/releases/latest',
    'https://user:pass@github.com/ZToolsCenter/ZTools/releases/latest',
    'https://github.com:444/ZToolsCenter/ZTools/releases/latest',
    'https://github.com/Other/ZTools/releases/latest',
    'https://github.com/ZToolsCenter/ZTools/releases/download/v3.3.0/setup.exe',
    'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0/attachment.exe',
    'https://github.com/ZToolsCenter/ZTools/releases/tag/v3.3.0-rc.1',
    'https://github.com/ZToolsCenter/ZTools/releases/tag/9007199254740992.0.0',
    'https://github.com/ZToolsCenter/ZTools/releases/latest?next=https://evil.example',
    'https://github.com/ZToolsCenter/ZTools/releases/latest#download',
    'https://github.com/ZToolsCenter/ZTools/releases/tag/%2e%2e/latest',
    'file:///tmp/setup.exe',
    '',
    null,
    { url: releaseUrl }
  ])('independently rejects renderer-provided URL %j before opening it', async (url) => {
    localUpdater.init({} as any)
    expect(await handler('handle', 'local-edition:open-upstream-release')({}, url)).toMatchObject({
      success: false,
      code: 'INVALID_UPSTREAM_RELEASE_URL'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([releaseUrl, 'https://github.com/ZToolsCenter/ZTools/releases/latest'])(
    'opens approved release page %s only after user IPC',
    async (url) => {
      localUpdater.init({} as any)
      expect(await handler('handle', 'local-edition:open-upstream-release')({}, url)).toEqual({
        success: true
      })
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url)
      expect(mocks.fetch).not.toHaveBeenCalled()
    }
  )

  it('reports browser launch failures without starting installation or fetching', async () => {
    mocks.openExternal.mockRejectedValue(new Error('no browser'))
    localUpdater.init({} as any)
    expect(
      await handler('handle', 'local-edition:open-upstream-release')({}, releaseUrl)
    ).toMatchObject({ success: false })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
