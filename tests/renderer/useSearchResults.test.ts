import { describe, it, expect } from 'vitest'
import { deduplicateResults } from '../../src/renderer/src/composables/useSearchResults'
import { prioritizeStringToolMatches } from '../../src/shared/stringToolsRecommendations'

describe('字符串工具匹配优先级', () => {
  const base = { path: '/plugins/string-tools', pluginName: 'string-tools', cmdType: 'regex' }

  it('覆盖使用次数排序后的输入顺序，解码优先且不会修改原数组', () => {
    const results = ['case', 'lines', 'sql', 'unicode'].map((featureCode) => ({
      ...base,
      featureCode
    }))
    expect(prioritizeStringToolMatches(results).map((item) => item.featureCode)).toEqual([
      'unicode',
      'sql',
      'lines',
      'case'
    ])
    expect(results.map((item) => item.featureCode)).toEqual(['case', 'lines', 'sql', 'unicode'])
  })

  it('其他插件位置及同一工具的别名顺序保持不变', () => {
    const foreign = {
      path: '/other',
      pluginName: 'other',
      featureCode: 'unicode',
      cmdType: 'regex'
    }
    const results = [
      { ...base, featureCode: 'case', name: 'name' },
      foreign,
      { ...base, featureCode: 'unicode', name: 'decode' },
      { ...base, featureCode: 'unicode', name: 'alias' }
    ]
    const sorted = prioritizeStringToolMatches(results)
    expect(sorted[1]).toBe(foreign)
    expect(sorted.map((item) => ('name' in item ? item.name : 'foreign'))).toEqual([
      'decode',
      'foreign',
      'alias',
      'name'
    ])
  })

  it('通用入口位于具体匹配之后，去重时保留 SQL 的具体入口', () => {
    const results = [
      { ...base, featureCode: 'sql', cmdType: 'over', name: '字符串处理', type: 'plugin' },
      { ...base, featureCode: 'lines', name: '行整理', type: 'plugin' },
      { ...base, featureCode: 'sql', name: 'SQL IN 拼接', type: 'plugin' }
    ]
    expect(
      deduplicateResults(prioritizeStringToolMatches(results)).map((item) => item.name)
    ).toEqual(['SQL IN 拼接', '行整理'])
  })

  it('手动搜索入口不受匹配优先级影响', () => {
    const results = [
      { ...base, featureCode: 'case', cmdType: 'text' },
      { ...base, featureCode: 'unicode', cmdType: 'text' }
    ]
    expect(prioritizeStringToolMatches(results)).toEqual(results)
  })

  it('开发插件和正式插件独立排序', () => {
    const dev = { ...base, path: '/dev', pluginName: 'string-tools__dev', featureCode: 'unicode' }
    const results = [{ ...base, featureCode: 'case' }, dev, { ...base, featureCode: 'sql' }]
    expect(prioritizeStringToolMatches(results)[1]).toBe(dev)
    expect(prioritizeStringToolMatches(results).map((item) => item.featureCode)).toEqual([
      'sql',
      'unicode',
      'case'
    ])
  })
})

describe('deduplicateResults', () => {
  describe('非插件类型', () => {
    it('应去除同名同路径的重复项', () => {
      const results = [
        { name: 'Chrome', path: 'C:\\chrome.exe', type: 'app' },
        { name: 'Chrome', path: 'C:\\chrome.exe', type: 'app' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(1)
    })

    it('应保留不同名同路径的应用（核心特性）', () => {
      const results = [
        { name: '原神', path: 'C:\\launcher.exe', type: 'app' },
        { name: '米哈游启动器', path: 'C:\\launcher.exe', type: 'app' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(2)
    })

    it('应保留同名不同路径的应用', () => {
      const results = [
        { name: 'App', path: 'C:\\v1\\app.exe', type: 'app' },
        { name: 'App', path: 'C:\\v2\\app.exe', type: 'app' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(2)
    })

    it('应合并同一路径下不同显示名的系统应用别名', () => {
      const results = [
        {
          name: 'WeChat',
          path: '/Applications/WeChat.app',
          type: 'direct',
          subType: 'app'
        },
        {
          name: '微信',
          path: '/Applications/WeChat.app',
          type: 'direct',
          subType: 'app'
        }
      ]

      const deduped = deduplicateResults(results)

      expect(deduped).toHaveLength(1)
      expect(deduped[0].name).toBe('WeChat')
    })

    it('应兼容路径大小写和分隔符差异', () => {
      const results = [
        {
          name: 'WeChat',
          path: 'C:\\Program Files\\Tencent\\WeChat.exe',
          type: 'direct',
          subType: 'app'
        },
        {
          name: '微信',
          path: 'c:/program files/tencent/wechat.exe',
          type: 'direct',
          subType: 'app'
        }
      ]

      expect(deduplicateResults(results)).toHaveLength(1)
    })
  })

  describe('插件类型', () => {
    it('应用 path+featureCode 去重', () => {
      const results = [
        { name: '翻译', path: '/plugins/translate', type: 'plugin', featureCode: 'translate' },
        { name: '翻译', path: '/plugins/translate', type: 'plugin', featureCode: 'translate' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(1)
    })

    it('应保留同路径不同 featureCode 的插件', () => {
      const results = [
        { name: '翻译', path: '/plugins/translate', type: 'plugin', featureCode: 'translate' },
        { name: '词典', path: '/plugins/translate', type: 'plugin', featureCode: 'dict' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(2)
    })
  })

  describe('混合类型', () => {
    it('应同时处理插件和非插件', () => {
      const results = [
        { name: 'Chrome', path: 'C:\\chrome.exe', type: 'app' },
        { name: 'Chrome', path: 'C:\\chrome.exe', type: 'app' },
        { name: '翻译', path: '/plugins/translate', type: 'plugin', featureCode: 'translate' },
        { name: '翻译', path: '/plugins/translate', type: 'plugin', featureCode: 'translate' },
        { name: '原神', path: 'C:\\launcher.exe', type: 'app' },
        { name: '米哈游启动器', path: 'C:\\launcher.exe', type: 'app' }
      ]
      const deduped = deduplicateResults(results)
      expect(deduped).toHaveLength(4) // Chrome + 翻译 + 原神 + 米哈游启动器
    })
  })

  it('空数组应返回空数组', () => {
    expect(deduplicateResults([])).toEqual([])
  })

  it('应保留第一个出现的重复项', () => {
    const results = [
      { name: 'App', path: 'C:\\app.exe', type: 'app', extra: 'first' },
      { name: 'App', path: 'C:\\app.exe', type: 'app', extra: 'second' }
    ]
    const deduped = deduplicateResults(results)
    expect(deduped[0].extra).toBe('first')
  })
})
