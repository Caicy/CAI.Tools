import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getPluginDataPath, getPluginDataRoot } from '../../src/main/core/appData/appDataPaths'

vi.mock('electron', () => ({
  app: { getPath: vi.fn() }
}))

describe('getPluginDataPath', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-plugin-data-'))
    vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(homeDir, 'data'))
    vi.stubEnv('ZTOOLS_LEGACY_USER_DATA_PATH', path.join(homeDir, 'legacy'))
    // 默认目录测试也只能解析临时 home，不能回退到真实用户目录。
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('返回数据根目录下的插件数据根容器', () => {
    vi.stubEnv('ZTOOLS_DATA_ROOT', '')
    expect(getPluginDataRoot()).toBe(path.join(homeDir, '.cai-tools', 'plugins-data'))
  })

  it('返回插件名对应的专属数据目录', () => {
    vi.stubEnv('ZTOOLS_DATA_ROOT', '')
    expect(getPluginDataPath('demo')).toBe(path.join(homeDir, '.cai-tools', 'plugins-data', 'demo'))
  })

  it('支持通过 ZTOOLS_DATA_ROOT 隔离数据根目录', () => {
    vi.stubEnv('ZTOOLS_DATA_ROOT', path.join(homeDir, 'custom-data'))
    expect(getPluginDataPath('demo')).toBe(
      path.join(process.env.ZTOOLS_DATA_ROOT, 'plugins-data', 'demo')
    )
  })

  it('拒绝会导致目录穿越的插件名', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'C:\\evil', '/abs']) {
      expect(() => getPluginDataPath(name)).toThrow()
    }
  })
})
