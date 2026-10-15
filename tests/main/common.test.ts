import { describe, it, expect, vi } from 'vitest'
// 缩写逻辑不调用原生窗口能力；在模块边界隔离 Electron 专用二进制。
vi.mock('../../src/main/core/native/index.js', () => ({ WindowManager: {} }))
import { extractAcronym } from '../../src/main/utils/common'

describe('extractAcronym', () => {
  describe('空格分隔的单词', () => {
    it('应提取每个单词的首字母', () => {
      expect(extractAcronym('Visual Studio Code')).toBe('vsc')
    })

    it('应转为小写', () => {
      expect(extractAcronym('Google Chrome Browser')).toBe('gcb')
    })

    it('两个单词也应提取', () => {
      expect(extractAcronym('Android Studio')).toBe('as')
    })

    it('应忽略多余空格', () => {
      expect(extractAcronym('Visual  Studio  Code')).toBe('vsc')
    })
  })

  describe('驼峰命名', () => {
    it('应提取大写字母', () => {
      expect(extractAcronym('VisualStudioCode')).toBe('vsc')
    })

    it('应转为小写', () => {
      expect(extractAcronym('GoogleChrome')).toBe('gc')
    })
  })

  describe('无法提取时', () => {
    it('单个小写单词应返回空字符串', () => {
      expect(extractAcronym('chrome')).toBe('')
    })

    it('单个首字母大写单词应返回空字符串', () => {
      // 只有一个大写字母，不满足 > 1 的条件
      expect(extractAcronym('Chrome')).toBe('')
    })

    it('中文名称应返回空字符串', () => {
      expect(extractAcronym('原神')).toBe('')
    })

    it('纯数字应返回空字符串', () => {
      expect(extractAcronym('12345')).toBe('')
    })
  })

  describe('边界情况', () => {
    it('空字符串应返回空字符串', () => {
      expect(extractAcronym('')).toBe('')
    })

    it('混合中英文用空格分隔应提取首字符', () => {
      // "米哈游 Launcher" 分成两个词
      expect(extractAcronym('米哈游 Launcher')).toBe('米l')
    })
  })
})
