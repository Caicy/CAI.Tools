import { describe, expect, it } from 'vitest'
import {
  BUNDLED_INTERNAL_PLUGIN_NAMES,
  INTERNAL_API_PLUGIN_NAMES,
  canPluginUseInternalApi,
  isBundledInternalPlugin,
  normalizeCustomInternalApiPluginNames
} from '../../src/main/core/internalPlugins'

describe('internal plugin privilege split', () => {
  it('将字符串工具随包内置，但不授予内部管理 API 权限', () => {
    expect(isBundledInternalPlugin('string-tools')).toBe(true)
    expect(canPluginUseInternalApi('string-tools')).toBe(false)
    expect(canPluginUseInternalApi('setting')).toBe(true)
    expect(canPluginUseInternalApi('system')).toBe(true)
  })

  it('应将开发者插件识别为仅拥有内部 API 权限', () => {
    expect(INTERNAL_API_PLUGIN_NAMES).toContain('ztools-developer-plugin')
    expect(BUNDLED_INTERNAL_PLUGIN_NAMES).not.toContain('ztools-developer-plugin')
    expect(canPluginUseInternalApi('ztools-developer-plugin')).toBe(true)
    expect(isBundledInternalPlugin('ztools-developer-plugin')).toBe(false)
  })

  it('应归一化用户自定义内部 API 授权插件名称', () => {
    expect(
      normalizeCustomInternalApiPluginNames([
        ' custom-plugin ',
        '',
        'custom-plugin',
        null,
        'another-plugin'
      ])
    ).toEqual(['custom-plugin', 'another-plugin'])
  })

  it('应支持通过用户授权名单授予内部 API 权限', () => {
    expect(canPluginUseInternalApi('custom-plugin')).toBe(false)
    expect(canPluginUseInternalApi('custom-plugin', ['custom-plugin'])).toBe(true)
  })
})
