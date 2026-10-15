import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import LmdbDatabase from '../../src/main/core/lmdb'
import { StorageRouter } from '../../src/main/core/storage/storageRouter'
import { getStorageScopeForKey } from '../../src/main/core/storage/storageRouting'
import { HOST_STORAGE_KEYS } from '../../src/shared/storageKeys'
import type { AiProviderStore } from '../../src/shared/aiProviderShared'
import {
  loadProviderStore,
  saveProviderStore,
  projectAiProviders,
  mergeAiProviders,
  type ProviderStorage
} from '../../src/main/core/gitMirror/aiProviderProjection'

const secret = 'LOCAL_ONLY_SECRET'
const store: AiProviderStore = {
  version: 2,
  providers: [
    {
      id: 'provider-a',
      name: '服务',
      apiUrl: 'https://example.test/v1',
      apiKey: secret,
      apiFormat: 'openai-chat',
      enabled: true,
      selectedModels: [{ ref: 'model-a', modelId: 'model-a', description: undefined }]
    }
  ]
}
const fixtures: { root: string; dbs: LmdbDatabase[] }[] = []

interface CredentialFixture {
  root: string
  device: LmdbDatabase
  account: LmdbDatabase
  router: StorageRouter
  ports: ProviderStorage
  put(key: string, value: unknown): void
}

/**
 * 用真实临时 LMDB 和实际设备/账户路由构造供应商存储端口。
 * @returns 可关闭重开并注入保存故障的临时持久化环境。
 */
function fixture(): CredentialFixture {
  // 独立根目录由本测试拥有，不触碰普通用户数据。
  const root = mkdtempSync(path.join(tmpdir(), 'cai-provider-'))
  const device = new LmdbDatabase({ path: path.join(root, 'device') })
  const account = new LmdbDatabase({ path: path.join(root, 'account') })
  fixtures.push({ root, dbs: [device, account] })
  const router = new StorageRouter({
    getDeviceDb: () => device,
    getAccountDb: () => account
  } as never)
  router.bindAccountDb(account)
  /**
   * 按主程序 data 包装方式保存配置，检查真实数据库结果。
   * @param key ZTOOLS 逻辑键。
   * @param value 配置值。
   * @returns 无返回值。
   * @throws 数据库未成功写入时抛错。
   */
  function put(key: string, value: unknown): void {
    const id = 'ZTOOLS/' + key
    const current = router.get(id)
    const result = router.put({
      _id: id,
      ...(current?._rev ? { _rev: current._rev } : {}),
      data: value
    })
    if (!result.ok) throw new Error('TEST_WRITE_FAILED')
  }
  const ports: ProviderStorage = {
    /**
     * @returns 账户库中的元数据。
     */
    getMetadata: () => router.get('ZTOOLS/' + HOST_STORAGE_KEYS.aiModels)?.data ?? null,
    /**
     * @returns 设备库中的凭据。
     */
    getCredentials: () =>
      router.get('ZTOOLS/' + HOST_STORAGE_KEYS.localAiProviderCredentials)?.data ?? null,
    /**
     * @param value 无密钥元数据。
     * @returns 无返回值。
     * @throws 数据库未成功写入时抛错。
     */
    putMetadata: (value) => put(HOST_STORAGE_KEYS.aiModels, value),
    /**
     * @param value 设备凭据。
     * @returns 无返回值。
     * @throws 数据库未成功写入时抛错。
     */
    putCredentials: (value) => put(HOST_STORAGE_KEYS.localAiProviderCredentials, value)
  }
  return { root, device, account, router, ports, put }
}

