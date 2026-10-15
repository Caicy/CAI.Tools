import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

describe('ordinary runtime audit instrumentation', () => {
  it('records every transport before business import, forwards unchanged and redacts credentials', async () => {
    const lines: string[] = []
    const marker = { forwarded: true }
    const nodeHttp = { request: vi.fn(() => marker), get: vi.fn(() => marker) }
    const nodeHttps = { request: vi.fn(() => marker), get: vi.fn(() => marker) }
    const net = { request: vi.fn(() => marker), fetch: vi.fn(() => marker) }
    const originalRequest = nodeHttp.request
    const app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve() })
    const defaultSession = { webRequest: { onBeforeRequest: vi.fn() } }
    const context = {
      URL,
      WeakSet,
      Date,
      Reflect,
      process: { env: { CAI_RUNTIME_AUDIT_LOG: 'isolated-log' } },
      fetch: vi.fn(() => marker),
      require: Object.assign(
        (id: string) => {
          if (id === 'node:fs')
            return { appendFileSync: (_path: string, line: string) => lines.push(line) }
          if (id === 'node:http') return nodeHttp
          if (id === 'node:https') return nodeHttps
          return { app, net, session: { defaultSession } }
        },
        { cache: {} }
      )
    }
    vm.runInNewContext(fs.readFileSync('scripts/local-runtime-network-hook.cjs', 'utf8'), context)
    await Promise.resolve()
    expect(JSON.parse(lines[0])).toMatchObject({
      source: 'audit.initialized',
      e2e: null,
      businessLoaded: false
    })
    const secretUrl = 'https://user:password@example.test/a/path?token=private#hidden'
    const options = { headers: { authorization: 'Bearer credential' }, body: 'private body' }
    expect(context.fetch(secretUrl, options)).toBe(marker)
    for (const transport of [nodeHttp, nodeHttps]) {
      expect(transport.request(secretUrl, options)).toBe(marker)
      expect(transport.get(secretUrl, options)).toBe(marker)
    }
    expect(originalRequest).toHaveBeenCalledWith(secretUrl, options)
    expect(net.request({ url: secretUrl })).toBe(marker)
    expect(net.fetch(secretUrl, options)).toBe(marker)
    const nextSession = { webRequest: { onBeforeRequest: vi.fn() } }
    app.emit('session-created', nextSession)
    app.emit('session-created', nextSession)
    expect(nextSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    for (const current of [defaultSession, nextSession]) {
      const continueRequest = vi.fn()
      current.webRequest.onBeforeRequest.mock.calls[0][0]({ url: secretUrl }, continueRequest)
      expect(continueRequest).toHaveBeenCalledWith({ cancel: false })
    }
    const recorded = lines.slice(1).map((line) => JSON.parse(line))
    expect(new Set(recorded.map((event) => event.source))).toEqual(
      new Set([
        'node.fetch',
        'node.http.request',
        'node.http.get',
        'node.https.request',
        'node.https.get',
        'electron.net.request',
        'electron.net.fetch',
        'session.webRequest'
      ])
    )
    for (const event of recorded) {
      expect(event).toMatchObject({ origin: 'https://example.test', path: '/a/path' })
      expect(Object.keys(event).sort()).toEqual(['origin', 'path', 'source', 'time'])
    }
    for (const secret of ['password', 'token', 'private', 'credential', 'hidden'])
      expect(lines.join('')).not.toContain(secret)
  })
})
