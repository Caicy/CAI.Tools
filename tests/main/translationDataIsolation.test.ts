import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({ home: vi.fn(), settings: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: mocks.home }, ipcMain: { handle: mocks.handle } }))
vi.mock('../../src/main/api/shared/database.js', () => ({ default: { dbGet: mocks.settings } }))
const ownedRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('translation resource isolation', () => {
  it('initializes enabled translation resources under the explicit local root without touching upstream data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-translation-isolation-'))
    ownedRoots.push(root)
    const dataRoot = path.join(root, 'local data')
    const fakeHome = path.join(root, 'fake-home')
    const upstream = path.join(fakeHome, '.ztools')
    fs.mkdirSync(upstream, { recursive: true })
    fs.writeFileSync(path.join(upstream, 'sentinel'), 'untouched')
    vi.stubEnv('ZTOOLS_DATA_ROOT', dataRoot)
    vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(root, 'legacy'))
    mocks.home.mockReturnValue(fakeHome)
    mocks.settings.mockReturnValue({ superPanelTranslateEnabled: true })
    vi.resetModules()
    const { default: manager } = await import('../../src/main/core/translationManager')
    // 模型下载与 WASM 执行不属于目录测试；保留资源创建、就地补丁及模型读取的真实文件访问。
    const download = vi
      .spyOn(manager as any, 'downloadResource')
      .mockImplementation(async (_url: string, filePath: string) => {
        fs.writeFileSync(filePath, 'fixture-resource')
      })
    vi.spyOn(manager as any, 'createWorker').mockResolvedValue(undefined)
    vi.spyOn(manager as any, 'sendWorkerMessage').mockResolvedValue(undefined)
    const exists = vi.spyOn(fs, 'existsSync')
    const reads = vi.spyOn(fs, 'readFileSync')
    const writes = vi.spyOn(fs, 'writeFileSync')
    const directories = vi.spyOn(fs, 'mkdirSync')

    manager.init()
    await vi.waitFor(() => expect(manager.getStatus().status).toBe('ready'))
    const expectedDirectory = path.join(dataRoot, 'bergamot-translation')
    expect((manager as any).translationDir).toBe(expectedDirectory)
    expect(download).toHaveBeenCalledTimes(7)
    const touched = [
      ...exists.mock.calls,
      ...reads.mock.calls,
      ...writes.mock.calls,
      ...directories.mock.calls
    ].map(([target]) => String(target))
    expect(touched.length).toBeGreaterThan(7)
    expect(
      touched.every(
        (target) => target === expectedDirectory || target.startsWith(expectedDirectory + path.sep)
      )
    ).toBe(true)
    expect(touched.some((target) => target.startsWith(upstream))).toBe(false)
    expect(mocks.home).not.toHaveBeenCalled()
    // 停止跟踪后再回读哨兵，避免把测试自身校验误记为产品访问。
    vi.restoreAllMocks()
    expect(fs.readdirSync(upstream)).toEqual(['sentinel'])
    expect(fs.readFileSync(path.join(upstream, 'sentinel'), 'utf8')).toBe('untouched')
  })
})
