import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(
  /**
   * 提供窗口替身间共享的测试依赖。
   * @returns 可重置的模拟对象。
   */
  () => ({
    handlers: new Map<string, Function>(),
    windows: [] as any[],
    read: vi.fn(),
    write: vi.fn(),
    load: vi.fn(),
    area: { x: 0, y: 0, width: 1920, height: 1040 }
  })
)

vi.mock(
  'electron',
  /**
   * 模拟原生生命周期，保留真实事件订阅语义。
   * @returns Electron 替身模块。
   */
  async () => {
    const { EventEmitter: Emitter } = await import('node:events')
    class FakeWindow extends Emitter {
      webContents = Object.assign(new Emitter(), {
        mainFrame: {},
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        isDestroyed: vi.fn().mockReturnValue(false)
      })
      show = vi.fn()
      focus = vi.fn()
      setBounds = vi.fn(
        /**
         * 维护原生边界，使拖动及屏幕变化测试可以读回位置。
         * @param bounds 新边界。
         * @returns 无返回值。
         */
        (bounds: any) => {
          Object.assign(this.options, bounds)
        }
      )
      loadFile = mocks.load
      loadURL = mocks.load
      /**
       * 记录窗口选项供生命周期断言。
       * @param options 窗口配置。
       * @returns 窗口替身。
       */
      constructor(public options: any) {
        super()
        mocks.windows.push(this)
      }
      /**
       * 返回当前窗口边界。
       * @returns 窗口配置中的边界。
       */
      getBounds(): any {
        return this.options
      }
      /**
       * 模拟原生关闭事件。
       * @returns 无返回值。
       */
      destroy(): void {
        this.emit('closed')
      }
    }
    return {
      app: { isPackaged: false },
      BrowserWindow: FakeWindow,
      ipcMain: Object.assign(new Emitter(), {
        /**
         * 登记异步通道。
         * @param name 通道名称。
         * @param callback 处理器。
         * @returns 无返回值。
         */
        handle: (name: string, callback: Function): void => {
          mocks.handlers.set(name, callback)
        },
        /**
         * 清除异步通道。
         * @param name 通道名称。
         * @returns 无返回值。
         */
        removeHandler: (name: string): void => {
          mocks.handlers.delete(name)
        }
      }),
      screen: Object.assign(new Emitter(), {
        /**
         * 返回测试中的工作区。
         * @returns 模拟显示器。
         */
        getDisplayMatching: () => ({ workArea: mocks.area }),
        /**
         * 提供已连接工作区供位置恢复。
         * @returns 显示器列表。
         */
        getAllDisplays: () => [{ workArea: mocks.area }]
      }),
      powerMonitor: new Emitter()
    }
  }
)
vi.mock(
  '@electron-toolkit/utils',
  /**
   * 使用本地构建入口。
   * @returns 环境替身。
   */
  () => ({ is: { dev: false } })
)
vi.mock(
  '../../src/main/api/shared/database',
  /**
   * 隔离设备数据库，避免访问真实数据。
   * @returns 数据库替身。
   */
  () => ({ default: { dbGet: mocks.read, dbPut: mocks.write } })
)
vi.mock(
  '../../src/main/utils/appBundlePath',
  /**
   * 返回可读的构建相对路径供断言。
   * @returns 路径解析替身。
   */
  () => ({
    /**
     * 保留 preload 路径。
     * @param file 文件名。
     * @returns 文件名。
     */
    getPreloadPath: (file: string) => file,
    /**
     * 保留 renderer 路径。
     * @param file 文件名。
     * @returns 文件名。
     */
    getRendererPath: (file: string) => file
  })
)

import { ipcMain, screen, powerMonitor } from 'electron'
import { RunnerGameManager } from '../../src/main/core/desktopPet/runnerGameManager'

let manager: RunnerGameManager
const host = { hide: vi.fn(), restore: vi.fn(), failed: vi.fn() }
const bounds = { x: 100, y: 100, width: 144, height: 192 }

/**
 * 返回当前窗口可信主 frame 事件。
 * @returns 模拟 IPC 事件。
 */
function event(): any {
  const win = mocks.windows.at(-1)
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame }
}

