import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { matchesRegexText, type RegexCmdLike } from '../../src/shared/commandContextShared'

const manifest = JSON.parse(
  readFileSync('internal-plugins/string-tools/public/plugin.json', 'utf8')
)

/**
 * 使用宿主的实际匹配器读取插件声明，避免测试与运行时维护两套规则。
 * @param text 待匹配的原始文本。
 * @returns 命中的具体工具代码。
 */
function matchedTools(text: string): string[] {
  return manifest.features
    .filter((feature: { cmds: Array<string | RegexCmdLike> }) =>
      feature.cmds.some(
        (cmd) =>
          typeof cmd !== 'string' &&
          cmd.type === 'regex' &&
          matchesRegexText(text, cmd, { preserveFlags: true })
      )
    )
    .map((feature: { code: string }) => feature.code)
}

describe('字符串工具按文本推荐', () => {
  it('长单行无分隔符时不会反复尝试每个起始位置', () => {
    const start = performance.now()
    expect(matchedTools('a'.repeat(100_000))).toEqual(['case'])
    expect(performance.now() - start).toBeLessThan(1000)
  })
  it.each(['123\n456', '甲\r\n乙', '甲\r乙', '\n甲\n\n乙\n', ' 甲 \n 乙 '])(
    '多个非空行同时提供 SQL IN 和行整理：%j',
    (text) => {
      expect(matchedTools(text)).toEqual(expect.arrayContaining(['sql', 'lines']))
    }
  )

  it.each(['', ' \n\t ', '甲\n', '\n甲\n \n', '123', '!!!', '中文', '日本語', '😀'])(
    '空白、单行或无英文文本不误推荐：%j',
    (text) => {
      expect(matchedTools(text)).toEqual([])
    }
  )

  it('表格单行的多个单元格只增加 SQL IN，不误判为多行', () => {
    expect(matchedTools('123\t456')).toEqual(['sql'])
  })

  it.each(['hello', 'HTTPResponse', 'user_name42', 'hello-world', 'Hello world!'])(
    '英文及常见 ASCII 符号提供命名工具：%j',
    (text) => {
      expect(matchedTools(text)).toEqual(['case'])
    }
  )

  it('多行英文可以同时使用三种工具', () => {
    expect(matchedTools('user_name\norder_id')).toEqual(['sql', 'case', 'lines'])
  })

  it.each(['用户 ID', 'hello 中文', 'hello 日本語', 'hello 😀'])(
    '混合其他文字不当成纯英文：%j',
    (text) => {
      expect(matchedTools(text)).not.toContain('case')
    }
  )

  it.each([
    String.raw`\u4e2d\u6587`,
    String.raw`prefix \u4E2D suffix`,
    String.raw`\uD83D\uDE00`,
    String.raw`\u{1F600}`,
    String.raw`\u{000041}`,
    '名称：U+4E2D',
    'U+10FFFF'
  ])('Unicode 含在文本中也提供解码并排除命名转换：%j', (text) => {
    expect(matchedTools(text)).toContain('unicode')
    expect(matchedTools(text)).not.toContain('case')
  })

  it.each([
    String.raw`C:\users\alice`,
    String.raw`\u12`,
    String.raw`\uGGGG`,
    String.raw`\u{}`,
    String.raw`\u{110000}`,
    String.raw`\u{D800}`,
    String.raw`\uD800`,
    String.raw`\uDC00`,
    'U+110000',
    'U+4E2DG'
  ])('路径和非法转义不误推荐 Unicode：%j', (text) => {
    expect(matchedTools(text)).not.toContain('unicode')
  })

  it('Unicode 多行与行工具并存，自定义拼接不参与推荐', () => {
    expect(matchedTools(String.raw`\u4e2d` + '\n' + String.raw`\u6587`)).toEqual([
      'sql',
      'unicode',
      'lines'
    ])
    expect(
      manifest.features.find((feature: { code: string }) => feature.code === 'join').cmds
    ).toSatisfy((cmds: unknown[]) => cmds.every((cmd) => typeof cmd === 'string'))
  })
})
