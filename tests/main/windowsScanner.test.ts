import { describe, it, expect, vi, beforeEach } from 'vitest'

const scanner = vi.hoisted(() => ({ scan: vi.fn() }))

vi.mock('../../src/main/core/native/index', () => ({
  MuiResolver: { resolve: vi.fn(() => new Map()) },
  WindowsShortcutScanner: scanner
}))
vi.mock('../../src/main/utils/systemPaths', () => ({
  getWindowsRecursiveScanPaths: () => ['C:\\Start Menu'],
  getWindowsFlatScanPaths: () => ['C:\\Desktop']
}))

import {
  shouldSkipShortcut,
  getIconUrl,
  deduplicateCommands,
  scanApplications,
  SKIP_FOLDERS
} from '../../src/main/core/commandScanner/windowsScanner'

// ========== shouldSkipShortcut ==========

describe('shouldSkipShortcut（仅按名称过滤）', () => {
  it('应跳过卸载相关名称', () => {
    expect(shouldSkipShortcut('Uninstall App')).toBe(true)
    expect(shouldSkipShortcut('卸载程序')).toBe(true)
    expect(shouldSkipShortcut('App卸载')).toBe(true)
  })

  it('应跳过网站/帮助/文档相关名称', () => {
    expect(shouldSkipShortcut('Website')).toBe(true)
    expect(shouldSkipShortcut('公司网站')).toBe(true)
    expect(shouldSkipShortcut('Help Center')).toBe(true)
    expect(shouldSkipShortcut('readme')).toBe(true)
    expect(shouldSkipShortcut('Documentation')).toBe(true)
    expect(shouldSkipShortcut('用户文档')).toBe(true)
  })

  it('不应跳过正常应用名称', () => {
    expect(shouldSkipShortcut('Visual Studio Code')).toBe(false)
    expect(shouldSkipShortcut('Chrome')).toBe(false)
    expect(shouldSkipShortcut('原神')).toBe(false)
    expect(shouldSkipShortcut('文件资源管理器')).toBe(false)
    expect(shouldSkipShortcut('cmd')).toBe(false)
    expect(shouldSkipShortcut('PowerShell')).toBe(false)
    expect(shouldSkipShortcut('设备管理器')).toBe(false)
  })

  it('不应跳过名称包含关键词但不匹配模式的应用', () => {
    // "文件" 不等于 "文档"，不应被过滤
    expect(shouldSkipShortcut('文件资源管理器')).toBe(false)
    // "helper" 包含 "help" 但 SKIP_NAME_PATTERN 是匹配 "help" 子串，所以会被过滤
    // 这是预期行为：名为 "helper" 的快捷方式通常是辅助工具
  })
})

// ========== getIconUrl ==========

