import { deflateSync, inflateSync } from 'node:zlib'

/**
 * PNG encoding and decoding, with no dependencies.
 *
 * The encoder is byte-for-byte the one Jot, Nib, Loom and Tend each carried their
 * own copy of: no row filtering, deflate level 9, IHDR then IDAT then IEND. That
 * is deliberate and worth keeping - it means an app can adopt this package and
 * regenerate its icons expecting an EMPTY diff, which is the only way to migrate
 * an icon pipeline without eyeballing every size.
 *
 * The decoder exists for one case: Helm's mark is supplied artwork rather than
 * geometry, so its icon is built by resampling a PNG instead of drawing one.
 */

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Encode raw RGBA to a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba Row-major, 4 bytes per pixel.
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    // The leading byte is the row filter, left at 0 (none).
    const row = Buffer.alloc(1 + width * 4)
    Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length).copy(
      row,
      1,
      y * width * 4,
      (y + 1) * width * 4
    )
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Render a square PNG by asking `shade` for every pixel.
 *
 * `shade` is called with the pixel's CENTRE (x + 0.5, y + 0.5) and the canvas
 * size, and returns `[r, g, b, a]`. Sampling at the centre rather than the corner
 * is what keeps a shape's anti-aliasing symmetric.
 *
 * @param {number} size
 * @param {(x: number, y: number, size: number) => number[]} shade
 * @returns {Buffer}
 */
export function renderPng(size, shade) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      rgba.set(shade(x + 0.5, y + 0.5, size), (y * size + x) * 4)
    }
  }
  return encodePng(size, size, rgba)
}

/**
 * Decode a non-interlaced 8-bit RGB or RGBA PNG to flat RGBA.
 *
 * Not a general decoder, and it throws rather than guessing on anything else -
 * the alternative is silently producing a wrong icon.
 *
 * @param {Buffer} file
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG')
  }
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.subarray(offset + 4, offset + 8).toString('ascii')
    const data = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colourType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(
          `unsupported PNG: depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}`
        )
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)

    // Undo the scanline filter. Byte-wise: `channels` back is the pixel to the
    // left, `previous` is the already-reconstructed row above.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      let value = line[i]
      if (filter === 1) {
        value += a
      } else if (filter === 2) {
        value += b
      } else if (filter === 3) {
        value += (a + b) >> 1
      } else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`unknown PNG row filter ${filter}`)
      }
      line[i] = value & 0xff
    }
    line.copy(previous)

    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      pixels[to] = line[from]
      pixels[to + 1] = line[from + 1]
      pixels[to + 2] = line[from + 2]
      pixels[to + 3] = channels === 4 ? line[from + 3] : 255
    }
  }

  return { width, height, pixels }
}

/**
 * Resample a decoded image down to `size` by averaging the source pixels that
 * fall inside each target pixel.
 *
 * Alpha-weighted deliberately: averaging colour straight through pulls the
 * transparent background's RGB into the edge and leaves a dark halo around the
 * mark.
 *
 * @param {{ width: number, height: number, pixels: Buffer }} image
 * @param {number} size
 * @returns {Buffer} RGBA
 */
export function resample(image, size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = image.width / size

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))

      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4
          const a = image.pixels[i + 3] / 255
          r += image.pixels[i] * a
          g += image.pixels[i + 1] * a
          b += image.pixels[i + 2] * a
          alpha += a
          count += 1
        }
      }

      const to = (y * size + x) * 4
      if (alpha > 0) {
        out[to] = Math.round(r / alpha)
        out[to + 1] = Math.round(g / alpha)
        out[to + 2] = Math.round(b / alpha)
        out[to + 3] = Math.round((alpha / count) * 255)
      }
    }
  }

  return out
}
