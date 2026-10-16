/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM 使用 JSDoc 定义返回合同。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'

/**
 * 在发布前校验 Windows local 通道的元数据、安装包与打包身份。
 * @param {string} directory 构建输出目录。
 * @param {string} version 本次构建的完整版本号。
 * @returns {Promise<void>} 所有发布合同满足后结束的 Promise。
 * @throws {Error} 版本、身份、更新源、校验值或必要文件不匹配时拒绝发布。
 */
export async function verifyWindowsUpdate(directory, version) {
  // 发布仅接受当前 local 数字版本体系，防止将试用包发布为稳定版。
  if (!/^\d+\.\d+\.\d+-local\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Expected local prerelease version')
  const names = await fs.readdir(directory)
  const installers = names.filter((name) => name.endsWith('-setup.exe'))
  if (installers.length !== 1) throw new Error('Expected exactly one NSIS installer')
  const metadata = yaml.parse(await fs.readFile(path.join(directory, 'local.yml'), 'utf8'))
  if (metadata.version !== version) throw new Error('Update version mismatch')
  const file = metadata.files?.find((item) => item.url === installers[0])
  if (!file || metadata.files.length !== 1 || metadata.path !== installers[0])
    throw new Error('Unexpected update artifact')

  // 对实际安装包重新计算摘要，避免上传残留或与 YAML 不一致的制品。
  const installer = await fs.readFile(path.join(directory, installers[0]))
  const digest = createHash('sha512').update(installer).digest('base64')
  if (file.sha512 !== digest || metadata.sha512 !== digest || file.size !== installer.length)
    throw new Error('Installer integrity mismatch')
  const blockmap = await fs.stat(path.join(directory, installers[0] + '.blockmap'))
  if (!blockmap.size) throw new Error('Empty installer blockmap')

  // 检查最终资源目录，不以源配置推断安装版确实携带更新源。
  const resources = path.join(directory, 'win-unpacked', 'resources')
  const feed = yaml.parse(await fs.readFile(path.join(resources, 'app-update.yml'), 'utf8'))
  if (
    feed.provider !== 'github' ||
    feed.owner !== 'Caicy' ||
    feed.repo !== 'CAI.Tools' ||
    feed.channel !== 'local' ||
    feed.private ||
    feed.token
  )
    throw new Error('Unexpected packaged update source')
  const info = JSON.parse(
    await fs.readFile(path.join(resources, 'ztools-install-info.json'), 'utf8')
  )
  if (
    info.schemaVersion !== 1 ||
    info.appId !== 'tools.cai.local' ||
    info.updater !== 'electron-updater-nsis'
  )
    throw new Error('Unexpected install identity')
}

// 导入时不执行；CI 通过命令行显式校验即将上传的目录。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await verifyWindowsUpdate(path.resolve(process.argv[2] || 'dist'), pkg.version)
  console.log(`Verified Windows update artifacts: ${pkg.version}`)
}
