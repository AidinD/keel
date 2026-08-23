import { renderPng } from './png.mjs'

/**
 * The sizes a Windows icon should carry.
 *
 * 20 and 24 are the two that get forgotten and the two that matter most in
 * practice: the taskbar asks for them at 125% and 150% display scaling, which is
 * what most laptops actually run at. Without them Windows resamples a
 * neighbouring frame and the mark goes soft at exactly the scale you use daily.
 */
export const DEFAULT_LADDER = [256, 128, 64, 48, 32, 24, 20, 16]

/**
 * Below this, use the simplified drawing.
 *
 * Measured rather than picked: at 16px a stroke at the mark's true weight lands
 * under a pixel and counters close up. Jot, Loom and Tend all landed on the same
 * threshold independently by rendering both drawings side by side.
 */
export const SMALL_BELOW = 32

/**
 * A Vista-era .ico: a directory of entries, each holding a whole PNG.
 *
 * Written by hand rather than handing electron-builder a single large PNG,
 * because that makes it downscale one drawing to 16px - which is the entire
 * thing the second drawing exists to avoid.
 *
 * @param {{ size: number, png: Buffer }[]} images
 * @returns {Buffer}
 */
export function buildIco(images) {
  if (images.length === 0) {
    throw new Error('an .ico needs at least one image')
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 means 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    directory.push(entry)
    offset += png.length
  }

  return Buffer.concat([header, ...directory, ...images.map((image) => image.png)])
}

/**
 * Draw every frame of an .ico from one shading function.
 *
 * The shade function receives the size, so it can pick its own drawing - see
 * SMALL_BELOW. Sizes are rendered largest-first, matching what the apps already
 * produced, so a migrating app gets a byte-identical file.
 *
 * @param {(x: number, y: number, size: number) => number[]} shade
 * @param {number[]} [sizes]
 * @returns {Buffer}
 */
export function renderIco(shade, sizes = DEFAULT_LADDER) {
  return buildIco(sizes.map((size) => ({ size, png: renderPng(size, shade) })))
}
