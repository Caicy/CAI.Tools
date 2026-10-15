import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import LmdbDatabase from '../../src/main/core/lmdb'
import { getZToolsDataLayout } from '../../src/main/core/appData/appDataPaths'
import { LegacyImportService } from '../../src/main/core/storage/legacyImportService'
import { hashAccountId, StorageManager } from '../../src/main/core/storage/storageManager'
import { DefaultAccountImportService } from '../../src/main/core/storage/defaultAccountImportService'

const tempRoots: string[] = []

/**
 * 为存储回归创建独立 home，确保 LMDB 和迁移来源均不触及真实数据。
 * @returns 临时 home 绝对路径。
 */
function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-storage3-'))
  tempRoots.push(root)
  // homeDir 的优先级低于环境变量，每个用例必须同时覆盖两个目录变量。
  vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(root, '.cai-tools'))
  vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(root, 'legacy-user-data'))
  return root
}

/**
 * 删除本测试拥有的临时根目录。
 * @param root 已创建的测试临时根目录。
 * @returns 无返回值。
 */
function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of tempRoots.splice(0)) cleanup(root)
})

describe('CAI.Tools local storage routing', () => {
  it('routes device data and default business data to separate persistent databases', () => {
    const homeDir = makeTempRoot()
    const manager = new StorageManager({ homeDir, mapSize: 128 * 1024 * 1024 })
    try {
      const db = manager.getRouter()
      db.put({ _id: 'ZTOOLS/settings-general', data: { theme: 'dark' } })
      db.put({ _id: 'ZTOOLS/plugins', data: [{ name: 'demo' }] })
      db.put({ _id: 'ZTOOLS/ai-models', data: [{ id: 'model-a' }] })
      db.put({ _id: 'PLUGIN/demo/settings', data: { value: 'default' } })
      expect(manager.getDeviceDb().get('ZTOOLS/settings-general')).not.toBeNull()
      expect(manager.getDeviceDb().get('ZTOOLS/plugins')).not.toBeNull()
      expect(manager.getAccountDb().get('ZTOOLS/ai-models')).not.toBeNull()
      expect(manager.getAccountDb().get('PLUGIN/demo/settings')).not.toBeNull()
      expect(manager.getDeviceDb().get('PLUGIN/demo/settings')).toBeNull()
      expect(() => manager.switchAccount('alice')).toThrow('当前本地版不提供官方服务能力')
      manager.switchAccount(null)
      expect(db.get('PLUGIN/demo/settings')?.data.value).toBe('default')
    } finally {
      manager.close()
    }
    const reopened = new StorageManager({ homeDir, mapSize: 128 * 1024 * 1024 })
    try {
      expect(reopened.getCurrentAccountUid()).toBeNull()
      expect(reopened.getRouter().get('PLUGIN/demo/settings')?.data.value).toBe('default')
      expect(reopened.getRouter().get('ZTOOLS/settings-general')?.data.theme).toBe('dark')
    } finally {
      reopened.close()
    }
  })

  it('keeps sync changelog scoped to default business data only', () => {
    const manager = new StorageManager({ homeDir: makeTempRoot(), mapSize: 128 * 1024 * 1024 })
    try {
      const db = manager.getRouter()
      db.put({ _id: 'ZTOOLS/settings-general', data: { theme: 'dark' } })
      db.put({ _id: 'ZTOOLS/ai-models', data: [{ id: 'model-a' }] })
      db.put({ _id: 'PLUGIN/demo/settings', data: { value: 'default' } })
      expect(db.getChangesSince(0).map((change) => change.docId)).toEqual([
        'ZTOOLS/ai-models',
        'PLUGIN/demo/settings'
      ])
    } finally {
      manager.close()
    }
  })

  it('preserves routing compatibility for inert auth and sync documents without activating an account', () => {
    const manager = new StorageManager({ homeDir: makeTempRoot(), mapSize: 128 * 1024 * 1024 })
    try {
      const db = manager.getRouter()
      db.put({ _id: 'AUTH/official-account', data: { username: 'inert-user' } })
      db.put({ _id: 'SYNC/profile', data: { provider: 'private', enabled: false } })
      db.put({ _id: 'SYNC/private-session', data: { username: 'inert-private-user' } })
      expect(manager.getDeviceDb().get('AUTH/official-account')?.data.username).toBe('inert-user')
      expect(manager.getDeviceDb().get('SYNC/profile')).toBeNull()
      expect(manager.getDeviceDb().get('SYNC/private-session')).toBeNull()
      expect(manager.getAccountDb().get('SYNC/profile')?.data.provider).toBe('private')
      expect(manager.getAccountDb().get('SYNC/private-session')?.data.username).toBe(
        'inert-private-user'
      )
      expect(manager.getCurrentAccountUid()).toBeNull()
    } finally {
      manager.close()
    }
  })

  it('does not create hashed account directories when rejecting a switch', () => {
    const homeDir = makeTempRoot()
    const manager = new StorageManager({ homeDir, mapSize: 128 * 1024 * 1024 })
    try {
      manager.init()
      expect(() => manager.switchAccount('user@example.com')).toThrow('账号切换')
      const layout = getZToolsDataLayout({ homeDir })
      expect(fs.readdirSync(layout.accountsRoot)).toEqual(['default'])
      expect(fs.existsSync(path.join(layout.accountsRoot, hashAccountId('user@example.com')))).toBe(
        false
      )
      expect(path.basename(path.dirname(layout.accountsRoot))).toBe('lmdb')
    } finally {
      manager.close()
    }
  })

  it('preserves default data and legacy account directories when deletion is rejected', () => {
    const homeDir = makeTempRoot()
    const layout = getZToolsDataLayout({ homeDir })
    const legacyAccountPath = path.join(layout.accountsRoot, hashAccountId('legacy-user'))
    fs.mkdirSync(legacyAccountPath, { recursive: true })
    fs.writeFileSync(path.join(legacyAccountPath, 'sentinel'), 'untouched')
    const manager = new StorageManager({ homeDir, mapSize: 128 * 1024 * 1024 })
    try {
      manager.getRouter().put({ _id: 'PLUGIN/demo/settings', data: { value: 'default' } })
      expect(() => manager.deleteCurrentAccount('')).toThrow('账号标识不能为空')
      expect(() => manager.deleteCurrentAccount('default')).toThrow('与当前本地账号不一致')
      expect(() => manager.deleteCurrentAccount('legacy-user')).toThrow('与当前本地账号不一致')
      expect(manager.getCurrentAccountUid()).toBeNull()
      expect(manager.getRouter().get('PLUGIN/demo/settings')?.data.value).toBe('default')
      expect(fs.existsSync(layout.defaultAccountLmdbPath)).toBe(true)
      expect(fs.readdirSync(legacyAccountPath)).toEqual(['sentinel'])
      expect(fs.readFileSync(path.join(legacyAccountPath, 'sentinel'), 'utf8')).toBe('untouched')
    } finally {
      manager.close()
    }
  })
})

