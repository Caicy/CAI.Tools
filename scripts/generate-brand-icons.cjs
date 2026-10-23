const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require(process.env.CAI_SHARP_MODULE || 'sharp')
const root = path.resolve(__dirname, '..')

/**
 * 从仓库矢量源生成应用、设置、托盘及跨平台安装图标。
 * @returns 所有图标写入完成后结束的 Promise。
 * @throws SVG 渲染或文件写入失败时抛错。
 */
async function main() {
  const source = await fs.readFile(path.join(root, 'resources/branding/cai-tools.svg'))
  const tray = await fs.readFile(path.join(root, 'resources/branding/cai-tools-tray.svg'))
  // 应用、默认头像与 README 共用品牌源，覆盖主窗口设置入口及超级面板。
  const targets = [
    ['build/icon.png', 1024],
    ['.github/assets/icon.png', 512],
    ['resources/icons/icon.png', 512],
    ['resources/icons/icon-ztools.png', 256],
    ['resources/icons/windows-icon.png', 64],
    ['src/renderer/src/assets/logo.png', 512],
    ['src/renderer/src/assets/image/default.png', 256],
    ['internal-plugins/setting/src/assets/image/default.png', 256],
    ['internal-plugins/setting/public/logo.png', 256]
  ]
  for (const [filename, size] of targets) {
    await sharp(source).resize(size, size).png().toFile(path.join(root, filename))
  }
  // macOS 模板托盘保留透明背景，只绘制单色 C，交给系统适配明暗主题。
  await sharp(tray).png().toFile(path.join(root, 'resources/icons/trayTemplate@2x.png'))
  await sharp(tray)
    .negate({ alpha: false })
    .png()
    .toFile(path.join(root, 'resources/icons/trayTemplate@2x-light.png'))

  // Windows ICO 采用标准 PNG 图像目录，包含常用 DPI 尺寸。
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of sizes) pngs.push(await sharp(source).resize(size, size).png().toBuffer())
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16
    header[entry] = sizes[index] === 256 ? 0 : sizes[index]
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(pngs[index].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += pngs[index].length
  }
  await fs.writeFile(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...pngs]))

  // macOS ICNS 使用现代 PNG 成员；类型与像素尺寸按容器规范对应。
  const members = []
  for (const [type, size] of [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024]
  ]) {
    const png = await sharp(source).resize(size, size).png().toBuffer()
    const item = Buffer.alloc(8)
    item.write(type, 0, 4, 'ascii')
    item.writeUInt32BE(png.length + 8, 4)
    members.push(item, png)
  }
  const icnsHeader = Buffer.alloc(8)
  icnsHeader.write('icns', 0, 4, 'ascii')
  icnsHeader.writeUInt32BE(
    8 +
      members.reduce(
        /**
         * 累计 ICNS 成员字节数。
         * @param total 已累计长度。
         * @param member 当前成员数据。
         * @returns 新的累计长度。
         */
        (total, member) => total + member.length,
        0
      ),
    4
  )
  await fs.writeFile(path.join(root, 'build/icon.icns'), Buffer.concat([icnsHeader, ...members]))
  console.log('Generated CAI.Tools PNG, ICO, ICNS and tray icons from SVG sources.')
}

main().catch(
  /**
   * 输出构建失败并返回非零退出码。
   * @param error 渲染或写入错误。
   * @returns 无返回值。
   */
  (error) => {
    console.error(error)
    process.exitCode = 1
  }
)
