import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  encodePng,
  renderPng,
  decodePng,
  resample,
  buildIco,
  renderIco,
  DEFAULT_LADDER,
  coverage,
  distSegment,
  distSegmentAt,
  distRoundedRect,
  distArc,
  distRing,
  flattenBezier,
  diagonalRamp
} from '../src/icon/index.mjs'

/** Read an .ico's directory back out, so tests assert on structure not bytes. */
function readIcoDirectory(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'reserved')
  assert.equal(buffer.readUInt16LE(2), 1, 'type is icon')
  const count = buffer.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    entries.push({
      width: buffer[at] === 0 ? 256 : buffer[at],
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12)
    })
  }
  return entries
}

test('encodePng round-trips through decodePng', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 255, 255, 9, 9, 9, 0
  ])
  const decoded = decodePng(encodePng(2, 2, rgba))
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual([...decoded.pixels], [...rgba])
})

test('renderPng samples pixel centres, not corners', () => {
  // A shade that reports the coordinate it was given, so the test can see it.
  const seen = []
  renderPng(2, (x, y) => {
    seen.push([x, y])
    return [0, 0, 0, 0]
  })
  assert.deepEqual(seen, [
    [0.5, 0.5],
    [1.5, 0.5],
    [0.5, 1.5],
    [1.5, 1.5]
  ])
})

test('decodePng rejects what it cannot actually read', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/)
})

test('buildIco writes a directory whose offsets and lengths line up', () => {
  const images = [16, 32].map((size) => ({
    size,
    png: renderPng(size, () => [1, 2, 3, 255])
  }))
  const ico = buildIco(images)
  const entries = readIcoDirectory(ico)

  assert.deepEqual(
    entries.map((e) => e.width),
    [16, 32]
  )
  let expected = 6 + entries.length * 16
  for (const [i, entry] of entries.entries()) {
    assert.equal(entry.offset, expected, `entry ${i} offset`)
    assert.equal(entry.bytes, images[i].png.length, `entry ${i} length`)
    // The bytes at the stated offset must be the PNG we handed in.
    assert.ok(ico.subarray(entry.offset, entry.offset + entry.bytes).equals(images[i].png))
    expected += entry.bytes
  }
  assert.equal(expected, ico.length, 'no trailing slack')
})

test('256 is recorded as 0 in the directory, per the format', () => {
  const [entry] = readIcoDirectory(buildIco([{ size: 256, png: renderPng(1, () => [0, 0, 0, 0]) }]))
  assert.equal(entry.width, 256)
})

test('buildIco refuses an empty set rather than writing a broken file', () => {
  assert.throws(() => buildIco([]), /at least one image/)
})

test('renderIco covers the ladder, including the 20 and 24 everyone forgets', () => {
  const ico = renderIco(() => [0, 0, 0, 255])
  assert.deepEqual(
    readIcoDirectory(ico).map((e) => e.width),
    DEFAULT_LADDER
  )
  assert.ok(DEFAULT_LADDER.includes(20) && DEFAULT_LADDER.includes(24))
})

test('renderIco tells the shade function which size it is drawing', () => {
  const sizes = new Set()
  renderIco((x, y, size) => {
    sizes.add(size)
    return [0, 0, 0, 0]
  }, [16, 48])
  assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 48])
})

test('coverage ramps across the stroke edge and clamps outside it', () => {
  assert.equal(coverage(-10, 2), 1, 'well inside')
  assert.equal(coverage(10, 2), 0, 'well outside')
  assert.equal(coverage(2, 2), 0.5, 'exactly on the edge is half covered')
})

test('distSegment survives a zero-length segment instead of returning NaN', () => {
  // A closed outline whose sides meet at a point contains one of these, and the
  // NaN it used to produce painted black rather than nothing.
  assert.equal(distSegment(3, 4, 0, 0, 0, 0), 5)
})

