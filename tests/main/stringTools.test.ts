import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  buildSqlList,
  cleanLines,
  convertCase,
  decodeUnicode,
  encodeUnicode
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
      'style.css'
    ]) {
      expect(existsSync(path.join(root, asset))).toBe(true)
    }
    expect(manifest.features.map((feature) => feature.code)).toEqual([
      'sql',
      'case',
      'unicode',
      'unicode-encode',
      'lines'
    ])
    expect(readFileSync(path.join(root, 'index.html'), 'utf8')).toContain("connect-src 'none'")
  })
})
