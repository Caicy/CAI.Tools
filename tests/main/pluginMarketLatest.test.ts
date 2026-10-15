import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequestPluginMarket = vi.hoisted(() => vi.fn())
const mockDbGet = vi.hoisted(() => vi.fn())
const mockDbPut = vi.hoisted(() => vi.fn())

vi.mock('../../src/main/api/renderer/pluginMarketConfig', () => ({
  PluginMarketAuthRequiredError: class PluginMarketAuthRequiredError extends Error {},
  PluginMarketAuthMode: { OPTIONAL: 'optional', REQUIRED: 'required' },
  getPluginMarketApiBase: () => 'https://z-tools.top/api/market',
  requestPluginMarket: mockRequestPluginMarket
}))

vi.mock('../../src/main/utils/httpRequest.js', () => ({
  httpGet: vi.fn()
}))

vi.mock('../../src/main/api/shared/database', () => ({
  default: {
    dbGet: mockDbGet,
    dbPut: mockDbPut
  }
}))

import { PluginMarketAPI } from '../../src/main/api/renderer/pluginMarket'

describe('PluginMarketAPI anonymous storefront requests', () => {
  const catalogPlugin = { name: 'catalog-demo', version: '1.0.0' }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('routes catalog, recommendations and both rankings through the bounded anonymous request', async () => {
    mockRequestPluginMarket.mockImplementation(async (requestPath: string) => {
      const url = new URL(requestPath, 'https://market.example')
      if (url.pathname === '/plugins') {
        return { data: { categories: [{ id: 1, plugins: [catalogPlugin] }] } }
      }
      if (url.pathname === '/plugins/recommendations') {
        return { data: JSON.stringify({ items: [{ name: 'recommended', version: '2.0.0' }, {}] }) }
      }
      const type = url.searchParams.get('type')
      return { data: { type, items: [{ name: type, version: '3.0.0' }] } }
    })

    const result = await new PluginMarketAPI().fetchPluginMarket()
    // 同一市场刷新必须把全部四个请求交给已验证的匿名认证与超时边界。
    expect(mockRequestPluginMarket).toHaveBeenCalledTimes(4)
    const requests = mockRequestPluginMarket.mock.calls.map(
      ([requestPath]) => new URL(requestPath, 'https://market.example')
    )
    expect(requests.map((url) => url.pathname)).toEqual([
      '/plugins',
      '/plugins/recommendations',
      '/plugins/rankings',
      '/plugins/rankings'
    ])
    expect(requests.every((url) => url.searchParams.get('platform') === process.platform)).toBe(
      true
    )
    expect(requests.slice(2).map((url) => url.searchParams.get('type'))).toEqual([
      'popular',
      'recent'
    ])
    expect(result).toMatchObject({
      success: true,
      data: [catalogPlugin, { name: 'popular' }, { name: 'recent' }],
      storefront: {
        sections: expect.arrayContaining([
          {
            type: 'random',
            key: 'recommendations-0',
            title: '探索发现',
            plugins: [{ name: 'recommended', version: '2.0.0' }]
          }
        ]),
        categories: {
          'ranking-popular': { plugins: [{ name: 'popular', version: '3.0.0' }] },
          'ranking-recent': { plugins: [{ name: 'recent', version: '3.0.0' }] }
        }
      }
    })
    expect(mockDbPut).toHaveBeenCalledWith('plugin-market-data', result.data)
  })

  it.each(['recommendations', 'popular', 'recent'])(
    'retains catalog results when the %s request times out',
    async (failedPart) => {
      mockRequestPluginMarket.mockImplementation(async (requestPath: string) => {
        const url = new URL(requestPath, 'https://market.example')
        if (url.pathname === '/plugins') {
          return { data: { categories: [{ id: 1, plugins: [catalogPlugin] }] } }
        }
        const part = url.pathname.endsWith('/recommendations')
          ? 'recommendations'
          : url.searchParams.get('type')
        if (part === failedPart) throw new Error('HTTP request timed out after 15000ms')
        return { data: { type: part, items: [] } }
      })

      await expect(new PluginMarketAPI().fetchPluginMarket()).resolves.toMatchObject({
        success: true,
        data: [catalogPlugin]
      })
      expect(mockRequestPluginMarket).toHaveBeenCalledTimes(4)
    }
  )

  it.each([true, false])(
    'settles catalog timeout with cached data available: %s',
    async (hasCache) => {
      const timeoutMessage = 'HTTP request timed out after 15000ms'
      mockRequestPluginMarket.mockRejectedValue(new Error(timeoutMessage))
      mockDbGet.mockImplementation((key) =>
        key === 'plugin-market-data' && hasCache ? [catalogPlugin] : undefined
      )

      const result = await new PluginMarketAPI().fetchPluginMarket()
      expect(result).toEqual(
        hasCache
          ? { success: true, data: [catalogPlugin] }
          : { success: false, error: timeoutMessage }
      )
      expect(mockRequestPluginMarket).toHaveBeenCalledTimes(4)
      // 失败刷新不得覆盖仍可用的本地缓存。
      expect(mockDbPut).not.toHaveBeenCalled()
    }
  )
})