beforeEach(
  /**
   * 为每个用例建立独立会话与模拟时钟。
   * @returns 无返回值。
   */
  () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.windows.length = 0
    mocks.area = { x: 0, y: 0, width: 1920, height: 1040 }
    mocks.read.mockReturnValue({ version: 1, bestDistance: 40 })
    mocks.write.mockReturnValue({ ok: true })
    mocks.load.mockResolvedValue(undefined)
    manager = new RunnerGameManager(host)
  }
)
afterEach(
  /**
   * 清理会话及测试时钟。
   * @returns 无返回值。
   */
  () => {
    manager.close()
    vi.useRealTimers()
  }
)

test('准备成功才隐藏宠物；重复开始只激活现有窗口' /**
 * 验证加载前后窗口切换顺序。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  manager.open(bounds)
  expect(mocks.windows).toHaveLength(1)
  expect(host.hide).not.toHaveBeenCalled()
  const ready = mocks.handlers.get('desktop-pet-runner:ready')!
  expect(ready(event())).toEqual({ version: 1, bestDistance: 40 })
  ready(event())
  expect(host.hide).toHaveBeenCalledTimes(1)
  manager.open(bounds)
  expect(mocks.windows[0].focus).toHaveBeenCalledTimes(2)
})

test('超时或素材失败回滚宠物，解除所有宿主监听' /**
 * 验证准备超时后的完整清理。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  vi.advanceTimersByTime(15_000)
  expect(manager.isActive()).toBe(false)
  expect(host.restore).toHaveBeenCalledTimes(1)
  expect(host.failed).toHaveBeenCalledTimes(1)
  expect(mocks.handlers.size).toBe(0)
  expect((screen as unknown as EventEmitter).listenerCount('display-removed')).toBe(0)
  expect((powerMonitor as unknown as EventEmitter).listenerCount('suspend')).toBe(0)
})

test('崩溃后释放会话，可以重新进入' /**
 * 验证崩溃恢复不永久禁用游戏。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  mocks.handlers.get('desktop-pet-runner:ready')!(event())
  mocks.windows[0].webContents.emit('render-process-gone')
  expect(manager.isActive()).toBe(false)
  expect(host.restore).toHaveBeenCalledTimes(1)
  manager.open(bounds)
  expect(mocks.windows).toHaveLength(2)
})

test('失焦和系统挂起发暂停通知；屏幕变化重新布局' /**
 * 验证原生事件不会自动继续游戏。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  mocks.handlers.get('desktop-pet-runner:ready')!(event())
  const win = mocks.windows[0]
  win.emit('blur')
  powerMonitor.emit('suspend')
  screen.emit('display-metrics-changed')
  expect(win.webContents.send).toHaveBeenCalledTimes(3)
  expect(win.webContents.send).toHaveBeenLastCalledWith('desktop-pet-runner:pause')
  expect(win.setBounds).toHaveBeenCalled()
})

test('拒绝非游戏 frame 与非法分数，低纪录不重复写库' /**
 * 验证权限边界、数值边界及最少持久化。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  const save = mocks.handlers.get('desktop-pet-runner:save')!
  expect(
    /**
     * 模拟其他窗口伪造保存。
     * @returns 保存结果。
     */
    () => save({ sender: {}, senderFrame: {} }, 50)
  ).toThrow('未授权')
  for (const distance of [-1, Infinity, NaN, '60', 1e15]) {
    expect(
      /**
       * 提交非法分数。
       * @returns 保存结果。
       */
      () => save(event(), distance)
    ).toThrow('距离无效')
  }
  expect(save(event(), 30)).toEqual({ saved: true, bestDistance: 40 })
  expect(mocks.write).not.toHaveBeenCalled()
  expect(save(event(), 60.5)).toEqual({ saved: true, bestDistance: 60 })
  expect(mocks.write).toHaveBeenCalledWith('desktop-pet-runner', { version: 1, bestDistance: 60 })
  mocks.write.mockReturnValue({ ok: false })
  expect(save(event(), 80)).toEqual({ saved: false, bestDistance: 40 })
  ipcMain.emit('desktop-pet-runner:exit', event())
  expect(manager.isActive()).toBe(false)
})

test('过小工作区不隐藏桌宠且不创建窗口' /**
 * 验证窗口创建前的几何失败边界。
 * @returns 无返回值。
 */, () => {
  mocks.area.width = 300
  manager.open(bounds)
  expect(mocks.windows).toHaveLength(0)
  expect(host.hide).not.toHaveBeenCalled()
  expect(host.failed).toHaveBeenCalledTimes(1)
})

