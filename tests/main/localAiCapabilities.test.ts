import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import type { AiProviderStore } from '../../src/shared/aiProviderShared'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  dbGet: vi.fn(),
  dbPut: vi.fn(),
  client: vi.fn(),
  completion: vi.fn(),
  fetch: vi.fn(),
  officialHttp: vi.fn(),
  officialChoices: vi.fn(),
  officialResolve: vi.fn(),
  officialStatus: vi.fn(),
  officialReference: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: mocks, net: { fetch: mocks.fetch } }))
vi.mock('../../src/main/api/shared/database.js', () => ({
  default: { dbGet: mocks.dbGet, dbPut: mocks.dbPut }
}))
vi.mock('../../src/main/core/detachedWindowManager', () => ({
  default: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/utils/httpRequest', () => ({ httpRequest: mocks.officialHttp }))
vi.mock('../../src/main/core/officialAIService.js', () => ({
  default: {
    getModelChoices: mocks.officialChoices,
    resolveModel: mocks.officialResolve,
    getProviderStatus: mocks.officialStatus,
    isOfficialReference: mocks.officialReference
  }
}))
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.completion } }
    /**
     * 记录实际协议适配器创建的供应商连接。
     * @param options SDK 连接参数。
     * @returns 新建的 SDK 替身。
     */
    constructor(options: unknown) {
      mocks.client(options)
    }
  }
}))

let stored: AiProviderStore
let tempRoot: string
let ai: (typeof import('../../src/main/api/plugin/ai'))['default']
let providers: (typeof import('../../src/main/core/aiProviderService'))['default']
let renderer: (typeof import('../../src/main/api/renderer/aiModels'))['default']
const sender = { id: 71, send: vi.fn(), isDestroyed: () => false }

/**
 * 找到实际模块注册的唯一 IPC handler。
 * @param channel 需要调用的 IPC 通道。
 * @returns 对应处理函数。
 */
function handler(channel: string): (...args: any[]) => any {
  const calls = mocks.handle.mock.calls.filter(([name]) => name === channel)
  expect(calls).toHaveLength(1)
  return calls[0][1]
}

/**
 * 为真实流式适配器生成带结束标记的供应商响应。
 * @returns 供应商流式数据。
 */
async function* completionStream() {
  yield { choices: [{ delta: { content: '自配回答' }, finish_reason: 'stop' }] }
}

beforeEach(async () => {
  // 先隔离数据根，再载入实际插件 API，防止间接依赖触碰用户数据。
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-local-ai-'))
  vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(tempRoot, 'data'))
  vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(tempRoot, 'legacy'))
  vi.stubGlobal('fetch', mocks.fetch)
  vi.resetAllMocks()
  vi.resetModules()
  stored = { version: 2, providers: [] }
  mocks.dbGet.mockImplementation(() => stored)
  mocks.dbPut.mockImplementation((_key, value) => {
    stored = value
    return { ok: true }
  })
  // 官方替身有可用响应，确保测试能够发现偷偷回退而不是偶然网络失败。
  mocks.officialChoices.mockImplementation(async () => {
    mocks.officialHttp('official-model-catalog')
    return [{ id: 'official:demo', value: 'official:demo' }]
  })
  mocks.officialResolve.mockImplementation(async () => {
    mocks.officialHttp('official-model-resolve')
    return {
      provider: {
        id: 'official',
        apiFormat: 'openai-chat',
        apiUrl: 'https://official.example',
        apiKey: 'official'
      },
      model: { modelId: 'official-demo' }
    }
  })
  mocks.officialReference.mockImplementation((ref) => ref?.startsWith('official:'))
  mocks.officialStatus.mockImplementation(async () => {
    mocks.officialHttp('official-status')
    return { models: [] }
  })
  mocks.completion.mockImplementation(async (options) =>
    options.stream
      ? completionStream()
      : {
          choices: [{ message: { role: 'assistant', content: '自配回答' }, finish_reason: 'stop' }]
        }
  )
  providers = (await import('../../src/main/core/aiProviderService')).default
  ai = (await import('../../src/main/api/plugin/ai')).default
  renderer = (await import('../../src/main/api/renderer/aiModels')).default
  ai.init(
    { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
    {
      getPluginInfoByWebContents: () => ({ name: 'test', path: 'test' })
    } as any
  )
  renderer.init()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 使用实际供应商写入逻辑准备自配模型。
 * @returns 新供应商的稳定模型选择值。
 */
function configureProvider(): string {
  expect(
    renderer.addProvider({
      name: '自配服务',
      apiUrl: 'https://custom.example/v1',
      apiKey: 'custom-key',
      selectedModels: [{ modelId: 'local-model' }]
    }).success
  ).toBe(true)
  return providers.getModelChoices()[0].value
}

/**
 * 断言所有官方网络和模型入口均未被调用。
 * @returns 无返回值。
 */
function expectNoOfficialTraffic(): void {
  expect(mocks.officialHttp).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.officialChoices).not.toHaveBeenCalled()
  expect(mocks.officialResolve).not.toHaveBeenCalled()
  expect(mocks.officialStatus).not.toHaveBeenCalled()
  expect(mocks.officialReference).not.toHaveBeenCalled()
}

