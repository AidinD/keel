/**
 * Turning the bytes of a hand-saved file into the string that was actually in it.
 *
 * This exists because of one failure mode, and it is the worst kind: the API
 * answers "400 Bad Request" and says nothing else, the key looks correct in every
 * editor, and the character breaking it is invisible. Three ways in:
 *
 *  - **A byte-order mark.** Notepad's "Save as" and PowerShell's `>` and
 *    `Out-File` both write UTF-8 with a leading mark by default on Windows. It is
 *    two or three bytes that no editor renders, and they travel into the key.
 *  - **UTF-16.** Notepad's encoding dropdown offers it, and picking it puts a
 *    zero byte between every character. Read as UTF-8 that is not a key, it is
 *    noise - and the noise still looks like the key in the editor that wrote it.
 *  - **The trailing newline.** Almost every editor adds one on save. Trimmed
 *    here, once, rather than remembered at each call site.
 *
 * A key never contains a zero byte, which is what makes the UTF-16 detection safe
 * rather than a guess: a zero at the second byte cannot be anything else.
 */

const UTF8_BOM = /** @type {const} */ ([0xef, 0xbb, 0xbf])

/**
 * Decode the bytes of a file that holds text, whatever Windows wrote it as.
 *
 * The leading mark is removed and the encoding is honoured; nothing else is
 * changed. Trimming is the caller's, so this stays usable for text where the ends
 * matter.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeText(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // UTF-16, little end first: the mark Notepad's "Unicode" writes.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }

  // UTF-16, big end first. Node cannot decode it directly, so the pairs are
  // swapped into the order it can.
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swapPairs(buffer.subarray(2)).toString('utf16le')
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  ) {
    return buffer.subarray(3).toString('utf8')
  }

  // UTF-16 with no mark at all. Rare from Notepad, which always writes one, but
  // a script that built the file byte by byte can produce it. A zero as the
  // second byte of real text is impossible, so this cannot misfire on UTF-8.
  if (buffer.length >= 2 && buffer[1] === 0x00 && buffer[0] !== 0x00) {
    return buffer.toString('utf16le')
  }

  return buffer.toString('utf8')
}

/**
 * Decode a file that holds nothing but a credential.
 *
 * The ends are trimmed, because a trailing newline is the editor's and never the
 * key's, and a leading space is a bad paste rather than a decision.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const decodeSecret = (bytes) => decodeText(bytes).trim()

/**
 * Reverse each byte pair, so big-end-first UTF-16 becomes what Node can read.
 *
 * A copy, not the caller's buffer: `swap16` works in place, and mutating bytes
 * somebody else still holds is a bug waiting for the second caller. An odd
 * trailing byte cannot be half of anything and is dropped - `swap16` throws on an
 * odd length, and throwing here would turn a malformed file into a crash.
 *
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function swapPairs(bytes) {
  const even = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1)
  return Buffer.from(even).swap16()
}
