/**
 * Distance-field helpers for drawing a mark.
 *
 * The whole approach: for each pixel, work out how far it is from the nearest
 * piece of the drawing, then turn that distance into coverage. It gives round
 * caps and clean anti-aliasing for free, and it is why the marks stay crisp at
 * 16px where a vector rasteriser or a downscaled bitmap would not.
 *
 * Everything here takes plain numbers in whatever space the caller is using.
 * The apps work in fractions of the canvas and multiply by `size`.
 */

/** @param {number} a @param {number} b @param {number} t */
export const mix = (a, b, t) => a + (b - a) * t

/** @param {number} degrees */
export const rad = (degrees) => (degrees * Math.PI) / 180

/**
 * Distance from a point to a line segment.
 *
 * The zero-length guard matters: a closed outline whose two sides meet at a
 * point contains a segment of length zero, and dividing by it turns every
 * distance into NaN - which paints black, not nothing.
 *
 * @param {number} px @param {number} py
 * @param {number} ax @param {number} ay
 * @param {number} bx @param {number} by
 */
export function distSegment(px, py, ax, ay, bx, by) {
  return distSegmentAt(px, py, ax, ay, bx, by).distance
}

/**
 * The same distance, plus how far along the segment the nearest point lies.
 *
 * That second number is what lets a stroke taper - a pen lands a little narrow,
 * runs full through the middle, and eases off as it lifts. Tend's marks are
 * drawn that way, and it is the difference between drawn and measured.
 *
 * @param {number} px @param {number} py
 * @param {number} ax @param {number} ay
 * @param {number} bx @param {number} by
 * @returns {{ distance: number, t: number }} `t` runs 0 at `a` to 1 at `b`.
 */
export function distSegmentAt(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const lengthSquared = abx * abx + aby * aby
  if (lengthSquared === 0) {
    return { distance: Math.hypot(px - ax, py - ay), t: 0 }
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSquared))
  return { distance: Math.hypot(px - (ax + abx * t), py - (ay + aby * t)), t }
}

/**
 * Distance to an open polyline, given as `[[x, y], ...]`.
 *
 * @param {number} px @param {number} py @param {number[][]} points
 */
export function distPolyline(px, py, points) {
  let best = Infinity
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(
      best,
      distSegment(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
    )
  }
  return best
}

/**
 * Distance to a closed polyline.
 *
 * @param {number} px @param {number} py @param {number[][]} points
 */
export function distPolygon(px, py, points) {
  let best = Infinity
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    best = Math.min(best, distSegment(px, py, a[0], a[1], b[0], b[1]))
  }
  return best
}

/**
 * Distance to a full circle of radius `r`.
 *
 * @param {number} px @param {number} py @param {number} cx @param {number} cy @param {number} r
 */
export const distRing = (px, py, cx, cy, r) => Math.abs(Math.hypot(px - cx, py - cy) - r)

/**
 * Distance to an arc running clockwise from `fromDeg` to `toDeg`, measured the
 * way SVG measures it: 0 degrees at three o'clock, increasing clockwise because
 * y points down.
 *
 * Outside the sweep the distance is taken to the nearer endpoint rather than to
 * the circle, which is what gives the arc round caps for free - the same caps
 * `stroke-linecap` gives an SVG.
 *
 * @param {number} px @param {number} py
 * @param {number} cx @param {number} cy @param {number} r
 * @param {number} fromDeg @param {number} toDeg
 */
export function distArc(px, py, cx, cy, r, fromDeg, toDeg) {
  const dx = px - cx
  const dy = py - cy
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle < 0) {
    angle += 360
  }
  const withinSweep =
    fromDeg <= toDeg ? angle >= fromDeg && angle <= toDeg : angle >= fromDeg || angle <= toDeg
  if (withinSweep) {
    return Math.abs(Math.hypot(dx, dy) - r)
  }
  return Math.min(
    Math.hypot(px - (cx + r * Math.cos(rad(fromDeg))), py - (cy + r * Math.sin(rad(fromDeg)))),
    Math.hypot(px - (cx + r * Math.cos(rad(toDeg))), py - (cy + r * Math.sin(rad(toDeg))))
  )
}

/**
 * Signed distance to a rounded rectangle: negative inside, positive outside.
 *
 * The odd one out here, and deliberately. Every other helper returns an
 * unsigned distance to an outline, because every other helper describes a
 * stroke and a stroke is symmetric about its path. A plate is a filled shape,
 * and filling needs to know which side you are on - so this is the one you pass
 * to `coverage(distance, 0)` rather than to `coverage(distance, halfWeight)`.
 *
 * @param {number} px @param {number} py
 * @param {number} x @param {number} y Top-left corner.
 * @param {number} width @param {number} height
 * @param {number} radius Corner radius.
 */
export function distRoundedRect(px, py, x, y, width, height, radius) {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const r = Math.min(radius, halfWidth, halfHeight)
  // Distance from the centre, folded into one quadrant, then inset by the
  // corner radius: what is left is the distance to a rectangle whose corners
  // have been rounded off by `r`.
  const dx = Math.abs(px - (x + halfWidth)) - (halfWidth - r)
  const dy = Math.abs(py - (y + halfHeight)) - (halfHeight - r)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - r
}

/**
 * A cubic bezier flattened to a polyline, so curves get the same round-capped
 * distance treatment as straight segments.
 *
 * 40 steps is well past the point where more makes a visible difference even at
 * 256px.
 *
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3
 * @param {number} [steps]
 */
export function flattenBezier(p0, p1, p2, p3, steps = 40) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ])
  }
  return points
}

/**
 * Turn a distance into coverage: 1 well inside the stroke, 0 well outside, and a
 * roughly one-pixel ramp between. `halfWeight` is half the stroke width.
 *
 * @param {number} distance @param {number} halfWeight @param {number} [feather]
 */
export function coverage(distance, halfWeight, feather = 1.1) {
  return Math.max(0, Math.min(1, (halfWeight - distance) / feather + 0.5))
}

/**
 * A two-stop colour ramp run across the canvas diagonal, which is how every mark
 * in the family is coloured.
 *
 * @param {number[]} from `[r, g, b]` at the top left
 * @param {number[]} to `[r, g, b]` at the bottom right
 * @returns {(x: number, y: number, size: number) => number[]}
 */
export function diagonalRamp(from, to) {
  return (x, y, size) => {
    const t = Math.max(0, Math.min(1, (x / size) * 0.5 + (y / size) * 0.5))
    return [
      Math.round(mix(from[0], to[0], t)),
      Math.round(mix(from[1], to[1], t)),
      Math.round(mix(from[2], to[2], t))
    ]
  }
}
