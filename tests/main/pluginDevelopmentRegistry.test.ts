import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  reorderProjects,
  buildInstalledDevelopmentPlugin,
  canPackageDevProject,
  insertDevProjectAtTop,
  rebindByConfig,
  readDevProjectRegistry,
  upsertByConfig,
  validateRepairConfigSelection
} from '../../src/main/api/renderer/pluginDevelopmentRegistry'

describe('pluginDevelopmentRegistry', () => {
  it('builds the installed snapshot from development.main', () => {
    const installed = buildInstalledDevelopmentPlugin('/workspace/demo', {
      name: 'demo',
      title: 'Demo',
      version: '1.0.0',
      features: [{ code: 'ui.demo', cmds: ['Demo'] }],
      development: { main: 'http://localhost:8686/' }
    })

    expect(installed.isDevelopment).toBe(true)
    expect(installed.main).toBe('http://localhost:8686/')
    expect(installed.path).toBe(path.resolve('/workspace/demo'))
  })

  it('rejects upsert when config name collides with different path', () => {
    const registry = {
      version: 3,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', title: 'Demo' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z',
          sortOrder: 0,
          projectPath: '/workspace/demo',
          configPath: '/workspace/demo/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z'
        }
      }
    }

    const result = upsertByConfig({
      registry,
      pluginPath: '/workspace/other',
      pluginConfig: { name: 'demo', title: 'Demo', version: '1.0.0' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toContain('/workspace/demo')
  })

  it.each(['setting', 'system', 'string-tools'])(
    'rejects upsert for built-in plugin %s',
    (name) => {
      const registry = { version: 3, projects: {} }

      const result = upsertByConfig({
        registry,
        pluginPath: `/workspace/${name}`,
        pluginConfig: { name, title: 'Built in', version: '1.0.0' }
      })

      expect(result.success).toBe(false)
      expect(result.reason).toMatch(/not allowed/)
    }
  )

  it('updates paths when registry entry already exists at the same path', () => {
    const registry = {
      version: 3,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', version: '0.5.0' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z',
          sortOrder: 0,
          projectPath: '/workspace/demo',
          configPath: '/workspace/demo/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z'
        }
      }
    }

    const result = upsertByConfig({
      registry,
      pluginPath: '/workspace/demo',
      pluginConfig: { name: 'demo', title: 'Demo', version: '1.0.0' },
      now: () => '2026-03-29T05:00:00.000Z'
    })

    expect(result.success).toBe(true)
    const entry = result.registry.projects.demo
    expect(entry.projectPath).toBe(path.resolve('/workspace/demo'))
    expect(entry.configPath).toBe(path.resolve('/workspace/demo/plugin.json'))
    expect(entry.status).toBe('ready')
    expect(entry.lastValidatedAt).toBe('2026-03-29T05:00:00.000Z')
    expect(entry.configSnapshot.version).toBe('1.0.0')
  })

  it('rejects import when plugin configuration lacks name', () => {
    const registry = { version: 3, projects: {} }

    const result = upsertByConfig({
      registry,
      pluginPath: '/workspace/nameless',
      pluginConfig: { title: 'Nameless' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toMatch(/requires a name/)
  })

  it('allows packaging ready projects even when dev mode is not installed', () => {
    const entry = {
      name: 'demo',
      configSnapshot: { name: 'demo', version: '1.0.0' },
      addedAt: '2026-03-29T00:00:00.000Z',
      updatedAt: '2026-03-29T00:00:00.000Z',
      sortOrder: 0,
      projectPath: '/workspace/demo',
      configPath: '/workspace/demo/plugin.json',
      status: 'ready',
      lastValidatedAt: '2026-03-29T00:00:00.000Z'
    }
    expect(canPackageDevProject(entry)).toBe(true)
  })

  it.each(['config_missing', 'invalid_config', 'unbound'] as const)(
    'does not allow packaging when binding status is %s',
    (status) => {
      const entry = {
        name: 'demo',
        configSnapshot: { name: 'demo', version: '1.0.0' },
        addedAt: '2026-03-29T00:00:00.000Z',
        updatedAt: '2026-03-29T00:00:00.000Z',
        sortOrder: 0,
        projectPath: '/workspace/demo',
        configPath: '/workspace/demo/plugin.json',
        status,
        lastValidatedAt: '2026-03-29T00:00:00.000Z'
      }
      expect(canPackageDevProject(entry)).toBe(false)
    }
  )

  it('rejects repair selections when config name does not match registry', () => {
    const registryItem = {
      name: 'demo',
      configSnapshot: { name: 'demo' },
      addedAt: '',
      updatedAt: ''
    }
    expect(validateRepairConfigSelection(registryItem, { name: 'other' })).toBe(false)
  })

  it('normalizes invalid registry docs into an empty v3 payload', () => {
    const registry = readDevProjectRegistry({ version: 1, projects: [] })
    expect(registry).toEqual({ version: 3, projects: {} })
  })

  it('drops invalid and built-in entries when normalizing registry docs', () => {
    const registry = readDevProjectRegistry({
      version: 3,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', title: 'Demo' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z',
          sortOrder: 0,
          projectPath: '/workspace/demo',
          configPath: '/workspace/demo/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z'
        },
        setting: {
          name: 'setting',
          configSnapshot: { name: 'setting', title: 'Setting' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z',
          sortOrder: 1,
          projectPath: '/workspace/setting',
          configPath: '/workspace/setting/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z'
        },
        bad: {
          configSnapshot: { name: 'bad' }
        }
      }
    })

    expect(Object.keys(registry.projects)).toEqual(['demo'])
  })

  it('falls back to addedAt order when sortOrder is missing', () => {
    const registry = readDevProjectRegistry({
      version: 3,
      projects: {
        alpha: {
          name: 'alpha',
          configSnapshot: { name: 'alpha', version: '1.0.0' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z',
          projectPath: '/workspace/alpha',
          configPath: '/workspace/alpha/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z'
        },
        beta: {
          name: 'beta',
          configSnapshot: { name: 'beta', version: '1.0.0' },
          addedAt: '2026-03-29T01:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z',
          projectPath: '/workspace/beta',
          configPath: '/workspace/beta/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T01:00:00.000Z'
        }
      }
    })

    expect(Object.values(registry.projects).map((item) => item.sortOrder)).toEqual([1, 0])
  })

  it('appends unseen projects when applying a stale order payload', () => {
    const next = reorderProjects(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          gamma: {
            name: 'gamma',
            configSnapshot: { name: 'gamma' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 2
          }
        }
      },
      ['alpha', 'beta']
    )

    expect(
      Object.values(next.projects)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => item.name)
    ).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('moves a newly imported project to the top of the shared order', () => {
    const next = insertDevProjectAtTop(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          }
        }
      },
      'beta'
    )

    expect(next.projects.beta?.sortOrder).toBe(0)
    expect(next.projects.alpha?.sortOrder).toBe(1)
  })

  it('keeps the top-inserted order stable after a reorder payload is applied', () => {
    const inserted = insertDevProjectAtTop(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          }
        }
      },
      'beta'
    )

    const reordered = reorderProjects(inserted, ['alpha', 'beta'])

    expect(
      Object.values(reordered.projects)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => item.name)
    ).toEqual(['alpha', 'beta'])
  })

  it('rebinds an existing project to a new config path while preserving sortOrder', () => {
    const result = rebindByConfig({
      registry: {
        version: 3,
        projects: {
          demo: {
            name: 'demo',
            configSnapshot: { name: 'demo', version: '1.0.0' },
            addedAt: '2026-03-29T00:00:00.000Z',
            updatedAt: '2026-03-29T00:00:00.000Z',
            sortOrder: 3,
            projectPath: '/workspace/old-demo',
            configPath: '/workspace/old-demo/plugin.json',
            status: 'ready',
            lastValidatedAt: '2026-03-29T00:00:00.000Z'
          }
        }
      },
      pluginJsonPath: '/workspace/new-demo/plugin.json',
      pluginConfig: { name: 'demo', version: '2.0.0', title: 'Demo' },
      now: () => '2026-03-31T10:00:00.000Z'
    })

    expect(result.success).toBe(true)
    expect(result.registry.projects.demo.projectPath).toBe(path.resolve('/workspace/new-demo'))
    expect(result.registry.projects.demo.configPath).toBe(
      path.resolve('/workspace/new-demo/plugin.json')
    )
    expect(result.registry.projects.demo.sortOrder).toBe(3)
    expect(result.registry.projects.demo.configSnapshot.version).toBe('2.0.0')
  })

  it('rejects upsert when same-name project is registered at a different path', () => {
    const result = upsertByConfig({
      registry: {
        version: 3,
        projects: {
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta', version: '1.0.0' },
            addedAt: '2026-03-29T00:00:00.000Z',
            updatedAt: '2026-03-29T00:00:00.000Z',
            sortOrder: 0,
            projectPath: '/workspace/beta-old',
            configPath: '/workspace/beta-old/plugin.json',
            status: 'ready',
            lastValidatedAt: '2026-03-29T00:00:00.000Z'
          }
        }
      },
      pluginPath: '/workspace/beta-new',
      pluginConfig: { name: 'beta', version: '1.0.0', title: 'Beta' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toContain('/workspace/beta-old')
  })
})