describe('local plugin AI capability boundary', () => {
  it('exposes exactly the configured models through actual plugin IPC', async () => {
    configureProvider()
    await expect(handler('plugin:ai-all-models')({ sender })).resolves.toEqual({
      success: true,
      data: providers.getModelChoices()
    })
    expectNoOfficialTraffic()
  })
  it.each(['plugin:ai-call', 'plugin:ai-call-stream', 'plugin:ai-chat'])(
    '%s sends requests to the selected custom provider',
    async (channel) => {
      const model = configureProvider()
      const result = await handler(channel)({ sender }, channel, {
        model,
        messages: [{ role: 'user', content: 'hello' }]
      })
      expect(result.success).toBe(true)
      expect(mocks.client).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://custom.example/v1',
          apiKey: 'custom-key',
          maxRetries: 0
        })
      )
      expect(mocks.completion).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'local-model' }),
        expect.anything()
      )
      expectNoOfficialTraffic()
    }
  )
  it.each(['plugin:ai-call', 'plugin:ai-call-stream', 'plugin:ai-chat'])(
    '%s explains missing configuration and never falls back to official models',
    async (channel) => {
      for (const model of [undefined, 'official:demo']) {
        const result = await handler(channel)({ sender }, `${channel}-${model}`, {
          model,
          messages: [{ role: 'user', content: 'hello' }]
        })
        expect(result.success).toBe(false)
        expect(typeof result.error === 'string' ? result.error : result.error.message).toContain(
          '设置中添加模型'
        )
      }
      expect(mocks.client).not.toHaveBeenCalled()
      expectNoOfficialTraffic()
    }
  )
  it.each(['plugin:ai-call', 'plugin:ai-call-stream', 'plugin:ai-chat'])(
    '%s explains a missing API key before external traffic',
    async (channel) => {
      const model = configureProvider()
      stored.providers[0].apiKey = '  '
      const result = await handler(channel)({ sender }, channel, {
        model,
        messages: [{ role: 'user', content: 'hello' }]
      })
      expect(result.success).toBe(false)
      expect(typeof result.error === 'string' ? result.error : result.error.message).toContain(
        'API 密钥'
      )
      expect(mocks.client).not.toHaveBeenCalled()
      expectNoOfficialTraffic()
    }
  )
  it('retains local provider CRUD and refuses keyless configuration under the existing contract', () => {
    configureProvider()
    const provider = stored.providers[0]
    expect(renderer.updateProvider({ ...provider, name: '改名' }).success).toBe(true)
    expect(renderer.setProviderEnabled(provider.id, false).success).toBe(true)
    expect(providers.getModelChoices()).toEqual([])
    expect(
      renderer.addProvider({
        name: '免钥',
        apiUrl: 'http://localhost:8080',
        apiKey: '',
        selectedModels: [{ modelId: 'a' }]
      })
    ).toMatchObject({ success: false })
    expect(renderer.deleteProvider(provider.id).success).toBe(true)
    expect(renderer.getAllProviders().providers).toEqual([])
    expectNoOfficialTraffic()
  })
  it('returns official unavailability through renderer and guarded internal IPC without a success wrapper', async () => {
    const expected = { success: false, code: 'OFFICIAL_CAPABILITY_UNAVAILABLE' }
    expect(await handler('ai-providers:get-official')({ sender })).toMatchObject(expected)
    // 仅替换内置插件无关外围依赖，运行实际权限检查和返回值包装。
    const compiled = ts.transpileModule(
      fs.readFileSync(path.resolve('src/main/api/plugin/internal.ts'), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS }
      }
    ).outputText
    const exports: Record<string, any> = {}
    vm.runInNewContext(compiled, {
      exports,
      require: (specifier: string) => {
        if (specifier === 'electron') return { ipcMain: mocks }
        if (specifier.includes('/aiModels')) return { default: renderer }
        return { default: {} }
      }
    })
    new exports.InternalPluginAPI().init(
      {},
      {
        getPluginInfoByWebContents: (contents: { trusted: boolean }) => ({
          canUseInternalApi: contents.trusted
        })
      }
    )
    const call = handler('internal:ai-providers-get-official')
    await expect(call({ sender: { trusted: false } })).rejects.toThrow('仅限内置插件调用')
    expect(await call({ sender: { trusted: true } })).toMatchObject(expected)
    expectNoOfficialTraffic()
  })
})
