/**
 * Telling "someone else has the file right now" apart from a real failure - and,
 * for a guarded write, keeping someone else out for the two operations that have
 * to look like one.
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
 * Deliberately synchronous. The sync writers are called straight from IPC handlers
 * and the alternative is silently dropping a write the user asked for; frequency is
 * what makes blocking unacceptable, not blocking itself.
 *
 * WHAT THE TOTAL IS BOUNDED BY, since this comment used to promise "a few hundred
 * milliseconds" and that stopped being true the moment a lock wait joined the
 * retry backoff: the rename retries add up to 360ms, and one lock wait adds up to
 * `LOCK_WAIT_MS`. A timed-out acquire is neither a transient lock nor an abort, so
 * no loop above re-acquires after one - a single user action waits for the lock at
 * most once. Keep it that way; the number that was here before was wrong by two
 * orders of magnitude and nothing in the code noticed.
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
/**
 * Jitter, for a retry that another writer is also retrying.
 *
 * The lock below serialises writers; it does not stop them from colliding again
 * on the next attempt. Two writers that back off on the identical schedule stay
 * in lockstep and keep losing to each other: the Jot skill's concurrency test
 * measured about one write in 60 running out of attempts with a fixed backoff,
 * and randomising the wait is what breaks the symmetry. Same base curve as
 * `backoffMs`, spread over 50-150% of it.
 *
 * This is for a CALLER's read-modify-write retry, not for the lock waits inside
 * this module - a lock wait is already short and already jittered.
 *
 * @param {number} attempt 0-based
 * @returns {number} milliseconds
 */
export declare const jitteredBackoffMs: (attempt: number) => number;
/**
 * Where the lock for `filePath` lives.
 *
 * The name is a CROSS-PROCESS CONTRACT: two writers only exclude each other if
 * they compute the same path for the same file. The Jot skill's standalone helper
 * (`~/.claude/skills/jot-task-tracking/jot-edit.mjs`) reimplements this function
 * because it has to run from any cwd with no package resolution - if you change
 * the name or the hash here, change it there too, or the app and the scripts will
 * each hold their own private lock and neither will know.
 *
 * Path-derived rather than random for the same reason, and lowercased because
 * Windows paths are case-insensitive: `D:\x\todos.json` and `d:\X\todos.json` are
 * one file and must be one lock.
 *
 * @param {string} filePath
 * @returns {string}
 */
export declare function lockPathFor(filePath: string): string;
/**
 * Take the write lock for `filePath`, waiting out whoever holds it.
 *
 * THE MUTEX IS A DIRECTORY, NOT A FILE, and that is not a stylistic choice. The
 * obvious version - create a lock file with the exclusive flag, unlink it on
 * release - is broken on Windows. A file still has an open handle when the release
 * unlinks it, so the deletion goes "pending", and another process's exclusive
 * create then fails with EPERM rather than EEXIST. The Jot skill's first version
 * read that EPERM as "no lock available here", quietly degraded to the content
 * guard alone, and lost a write; its 6-writer stress run is the only reason that
 * is known. `mkdir` is the classic portable mutex precisely because nothing holds
 * a handle to a directory we never open, so its removal is immediate and the next
 * writer sees a clean EEXIST-or-success.
 *
 * Returns a handle to pass to `releaseLock`. `lockPath: null` means the lock could
 * not be used at all (no temp directory, read-only, something that is not a lock
 * sitting at the path) and the caller is running on its content guard alone:
 * degrading is better than refusing a write over a lock that is only ever a
 * narrowing of an already-narrow window.
 *
 * Throws if a LIVE holder still has it after `LOCK_WAIT_MS`, which means another
 * writer is wedged rather than busy. Callers turn that into "nothing was changed".
 *
 * @param {string} filePath
 * @returns {{ lockPath: string | null, nonce: string | null }}
 */
export declare function acquireLock(filePath: string): {
    lockPath: string | null;
    nonce: string | null;
};
/**
 * Give the lock back. Never throws - a lock left behind is survivable, because the
 * next writer takes it over once its holder is gone.
 *
 * @param {{ lockPath: string | null, nonce?: string | null } | null} lock
 */
export declare function releaseLock(lock: {
    lockPath: string | null;
    nonce?: string | null;
} | null): void;