test('旧窗口加载失败不能关闭后来创建的新会话' /**
 * 验证关闭重开与旧异步拒绝交错的边界。
 * @returns 检查完成的 Promise。
 */, async () => {
  let rejectOld!: (error: Error) => void
  mocks.load.mockReturnValueOnce(
    new Promise<void>(
      /**
       * 保留旧会话加载的拒绝控制器。
       * @param _resolve 未使用的完成回调。
       * @param reject 失败回调。
       * @returns 无返回值。
       */
      (_resolve, reject) => {
        rejectOld = reject
      }
    )
  )
  manager.open(bounds)
  manager.close()
  manager.open(bounds)
  rejectOld(new Error('旧窗口已销毁'))
  await Promise.resolve()
  expect(manager.isActive()).toBe(true)
  expect(host.failed).not.toHaveBeenCalled()
  expect(mocks.handlers.get('desktop-pet-runner:ready')!(event()).bestDistance).toBe(40)
})

test('同窗口子frame不能就绪、关闭或回滚主frame会话' /**
 * 检查不能仅通过 sender 身份绕过主 frame 限制。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  const child = { ...event(), senderFrame: {} }
  expect(
    /**
     * 子 frame 尝试宣告就绪。
     * @returns 纪录结果。
     */
    () => mocks.handlers.get('desktop-pet-runner:ready')!(child)
  ).toThrow('未授权')
  ipcMain.emit('desktop-pet-runner:exit', child)
  ipcMain.emit('desktop-pet-runner:failed', child)
  expect(manager.isActive()).toBe(true)
  expect(host.hide).not.toHaveBeenCalled()
  expect(host.failed).not.toHaveBeenCalled()
})

test('数据库抛错时保留会话和明确保存失败结果' /**
 * 验证存储异常不会阻塞退出。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  mocks.write.mockImplementationOnce(
    /**
     * 模拟磁盘写入异常。
     * @returns 无返回值。
     * @throws 模拟磁盘不可用。
     */
    () => {
      throw new Error('disk unavailable')
    }
  )
  expect(mocks.handlers.get('desktop-pet-runner:save')!(event(), 60)).toEqual({
    saved: false,
    bestDistance: 40
  })
  expect(manager.isActive()).toBe(true)
  ipcMain.emit('desktop-pet-runner:exit', event())
  expect(manager.isActive()).toBe(false)
})

test('可信拖动移动并夹取保存，屏幕变化保留位置，重开恢复；非法 frame 不得拖动' /**
 * 验证设备位置完整生命周期和最小 IPC 权限。
 * @returns 无返回值。
 */, () => {
  manager.open(bounds)
  mocks.handlers.get('desktop-pet-runner:ready')!(event())
  const win = mocks.windows[0]
  const original = { x: win.options.x, y: win.options.y }
  ipcMain.emit(
    'desktop-pet-runner:drag',
    { ...event(), senderFrame: {} },
    { type: 'start', x: 100, y: 100 }
  )
  ipcMain.emit('desktop-pet-runner:drag', event(), { type: 'move', x: 0, y: 0 })
  expect(win.setBounds).not.toHaveBeenCalled()
  ipcMain.emit('desktop-pet-runner:drag', event(), { type: 'start', x: 100, y: 100 })
  win.emit('blur')
  expect(win.webContents.send).not.toHaveBeenCalled()
  ipcMain.emit('desktop-pet-runner:drag', event(), { type: 'move', x: NaN, y: 0 })
  expect(win.setBounds).not.toHaveBeenCalled()
  ipcMain.emit('desktop-pet-runner:drag', event(), { type: 'move', x: 170, y: 0 })
  ipcMain.emit('desktop-pet-runner:drag', event(), { type: 'end' })
  const position = { version: 1, x: original.x + 70, y: original.y - 100 }
  expect(mocks.write).toHaveBeenLastCalledWith('desktop-pet-runner-position', position)
  screen.emit('display-metrics-changed')
  expect(win.options.x).toBe(position.x)
  expect(win.options.y).toBe(position.y)
  manager.close()
  expect((ipcMain as unknown as EventEmitter).listenerCount('desktop-pet-runner:drag')).toBe(0)
  mocks.read.mockReturnValue(position)
  manager.open(bounds)
  expect(mocks.windows[1].options.x).toBe(position.x)
  expect(mocks.windows[1].options.y).toBe(position.y)
})
