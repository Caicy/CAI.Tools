import { describe, expect, it, vi } from 'vitest'
import { NsisUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'

/**
 * 使用实际 electron-updater 和隔离适配器建立版本策略测试实例。
 * @param version 模拟已安装版本。
 * @returns 禁止下载和降级的真实 NSIS 更新器。
 */
function updaterFor(version: string): NsisUpdater {
  const updater = new NsisUpdater(undefined, {
    version,
    name: 'CAI.Tools',
    isPackaged: true
  } as AppAdapter)
  updater.channel = 'local'
  updater.allowPrerelease = true
  updater.allowDowngrade = false
  updater.autoDownload = false
  return updater
}

describe('installed electron-updater local channel behavior', () => {
  it.each([
    ['3.2.0-local.9', '3.2.0-local.10', true],
    ['3.2.0-local.10', '3.2.0-local.9', false],
    ['3.2.0-local.10', '3.2.0-local.10', false]
  ])('compares %s -> %s using real SemVer', async (current, next, available) => {
    const updater = updaterFor(current)
    // 只测试依赖内的版本策略，不读真实设备 staging 标识。
    updater.isUserWithinRollout = async () => true
    expect(await (updater as any).isUpdateAvailable({ version: next })).toBe(available)
  })

  it('uses the own-repo local.yml even when a newer upstream-style stable tag is in the Atom feed', async () => {
    const request = vi.fn(async (options) => {
      if (options.path.endsWith('.atom'))
        return `<?xml version="1.0"?><feed>
        <entry><title>stable</title><link href="https://github.com/Caicy/CAI.Tools/releases/tag/v99.0.0"/></entry>
        <entry><title>local</title><link href="https://github.com/Caicy/CAI.Tools/releases/tag/v3.2.0-local.10"/></entry>
      </feed>`
      return 'version: 3.2.0-local.10\nfiles:\n  - url: CAI.Tools-setup.exe\n    sha512: fixture\n    size: 123\n'
    })
    const provider = new GitHubProvider(
      { provider: 'github', owner: 'Caicy', repo: 'CAI.Tools' },
      updaterFor('3.2.0-local.9'),
      {
        platform: 'win32',
        isUseMultipleRangeRequest: false,
        executor: { request } as unknown as ElectronHttpExecutor
      }
    )
    const update = await provider.getLatestVersion()
    expect(update.version).toBe('3.2.0-local.10')
    expect(request.mock.calls[1][0].path).toBe(
      '/Caicy/CAI.Tools/releases/download/v3.2.0-local.10/local.yml'
    )
    expect(provider.resolveFiles(update)[0].url.toString()).toBe(
      'https://github.com/Caicy/CAI.Tools/releases/download/v3.2.0-local.10/CAI.Tools-setup.exe'
    )
    expect(request.mock.calls.every(([options]) => options.hostname === 'github.com')).toBe(true)
  })
})
