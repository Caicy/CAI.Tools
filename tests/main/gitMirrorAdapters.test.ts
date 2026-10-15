import { expect, test } from 'vitest'
import { adapterRegistry } from '../../src/main/core/gitMirror/adapters/registry'
import { canonicalJson } from '../../src/main/core/gitMirror/canonicalJson'
import {
  projectHostPreferences,
  mergeHostPreferences,
  projectPluginShortcuts,
  mergePluginShortcuts
} from '../../src/main/core/gitMirror/hostProjection'

test('快捷键导入保留本机应用目标，拒绝环境 ID 冲突与远端路径字段', () => {
  const local = [{ id: 'local', shortcut: 'Alt+B', target: 'C:/local.exe', enabled: true }]
  const remote = [
    { id: 'plugin', shortcut: 'Alt+A', target: 'code-snippets/代码模板', enabled: true }
  ]
  expect(mergePluginShortcuts(remote, local, ['code-snippets'])).toEqual([...local, ...remote])
  expect(() =>
    mergePluginShortcuts([{ ...remote[0], id: 'local' }], local, ['code-snippets'])
  ).toThrow('SHORTCUT_LOCAL_ID_CONFLICT')
  expect(() =>
    mergePluginShortcuts([{ ...remote[0], path: 'C:/remote' }], local, ['code-snippets'])
  ).toThrow('UNSUPPORTED_FIELD')
  expect(() => mergePluginShortcuts(remote, local, [])).toThrow('INVALID_PAYLOAD')
})

const template = {
  _id: 'tpl_1',
  _rev: '1-local',
  name: '模板',
  description: '',
  language: 'text',
  tags: ['a'],
  code: 'LOCAL_ONLY_SECRET',
  usageCount: 4,
  pinned: true,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z'
}

test('只登记确切插件版本，不接收凭据插件或未知键', () => {
  expect(adapterRegistry.get('code-snippets', '1.2.1')).toBeNull()
  expect(adapterRegistry.get('otp-2fa', '1.0.0')).toBeNull()
  expect(adapterRegistry.get('code-snippets', '1.2.0')?.acceptsKey('apiKey')).toBe(false)
})

test('模板投影保留正文并排除统计与 revision，复制不改变投影', () => {
  const adapter = adapterRegistry.get('code-snippets', '1.2.0')!
  const payload = adapter.exportPayload('tpl_1', template)
  expect(payload).toMatchObject({ code: 'LOCAL_ONLY_SECRET' })
  expect(payload).not.toHaveProperty('usageCount')
  expect(payload).not.toHaveProperty('_rev')
  expect(canonicalJson(payload)).toBe(
    canonicalJson(
      adapter.exportPayload('tpl_1', {
        ...template,
        usageCount: 5,
        updatedAt: '2026-10-16T00:00:00.000Z'
      })
    )
  )
  expect(adapter.importPayload('tpl_1', payload, template)).toMatchObject({
    _id: 'PLUGIN/code-snippets/tpl_1',
    usageCount: 4,
    updatedAt: template.updatedAt
  })
  expect(adapter.importPayload('tpl_1', payload, null)).toMatchObject({ usageCount: 0 })
})

test.each([{ apiKey: 'secret' }, { tags: [3] }, { createdAt: 'bad' }, { pinned: 'yes' }])(
  '模板未知字段或坏结构拒绝导出 %j',
  (change) => {
    expect(() =>
      adapterRegistry
        .get('code-snippets', '1.2.0')!
        .exportPayload('tpl_1', { ...template, ...change } as never)
    ).toThrow()
  }
)

test('AI 会话与模型选择保持原插件读写格式，不扩展未知字段', () => {
  const adapter = adapterRegistry.get('ai-helper', '1.2.1')!
  const conversation = {
    id: '1',
    title: '对话',
    messages: [
      {
        id: 'm',
        role: 'user',
        content: '正文',
        timestamp: 1,
        images: ['data:image/png;base64,YQ==']
      }
    ],
    createdAt: 1,
    updatedAt: 2
  }
  const payload = adapter.exportPayload('conv/1', {
    _id: 'conv/1',
    data: JSON.stringify(conversation)
  })
  expect(
    JSON.parse((adapter.importPayload('conv/1', payload, null) as { data: string }).data)
  ).toEqual(conversation)
  expect(adapter.importPayload('selected_model', 'model-a', null)).toEqual({
    _id: 'PLUGIN/ai-helper/selected_model',
    value: 'model-a'
  })
  expect(() => adapter.exportPayload('conv/1', { data: '{"id":1,"id":2}' })).toThrow(
    'DUPLICATE_JSON_KEY'
  )
  expect(() =>
    adapter.exportPayload('conv/1', { data: JSON.stringify({ ...conversation, apiKey: 'secret' }) })
  ).toThrow('UNSUPPORTED_FIELD')
  expect(() => adapter.importPayload('conv/2', payload, null)).toThrow('IDENTITY_MISMATCH')
})

test('宿主只投影白名单，合并保留机器设置', () => {
  const local = {
    theme: 'dark',
    apiKey: 'LOCAL_ONLY_SECRET',
    windowPosition: [1, 2],
    autoStart: true
  }
  const portable = projectHostPreferences(local)
  expect(portable).toEqual({ theme: 'dark' })
  expect(mergeHostPreferences({ theme: 'light' }, local)).toEqual({ ...local, theme: 'light' })
  expect(() => mergeHostPreferences({ apiKey: 'remote' }, local)).toThrow('UNSUPPORTED_FIELD')
  expect(() => projectHostPreferences({ theme: 1 })).toThrow()
})

test('快捷键只导出已安装插件 canonical 目标', () => {
  const shortcuts = [
    {
      id: '1',
      shortcut: 'Alt+A',
      target: 'code-snippets/代码模板',
      enabled: true,
      path: 'C:/private'
    },
    { id: '2', shortcut: 'Alt+B', target: 'C:/local.exe', enabled: true },
    { id: '3', shortcut: 'Alt+C', target: 'unknown/cmd', enabled: true }
  ]
  expect(projectPluginShortcuts(shortcuts, ['code-snippets'])).toEqual([
    { id: '1', shortcut: 'Alt+A', target: 'code-snippets/代码模板', enabled: true }
  ])
})
