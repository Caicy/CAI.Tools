import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  canonicalJson,
  strictParseJson,
  jsonFingerprint
} from '../../src/main/core/gitMirror/canonicalJson'
import {
  assertRelativeMirrorPath,
  assertDistinctMirrorPaths,
  recordRelativePath,
  resolveSafeMirrorPath,
  assertSeparateMirrorRoot
} from '../../src/main/core/gitMirror/pathSafety'
import { initializeMirrorAttributes } from '../../src/main/core/gitMirror/attributes'

const roots: string[] = []

/**
 * 创建只属于当前测试的目录。
 * @returns 临时目录绝对路径。
 */
async function fixture(): Promise<string> {
  // 所有写入限定在测试自己创建的根，避免接触真实用户目录。
  const root = await mkdtemp(path.join(tmpdir(), 'cai-mirror-format-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  // 只清理本文件创建且已释放句柄的临时目录。
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test('稳定 JSON 按键排序，保留数组和正文，不受换行排版影响', () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  expect(strictParseJson('{"text":"<<<<<<< sample","list":[2,1]}')).toEqual({
    text: '<<<<<<< sample',
    list: [2, 1]
  })
  expect(jsonFingerprint('{\r\n"b":2,"a":1}')).toBe(jsonFingerprint('{"a":1,"b":2}'))
})

test.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":[{"x":1,"x":2}]}'])(
  '拒绝重复键 %s',
  (text) => expect(() => strictParseJson(text)).toThrow('DUPLICATE_JSON_KEY')
)

test.each(['__proto__', 'prototype', 'constructor'])('拒绝危险键 %s', (key) => {
  expect(() => strictParseJson(`{"${key}":1}`)).toThrow('UNSAFE_JSON_KEY')
})

test('拒绝坏语法、无限数值、过深 JSON，正确处理转义引号', () => {
  expect(() => strictParseJson('<<<<<<< HEAD\n{}')).toThrow()
  expect(() => strictParseJson('{"a":1,}')).toThrow()
  expect(() => strictParseJson('1e999')).toThrow('INVALID_NUMBER')
  expect(() => canonicalJson(NaN)).toThrow('INVALID_NUMBER')
  expect(() => strictParseJson('['.repeat(65) + '0' + ']'.repeat(65))).toThrow('JSON_TOO_DEEP')
  expect(strictParseJson(String.raw`[{"a":"\" : { ","b":2},{"a":3}]`)).toEqual([
    { a: '" : { ', b: 2 },
    { a: 3 }
  ])
})

test('序列化严格拒绝非 JSON 值和循环，数字对象键也按字典序', () => {
  expect(canonicalJson({ '2': 2, '10': 10 })).toBe('{\n  "10": 10,\n  "2": 2\n}\n')
  expect(() => canonicalJson({ a: undefined } as never)).toThrow('INVALID_JSON_VALUE')
  expect(() => canonicalJson(new Date() as never)).toThrow('INVALID_JSON_OBJECT')
  const cyclic: { child?: unknown } = {}
  cyclic.child = cyclic
  expect(() => canonicalJson(cyclic as never)).toThrow('CYCLIC_JSON')
  expect(() => strictParseJson('"' + 'x'.repeat(1024 * 1024) + '"')).toThrow('JSON_TOO_LARGE')
  expect(() => canonicalJson('x'.repeat(1024 * 1024))).toThrow('JSON_TOO_LARGE')
  const shared = { a: 1 }
  expect(() => canonicalJson([shared, shared])).not.toThrow()
})

test.each([
  '../a',
  '/a',
  'C:\\a',
  '\\\\server\\a',
  'a:b',
  'CON',
  'con.txt',
  'LPT1.json',
  'a/../b',
  'a//b',
  'a\\b',
  'a.',
  'a ',
  '.git/config',
  'a\u0000b',
  'a/./b',
  'x?y',
  'COM¹.txt'
])('拒绝不安全相对路径 %s', (value) => expect(() => assertRelativeMirrorPath(value)).toThrow())

test('检测大小写重名，以逻辑键摘要生成记录路径', () => {
  expect(() => assertDistinctMirrorPaths(['records/A/a.json', 'records/a/b.json'])).toThrow(
    'CASE_COLLISION'
  )
  expect(() => assertDistinctMirrorPaths(['host/a.json', 'host/A.JSON'])).toThrow('CASE_COLLISION')
  expect(recordRelativePath('code-snippets', '../CON')).toBe(
    `records/code-snippets/${createHash('sha256').update('../CON').digest('hex')}.json`
  )
  expect(() => recordRelativePath('CON', 'id')).toThrow()
  expect(() => assertDistinctMirrorPaths(['host/a', 'host/a/b'])).toThrow('PATH_TYPE_COLLISION')
  expect(() => assertDistinctMirrorPaths(['host/a/b', 'host/a'])).toThrow('PATH_TYPE_COLLISION')
})

test('路径检查允许缺失的受管目标但拒绝文件作为父目录', async () => {
  const root = await fixture()
  expect(await resolveSafeMirrorPath(root, 'records/code-snippets/a.json')).toBe(
    path.join(root, 'records/code-snippets/a.json')
  )
  await writeFile(path.join(root, 'records'), 'file')
  await expect(resolveSafeMirrorPath(root, 'records/a.json')).rejects.toThrow('NOT_DIRECTORY')
})

test('拒绝 UNC 和相对同步根，以及过深路径', async () => {
  await expect(resolveSafeMirrorPath('\\\\server\\share', 'profile.json')).rejects.toThrow(
    'UNSAFE_MIRROR_ROOT'
  )
  await expect(resolveSafeMirrorPath('relative', 'profile.json')).rejects.toThrow(
    'UNSAFE_MIRROR_ROOT'
  )
  expect(() => assertRelativeMirrorPath(Array(65).fill('a').join('/'))).toThrow('PATH_TOO_DEEP')
})

test('逐级拒绝 junction，包括同步根或父级的跳转', async () => {
  const root = await fixture()
  await mkdir(path.join(root, 'repo'))
  await mkdir(path.join(root, 'outside'))
  await symlink(path.join(root, 'outside'), path.join(root, 'repo/link'), 'junction')
  await expect(resolveSafeMirrorPath(path.join(root, 'repo'), 'link/data.json')).rejects.toThrow(
    'SYMLINK'
  )
  await expect(resolveSafeMirrorPath(path.join(root, 'repo/link'), 'data.json')).rejects.toThrow(
    'SYMLINK'
  )
})

test('拒绝同步目录和本机根互相包含，接受相邻目录', async () => {
  const root = await fixture()
  const local = path.join(root, 'local')
  const repo = path.join(root, 'repo')
  await mkdir(local)
  await mkdir(repo)
  await mkdir(path.join(local, 'nested'))
  await expect(assertSeparateMirrorRoot(local, local)).rejects.toThrow('OVERLAPPING_ROOTS')
  await expect(assertSeparateMirrorRoot(path.join(local, 'nested'), local)).rejects.toThrow(
    'OVERLAPPING_ROOTS'
  )
  await expect(assertSeparateMirrorRoot(root, local)).rejects.toThrow('OVERLAPPING_ROOTS')
  await expect(assertSeparateMirrorRoot(repo, local)).resolves.toBeUndefined()
})

test('追加受管属性且保留用户内容，重复初始化不重写', async () => {
  const root = await fixture()
  const filename = path.join(root, '.gitattributes')
  await writeFile(filename, '# personal\r\n*.txt text\r\n')
  expect(await initializeMirrorAttributes(root)).toBe(true)
  const content = await readFile(filename, 'utf8')
  expect(content.startsWith('# personal\r\n*.txt text\r\n')).toBe(true)
  expect(content).toContain('packages/**/*.zpx -text\n')
  expect(content).toContain('records/**/*.json text eol=lf\n')
  expect(await initializeMirrorAttributes(root)).toBe(false)
  expect(await readFile(filename, 'utf8')).toBe(content)
})

test('属性块损坏时拒绝覆盖，未知文件保持原样', async () => {
  const root = await fixture()
  const existing = '# BEGIN CAI.Tools Git mirror\ncustom rule\n'
  await writeFile(path.join(root, '.gitattributes'), existing)
  await writeFile(path.join(root, 'personal.txt'), 'keep')
  await expect(initializeMirrorAttributes(root)).rejects.toThrow('INVALID_ATTRIBUTES_BLOCK')
  expect(await readFile(path.join(root, '.gitattributes'), 'utf8')).toBe(existing)
  expect(await readFile(path.join(root, 'personal.txt'), 'utf8')).toBe('keep')
})
