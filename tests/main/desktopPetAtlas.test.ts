import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import manifest from '../../src/renderer/src/desktopPet/assets/manifest.json'
import { PET_ACTIONS, validatePetManifest } from '../../src/shared/desktopPetManifest'

/**
 * 计算 PNG Paeth 滤波预测值，不依赖安装额外原生解码器。
 * @param a 左邻像素。
 * @param b 上邻像素。
 * @param c 左上邻像素。
 * @returns 最接近预测值的邻像素。
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c)
  return da <= db && da <= dc ? a : db <= dc ? b : c
}

/**
 * 解码仓库的非交错 8-bit RGBA PNG，保留原始 alpha 以验证素材而非截图。
 * @returns 图像宽高与逐像素 RGBA 缓冲区。
 * @throws PNG 编码不符合本素材契约时抛错。
 */
function decodeAtlas(): { width: number; height: number; pixels: Uint8Array } {
  const png = readFileSync(resolve(__dirname, '../../src/renderer/src/desktopPet/assets/atlas.png'))
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG')
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20)
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error('需要非交错 RGBA8 PNG')
  const chunks: Buffer[] = []
  // 收集 IDAT 并撤销 PNG 的五种标准逐行滤波；无需修改项目安装策略。
  for (let offset = 8; offset < png.length; ) {
    const size = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + size))
    offset += size + 12
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * 4
  if (raw.length !== (stride + 1) * height) throw new Error('PNG 解码长度不匹配')
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) throw new Error('无效 PNG 滤波')
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x
      const a = x >= 4 ? pixels[index - 4] : 0
      const b = y > 0 ? pixels[index - stride] : 0
      const c = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0
      const predicted =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? Math.floor((a + b) / 2)
              : filter === 4
                ? paeth(a, b, c)
                : 0
      pixels[index] = (raw[y * (stride + 1) + x + 1] + predicted) & 255
    }
  }
  return { width, height, pixels }
}

/**
 * 测量球壳最大浅色连通区域，深绿轮廓自然分离天线、手、耳、脚。
 * @param pixels 完整图集 RGBA。
 * @param imageWidth 图集宽度。
 * @param row 动作行。
 * @param col 帧列。
 * @returns 球壳宽高、宽高比和中心；宽度仅取 y≤160，排除低位摆臂。
 */
function bodyBounds(pixels: Uint8Array, imageWidth: number, row: number, col: number) {
  const seen = new Uint8Array(192 * 256)
  let largest: number[] = []
  for (let y = 90; y < 218; y++) {
    for (let x = 0; x < 192; x++) {
      const queue = [y * 192 + x],
        region: number[] = []
      for (let q = 0; q < queue.length; q++) {
        const cell = queue[q],
          px = cell % 192,
          py = Math.floor(cell / 192)
        if (px < 0 || px >= 192 || py < 90 || py >= 218 || seen[cell]) continue
        seen[cell] = 1
        const index = ((row * 256 + py) * imageWidth + col * 192 + px) * 4
        const [r, g, b, a] = pixels.subarray(index, index + 4)
        if (
          !(
            a > 240 &&
            ((g >= 90 && g > r * 1.08 && g > b * 1.05) || (r > 205 && g > 190 && b > 135))
          )
        )
          continue
        region.push(cell)
        if (px > 0) queue.push(cell - 1)
        if (px < 191) queue.push(cell + 1)
        queue.push(cell - 192, cell + 192)
      }
      if (region.length > largest.length) largest = region
    }
  }
  // 腹部摆臂可能与球壳抗锯齿相连，宽度取没有手脚的肩部/赤道带。
  let left = 192,
    right = -1,
    top = 256,
    bottom = -1
  for (const cell of largest) {
    const x = cell % 192,
      y = Math.floor(cell / 192)
    if (y <= 160) {
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  const width = right - left + 1,
    height = bottom - top + 1
  return { width, height, ratio: width / height, x: (left + right) / 2, y: (top + bottom) / 2 }
}

// 两项像素检查共享一次原始解码，避免 Windows 并行测试重复撤销 2.36M 像素滤波。
const decodedAtlas = decodeAtlas()

describe('desktop pet atlas pixel contract', /**
 * 验证所有动作的透明度、地面与球形侧身。
 * @returns 无返回值。
 */ () => {
  it('grounds every non-jump frame at y=230 and keeps required cells transparent/nonempty', /**
   * 以原始 alpha>16 测量 48 帧，防止背景或插值尾部污染。
   * @returns 无返回值。
   */ () => {
    const image = decodedAtlas
    const checked = validatePetManifest(manifest, image.width, image.height)
    for (let row = 0; row < checked.rows; row++) {
      for (let col = 0; col < checked.columns; col++) {
        let bottom = -1,
          occupied = 0
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 192; x++) {
            if (image.pixels[((row * 256 + y) * image.width + col * 192 + x) * 4 + 3] > 16) {
              bottom = y
              occupied++
            }
          }
        }
        let required = false
        for (const action of PET_ACTIONS) {
          if (checked.clips[action].row === row && col < checked.clips[action].frames)
            required = true
        }
        if (!required) expect(occupied, `unused ${row}:${col}`).toBe(0)
        else {
          expect(bottom, `baseline ${row}:${col}`).toBe(230)
          expect(occupied).toBeGreaterThan(1000)
          expect(occupied).toBeLessThan(192 * 256 * 0.9)
        }
      }
    }
  })

  it('keeps running bodies circular, idle-sized, and stationary within each clip', /**
   * 比较最大浅色球壳连通区域，手脚天线不参与身体宽高比。
   * @returns 无返回值。
   */ () => {
    const image = decodedAtlas
    const front = bodyBounds(image.pixels, image.width, 0, 0)
    for (const row of [1, 2]) {
      const bodies: ReturnType<typeof bodyBounds>[] = []
      for (let col = 0; col < 8; col++) {
        const body = bodyBounds(image.pixels, image.width, row, col)
        bodies.push(body)
        expect(body.ratio, `${row}:${col} absolute roundness`).toBeGreaterThanOrEqual(0.95)
        expect(body.ratio).toBeLessThanOrEqual(1.05)
        expect(body.ratio / front.ratio).toBeGreaterThanOrEqual(0.95)
        expect(body.ratio / front.ratio).toBeLessThanOrEqual(1.05)
        expect(body.width / front.width).toBeGreaterThanOrEqual(0.95)
        expect(body.height / front.height).toBeGreaterThanOrEqual(0.95)
      }
      const xs: number[] = [],
        ys: number[] = []
      for (const body of bodies) {
        xs.push(body.x)
        ys.push(body.y)
      }
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(2)
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(2)
    }
  })
})
