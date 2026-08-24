/**
 * Telling "someone else has the file right now" apart from a real failure.
 *
 * Every app in the suite keeps its data in a Dropbox-synced folder, so on Windows
 * the sync client holding a file mid-rename is not an edge case - it is the normal
 * operating condition. Helm observed it for real on 2026-07-27: a board update
 * returned "EPERM ... rename" and the change was simply gone.
 */
/**
 * Four attempts, 60ms apart and growing: 60 + 120 + 180 = 360ms of waiting at
 * worst. Enough for a sync client to let go, short enough that a user watching a
 * save does not notice.
 */
export declare const MAX_ATTEMPTS = 4;
/**
 * Is this error a transient lock rather than a real failure?
 *
 * Windows reports BOTH a locked file and a permission-denied folder as EPERM, so
 * the code alone cannot tell them apart. `targetExists` is what separates them:
 * you can only be fighting over a file that is already there. A folder the app is
 * not allowed to write in produces the same EPERM with no file at the end of it,
 * and retrying that just delays a wrong answer - Helm's pre-release review
 * measured the app blocking for 377ms and then blaming Dropbox for a permission
 * problem that would never clear on its own.
 *
 * Defaults to `true` so the predicate is still usable as a plain "could this be a
 * lock?" check, which is how Helm's callers use it.
 *
 * @param {unknown} error
 * @param {boolean} [targetExists]
 * @returns {boolean}
 */
export declare function isTransientLock(error: unknown, targetExists?: boolean): boolean;
/**
 * How long to wait before attempt `attempt` (0-based) is retried.
 *
 * @param {number} attempt
 * @returns {number} milliseconds
 */
export declare const backoffMs: (attempt: number) => number;
/**
 * Block for `ms` without burning CPU.
 *
 * Deliberately synchronous. The sync writers are called straight from IPC
 * handlers, this path is rare, and the total is bounded to a few hundred
 * milliseconds; the alternative is silently dropping a write the user asked for.
 * Frequency is what makes blocking unacceptable, not blocking itself.
 *
 * @param {number} ms
 */
export declare function sleepSync(ms: number): void;
/**
 * The async counterpart.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export declare const delay: (ms: number) => Promise<void>;