describe('explicit temporary legacy import compatibility', () => {
  it('detects only an explicitly supplied temporary legacy directory', () => {
    const homeDir = makeTempRoot()
    const legacyUserDataPath = path.join(homeDir, 'Library', 'Application Support', 'ZTools')
    fs.mkdirSync(path.join(legacyUserDataPath, 'lmdb'), { recursive: true })

    const service = new LegacyImportService(new StorageManager({ homeDir, legacyUserDataPath }), {
      homeDir,
      legacyUserDataPath
    })

    expect(service.detect()).toMatchObject({
      initialized: false,
      legacyLmdbFound: true,
      shouldPrompt: true
    })

    fs.mkdirSync(path.join(homeDir, '.cai-tools'), { recursive: true })
    expect(service.detect()).toMatchObject({
      initialized: false,
      legacyLmdbFound: true,
      shouldPrompt: true
    })

    service.startFresh()
    expect(service.detect()).toMatchObject({
      initialized: true,
      legacyLmdbFound: false,
      shouldPrompt: false
    })
  })

  it('imports selected legacy docs without deleting or modifying the legacy lmdb', () => {
    const homeDir = makeTempRoot()
    const legacyUserDataPath = path.join(homeDir, 'legacy-user-data')
    const legacyLmdbPath = path.join(legacyUserDataPath, 'lmdb')
    fs.mkdirSync(legacyLmdbPath, { recursive: true })
    fs.mkdirSync(path.join(legacyUserDataPath, 'plugins', 'demo'), { recursive: true })
    fs.writeFileSync(
      path.join(legacyUserDataPath, 'plugins', 'demo', 'plugin.json'),
      JSON.stringify({ name: 'demo' })
    )
    fs.writeFileSync(path.join(legacyUserDataPath, 'plugins', 'demo', 'logo.png'), 'logo')
    fs.mkdirSync(path.join(legacyUserDataPath, 'avatar'), { recursive: true })
    fs.writeFileSync(path.join(legacyUserDataPath, 'avatar', 'user.png'), 'avatar')

    const legacyDb = new LmdbDatabase({
      path: legacyLmdbPath,
      mapSize: 128 * 1024 * 1024,
      maxDbs: 6
    })
    legacyDb.put({
      _id: 'ZTOOLS/settings-general',
      data: {
        theme: 'light',
        avatar: pathToFileURL(path.join(legacyUserDataPath, 'avatar', 'user.png')).href
      }
    })
    legacyDb.put({
      _id: 'ZTOOLS/plugins',
      data: [
        {
          name: 'keep-installed',
          path: path.join(legacyUserDataPath, 'plugins', 'demo'),
          logo: pathToFileURL(path.join(legacyUserDataPath, 'plugins', 'demo', 'logo.png')).href,
          features: [
            {
              code: 'demo',
              icon: pathToFileURL(path.join(legacyUserDataPath, 'plugins', 'demo', 'logo.png')).href
            }
          ]
        }
      ]
    })
    legacyDb.put({ _id: 'PLUGIN/demo/settings', data: { value: 'legacy' } })
    legacyDb.postAttachment('PLUGIN/demo/settings', Buffer.from('legacy-attachment'), 'text/plain')
    ;(legacyDb as any).mainDb.putSync(
      'PLUGIN/demo/cloud-state',
      JSON.stringify({
        _id: 'PLUGIN/demo/cloud-state',
        _rev: '99-oldcloud',
        _cloudSynced: true,
        _lastModified: 123456,
        _deleted: false,
        _conflicts: ['98-loser'],
        _revisions: { start: 99, ids: ['oldcloud'] },
        data: { value: 'legacy-cloud' }
      })
    )
    legacyDb.put({ _id: 'ZTOOLS/ai-models', data: [{ id: 'legacy-model' }] })
    legacyDb.put({
      _id: 'SYNC/config',
      data: {
        enabled: true,
        serverUrl: 'wss://legacy.example',
        token: 'old-token',
        refreshToken: 'old-refresh',
        username: 'old-user'
      }
    })
    legacyDb.close()

    const manager = new StorageManager({ homeDir, legacyUserDataPath, mapSize: 128 * 1024 * 1024 })
    const service = new LegacyImportService(manager, { homeDir, legacyUserDataPath })
    const result = service.importSelected({
      baseSettings: true,
      pluginInstallState: true,
      pluginData: true,
      aiModels: false,
      legacySyncConfig: true
    })

    expect(result.importedDocs).toBe(5)
    expect(result.skippedDocs).toBe(1)
    expect(result.importedAttachments).toBe(1)
    expect(result.skippedAttachments).toBe(0)
    expect(result.copiedDirs).toEqual(['plugins', 'avatar'])
    expect(manager.getDeviceDb().get('ZTOOLS/settings-general')?.data.theme).toBe('light')
    expect(manager.getDeviceDb().get('ZTOOLS/settings-general')?.data.avatar).toBe(
      pathToFileURL(path.join(homeDir, '.cai-tools', 'avatar', 'user.png')).href
    )
    expect(manager.getDeviceDb().get('ZTOOLS/plugins')?.data[0]).toMatchObject({
      name: 'keep-installed',
      path: path.join(homeDir, '.cai-tools', 'plugins', 'demo'),
      logo: pathToFileURL(path.join(homeDir, '.cai-tools', 'plugins', 'demo', 'logo.png')).href,
      features: [
        {
          code: 'demo',
          icon: pathToFileURL(path.join(homeDir, '.cai-tools', 'plugins', 'demo', 'logo.png')).href
        }
      ]
    })
    expect(fs.existsSync(path.join(homeDir, '.cai-tools', 'plugins', 'demo', 'plugin.json'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(homeDir, '.cai-tools', 'avatar', 'user.png'))).toBe(true)
    expect(manager.getAccountDb().get('PLUGIN/demo/settings')?.data.value).toBe('legacy')
    expect(
      Buffer.from(manager.getAccountDb().getAttachment('PLUGIN/demo/settings') || []).toString()
    ).toBe('legacy-attachment')
    expect(manager.getAccountDb().getAttachmentType('PLUGIN/demo/settings')?.type).toBe(
      'text/plain'
    )
    expect(
      (manager.getAccountDb().get('PLUGIN/demo/settings') as any)?._attachments?.default?.stub
    ).toBe(true)
    const importedCloudState = manager.getAccountDb().get('PLUGIN/demo/cloud-state') as any
    expect(importedCloudState.data.value).toBe('legacy-cloud')
    expect(importedCloudState._rev).not.toBe('99-oldcloud')
    expect(importedCloudState._cloudSynced).toBeUndefined()
    expect(importedCloudState._lastModified).toBeUndefined()
    expect(importedCloudState._deleted).toBeUndefined()
    expect(importedCloudState._conflicts).toBeUndefined()
    expect(importedCloudState._revisions).toBeUndefined()
    expect(manager.getAccountDb().getSyncMeta('PLUGIN/demo/cloud-state')).not.toHaveProperty(
      '_cloudSynced'
    )
    expect(
      manager
        .getAccountDb()
        .getChangesSince(0)
        .map((change) => change.docId)
    ).toContain('PLUGIN/demo/cloud-state')
    expect(manager.getAccountDb().get('ZTOOLS/ai-models')).toBeNull()
    expect(manager.getDeviceDb().get('SYNC/config')?.data).toMatchObject({
      enabled: false,
      serverUrl: 'wss://legacy.example',
      token: '',
      refreshToken: '',
      username: ''
    })

    const legacyCheckDb = new LmdbDatabase({
      path: legacyLmdbPath,
      mapSize: 128 * 1024 * 1024,
      maxDbs: 6
    })
    expect(legacyCheckDb.get('PLUGIN/demo/settings')?.data.value).toBe('legacy')
    expect(Buffer.from(legacyCheckDb.getAttachment('PLUGIN/demo/settings') || []).toString()).toBe(
      'legacy-attachment'
    )
    legacyCheckDb.close()
    manager.close()
  })

  it('imports the full user-data set and renames legacy camel-case keys', () => {
    const homeDir = makeTempRoot()
    const legacyUserDataPath = path.join(homeDir, 'legacy-user-data')
    const legacyLmdbPath = path.join(legacyUserDataPath, 'lmdb')
    fs.mkdirSync(legacyLmdbPath, { recursive: true })

    const legacyDb = new LmdbDatabase({
      path: legacyLmdbPath,
      mapSize: 128 * 1024 * 1024,
      maxDbs: 6
    })
    legacyDb.put({
      _id: 'ZTOOLS/plugins',
      data: [{ name: 'enabled-plugin' }, { name: 'blocked-plugin' }]
    })
    legacyDb.put({ _id: 'ZTOOLS/pinned-commands', data: [{ name: 'Pinned' }] })
    legacyDb.put({ _id: 'ZTOOLS/command-history', data: [{ name: 'Recent' }] })
    legacyDb.put({ _id: 'ZTOOLS/autoStartPlugin', data: ['enabled-plugin'] })
    legacyDb.put({ _id: 'ZTOOLS/autoDetachPlugin', data: ['enabled-plugin'] })
    legacyDb.put({ _id: 'ZTOOLS/outKillPlugin', data: ['enabled-plugin'] })
    legacyDb.put({ _id: 'ZTOOLS/disabledMainPushPlugin', data: ['blocked-plugin'] })
    legacyDb.put({
      _id: 'ZTOOLS/detachedWindowSizes',
      data: { 'enabled-plugin': { width: 600, height: 400 } }
    })
    legacyDb.put({ _id: 'ZTOOLS/settings-mcp-disabled-plugins', data: ['/plugin/path'] })
    legacyDb.put({ _id: 'ZTOOLS/plugin-market-data', data: ['cache'] })
    legacyDb.close()

    const manager = new StorageManager({ homeDir, legacyUserDataPath, mapSize: 128 * 1024 * 1024 })
    const service = new LegacyImportService(manager, { homeDir, legacyUserDataPath })
    const result = service.importSelected({ mode: 'full' })

    expect(result.mode).toBe('full')
    expect(manager.getDeviceDb().get('ZTOOLS/pinned-commands')?.data).toEqual([{ name: 'Pinned' }])
    expect(manager.getDeviceDb().get('ZTOOLS/command-history')?.data).toEqual([{ name: 'Recent' }])
    expect(manager.getDeviceDb().get('ZTOOLS/auto-start-plugin')?.data).toEqual(['enabled-plugin'])
    expect(manager.getDeviceDb().get('ZTOOLS/auto-detach-plugin')?.data).toEqual(['enabled-plugin'])
    expect(manager.getDeviceDb().get('ZTOOLS/out-kill-plugin')?.data).toEqual(['enabled-plugin'])
    expect(manager.getDeviceDb().get('ZTOOLS/enabled-main-push-plugin')?.data).toEqual([
      'enabled-plugin'
    ])
    expect(manager.getDeviceDb().get('ZTOOLS/detached-window-sizes')?.data).toEqual({
      'enabled-plugin': { width: 600, height: 400 }
    })
    expect(manager.getDeviceDb().get('ZTOOLS/settings-mcp-disabled-plugins')?.data).toEqual([
      '/plugin/path'
    ])
    expect(manager.getDeviceDb().get('ZTOOLS/autoStartPlugin')).toBeNull()
    expect(manager.getDeviceDb().get('ZTOOLS/plugin-market-data')).toBeNull()
    manager.close()
  })

  it('keeps the compact import limited to the original data set', () => {
    const homeDir = makeTempRoot()
    const legacyUserDataPath = path.join(homeDir, 'legacy-user-data')
    const legacyLmdbPath = path.join(legacyUserDataPath, 'lmdb')
    fs.mkdirSync(legacyLmdbPath, { recursive: true })

    const legacyDb = new LmdbDatabase({
      path: legacyLmdbPath,
      mapSize: 128 * 1024 * 1024,
      maxDbs: 6
    })
    legacyDb.put({ _id: 'ZTOOLS/settings-general', data: { theme: 'dark' } })
    legacyDb.put({ _id: 'ZTOOLS/pinned-commands', data: [{ name: 'Skipped' }] })
    legacyDb.put({ _id: 'ZTOOLS/autoStartPlugin', data: ['skipped-plugin'] })
    legacyDb.close()

    const manager = new StorageManager({ homeDir, legacyUserDataPath, mapSize: 128 * 1024 * 1024 })
    const service = new LegacyImportService(manager, { homeDir, legacyUserDataPath })
    const result = service.importSelected({ mode: 'compact' })

    expect(result.mode).toBe('compact')
    expect(manager.getDeviceDb().get('ZTOOLS/settings-general')?.data.theme).toBe('dark')
    expect(manager.getDeviceDb().get('ZTOOLS/pinned-commands')).toBeNull()
    expect(manager.getDeviceDb().get('ZTOOLS/auto-start-plugin')).toBeNull()
    manager.close()
  })
})

// 上游登录后多账户导入场景已不适用；本地版以默认空间行为和拒绝切换覆盖替代。
describe('default import compatibility without a local account', () => {
  it('does not offer or perform login-dependent import in default storage', () => {
    const manager = new StorageManager({ homeDir: makeTempRoot(), mapSize: 128 * 1024 * 1024 })
    try {
      manager.getRouter().put({ _id: 'PLUGIN/demo/settings', data: { value: 'default-data' } })
      manager.getRouter().postAttachment('PLUGIN/demo/settings', Buffer.from('hello'), 'text/plain')
      const service = new DefaultAccountImportService(manager)
      expect(service.getStatus()).toMatchObject({
        pending: false,
        uid: null,
        imported: false,
        skipped: false
      })
      expect(() => service.importToCurrentAccount()).toThrow('未登录账号')
      service.skip()
      expect(manager.getRouter().get('PLUGIN/demo/settings')?.data.value).toBe('default-data')
      expect(
        Buffer.from(manager.getRouter().getAttachment('PLUGIN/demo/settings') || []).toString()
      ).toBe('hello')
      expect(manager.getDeviceDb().get('SYNC/current-account')).toBeNull()
    } finally {
      manager.close()
    }
  })
})
