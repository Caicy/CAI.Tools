import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({
  http: vi.fn(),
  netRequest: vi.fn(),
  loadSession: vi.fn(),
  refreshTokens: vi.fn(),
  saveSession: vi.fn()
}))
vi.mock('../../src/main/core/account/officialAccountService', () => ({
  loadOfficialAccountSession: mocks.loadSession,
  refreshOfficialAccountTokens: mocks.refreshTokens,
  saveOfficialAccountSession: mocks.saveSession
}))
vi.mock('../../src/main/utils/httpRequest.js', () => ({ httpRequest: mocks.http }))
vi.mock('electron', () => ({ net: { request: mocks.netRequest }, session: { defaultSession: {} } }))

import {
  getPluginMarketApiBase,
  getPluginMarketAuthHeaders,
  PluginMarketAuthRequiredError,
  PluginMarketAuthMode,
  requestPluginMarket,
  savePluginMarketTokens
} from '../../src/main/api/renderer/pluginMarketConfig'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.loadSession.mockResolvedValue({ token: 'official-token', refreshToken: 'refresh-token' })
  mocks.refreshTokens.mockResolvedValue({ status: 'failed' })
  mocks.http.mockResolvedValue({ status: 200, data: { items: [] } })
})
afterEach(() => vi.useRealTimers())

describe('anonymous local plugin market', () => {
  it('strips every Authorization casing and reads no official session', async () => {
    const headers = {
      Authorization: 'Bearer one',
      authorization: 'Bearer two',
      AUTHORIZATION: 'Bearer three',
      aUtHoRiZaTiOn: 'Bearer four',
      Accept: 'application/json'
    }
    await requestPluginMarket('/plugins', { headers })
    expect(mocks.http).toHaveBeenCalledTimes(1)
    expect(mocks.http.mock.calls[0][0]).toBe(`${getPluginMarketApiBase()}/plugins`)
    expect(mocks.http.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' })
    expect(headers.Authorization).toBe('Bearer one')
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.refreshTokens).not.toHaveBeenCalled()
  })
  it('keeps an explicit external endpoint and its downloadUrl intact', async () => {
    const data = { downloadUrl: 'https://cdn.example/demo.zpx' }
    mocks.http.mockResolvedValue({ status: 200, data })
    await expect(requestPluginMarket('https://market.example/download')).resolves.toMatchObject({
      data
    })
    expect(mocks.http.mock.calls[0][0]).toBe('https://market.example/download')
  })
  it('rejects required official operations before any network or session access', async () => {
    await expect(
      requestPluginMarket('/plugins/comments', { method: 'POST' }, PluginMarketAuthMode.REQUIRED)
    ).rejects.toThrow('此操作需要官方账号，本地版不提供')
    expect(mocks.http).not.toHaveBeenCalled()
    expect(mocks.loadSession).not.toHaveBeenCalled()
  })
  it.each([401, 403, 429])(
    'exits on HTTP %s without login retry or token refresh',
    async (status) => {
      // 只模拟 HTTP 状态校验，保留真实市场包装函数的全部重试行为。
      mocks.http.mockImplementation(async (_url, options) => {
        if (!options.validateStatus(status))
          throw new Error(`Request failed with status code ${status}`)
        return { status, data: {} }
      })
      const result = await requestPluginMarket('/plugins').catch((error) => error)
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toContain(String(status))
      expect(result).not.toBeInstanceOf(PluginMarketAuthRequiredError)
      expect(mocks.http).toHaveBeenCalledTimes(1)
      expect(mocks.loadSession).not.toHaveBeenCalled()
      expect(mocks.refreshTokens).not.toHaveBeenCalled()
    }
  )
  it('returns no authentication headers and refuses to save official tokens', async () => {
    await expect(getPluginMarketAuthHeaders()).resolves.toEqual({})
    await expect(
      savePluginMarketTokens({ token: 'token', username: 'user' })
    ).rejects.toMatchObject({
      code: 'OFFICIAL_CAPABILITY_UNAVAILABLE'
    })
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.saveSession).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'uses a finite 15 second default for timeout %s',
    async (timeout) => {
      await requestPluginMarket('/plugins', { timeout } as any)
      expect(mocks.http.mock.calls[0][1].timeout).toBe(15_000)
    }
  )
  it('preserves an explicitly shorter timeout', async () => {
    await requestPluginMarket('/plugins', { timeout: 20 } as any)
    expect(mocks.http.mock.calls[0][1].timeout).toBe(20)
  })
  it('caps an explicitly longer timeout at 15 seconds', async () => {
    await requestPluginMarket('/plugins', { timeout: 60_000 })
    expect(mocks.http.mock.calls[0][1].timeout).toBe(15_000)
  })
})

