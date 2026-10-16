import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  buildSqlList,
  cleanLines,
  convertCase,
  decodeUnicode,
  encodeUnicode,
  joinText,
  replaceText,
  organizeLines
} from '../../internal-plugins/string-tools/public/transforms.mjs'

describe('SQL IN list', () => {
  it('quotes text and preserves long numeric IDs without floating point conversion', () => {
    expect(buildSqlList("123\n张三\nO'Reilly\n00123\n90071992547409931234").output).toBe(
      "123,'张三','O''Reilly','00123',90071992547409931234"
    )
  })

  it('cleans table cells and retains the first occurrence order', () => {
    expect(buildSqlList(' 42 \r\n\n42\tfoo\rbar\n', { unique: true, wrap: true })).toMatchObject({
      output: "(42,'foo','bar')",
      count: 3,
      empty: 2,
      duplicates: 1
    })
  })

  it('supports string columns, optional whitespace and repeated values', () => {
    expect(buildSqlList('1\n1', { mode: 'text' }).output).toBe("'1','1'")
    expect(buildSqlList(' 1 ', { trim: false }).output).toBe("' 1 '")
  })

  it('accepts decimal and signed values but conservatively quotes other forms', () => {
    expect(buildSqlList('0\n-12\n+12\n3.14\n01\n1e3\n0x10\nNaN').output).toBe(
      "0,-12,+12,3.14,'01','1e3','0x10','NaN'"
    )
    expect(() => buildSqlList('1\n001', { mode: 'number' })).toThrow('前导零')
    expect(() => buildSqlList('abc', { mode: 'number' })).toThrow('非普通数字')
  })

  it('escapes quotes without treating comma or SQL syntax as delimiters', () => {
    expect(buildSqlList("a,b\nx'); DROP TABLE users;--").output).toBe(
      "'a,b','x''); DROP TABLE users;--'"
    )
    expect(buildSqlList('C:\\temp').warning).toContain('反斜杠')
  })

  it('does not produce empty SQL parentheses', () => {
    expect(buildSqlList('\n \n', { wrap: true }).output).toBe('')
  })
})

describe('case conversion', () => {
  it.each([
    ['lower', 'httpresponse user_id'],
    ['upper', 'HTTPRESPONSE USER_ID'],
    ['pascal', 'HttpResponseUserId'],
    ['camel', 'httpResponseUserId'],
    ['snake', 'http_response_user_id'],
    ['kebab', 'http-response-user-id']
  ])('converts acronym and separator boundaries in %s mode', (mode, expected) => {
    expect(convertCase('HTTPResponse user_id', mode)).toBe(expected)
  })

  it('keeps identifiers on separate lines, including blank lines and Unicode', () => {
    expect(convertCase('first-name\r\n\n用户 ID', 'camel')).toBe('firstName\n\n用户Id')
    expect(convertCase('a1B2_test', 'snake')).toBe('a1_b2_test')
  })
})

describe('Unicode conversion', () => {
  it('decodes Chinese, surrogate pairs and code points with mixed plain text', () => {
    expect(decodeUnicode(String.raw`hi \u4e2d\u6587 \uD83D\uDE00 \u{1F600} U+4E2D`)).toBe(
      'hi 中文 😀 😀 中'
    )
    expect(decodeUnicode(String.raw`\n中文\t`)).toBe(String.raw`\n中文\t`)
  })

  it.each([
    String.raw`\u12`,
    String.raw`\uGGGG`,
    String.raw`\u{}`,
    String.raw`\u{110000}`,
    String.raw`\u{D800}`,
    String.raw`\uD800`,
    String.raw`\uDC00`,
    String.raw`\uD800abc`,
    String.raw`U+110000`,
    String.raw`\u{4e2d`
  ])('rejects malformed input %s', (text) => {
    expect(() => decodeUnicode(text)).toThrow()
  })

  it('round trips Chinese and emoji while preserving ASCII and line breaks', () => {
    const text = 'A 中文😀\n第二行'
    expect(encodeUnicode(text)).toBe(
      String.raw`A \u4e2d\u6587\ud83d\ude00` + '\n' + String.raw`\u7b2c\u4e8c\u884c`
    )
    expect(decodeUnicode(encodeUnicode(text))).toBe(text)
    expect(() => encodeUnicode('\ud800')).toThrow('代理项')
  })
})

describe('line cleanup', () => {
  it('removes empty lines and duplicates with case sensitive stable ordering', () => {
    expect(cleanLines(' b \na\nb\nA\n\n', { unique: true })).toEqual({
      values: ['b', 'a', 'A'],
      total: 6,
      empty: 2,
      duplicates: 1
    })
    expect(cleanLines(' a \na', { trim: false, unique: true }).values).toEqual([' a ', 'a'])
    expect(cleanLines('').values).toEqual([])
  })
})

