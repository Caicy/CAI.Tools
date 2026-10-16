import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IPCListener = (...args: unknown[]) => void

const mocks = vi.hoisted(() => {
  const ipcListeners = new Map<string, IPCListener>()
  const navigationListeners = new Map<string, IPCListener>()
  const latestWindow = { current: null as any }
  const openExternal = vi.fn(() => Promise.resolve())
  const windowOpenHandler = { current: null as null | ((details: { url: string }) => unknown) }
  const browserWindow = vi.fn(function BrowserWindowMock(
    options: Electron.BrowserWindowConstructorOptions
  ) {
    const handlers = new Map<string, () => void>()
    const win = {
      options,
      webContents: {
        send: vi.fn(),
        on: vi.fn((event: string, handler: IPCListener) => navigationListeners.set(event, handler)),
        setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => unknown) => {
          windowOpenHandler.current = handler
        })
      },
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      minimize: vi.fn(),
      close: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler))
    }
    latestWindow.current = win
    return win
  })

  return {
    initialize: vi.fn(() => Promise.resolve()),
    checkForUpdates: vi.fn(),
    browserWindow,
    ipcListeners,
    latestWindow,
    navigationListeners,
    openExternal,
    windowOpenHandler
  }
})

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => 'D:\\ztools'),
    getVersion: vi.fn(() => '3.1.0'),
    isPackaged: true
  },
  BrowserWindow: mocks.browserWindow,
  dialog: {
    showMessageBox: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, listener: IPCListener) => {
      mocks.ipcListeners.set(channel, listener)
    })
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }))
  },
  shell: {
    openExternal: mocks.openExternal
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

vi.mock('@platform-updater', () => ({
  default: vi.fn(() => ({
    initialize: mocks.initialize,
    cleanup: vi.fn(),
    getDownloadStatus: vi.fn(() => ({ hasDownloaded: false, status: 'idle' })),
    checkForUpdates: mocks.checkForUpdates,
    startUpdate: vi.fn(),
    cancelUpdate: vi.fn(),
    installDownloadedUpdate: vi.fn()
  }))
}))

vi.mock('../../src/main/api/shared/database.js', () => ({
  default: {
    dbGet: vi.fn(() => null)
  }
}))

vi.mock('../../src/main/managers/windowManager', () => ({
  default: {
    setQuitting: vi.fn()
  }
}))

vi.mock('../../src/main/utils/windowUtils.js', () => ({
  applyWindowMaterial: vi.fn(),
  getDefaultWindowMaterial: vi.fn(() => 'none')
}))

import { UpdaterAPI } from '../../src/main/api/updater'
import databaseAPI from '../../src/main/api/shared/database.js'

describe('updater window controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkForUpdates.mockResolvedValue({
      success: true,
      hasUpdate: true,
      status: 'available',
      latestVersion: '3.2.0-local.4',
      updateInfo: { version: '3.2.0-local.4', changelog: 'Changes', sources: [] }
    })
    vi.useFakeTimers()
    vi.stubEnv('ZTOOLS_E2E', '1')
    vi.mocked(databaseAPI.dbGet).mockReturnValue(null)
    mocks.ipcListeners.clear()
    mocks.navigationListeners.clear()
    mocks.latestWindow.current = null
    mocks.windowOpenHandler.current = null
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('checks the update catalog on startup and every 30 minutes without heartbeat responses', async () => {
    vi.stubEnv('ZTOOLS_E2E', '0')
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(mocks.browserWindow).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(mocks.browserWindow).toHaveBeenCalledTimes(1)

    updater.setAutoCheck(false)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2)

    updater.setAutoCheck(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(3)
    updater.cleanup()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps automatic checks off when disabled while allowing manual checks', async () => {
    vi.stubEnv('ZTOOLS_E2E', '0')
    vi.mocked(databaseAPI.dbGet).mockReturnValue({ autoCheckUpdate: false })
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()

    expect(await updater.checkUpdate()).toMatchObject({ success: true, hasUpdate: true })
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce()
    updater.cleanup()
  })

  it('reports platform initialization failures instead of claiming the current version is latest', async () => {
    mocks.initialize.mockRejectedValueOnce(new Error('update configuration unavailable'))
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)
    await expect(updater.checkUpdate()).resolves.toMatchObject({
      success: false,
      hasUpdate: false,
      error: 'update configuration unavailable'
    })
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    updater.cleanup()
  })

  it('does not notify when automatic checks are disabled during an in-flight request', async () => {
    vi.stubEnv('ZTOOLS_E2E', '0')
    let resolveUpdate!: (value: any) => void
    vi.mocked(mocks.checkForUpdates).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve
        })
    )
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)
    await vi.advanceTimersByTimeAsync(0)
    updater.setAutoCheck(false)
    resolveUpdate({
      success: true,
      hasUpdate: true,
      updateInfo: { version: '3.2.0-local.4', changelog: '' }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.browserWindow).not.toHaveBeenCalled()
    updater.cleanup()
  })

  it('creates a minimizable window and minimizes it through IPC', async () => {
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)

    const result = await updater.checkUpdate()

    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ success: true })
    expect(mocks.browserWindow).toHaveBeenCalledWith(expect.objectContaining({ minimizable: true }))
    const minimizeListener = mocks.ipcListeners.get('updater:minimize-window')
    expect(minimizeListener).toBeTypeOf('function')

    minimizeListener?.()

    expect(mocks.latestWindow.current.minimize).toHaveBeenCalledOnce()
  })

  it('opens changelog links in the system browser without navigating the update window', async () => {
    const updater = new UpdaterAPI()
    updater.init({ webContents: { send: vi.fn() } } as any)
    await updater.checkUpdate()

    const navigationListener = mocks.navigationListeners.get('will-navigate')
    const navigationEvent = { preventDefault: vi.fn() }
    expect(navigationListener).toBeTypeOf('function')

    navigationListener?.(navigationEvent, 'https://github.com/ZToolsCenter/ZTools/issues/642')

    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/ZToolsCenter/ZTools/issues/642'
    )

    const windowOpenResult = mocks.windowOpenHandler.current?.({
      url: 'http://example.com/release-notes'
    })
    expect(windowOpenResult).toEqual({ action: 'deny' })
    expect(mocks.openExternal).toHaveBeenCalledWith('http://example.com/release-notes')

    // 非网页协议必须被拦截，但不能交由操作系统执行。
    navigationListener?.({ preventDefault: vi.fn() }, 'file:///tmp/untrusted-release-note')
    expect(mocks.openExternal).toHaveBeenCalledTimes(2)
  })
})