test('distSegmentAt reports how far along the segment the nearest point is', () => {
  // A tapered stroke reads its half-width off this, so the ends have to clamp
  // rather than run past the segment - otherwise the taper keeps going into
  // the round cap and the stroke comes to a point.
  assert.deepEqual(distSegmentAt(5, 3, 0, 0, 10, 0), { distance: 3, t: 0.5 })
  assert.equal(distSegmentAt(-5, 0, 0, 0, 10, 0).t, 0, 'before the start clamps to 0')
  assert.equal(distSegmentAt(15, 0, 0, 0, 10, 0).t, 1, 'past the end clamps to 1')
  assert.equal(distSegmentAt(3, 4, 0, 0, 0, 0).t, 0, 'and a zero-length segment is all start')
})

test('distRoundedRect is signed, so a plate can be filled rather than outlined', () => {
  // 0,0 to 100,100 with a radius of 20.
  const at = (x, y) => distRoundedRect(x, y, 0, 0, 100, 100, 20)
  assert.equal(at(50, 50), -50, 'the centre is half the plate from the nearest edge')
  assert.equal(at(0, 50), 0, 'a point on a flat edge is exactly on the outline')
  assert.equal(at(-10, 50), 10, 'outside is positive')
  // The corner: the arc centre sits at (20, 20), so the outline passes 20 away
  // from it and the square corner at (0, 0) is outside the shape.
  assert.ok(Math.abs(at(0, 0) - (Math.hypot(20, 20) - 20)) < 1e-9, 'the corner is rounded off')
  assert.equal(coverage(at(50, 50), 0), 1, 'and coverage fills it, rather than tracing it')
  assert.equal(coverage(at(-10, 50), 0), 0)
})

test('distArc gives round caps by measuring to the nearer endpoint', () => {
  // Sweep 0..90 degrees (three o'clock round to six, since y points down).
  const onArc = distArc(10, 0, 0, 0, 10, 0, 90)
  assert.equal(onArc, 0, 'a point on the arc is at zero distance')

  // Straight up is outside the sweep, so distance is to the (10, 0) endpoint.
  const offArc = distArc(0, -10, 0, 0, 10, 0, 90)
  assert.ok(Math.abs(offArc - Math.hypot(10, 10)) < 1e-9, 'measured to the endpoint')
})

test('distArc handles a sweep that wraps past 360', () => {
  // 350..10 crosses zero; a point at 0 degrees is inside it.
  assert.equal(distArc(10, 0, 0, 0, 10, 350, 10), 0)
})

test('distRing measures to the circle, inside and out', () => {
  assert.equal(distRing(0, 0, 0, 0, 10), 10, 'the centre is a full radius away')
  assert.equal(distRing(15, 0, 0, 0, 10), 5)
})

test('flattenBezier keeps both endpoints', () => {
  const points = flattenBezier([0, 0], [0, 10], [10, 10], [10, 0], 8)
  assert.equal(points.length, 9)
  assert.deepEqual(points[0], [0, 0])
  assert.deepEqual(points[points.length - 1], [10, 0])
})

test('diagonalRamp interpolates corner to corner', () => {
  const ramp = diagonalRamp([0, 0, 0], [100, 200, 255])
  assert.deepEqual(ramp(0, 0, 10), [0, 0, 0], 'top left is the from colour')
  assert.deepEqual(ramp(10, 10, 10), [100, 200, 255], 'bottom right is the to colour')
  assert.deepEqual(ramp(5, 5, 10), [50, 100, 128], 'the middle is halfway')
})

test('resample averages colour weighted by alpha, so edges keep no halo', () => {
  // Two opaque red pixels and two fully transparent ones whose RGB is black.
  // A naive average would give a dark red; alpha-weighting must give pure red.
  const image = {
    width: 2,
    height: 2,
    pixels: Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 0, 0, 0, 0, 0, 0
    ])
  }
  const [r, g, b, a] = resample(image, 1)
  assert.deepEqual([r, g, b], [255, 0, 0], 'colour untouched by the transparent pixels')
  assert.equal(a, 128, 'but alpha is the honest average')
})
