import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import databaseAPI from '../../src/main/api/shared/database'

vi.mock('electron', () => ({
  app: { dock: { hide: vi.fn(), show: vi.fn() } },
  BrowserWindow: class {},
  ipcMain: { off: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  WebContentsView: class {}
}))

vi.mock('../../src/main/api/shared/database', () => ({
  default: { dbGet: vi.fn(() => ({})), dbPut: vi.fn() }
}))

vi.mock('../../src/main/utils/windowUtils', () => ({
  applyWindowMaterial: vi.fn()
}))

vi.mock('../../src/main/core/globalStyles.js', () => ({
  GLOBAL_SCROLLBAR_CSS: ''
}))

vi.mock('../../src/main/core/lmdb/lmdbInstance', () => ({
  default: { promises: { get: vi.fn() } }
}))

vi.mock('../../src/main/utils/devToolsShortcut', () => ({
  default: { register: vi.fn() },
  getDevToolsMode: vi.fn(() => 'detach')
}))

vi.mock('../../src/main/managers/pluginManager', () => ({
  registerExternalLinkInterceptor: vi.fn()
}))

vi.mock('../../src/main/core/pluginWindowManager', () => ({
  default: { closeByPlugin: vi.fn() }
}))

vi.mock('../../src/main/utils/appBundlePath', () => ({
  getPreloadPath: vi.fn(() => '/preload.js'),
  getRendererPath: vi.fn(() => '/renderer')
}))

import detachedWindowManager, {
  DETACHED_TITLEBAR_HEIGHT
} from '../../src/main/core/detachedWindowManager'

/**
 * 安装带同步和迟到 resize 的模拟窗口，执行真实布局与保存回调。
 * @returns 窗口内容尺寸、插件视图及触发 resize 的测试接口。
 */
function mountHeaderWindow(): any {
  const manager = detachedWindowManager as any
  const state = {
    content: { x: 0, y: 0, width: 806, height: 598 },
    view: { x: 0, y: 52, width: 803, height: 544 }
  }
  const view = {
    getBounds: () => ({ ...state.view }),
    /**
     * 更新模拟插件视图的实际边界。
     * @param bounds 新的插件视图边界。
     * @returns 无返回值。
     */
    setBounds: (bounds: Electron.Rectangle) => {
      state.view = { ...bounds }
    }
  }
  const win = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
    getContentBounds: () => ({ ...state.content }),
    setMinimumSize: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    /**
     * 模拟原生内容尺寸偏差及同步、迟到的 resize 通知。
     * @param width 请求的窗口内容宽度。
     * @param height 请求的窗口内容高度。
     * @returns 无返回值。
     */
    setContentSize: (width: number, height: number) => {
      state.content = { x: 0, y: 0, width: width + 3, height: height + 2 }
      manager.updateResizedWindowLayout('header-window', win, view, 'demo')
      // 同次原生尺寸也可能在 setter 返回后再通知一次。
      void Promise.resolve().then(() =>
        manager.updateResizedWindowLayout('header-window', win, view, 'demo')
      )
    }
  }
  manager.detachedWindowMap.set('header-window', { window: win, view, pluginName: 'demo' })
  return { state, win, view }
}

