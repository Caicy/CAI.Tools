import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const mockDbGet = vi.hoisted(() => vi.fn())
const mockDbPut = vi.hoisted(() => vi.fn())
const mockDbRemove = vi.hoisted(() => vi.fn())

vi.mock('../../src/main/api/shared/database.js', () => ({
  default: {
    dbGet: mockDbGet,
    dbPut: mockDbPut,
    dbRemove: mockDbRemove
  }
}))

vi.mock('../../src/shared/pluginRuntimeNamespace.js', () => ({
  isDevelopmentPluginName: vi.fn((name: string) => name.endsWith('__dev')),
  toDevPluginName: vi.fn((name: string) => `${name}__dev`)
}))

vi.mock('../../src/main/core/internalPlugins.js', () => ({
  isBundledInternalPlugin: vi.fn(() => false)
}))

import {
  cleanupLegacyWebSearchReferences,
  migrateLegacyFileUrls,
  migrateHostStorageKeys
} from '../../src/main/core/startupDataMigrations'

describe('startupDataMigrations', () => {
  let homeDir: string
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-startup-migrations-'))
    vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(homeDir, '.cai-tools'))
    vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(homeDir, 'legacy'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('removes legacy web search command references from flat command lists', () => {
    const stores: Record<string, any[]> = {
      'command-history': [
        { path: '/system', type: 'plugin', featureCode: 'web-search-history' },
        { path: '/system', type: 'plugin', featureCode: 'clear' }
      ],
      'pinned-commands': [
        { path: '/system', type: 'plugin', featureCode: 'web-search-pinned' },
        { path: '/apps/foo', type: 'direct' }
      ],
      'command-usage-stats': [
        { path: '/system', type: 'plugin', featureCode: 'web-search-stats', useCount: 3 },
        { path: '/system', type: 'plugin', featureCode: 'clear', useCount: 1 }
      ],
      'cached-commands': [
        { path: '/system', type: 'plugin', featureCode: 'web-search-cached' },
        { path: '/system', type: 'plugin', featureCode: 'reboot' }
      ],
      'super-panel-pinned': []
    }
    mockDbGet.mockImplementation((key: string) => stores[key] || [])

    cleanupLegacyWebSearchReferences()

    expect(mockDbPut).toHaveBeenCalledWith('command-history', [
      { path: '/system', type: 'plugin', featureCode: 'clear' }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('pinned-commands', [
      { path: '/apps/foo', type: 'direct' }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('command-usage-stats', [
      { path: '/system', type: 'plugin', featureCode: 'clear', useCount: 1 }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('cached-commands', [
      { path: '/system', type: 'plugin', featureCode: 'reboot' }
    ])
  })

  it('removes legacy web search commands from super panel folders', () => {
    const stores: Record<string, any[]> = {
      'command-history': [],
      'pinned-commands': [],
      'command-usage-stats': [],
      'cached-commands': [],
      'super-panel-pinned': [
        {
          id: 'folder-1',
          name: 'Folder',
          isFolder: true,
          items: [
            { path: '/system', type: 'plugin', featureCode: 'web-search-nested' },
            { path: '/system', type: 'plugin', featureCode: 'clear' }
          ]
        },
        {
          id: 'folder-2',
          name: 'Empty Folder',
          isFolder: true,
          items: [{ path: '/system', type: 'plugin', featureCode: 'web-search-only' }]
        },
        { path: '/system', type: 'plugin', featureCode: 'web-search-top' }
      ]
    }
    mockDbGet.mockImplementation((key: string) => stores[key] || [])

    cleanupLegacyWebSearchReferences()

    expect(mockDbPut).toHaveBeenCalledTimes(1)
    expect(mockDbPut).toHaveBeenCalledWith('super-panel-pinned', [
      { path: '/system', type: 'plugin', featureCode: 'clear' }
    ])
  })

  it('renames camel-case host keys and preserves canonical values', () => {
    const stores: Record<string, any> = {
      autoStartPlugin: ['legacy', 'shared'],
      'auto-start-plugin': ['current', 'shared'],
      detachedWindowSizes: { legacy: { width: 400 } },
      'detached-window-sizes': { current: { width: 500 } }
    }
    mockDbGet.mockImplementation((key: string) => stores[key] ?? null)

    migrateHostStorageKeys()

    expect(mockDbPut).toHaveBeenCalledWith('auto-start-plugin', ['current', 'shared', 'legacy'])
    expect(mockDbPut).toHaveBeenCalledWith('detached-window-sizes', {
      legacy: { width: 400 },
      current: { width: 500 }
    })
    expect(mockDbRemove).toHaveBeenCalledWith('autoStartPlugin')
    expect(mockDbRemove).toHaveBeenCalledWith('detachedWindowSizes')
  })

  it('converts the legacy mainPush denylist into the 3.0 allowlist', () => {
    const stores: Record<string, any> = {
      disabledMainPushPlugin: ['blocked'],
      plugins: [{ name: 'enabled' }, { name: 'blocked' }]
    }
    mockDbGet.mockImplementation((key: string) => stores[key] ?? null)

    migrateHostStorageKeys()

    expect(mockDbPut).toHaveBeenCalledWith('enabled-main-push-plugin', ['enabled'])
    expect(mockDbRemove).toHaveBeenCalledWith('disabledMainPushPlugin')
  })

  it('repairs migrated plugin, history, and avatar file URLs idempotently', () => {
    const legacyUserDataPath = path.join(homeDir, 'Library', 'Application Support', 'ZTools')
    const oldPluginLogo = pathToFileURL(
      path.join(legacyUserDataPath, 'plugins', 'demo', 'logo.png')
    ).href
    const currentPluginLogo = pathToFileURL(
      path.join(homeDir, '.cai-tools', 'plugins', 'current', 'logo.png')
    ).href
    const stores: Record<string, any> = {
      plugins: [
        {
          name: 'demo',
          path: path.join(homeDir, '.cai-tools', 'plugins', 'demo'),
          logo: oldPluginLogo,
          features: [{ code: 'demo', icon: oldPluginLogo }]
        },
        { name: 'current', logo: currentPluginLogo }
      ],
      'command-history': [{ name: 'Demo', type: 'plugin', icon: oldPluginLogo }],
      'settings-general': {
        avatar: pathToFileURL(path.join(legacyUserDataPath, 'avatar', 'avatar.png')).href,
        homepage: 'https://example.com/image.png'
      }
    }
    mockDbGet.mockImplementation((key: string) => stores[key] ?? null)
    mockDbPut.mockImplementation((key: string, value: any) => {
      stores[key] = value
    })

    migrateLegacyFileUrls({ homeDir, legacyUserDataPath })

    const migratedPluginLogo = pathToFileURL(
      path.join(homeDir, '.cai-tools', 'plugins', 'demo', 'logo.png')
    ).href
    expect(mockDbPut).toHaveBeenCalledWith('plugins', [
      {
        name: 'demo',
        path: path.join(homeDir, '.cai-tools', 'plugins', 'demo'),
        logo: migratedPluginLogo,
        features: [{ code: 'demo', icon: migratedPluginLogo }]
      },
      { name: 'current', logo: currentPluginLogo }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('command-history', [
      { name: 'Demo', type: 'plugin', icon: migratedPluginLogo }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('settings-general', {
      avatar: pathToFileURL(path.join(homeDir, '.cai-tools', 'avatar', 'avatar.png')).href,
      homepage: 'https://example.com/image.png'
    })

    mockDbPut.mockClear()
    migrateLegacyFileUrls({ homeDir, legacyUserDataPath })
    expect(mockDbPut).not.toHaveBeenCalled()
  })
})