describe('getIconUrl', () => {
  it('应生成正确的图标 URL', () => {
    const result = getIconUrl('C:\\App\\app.exe')
    expect(result).toBe(`ztools-icon://${encodeURIComponent('C:\\App\\app.exe')}`)
  })

  it('应正确编码特殊字符', () => {
    const result = getIconUrl('C:\\Program Files (x86)\\App\\app.exe')
    expect(result).toContain('ztools-icon://')
    expect(result).toContain(encodeURIComponent('C:\\Program Files (x86)\\App\\app.exe'))
  })

  it('应以 ztools-icon:// 协议开头', () => {
    expect(getIconUrl('test')).toMatch(/^ztools-icon:\/\//)
  })
})

// ========== deduplicateCommands ==========

describe('deduplicateCommands', () => {
  it('应去除完全相同名称和路径的重复项（无 _dedupeTarget 时降级为 path）', () => {
    const apps = [
      { name: 'App', path: 'C:\\app.exe' },
      { name: 'App', path: 'C:\\app.exe' }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('App')
  })

  it('应合并同名同目标但不同 .lnk 路径的快捷方式', () => {
    // 用户开始菜单和系统开始菜单都有同名同目标的快捷方式
    const apps = [
      {
        name: 'App',
        path: 'C:\\Users\\test\\Start Menu\\Programs\\App.lnk',
        _dedupeTarget: 'C:\\Program Files\\App\\app.exe'
      },
      {
        name: 'App',
        path: 'C:\\ProgramData\\Start Menu\\Programs\\App.lnk',
        _dedupeTarget: 'C:\\Program Files\\App\\app.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('App')
    // 保留第一个出现的 .lnk 路径
    expect(result[0].path).toBe('C:\\Users\\test\\Start Menu\\Programs\\App.lnk')
  })

  it('应合并 Start Menu 根级与 Programs 子树同名同目标的快捷方式', () => {
    const apps = [
      {
        name: 'App',
        path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\App.lnk',
        _dedupeTarget: 'C:\\Program Files\\App\\app.exe'
      },
      {
        name: 'App',
        path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\App.lnk',
        _dedupeTarget: 'C:\\Program Files\\App\\app.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('App')
  })

  it('应保留不同名但同目标的应用（核心特性）', () => {
    const apps = [
      {
        name: '原神',
        path: 'C:\\Users\\test\\Start Menu\\原神.lnk',
        _dedupeTarget: 'C:\\miHoYo\\launcher.exe'
      },
      {
        name: '米哈游启动器',
        path: 'C:\\Users\\test\\Start Menu\\米哈游启动器.lnk',
        _dedupeTarget: 'C:\\miHoYo\\launcher.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(2)
    expect(result.map((a) => a.name).sort()).toEqual(['原神', '米哈游启动器'].sort())
  })

  it('应保留同名但不同目标的应用', () => {
    const apps = [
      {
        name: 'App',
        path: 'C:\\Users\\test\\Start Menu\\App.lnk',
        _dedupeTarget: 'C:\\v1\\app.exe'
      },
      {
        name: 'App',
        path: 'C:\\ProgramData\\Start Menu\\App.lnk',
        _dedupeTarget: 'C:\\v2\\app.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(2)
  })

  it('去重应不区分大小写', () => {
    const apps = [
      {
        name: 'App',
        path: 'C:\\Users\\Start Menu\\App.lnk',
        _dedupeTarget: 'C:\\App\\APP.EXE'
      },
      {
        name: 'app',
        path: 'C:\\ProgramData\\Start Menu\\App.lnk',
        _dedupeTarget: 'c:\\app\\app.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(1)
  })

  it('应保留第一个出现的重复项', () => {
    const apps = [
      { name: 'App', path: 'C:\\first\\App.lnk', icon: 'icon1', _dedupeTarget: 'C:\\app.exe' },
      { name: 'App', path: 'C:\\second\\App.lnk', icon: 'icon2', _dedupeTarget: 'C:\\app.exe' }
    ]
    const result = deduplicateCommands(apps)
    expect(result[0].icon).toBe('icon1')
  })

  it('去重后应清除 _dedupeTarget 字段', () => {
    const apps = [
      {
        name: 'App',
        path: 'C:\\Users\\Start Menu\\App.lnk',
        _dedupeTarget: 'C:\\app.exe'
      }
    ]
    const result = deduplicateCommands(apps)
    expect(result).toHaveLength(1)
    expect((result[0] as any)._dedupeTarget).toBeUndefined()
  })

  it('空数组应返回空数组', () => {
    expect(deduplicateCommands([])).toEqual([])
  })
})

// .url 文本解析已迁往原生模块；此处验证真实 TS 扫描入口与原生结果的契约。
describe('native scanner result adapter', () => {
  beforeEach(() => scanner.scan.mockReset().mockResolvedValue([]))

  it('保留原生解析的应用协议和图标，并传递递归及扁平来源', async () => {
    scanner.scan.mockResolvedValueOnce([
      { name: 'Steam Game', path: 'steam://rungameid/12345', icon: 'C:\\steam.ico' }
    ])
    const result = await scanApplications()
    expect(scanner.scan).toHaveBeenCalledWith(['C:\\Start Menu'], [], SKIP_FOLDERS)
    expect(scanner.scan).toHaveBeenCalledWith([], ['C:\\Desktop'], SKIP_FOLDERS)
    expect(result).toMatchObject({
      complete: true,
      errors: [],
      apps: [
        {
          name: 'Steam Game',
          path: 'steam://rungameid/12345',
          icon: getIconUrl('C:\\steam.ico'),
          acronym: 'sg'
        }
      ]
    })
  })

  it('原生层过滤网页或无效 URL 后的空结果保持为空', async () => {
    expect(await scanApplications()).toEqual({ apps: [], complete: true, errors: [] })
  })

  it('丢弃缺少名称或路径的异常原生条目', async () => {
    scanner.scan.mockResolvedValueOnce([
      { name: '', path: 'steam://invalid' },
      { name: 'Missing path', path: '' }
    ])
    expect((await scanApplications()).apps).toEqual([])
  })

  it('来源读取失败不抹去另一来源的有效快捷方式', async () => {
    scanner.scan
      .mockRejectedValueOnce(new Error('directory unavailable'))
      .mockResolvedValueOnce([{ name: 'Calculator', path: 'C:\\Desktop\\Calculator.lnk' }])
    const result = await scanApplications()
    expect(result.complete).toBe(false)
    expect(result.errors).toEqual(['recursive:C:\\Start Menu: directory unavailable'])
    expect(result.apps).toHaveLength(1)
    expect(result.apps[0].name).toBe('Calculator')
  })

  it('经过真实扫描入口过滤帮助条目并合并同名同目标', async () => {
    scanner.scan
      .mockResolvedValueOnce([
        { name: 'Help Center', path: 'C:\\help.lnk' },
        { name: 'App', path: 'C:\\Start Menu\\App.lnk', targetPath: 'C:\\app.exe' }
      ])
      .mockResolvedValueOnce([
        { name: 'App', path: 'C:\\Desktop\\App.lnk', targetPath: 'C:\\app.exe' }
      ])
    expect((await scanApplications()).apps).toMatchObject([
      { name: 'App', path: 'C:\\Start Menu\\App.lnk' }
    ])
  })
})

// ========== 配置常量 ==========

describe('配置常量', () => {
  it('SKIP_FOLDERS 应包含常见开发文件夹', () => {
    expect(SKIP_FOLDERS).toContain('sdk')
    expect(SKIP_FOLDERS).toContain('docs')
    expect(SKIP_FOLDERS).toContain('examples')
    expect(SKIP_FOLDERS).toContain('demo')
  })
})