afterEach(() => {
  // 先释放全部原生句柄，再清理本文件创建的临时数据。
  for (const fixture of fixtures.splice(0)) {
    for (const db of fixture.dbs) db.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('真实 LMDB 将密钥落到设备库，账户元数据无密钥，运行 API 仍可组装', () => {
  const f = fixture()
  f.put(HOST_STORAGE_KEYS.aiModels, store)
  expect(loadProviderStore(f.ports)).toEqual(store)
  expect(getStorageScopeForKey('ZTOOLS/' + HOST_STORAGE_KEYS.localAiProviderCredentials)).toBe(
    'device'
  )
  expect(
    f.device.get('ZTOOLS/' + HOST_STORAGE_KEYS.localAiProviderCredentials)?.data.keys['provider-a']
  ).toBe(secret)
  expect(f.account.get('ZTOOLS/' + HOST_STORAGE_KEYS.localAiProviderCredentials)).toBeNull()
  expect(JSON.stringify(f.ports.getMetadata())).not.toContain(secret)
  expect(f.ports.getMetadata()).not.toHaveProperty('providers.0.apiKey')
})

test('凭据没有成功读回时，旧完整配置不去除密钥', () => {
  const f = fixture()
  f.put(HOST_STORAGE_KEYS.aiModels, store)
  expect(() => loadProviderStore({ ...f.ports, putCredentials: () => {} })).toThrow(
    'PROVIDER_CREDENTIAL_READBACK_FAILED'
  )
  expect(f.ports.getMetadata()).toHaveProperty('providers.0.apiKey', secret)
})

test('凭据已保存但元数据发布失败，重开数据库后可幂等重试', () => {
  const f = fixture()
  f.put(HOST_STORAGE_KEYS.aiModels, store)
  expect(() =>
    loadProviderStore({
      ...f.ports,
      putMetadata: () => {
        throw new Error('INJECTED_STOP')
      }
    })
  ).toThrow('INJECTED_STOP')
  expect(f.ports.getMetadata()).toHaveProperty('providers.0.apiKey', secret)
  f.router.unbind()
  f.device.close()
  f.account.close()
  fixtures[fixtures.length - 1].dbs = []
  const device = new LmdbDatabase({ path: path.join(f.root, 'device') })
  const account = new LmdbDatabase({ path: path.join(f.root, 'account') })
  fixtures[fixtures.length - 1].dbs = [device, account]
  const router = new StorageRouter({
    getDeviceDb: () => device,
    getAccountDb: () => account
  } as never)
  router.bindAccountDb(account)
  // 保留相同端口合同，只将其指向重开的持久化库。
  const reopened: ProviderStorage = {
    ...f.ports,
    /**
     * @returns 重开的账户库元数据。
     */
    getMetadata: () => router.get('ZTOOLS/ai-models')?.data,
    /**
     * @returns 重开的设备库凭据。
     */
    getCredentials: () => router.get('ZTOOLS/local-ai-provider-credentials')?.data,
    /**
     * @param value 待保存设备凭据。
     * @returns 无返回值。
     */
    putCredentials: (value) => {
      const doc = router.get('ZTOOLS/local-ai-provider-credentials')!
      expect(router.put({ ...doc, data: value }).ok).toBe(true)
    },
    /**
     * @param value 待发布账户元数据。
     * @returns 无返回值。
     */
    putMetadata: (value) => {
      const doc = router.get('ZTOOLS/ai-models')!
      expect(router.put({ ...doc, data: value }).ok).toBe(true)
    }
  }
  expect(loadProviderStore(reopened)).toEqual(store)
  expect(loadProviderStore(reopened)).toEqual(store)
  expect(JSON.stringify(reopened.getMetadata())).not.toContain(secret)
})

test('损坏设备凭据拒绝覆盖；全新设备的元数据不丢提供商但密钥为空', () => {
  const f = fixture()
  saveProviderStore(store, f.ports)
  const metadata = f.ports.getMetadata()
  expect(loadProviderStore({ ...f.ports, getCredentials: () => null })).toHaveProperty(
    'providers.0.apiKey',
    ''
  )
  expect(() =>
    saveProviderStore(store, { ...f.ports, getCredentials: () => ({ version: 9, keys: {} }) })
  ).toThrow('INVALID_PROVIDER_CREDENTIALS')
  expect(f.ports.getMetadata()).toEqual(metadata)
})

test.each([
  'https://user:pass@example.test/v1',
  'https://example.test/v1?token=' + secret,
  'https://example.test/v1#' + secret
])('含鉴权信息的 URL 留本机 %s', (apiUrl) => {
  const payload = projectAiProviders({ ...store, providers: [{ ...store.providers[0], apiUrl }] })
  expect(JSON.stringify(payload)).not.toContain(secret)
  expect(payload).not.toHaveProperty('providers.0.apiUrl')
  expect(
    mergeAiProviders(payload, { ...store, providers: [{ ...store.providers[0], apiUrl }] })
  ).toHaveProperty('providers.0.apiUrl', apiUrl)
  expect(mergeAiProviders(payload, { version: 2, providers: [] })).toHaveProperty(
    'providers.0.enabled',
    false
  )
})

test('供应商投影不携带密钥，接收内容不抹掉本机密钥', () => {
  const payload = projectAiProviders(store)
  expect(JSON.stringify(payload)).not.toContain(secret)
  expect(mergeAiProviders(payload, store)).toHaveProperty('providers.0.apiKey', secret)
  expect(mergeAiProviders(payload, { version: 2, providers: [] })).toHaveProperty(
    'providers.0.apiKey',
    ''
  )
  expect(() =>
    projectAiProviders({
      ...store,
      providers: [{ ...store.providers[0], token: 'secret' } as never]
    })
  ).toThrow('UNSUPPORTED_FIELD')
  expect(() =>
    projectAiProviders({
      ...store,
      providers: [
        {
          ...store.providers[0],
          selectedModels: [
            { ...store.providers[0].selectedModels[0], reasoning: { apiKey: secret } as never }
          ]
        }
      ]
    })
  ).toThrow('UNSUPPORTED_FIELD')
})
