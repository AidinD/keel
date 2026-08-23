/**
 * The sizes a Windows icon should carry.
 *
 * 20 and 24 are the two that get forgotten and the two that matter most in
 * practice: the taskbar asks for them at 125% and 150% display scaling, which is
 * what most laptops actually run at. Without them Windows resamples a
 * neighbouring frame and the mark goes soft at exactly the scale you use daily.
 */
export declare const DEFAULT_LADDER: number[];
/**
 * Below this, use the simplified drawing.
 *
 * Measured rather than picked: at 16px a stroke at the mark's true weight lands
 * under a pixel and counters close up. Jot, Loom and Tend all landed on the same
 * threshold independently by rendering both drawings side by side.
 */
export declare const SMALL_BELOW = 32;
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
export declare function buildIco(images: {
    size: number;
    png: Buffer;
}[]): Buffer;
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
export declare function renderIco(shade: (x: number, y: number, size: number) => number[], sizes?: number[]): Buffer;
