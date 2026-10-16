import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken } from 'builder-util-runtime'
import type { PlatformUpdaterCallbacks } from '../../src/main/api/platformUpdater/types'

const updaterMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

vi.mock('electron-log', () => ({
  default: {}
}))

vi.mock('electron-updater', () => ({
  NsisUpdater: class {},
  autoUpdater: {
    currentVersion: { prerelease: [], version: '3.0.2' },
    downloadUpdate: updaterMocks.downloadUpdate,
    checkForUpdates: updaterMocks.checkForUpdates,
    quitAndInstall: updaterMocks.quitAndInstall,
    setFeedURL: updaterMocks.setFeedURL,
    on: updaterMocks.on,
    removeListener: updaterMocks.removeListener
  }
}))

import { ElectronUpdaterService } from '../../src/main/api/electronUpdater'

describe('ElectronUpdaterService cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updaterMocks.checkForUpdates.mockResolvedValue({
      updateInfo: { version: '3.1.0', releaseNotes: 'New version' }
    })
    updaterMocks.downloadUpdate.mockImplementation(
      (cancellationToken: CancellationToken) =>
        new Promise((_resolve, reject) => {
          cancellationToken.once('cancel', () => reject(new Error('cancelled')))
        })
    )
  })

  it('cancels an active download without installing and allows a new download', async () => {
    const callbacks: PlatformUpdaterCallbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)
    await service.checkForUpdates()

    // 启动下载后立即取消，验证安装流程不会继续执行。
    const firstDownload = service.downloadAndInstall()
    const cancelResult = await service.cancelUpdate()

    expect(cancelResult).toEqual({ success: true, cancelled: true })
    await expect(firstDownload).resolves.toEqual({ success: false, cancelled: true })
    expect(service.getDownloadStatus().status).toBe('available')
    expect(callbacks.onDownloadCancelled).toHaveBeenCalledOnce()
    expect(callbacks.onDownloadFailed).not.toHaveBeenCalled()
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()

    // 模拟底层下载进入无法中断的收尾阶段，完成后仍不得继续安装。
    let finishSecondDownload: (() => void) | null = null
    updaterMocks.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finishSecondDownload = () => resolve(['/update'])
        })
    )
    const secondDownload = service.downloadUpdate(false)
    expect(updaterMocks.downloadUpdate).toHaveBeenCalledTimes(2)
    const secondCancellation = service.cancelUpdate()
    finishSecondDownload?.()

    await expect(secondCancellation).resolves.toEqual({ success: true, cancelled: true })
    await expect(secondDownload).resolves.toEqual({ success: false, cancelled: true })
    expect(callbacks.onDownloadCancelled).toHaveBeenCalledTimes(2)
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()
  })

  it('pins the public CAI.Tools local channel and refuses a foreign feed', async () => {
    const { autoUpdater } = await import('electron-updater')
    const service = new ElectronUpdaterService({
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    })
    expect(updaterMocks.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'Caicy',
      repo: 'CAI.Tools',
      private: false
    })
    expect(autoUpdater.channel).toBe('local')
    expect(autoUpdater.allowDowngrade).toBe(false)
    await expect(
      service.downloadAndInstall({
        version: '3.2.0-local.4',
        changelog: '',
        feedUrl: 'https://example.com/feed'
      })
    ).resolves.toMatchObject({ success: false })
    expect(updaterMocks.downloadUpdate).not.toHaveBeenCalled()
  })

  it('keeps the downloaded update and restores quit state when installation throws', async () => {
    const callbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn(),
      onInstallFailed: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)
    await service.checkForUpdates()
    const downloaded = updaterMocks.on.mock.calls.find(
      ([event]) => event === 'update-downloaded'
    )![1]
    downloaded({ version: '3.2.0-local.4', releaseNotes: '' })
    updaterMocks.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('permission denied')
    })
    expect(service.installDownloadedUpdate()).toMatchObject({
      success: false,
      error: 'permission denied'
    })
    expect(service.getDownloadStatus().hasDownloaded).toBe(true)
    expect(callbacks.onInstallFailed).toHaveBeenCalledOnce()
  })

  it('retries a failed download and installs only after the verified completion event', async () => {
    const callbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)
    await service.checkForUpdates()
    updaterMocks.downloadUpdate.mockRejectedValueOnce(new Error('SHA512 checksum mismatch'))
    await expect(service.downloadAndInstall()).resolves.toMatchObject({
      success: false,
      error: 'SHA512 checksum mismatch'
    })
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()
    updaterMocks.downloadUpdate.mockImplementationOnce(async () => {
      updaterMocks.on.mock.calls.find(([event]) => event === 'update-downloaded')![1]({
        version: '3.1.0'
      })
      return ['/fixture-setup.exe']
    })
    await expect(service.downloadAndInstall()).resolves.toEqual({ success: true })
    expect(updaterMocks.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
    expect(callbacks.onBeforeInstall).toHaveBeenCalledOnce()
  })

  it('merges concurrent checks and preserves a downloaded update during further checks', async () => {
    const callbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)
    await Promise.all([service.checkForUpdates(), service.checkForUpdates()])
    expect(updaterMocks.checkForUpdates).toHaveBeenCalledOnce()
    updaterMocks.on.mock.calls.find(([event]) => event === 'update-downloaded')![1]({
      version: '3.1.0'
    })
    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'downloaded',
      hasUpdate: true
    })
    expect(service.getDownloadStatus().hasDownloaded).toBe(true)
    expect(updaterMocks.checkForUpdates).toHaveBeenCalledOnce()
    service.cleanup()
    expect(updaterMocks.removeListener).toHaveBeenCalledTimes(6)
  })

  it('returns a network check failure without installing or offering an update', async () => {
    const service = new ElectronUpdaterService({
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    })
    updaterMocks.checkForUpdates.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(service.checkForUpdates()).resolves.toMatchObject({
      success: false,
      hasUpdate: false,
      error: 'network unavailable'
    })
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()
  })
})
