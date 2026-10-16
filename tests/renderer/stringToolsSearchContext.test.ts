import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import { useSearchResults } from '../../src/renderer/src/composables/useSearchResults'

const state = vi.hoisted(() => ({ matches: [] as Array<Record<string, unknown>> }))

vi.mock('../../src/renderer/src/stores/commandDataStore', () => ({
  useCommandDataStore: () => ({
    search: () => ({ bestMatches: [], regexMatches: state.matches }),
    searchInCommands: (items: unknown[]) => items,
    searchImageCommands: () => [],
    searchFileCommands: () => [],
    searchTextCommands: () => state.matches,
    matchesWindowCommand: () => false,
    sortRecommendations: (items: unknown[]) => items
  })
}))

vi.mock('../../src/renderer/src/stores/windowStore', () => ({
  useWindowStore: () => ({ currentWindow: null, showMatchRecommendation: true })
}))

afterEach(() => vi.unstubAllGlobals())

describe('字符串推荐与使用次数接入', () => {
  it('异步加载使用次数及二次筛选后，仍优先解码且保留通用入口', async () => {
    const path = '/plugins/string-tools'
    state.matches = ['case', 'lines', 'sql', 'unicode'].map((featureCode) => ({
      type: 'plugin',
      pluginName: 'string-tools',
      path,
      featureCode,
      name: featureCode,
      cmdType: 'regex'
    }))
    state.matches.push({
      type: 'plugin',
      pluginName: 'string-tools',
      path,
      featureCode: 'sql',
      name: '字符串处理',
      cmdType: 'over'
    })
    // 模拟主进程返回相反的使用历史，验证实际 computed 链而非只验证排序辅助函数。
    vi.stubGlobal('window', {
      ztools: {
        getUsageStats: vi.fn().mockResolvedValue([
          { path, featureCode: 'case', useCount: 1000 },
          { path, featureCode: 'sql', useCount: 100 },
          { path, featureCode: 'unicode', useCount: 1 }
        ])
      }
    })
    const scope = effectScope()
    const props = reactive({ searchQuery: '', pastedText: String.raw`\u4e2d` })
    try {
      const result = scope.run(() => useSearchResults(props))!
      await nextTick()
      expect(
        result.bestMatches.value.map((item: { featureCode: string }) => item.featureCode)
      ).toEqual(['unicode', 'sql', 'lines', 'case'])
      expect(result.recommendations.value.map((item: { name: string }) => item.name)).toEqual([
        '字符串处理'
      ])
      props.searchQuery = '工具'
      await nextTick()
      expect(
        result.allListModeResults.value.map((item: { featureCode: string }) => item.featureCode)
      ).toEqual(['unicode', 'sql', 'lines', 'case'])
    } finally {
      scope.stop()
    }
  })
})