describe('custom joining', () => {
  it('splits literal separators, cleans items and wraps each item', () => {
    expect(
      joinText(' a,b,a ,, ', {
        input: 'comma',
        separator: ';',
        prefix: '[',
        suffix: ']',
        unique: true
      })
    ).toEqual({ output: '[a];[b]', count: 2, empty: 2, duplicates: 1 })
    expect(joinText('a.*b.*c', { input: 'custom', delimiter: '.*' }).output).toBe('a,b,c')
  })

  it('handles CRLF, tabs and escaped delimiters without rewriting affixes', () => {
    expect(
      joinText(' a \r\nb\rc\n', { separator: String.raw`\t`, prefix: String.raw`\n` }).output
    ).toBe('\\na\t\\nb\t\\nc')
    expect(joinText('a\tb', { input: 'tab', separator: String.raw`\n` }).output).toBe('a\nb')
    expect(joinText('a;b', { input: 'semicolon', separator: String.raw`\\n` }).output).toBe(
      String.raw`a\nb`
    )
    expect(
      joinText('a\r\nb', { input: 'custom', delimiter: String.raw`\r\n`, separator: '' }).output
    ).toBe('ab')
    expect(joinText('a,b', { input: 'comma', separator: String.raw`\q` }).output).toBe(
      String.raw`a\qb`
    )
  })

  it('preserves optional whitespace and duplicates, and never wraps absent items', () => {
    expect(joinText(' a \na', { trim: false }).output).toBe(' a ,a')
    expect(joinText('a\na').output).toBe('a,a')
    expect(joinText('', { prefix: '[', suffix: ']' }).output).toBe('')
    expect(joinText(' \n\n').count).toBe(0)
    expect(() => joinText('abc', { input: 'custom', delimiter: '' })).toThrow('分隔符不能为空')
    expect(() => joinText('abc', { input: 'unknown' })).toThrow('分隔方式')
  })
})

describe('find and replace', () => {
  it('treats punctuation and dollar replacement tokens literally in plain mode', () => {
    expect(replaceText('a.b aXb a.b', { search: 'a.b', replacement: '$1$&' })).toBe('$1$& aXb $1$&')
    expect(
      replaceText('Ab aB ab', { search: 'ab', replacement: 'x', ignoreCase: true, all: false })
    ).toBe('x aB ab')
    expect(replaceText('a\nb', { search: '\n', replacement: '' })).toBe('ab')
    expect(replaceText('你好你好', { search: '你好', replacement: '好' })).toBe('好好')
  })

  it('supports regex capture groups, case and multiline anchors', () => {
    expect(
      replaceText('item-12 thing-34', {
        search: '(\\w+)-(\\d+)',
        replacement: '$2:$1',
        regex: true
      })
    ).toBe('12:item 34:thing')
    expect(
      replaceText('foo\nFOO', {
        search: '^foo$',
        replacement: 'bar',
        regex: true,
        ignoreCase: true,
        multiline: true
      })
    ).toBe('bar\nbar')
    expect(replaceText('aa', { search: '(?=a)', replacement: '-', regex: true })).toBe('-a-a')
  })

  it('keeps the source for empty search and reports invalid expressions', () => {
    expect(replaceText('abc', { search: '', replacement: 'x' })).toBe('abc')
    expect(replaceText('abc', { search: 'b', replacement: '' })).toBe('ac')
    expect(() => replaceText('abc', { search: '[', regex: true })).toThrow('正则表达式')
  })
})

describe('line sorting and filtering', () => {
  it('filters before sorting and retains existing cleanup defaults', () => {
    expect(
      organizeLines(' item10 \nother\nitem2\nitem2\n\n', {
        unique: true,
        keyword: 'item',
        filter: 'include',
        sort: 'natural'
      })
    ).toMatchObject({ values: ['item2', 'item10'], empty: 2, duplicates: 1, filtered: 1 })
    expect(
      organizeLines('A\na\nb', { keyword: 'a', filter: 'exclude', ignoreCase: true }).values
    ).toEqual(['b'])
    expect(organizeLines('A\na', { keyword: 'a', filter: 'include' }).values).toEqual(['a'])
    expect(organizeLines('a.b\naxb', { keyword: '.', filter: 'include' }).values).toEqual(['a.b'])
    expect(organizeLines('b\na', { keyword: '', filter: 'exclude' }).values).toEqual(['b', 'a'])
  })

  it('supports text ordering, reversing original order and empty input', () => {
    expect(organizeLines('b\na\nc', { sort: 'text', reverse: true }).values).toEqual([
      'c',
      'b',
      'a'
    ])
    expect(organizeLines('b\na\nc', { reverse: true }).values).toEqual(['c', 'a', 'b'])
    expect(organizeLines('').values).toEqual([])
    expect(organizeLines(' b \nb', { trim: false, unique: true }).values).toEqual([' b ', 'b'])
  })

  it('sorts signed decimals and long numeric IDs without losing precision', () => {
    expect(organizeLines('10\n-2\n1.5\n.5\n001\n-10\n1.05', { sort: 'number' }).values).toEqual([
      '-10',
      '-2',
      '.5',
      '001',
      '1.05',
      '1.5',
      '10'
    ])
    expect(organizeLines('9007199254740993\n9007199254740992', { sort: 'number' }).values).toEqual([
      '9007199254740992',
      '9007199254740993'
    ])
    expect(organizeLines('-0\n+0\n0.00', { sort: 'number' }).values).toEqual(['-0', '+0', '0.00'])
    expect(() => organizeLines('1\nabc', { sort: 'number' })).toThrow('数字排序')
    expect(() => organizeLines('Infinity', { sort: 'number' })).toThrow('数字排序')
    expect(() => organizeLines('a', { sort: 'unknown' })).toThrow('排序方式')
    expect(() => organizeLines('a', { filter: 'unknown' })).toThrow('筛选方式')
  })
})

describe('bundled assets', () => {
  it('ships entry point, preload, icon, and offline resources in public', () => {
    const root = path.resolve('internal-plugins/string-tools/public')
    const manifest = JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe('string-tools')
    for (const asset of [
      manifest.main,
      manifest.preload,
      manifest.logo,
      'app.mjs',
      'transforms.mjs',
      'replace-worker.mjs',
      'style.css'
    ]) {
      expect(existsSync(path.join(root, asset))).toBe(true)
    }
    expect(manifest.features.map((feature) => feature.code)).toEqual([
      'sql',
      'case',
      'unicode',
      'unicode-encode',
      'lines',
      'join',
      'replace'
    ])
    expect(readFileSync(path.join(root, 'index.html'), 'utf8')).toContain("connect-src 'none'")
  })
})
