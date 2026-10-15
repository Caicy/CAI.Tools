import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import LmdbDatabase from '../../src/main/core/lmdb'
import { getZToolsRoot, getZToolsDataLayout } from '../../src/main/core/appData/appDataPaths'
import { hashAccountId, StorageManager } from '../../src/main/core/storage/storageManager'

const electronApp = vi.hoisted(() => ({
  getPath: vi.fn(),
  setPath: vi.fn(),
  setName: vi.fn()
}))
vi.mock('electron', () => ({ app: electronApp }))
const tempRoots: string[] = []
const managers: StorageManager[] = []

/**
 * 准备完全独立的测试 home，避免访问真实用户数据。
 * @returns 临时 home 绝对路径。
 */
function makeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-tools-local-'))
  tempRoots.push(root)
  // 显式 home 与全局环境覆盖必须指向同一用例，避免复用其他测试数据库。
  vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(root, '.cai-tools'))
  vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(root, 'old-user-data'))
  return root
}

beforeEach(() => {
  const homeDir = makeHome()
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
})
afterEach(() => {
  // 先释放 LMDB 文件句柄，再清理本测试拥有的临时目录。
  for (const manager of managers.splice(0)) manager.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CAI.Tools local edition', () => {
  it('declares local product identity and a stable official capability error', async () => {
    const local = await import('../../src/shared/localEdition')
    expect(local.LOCAL_PRODUCT_NAME).toBe('CAI.Tools')
    expect(local.LOCAL_APP_ID).toBe('tools.cai.local')
    expect(local.UPSTREAM_BASE_VERSION).toBe('3.2.0')
    expect(local.LOCAL_DEFAULT_ROOT_NAME).toBe('.cai-tools')
    expect(local.unavailableOfficialCapability('账号登录')).toEqual({
      success: false,
      code: 'OFFICIAL_CAPABILITY_UNAVAILABLE',
      error: '当前本地版不提供官方服务能力：账号登录'
    })
  })

  it('uses isolated default storage and preserves explicit over environment precedence', () => {
    const homeDir = makeHome()
    vi.stubEnv('ZTOOLS_DATA_ROOT', '')
    expect(getZToolsRoot({ homeDir })).toBe(path.join(homeDir, '.cai-tools'))
    vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(homeDir, 'environment'))
    expect(getZToolsRoot({ homeDir })).toBe(path.join(homeDir, 'environment'))
    expect(getZToolsRoot({ homeDir, dataRoot: path.join(homeDir, 'explicit') })).toBe(
      path.join(homeDir, 'explicit')
    )
  })

  it('starts fresh without probing or modifying upstream storage', () => {
    const homeDir = makeHome()
    const upstream = path.join(homeDir, '.ztools')
    const legacy = path.join(homeDir, 'old-user-data')
    fs.mkdirSync(upstream)
    fs.mkdirSync(path.join(legacy, 'lmdb'), { recursive: true })
    const sentinel = path.join(upstream, 'sentinel')
    fs.writeFileSync(sentinel, 'untouched')
    const exists = vi.spyOn(fs, 'existsSync')
    const reads = vi.spyOn(fs, 'readFileSync')
    const manager = new StorageManager({
      homeDir,
      legacyUserDataPath: legacy,
      mapSize: 128 * 1024 * 1024
    })
    managers.push(manager)
    expect(manager.init()).toMatchObject({
      firstRun: true,
      legacyLmdbFound: false,
      importedFromLegacy: false
    })
    manager.getRouter().put({ _id: 'PLUGIN/demo/settings', data: { local: true } })
    expect(
      exists.mock.calls.some(
        ([target]) => String(target).startsWith(upstream) || String(target).startsWith(legacy)
      )
    ).toBe(false)
    expect(
      reads.mock.calls.some(
        ([target]) => String(target).startsWith(upstream) || String(target).startsWith(legacy)
      )
    ).toBe(false)
    expect(fs.readdirSync(upstream)).toEqual(['sentinel'])
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched')
  })

  it('ignores a persisted upstream uid and writes only default business data', () => {
    const homeDir = makeHome()
    const layout = getZToolsDataLayout({ homeDir })
    const uid = 'fake-upstream-account'
    // 模拟设备数据库遗留账号，关闭句柄后才启动被测存储层。
    fs.mkdirSync(layout.deviceLmdbPath, { recursive: true })
    const device = new LmdbDatabase({
      path: layout.deviceLmdbPath,
      mapSize: 128 * 1024 * 1024,
      maxDbs: 6
    })
    device.put({ _id: 'SYNC/current-account', data: { uid } })
    device.close()
    const uidPath = path.join(layout.accountsRoot, hashAccountId(uid))
    fs.mkdirSync(uidPath, { recursive: true })
    fs.writeFileSync(path.join(uidPath, 'sentinel'), 'untouched')
    const manager = new StorageManager({ homeDir, mapSize: 128 * 1024 * 1024 })
    managers.push(manager)
    expect(manager.getCurrentAccountUid()).toBeNull()
    manager.getRouter().put({ _id: 'PLUGIN/demo/settings', data: { value: 'local' } })
    expect(manager.getAccountDb().get('PLUGIN/demo/settings')?.data.value).toBe('local')
    expect(fs.readdirSync(uidPath)).toEqual(['sentinel'])
    expect(() => manager.switchAccount(uid)).toThrow('当前本地版不提供官方服务能力')
    manager.switchAccount(null)
    expect(manager.getCurrentAccountUid()).toBeNull()
  })

  it('configures Electron identity and userData before legacy path capture', async () => {
    const homeDir = makeHome()
    const root = path.join(homeDir, '.cai-tools')
    vi.stubEnv('ZTOOLS_DATA_ROOT', root)
    vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', '')
    electronApp.getPath.mockReturnValue(path.join(homeDir, 'ZTools'))
    electronApp.setPath.mockClear()
    electronApp.setName.mockClear()
    vi.resetModules()
    await import('../../src/main/core/appData/configureAppDataRoot')
    expect(electronApp.setName).toHaveBeenCalledWith('CAI.Tools')
    expect(electronApp.setPath).toHaveBeenCalledWith('userData', root)
    expect(process.env.ZTOOLS_LEGACY_USER_DATA_PATH).toBe(root)
  })
})