describe('PluginMarketAPI.fetchLatestPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deduplicates concurrent requests and reuses the positive cache', async () => {
    let resolveRequest: ((value: any) => void) | undefined
    mockRequestPluginMarket.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const api = new PluginMarketAPI()

    const first = api.fetchLatestPlugin('demo', 'darwin')
    const second = api.fetchLatestPlugin('demo', 'darwin')

    expect(mockRequestPluginMarket).toHaveBeenCalledTimes(1)
    resolveRequest?.({
      status: 200,
      data: {
        available: true,
        plugin: { name: 'demo', title: 'Demo', version: '1.2.0' }
      }
    })

    await expect(first).resolves.toMatchObject({
      available: true,
      plugin: { name: 'demo', version: '1.2.0' }
    })
    await expect(second).resolves.toMatchObject({ available: true })
    await expect(api.fetchLatestPlugin('demo', 'darwin')).resolves.toMatchObject({
      available: true
    })
    expect(mockRequestPluginMarket).toHaveBeenCalledTimes(1)
  })

  it('returns a normal unavailable result for an unlisted plugin', async () => {
    mockRequestPluginMarket.mockResolvedValue({
      status: 200,
      data: { available: false, reason: 'not_found' }
    })
    const api = new PluginMarketAPI()

    await expect(api.fetchLatestPlugin('local-only', 'win32')).resolves.toEqual({
      available: false,
      reason: 'not_found'
    })
  })
})

describe('PluginMarketAPI.fetchReleaseHistory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the configured market endpoint and forwards pagination', async () => {
    mockRequestPluginMarket.mockResolvedValue({
      status: 200,
      data: JSON.stringify({ name: 'demo', currentVersion: '2.0.0', items: [], nextOffset: 40 })
    })
    await expect(new PluginMarketAPI().fetchReleaseHistory(' demo ', 20)).resolves.toMatchObject({
      currentVersion: '2.0.0',
      nextOffset: 40
    })
    expect(mockRequestPluginMarket).toHaveBeenCalledWith(
      '/plugins/releases?name=demo&limit=20&offset=20'
    )
  })

  it('rejects invalid input and invalid responses', async () => {
    const api = new PluginMarketAPI()
    await expect(api.fetchReleaseHistory('')).rejects.toThrow()
    await expect(api.fetchReleaseHistory('demo', -1)).rejects.toThrow()
    expect(mockRequestPluginMarket).not.toHaveBeenCalled()
    mockRequestPluginMarket.mockResolvedValue({ status: 200, data: {} })
    await expect(api.fetchReleaseHistory('demo')).rejects.toThrow('更新日志响应无效')
  })
})
