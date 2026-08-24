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
export declare function decodeText(bytes: Uint8Array): string;
/**
 * Decode a file that holds nothing but a credential.
 *
 * The ends are trimmed, because a trailing newline is the editor's and never the
 * key's, and a leading space is a bad paste rather than a decision.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export declare const decodeSecret: (bytes: Uint8Array) => string;
