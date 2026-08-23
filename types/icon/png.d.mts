/**
 * Encode raw RGBA to a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba Row-major, 4 bytes per pixel.
 * @returns {Buffer}
 */
export declare function encodePng(width: number, height: number, rgba: Buffer | Uint8Array): Buffer;
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
export declare function renderPng(size: number, shade: (x: number, y: number, size: number) => number[]): Buffer;
/**
 * Decode a non-interlaced 8-bit RGB or RGBA PNG to flat RGBA.
 *
 * Not a general decoder, and it throws rather than guessing on anything else -
 * the alternative is silently producing a wrong icon.
 *
 * @param {Buffer} file
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export declare function decodePng(file: Buffer): {
    width: number;
    height: number;
    pixels: Buffer;
};
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
export declare function resample(image: {
    width: number;
    height: number;
    pixels: Buffer;
}, size: number): Buffer;
