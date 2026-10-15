import { readFile, open } from 'node:fs/promises'
import { resolveSafeMirrorPath } from './pathSafety'

const start = '# BEGIN CAI.Tools Git mirror'
const end = '# END CAI.Tools Git mirror'
const block = [
  start,
  'profile.json text eol=lf',
  'host/**/*.json text eol=lf',
  'plugins/*.json text eol=lf',
  'records/**/*.json text eol=lf',
  'packages/**/*.zpx -text',
  'blobs/** -text',
  end,
  ''
].join('\n')

/**
 * 首次绑定时追加协议属性，保留用户既有规则，重复执行不写入。
 * @param repoRoot 已校验的同步根。
 * @returns 本次是否追加了受管块。
 * @throws 路径不安全、已有块损坏或文件写入失败时抛错。
 */
export async function initializeMirrorAttributes(repoRoot: string): Promise<boolean> {
  const filename = await resolveSafeMirrorPath(repoRoot, '.gitattributes')
  let existing = ''
  try {
    existing = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 拒绝不完整或被改写的受管块，不能猜测并覆盖用户规则。
  const normalized = existing.replace(/\r\n/g, '\n')
  if (normalized.includes(start) || normalized.includes(end)) {
    if (
      normalized.split(start).length !== 2 ||
      normalized.split(end).length !== 2 ||
      !normalized.includes(block)
    ) {
      throw new Error('INVALID_ATTRIBUTES_BLOCK')
    }
    return false
  }
  await resolveSafeMirrorPath(repoRoot, '.gitattributes')
  const handle = await open(filename, 'a')
  try {
    // 只追加受管块，不截断任何既有规则；flush 后才报告成功。
    await handle.writeFile((existing && !existing.endsWith('\n') ? '\n' : '') + block, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}
