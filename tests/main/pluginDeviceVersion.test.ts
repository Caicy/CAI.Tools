import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPSTREAM_BASE_VERSION } from '../../src/shared/localEdition'

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  getVersion: vi.fn(() => '3.2.0-local.1')
}))

vi.mock('electron', () => ({
  app: { getVersion: mocks.getVersion },
  ipcMain: { on: mocks.on }
}))

import { PluginDeviceAPI } from '../../src/main/api/plugin/device'

beforeEach(() => vi.clearAllMocks())

describe('plugin application version compatibility', () => {
  it('reports the upstream API baseline instead of the local prerelease version', () => {
    new PluginDeviceAPI().init()
    const handlers = mocks.on.mock.calls.filter(([channel]) => channel === 'get-app-version')
    expect(handlers).toHaveLength(1)
    const event = { returnValue: undefined }

    // 第三方插件按稳定版本门槛检查 API；本地构建后缀不能使兼容基线降级。
    handlers[0][1](event)
    expect(event.returnValue).toBe(UPSTREAM_BASE_VERSION)
    expect(event.returnValue).toMatch(/^\d+\.\d+\.\d+$/)
    expect(mocks.getVersion).not.toHaveBeenCalled()
  })
})