/**
 * 建立不会自行完成的 Electron 请求替身，供真实 HTTP 包装函数驱动事件和取消。
 * @returns 可控制完成、失败及中止的请求。
 */
function pendingRequest() {
  const request = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    abort: vi.fn()
  })
  // Electron 可能仅报告 abort 而不报告 error；包装函数必须自行结束超时 Promise。
  request.abort.mockImplementation(() => request.emit('abort'))
  mocks.netRequest.mockReturnValue(request)
  return request
}

/**
 * 在请求上发布完整 JSON 响应。
 * @param request 待完成的请求。
 * @param status 响应状态码。
 * @returns 无返回值。
 */
function respond(request: EventEmitter, status = 200): void {
  const response = Object.assign(new EventEmitter(), {
    statusCode: status,
    statusMessage: status === 200 ? 'OK' : 'Unauthorized',
    headers: { 'content-type': 'application/json' }
  })
  request.emit('response', response)
  response.emit('data', Buffer.from('{"items":[]}'))
  response.emit('end')
}

describe('market timeout through the actual httpRequest implementation', () => {
  it('aborts and settles a stalled request without any login retry', async () => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof import('../../src/main/utils/httpRequest')>(
      '../../src/main/utils/httpRequest'
    )
    mocks.http.mockImplementation(actual.httpRequest)
    const request = pendingRequest()
    const result = requestPluginMarket('/plugins', { timeout: 20 } as any).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20)
    // 先断言原生请求被取消，避免缺失超时实现时测试自己永久等待。
    expect(request.abort).toHaveBeenCalledTimes(1)
    expect(await result).toMatchObject({ code: 'ETIMEDOUT' })
    expect(mocks.netRequest).toHaveBeenCalledTimes(1)
    expect(mocks.refreshTokens).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['success', 'status-error', 'request-error', 'response-error', 'abort'])(
    'clears the timeout after %s',
    async (outcome) => {
      vi.useFakeTimers()
      const actual = await vi.importActual<typeof import('../../src/main/utils/httpRequest')>(
        '../../src/main/utils/httpRequest'
      )
      const request = pendingRequest()
      const result = actual
        .httpRequest('https://market.example', { timeout: 100 } as any)
        .catch((error) => error)
      if (outcome === 'success') respond(request)
      else if (outcome === 'status-error') respond(request, 401)
      else if (outcome === 'request-error') request.emit('error', new Error('disconnected'))
      else if (outcome === 'response-error') {
        const response = Object.assign(new EventEmitter(), { headers: {} })
        request.emit('response', response)
        response.emit('error', new Error('response disconnected'))
      } else request.abort()
      await Promise.resolve()
      const settled = await Promise.race([result, Promise.resolve('still-pending')])
      expect(settled).not.toBe('still-pending')
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('keeps other HTTP callers timeout-free unless they opt in', async () => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof import('../../src/main/utils/httpRequest')>(
      '../../src/main/utils/httpRequest'
    )
    const request = pendingRequest()
    const result = actual.httpRequest('https://other.example')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request.abort).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    respond(request)
    await expect(result).resolves.toMatchObject({ status: 200 })
  })
})
