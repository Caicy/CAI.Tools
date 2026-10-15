import path from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, realpath, readdir } from 'node:fs/promises'
import { assertSafePluginArtifactPart } from '../../utils/pluginStorage'
import { MIRROR_LIMITS } from '../../../shared/gitMirrorTypes'

const reservedDevice = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

/**
 * 验证协议路径采用唯一的 Windows 安全相对写法。
 * @param relativePath 使用正斜杠的协议相对路径。
 * @returns 无返回值。
 * @throws 绝对路径、穿越、设备名、ADS 或无效片段时抛错。
 */
export function assertRelativeMirrorPath(relativePath: string): void {
  if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error('UNSAFE_MIRROR_PATH')
  }
  const parts = relativePath.split('/')
  if (parts.length > MIRROR_LIMITS.depth) throw new Error('PATH_TOO_DEEP')
  for (const part of parts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part.toLowerCase() === '.git' ||
      /[<>:"\\|?*]/.test(part) ||
      Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/.test(part) ||
      reservedDevice.test(part) ||
      part.length > 255
    ) {
      throw new Error('UNSAFE_MIRROR_PATH')
    }
  }
}

/**
 * 检查整组协议文件与所有父目录不存在大小写别名。
 * @param paths 本次快照中的相对文件路径。
 * @returns 无返回值。
 * @throws 重复路径、大小写或文件与目录身份冲突时抛错。
 */
export function assertDistinctMirrorPaths(paths: string[]): void {
  const names = new Map<string, string>()
  const files = new Set<string>()
  const directories = new Set<string>()
  for (const filename of paths) {
    assertRelativeMirrorPath(filename)
    if (files.has(filename)) throw new Error('DUPLICATE_MIRROR_PATH')
    if (directories.has(filename)) throw new Error('PATH_TYPE_COLLISION')
    files.add(filename)
    const parts = filename.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      if (i < parts.length && files.has(prefix)) throw new Error('PATH_TYPE_COLLISION')
      if (i < parts.length) directories.add(prefix)
      const previous = names.get(prefix.toLowerCase())
      if (previous && previous !== prefix) throw new Error('CASE_COLLISION')
      names.set(prefix.toLowerCase(), prefix)
    }
  }
}

/**
 * 以插件名和逻辑键生成不暴露业务键的记录文件名。
 * @param plugin 插件 canonical 名称。
 * @param key 插件内部逻辑键。
 * @returns 记录的协议相对路径。
 * @throws 插件名不是安全文件片段时抛错。
 */
export function recordRelativePath(plugin: string, key: string): string {
  assertSafePluginArtifactPart(plugin, '插件名称')
  assertRelativeMirrorPath(plugin)
  const hash = createHash('sha256').update(key, 'utf8').digest('hex')
  return `records/${plugin}/${hash}.json`
}

/**
 * 逐级检查既存目录，拒绝 symlink、junction 和真实路径逃逸。
 * @param absolutePath 待校验的绝对路径，允许尚未创建的尾部。
 * @returns 按既存父目录规范化后的绝对路径。
 * @throws 链接、父级文件、路径别名或访问错误时抛错。
 */
async function inspectPhysicalPath(absolutePath: string): Promise<string> {
  if (
    !path.isAbsolute(absolutePath) ||
    absolutePath.startsWith('\\\\') ||
    absolutePath.startsWith('//')
  ) {
    throw new Error('UNSAFE_MIRROR_ROOT')
  }
  const resolved = path.resolve(absolutePath)
  const anchor = path.parse(resolved).root
  const parts = path.relative(anchor, resolved).split(path.sep).filter(Boolean)
  let current = anchor
  for (let index = 0; index < parts.length; index++) {
    const component = parts[index]
    // 既存父目录不得通过大小写不同的名字指向同一实体。
    const names = await readdir(current)
    const alias = names.find((name) => name.toLowerCase() === component.toLowerCase())
    if (alias && alias !== component) throw new Error('CASE_COLLISION')
    current = path.join(current, component)
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return path.join(current, ...parts.slice(index + 1))
    }
    if (stat.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED')
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('NOT_DIRECTORY')
    const physical = await realpath(current)
    if (path.relative(path.dirname(current), physical) !== component) throw new Error('PATH_ESCAPE')
    current = physical
  }
  return current
}

/**
 * 将已校验相对路径解析到同步根以内，允许待创建的目标。
 * @param repoRoot 已选择的同步根。
 * @param relativePath 协议相对路径。
 * @returns 经过物理路径边界检查的绝对目标。
 * @throws 目录不存在、路径越界或含链接时抛错。
 */
export async function resolveSafeMirrorPath(
  repoRoot: string,
  relativePath: string
): Promise<string> {
  assertRelativeMirrorPath(relativePath)
  const root = await inspectPhysicalPath(repoRoot)
  if (!(await lstat(root)).isDirectory()) throw new Error('NOT_DIRECTORY')
  const target = await inspectPhysicalPath(path.join(root, relativePath))
  const relative = path.relative(root, target)
  if (
    !relative ||
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('PATH_ESCAPE')
  }
  return target
}

/**
 * 拒绝同步目录与本机数据根重叠，避免把运行库带入 Git。
 * @param repoRoot 候选同步根，必须已存在。
 * @param localRoot 本机数据根，允许尚未初始化。
 * @returns 校验完成后结束的 Promise。
 * @throws 两目录重叠、候选不是目录或含链接时抛错。
 */
export async function assertSeparateMirrorRoot(repoRoot: string, localRoot: string): Promise<void> {
  const repo = await inspectPhysicalPath(repoRoot)
  const local = await inspectPhysicalPath(localRoot)
  if (!(await lstat(repo)).isDirectory()) throw new Error('NOT_DIRECTORY')
  // path.relative 在 Windows 同时处理盘符与大小写；两个方向都必须在根外。
  for (const [parent, child] of [
    [repo, local],
    [local, repo]
  ]) {
    const relative = path.relative(parent, child)
    if (
      !relative ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    ) {
      throw new Error('OVERLAPPING_ROOTS')
    }
  }
}