describe('DetachedWindowManager plugin upgrade surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(detachedWindowManager as any).detachedWindowMap = new Map()
    ;(detachedWindowManager as any).suppressedSizePersistenceWindows = new Set()
    ;(detachedWindowManager as any).compactWindowHeader = false
    ;(detachedWindowManager as any).resizeSaveTimers = new Map()
    ;(detachedWindowManager as any).lastSavedSizeByPlugin = new Map()
    ;(detachedWindowManager as any).headerSizeSnapshots = new WeakMap()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('collapses only the matching detached titlebar and restores its original size', () => {
    const setContentSize = vi.fn()
    const show = vi.fn()
    const focus = vi.fn()
    const setBounds = vi.fn()
    const info = {
      window: {
        isDestroyed: vi.fn(() => false),
        webContents: { id: 17 },
        getContentBounds: vi.fn(() => ({ x: 40, y: 80, width: 820, height: 472 })),
        setContentSize,
        show,
        focus
      },
      view: { setBounds },
      pluginName: 'demo',
      pluginPath: '/plugins/demo',
      isAlwaysOnTop: false,
      lastFocusTarget: 'plugin',
      savedFocusTarget: 'plugin'
    }
    ;(detachedWindowManager as any).detachedWindowMap.set('window-1', info)

    const snapshot = detachedWindowManager.collapsePluginForUpgrade('demo', '/plugins/demo', {
      id: 17
    } as Electron.WebContents)

    expect(snapshot).toEqual({
      windowId: 'window-1',
      pluginName: 'demo',
      pluginPath: '/plugins/demo',
      width: 820,
      viewHeight: 420
    })
    expect(setBounds).toHaveBeenNthCalledWith(1, {
      x: 0,
      y: DETACHED_TITLEBAR_HEIGHT,
      width: 820,
      height: 0
    })
    expect(setContentSize).toHaveBeenNthCalledWith(1, 820, DETACHED_TITLEBAR_HEIGHT)

    expect(detachedWindowManager.restorePluginAfterFailedUpgrade(snapshot!)).toBe(true)
    expect(setContentSize).toHaveBeenNthCalledWith(2, 820, 472)
    expect(setBounds).toHaveBeenNthCalledWith(2, {
      x: 0,
      y: DETACHED_TITLEBAR_HEIGHT,
      width: 820,
      height: 420
    })
    expect(show).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not collapse a detached window for a different titlebar sender', () => {
    const setContentSize = vi.fn()
    const setBounds = vi.fn()
    ;(detachedWindowManager as any).detachedWindowMap.set('window-1', {
      window: {
        isDestroyed: vi.fn(() => false),
        webContents: { id: 17 },
        getContentBounds: vi.fn(),
        setContentSize
      },
      view: { setBounds },
      pluginName: 'demo',
      pluginPath: '/plugins/demo'
    })

    const snapshot = detachedWindowManager.collapsePluginForUpgrade('demo', '/plugins/demo', {
      id: 99
    } as Electron.WebContents)

    expect(snapshot).toBeNull()
    expect(setContentSize).not.toHaveBeenCalled()
    expect(setBounds).not.toHaveBeenCalled()
  })

  it('preserves plugin width and height through repeated header changes when native content bounds include extra pixels', () => {
    let viewBounds = { x: 0, y: 52, width: 803, height: 544 }
    /**
     * 保存模拟视图的实际边界。
     * @param next 新的视图边界。
     * @returns 无返回值。
     */
    const setBounds = vi.fn((next: Electron.Rectangle) => {
      viewBounds = { ...next }
    })
    /**
     * 模拟原生尺寸设置期间触发的同步 resize。
     * @param width 请求的窗口内容宽度。
     * @param height 请求的窗口内容高度。
     * @returns 无返回值。
     */
    const setContentSize = vi.fn((width: number, height: number) => {
      // 模拟 Windows 在 setContentSize 内同步触发 resize，原生内容宽比请求多 3px。
      setBounds({
        x: 0,
        y: detachedWindowManager.getTitlebarHeight(),
        width: width + 3,
        height: height - detachedWindowManager.getTitlebarHeight()
      })
    })
    ;(detachedWindowManager as any).detachedWindowMap.set('header-window', {
      window: {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
        getContentBounds: () => ({
          x: 0,
          y: 0,
          width: viewBounds.width + 3,
          height: viewBounds.height + viewBounds.y
        }),
        setMinimumSize: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        setContentSize
      },
      view: { getBounds: () => ({ ...viewBounds }), setBounds },
      pluginName: 'demo'
    })

    for (const compact of [true, false, true, false]) {
      detachedWindowManager.setCompactWindowHeader(compact)
      expect(viewBounds).toEqual({ x: 0, y: compact ? 40 : 52, width: 803, height: 544 })
      expect(setContentSize).toHaveBeenLastCalledWith(803, 544 + (compact ? 40 : 52))
    }
  })

  it('writes preserved dimensions after synchronous and delayed resize, then saves genuine user resizing', async () => {
    const { state, win, view } = mountHeaderWindow()
    for (const compact of [true, false, true, false]) {
      detachedWindowManager.setCompactWindowHeader(compact)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)
      expect(state.view).toEqual({ x: 0, y: compact ? 40 : 52, width: 803, height: 544 })
      expect(databaseAPI.dbPut).toHaveBeenLastCalledWith('detached-window-sizes', {
        demo: { width: 803, height: 544 }
      })
    }
    expect(vi.mocked(databaseAPI.dbPut).mock.calls).toHaveLength(1)

    // 用户实际改变原生内容尺寸后必须解除快照，保存新的正文尺寸。
    state.content = { x: 0, y: 0, width: 900, height: 700 }
    ;(detachedWindowManager as any).updateResizedWindowLayout('header-window', win, view, 'demo')
    await vi.advanceTimersByTimeAsync(300)
    expect(state.view).toEqual({ x: 0, y: 52, width: 900, height: 648 })
    expect(databaseAPI.dbPut).toHaveBeenLastCalledWith('detached-window-sizes', {
      demo: { width: 900, height: 648 }
    })
  })

  it('preserves existing upgrade suppression and prevents queued saves from crossing it', async () => {
    mountHeaderWindow()
    const manager = detachedWindowManager as any
    manager.schedulePersistWindowSize('header-window', 'demo', 806, 546)
    manager.suppressedSizePersistenceWindows.add('header-window')
    detachedWindowManager.setCompactWindowHeader(true)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    expect(manager.suppressedSizePersistenceWindows.has('header-window')).toBe(true)
    expect(databaseAPI.dbPut).not.toHaveBeenCalled()
    expect(manager.resizeSaveTimers.size).toBe(0)
  })
})
