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
export declare const mix: (a: number, b: number, t: number) => number;
/** @param {number} degrees */
export declare const rad: (degrees: number) => number;
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
export declare function distSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number;
/**
 * Distance to an open polyline, given as `[[x, y], ...]`.
 *
 * @param {number} px @param {number} py @param {number[][]} points
 */
export declare function distPolyline(px: number, py: number, points: number[][]): number;
/**
 * Distance to a closed polyline.
 *
 * @param {number} px @param {number} py @param {number[][]} points
 */
export declare function distPolygon(px: number, py: number, points: number[][]): number;
/**
 * Distance to a full circle of radius `r`.
 *
 * @param {number} px @param {number} py @param {number} cx @param {number} cy @param {number} r
 */
export declare const distRing: (px: number, py: number, cx: number, cy: number, r: number) => number;
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
export declare function distArc(px: number, py: number, cx: number, cy: number, r: number, fromDeg: number, toDeg: number): number;
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
export declare function flattenBezier(p0: number[], p1: number[], p2: number[], p3: number[], steps?: number): number[][];
/**
 * Turn a distance into coverage: 1 well inside the stroke, 0 well outside, and a
 * roughly one-pixel ramp between. `halfWeight` is half the stroke width.
 *
 * @param {number} distance @param {number} halfWeight @param {number} [feather]
 */
export declare function coverage(distance: number, halfWeight: number, feather?: number): number;
/**
 * A two-stop colour ramp run across the canvas diagonal, which is how every mark
 * in the family is coloured.
 *
 * @param {number[]} from `[r, g, b]` at the top left
 * @param {number[]} to `[r, g, b]` at the bottom right
 * @returns {(x: number, y: number, size: number) => number[]}
 */
export declare function diagonalRamp(from: number[], to: number[]): (x: number, y: number, size: number) => number[];
