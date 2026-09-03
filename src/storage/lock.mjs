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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Four attempts, 60ms apart and growing: 60 + 120 + 180 = 360ms of waiting at
 * worst. Enough for a sync client to let go, short enough that a user watching a
 * save does not notice.
 */
export const MAX_ATTEMPTS = 4

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
export function isTransientLock(error, targetExists = true) {
  const code = /** @type {NodeJS.ErrnoException | null} */ (error)?.code
  if (code === 'EBUSY') {
    return true // always a live handle on something
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return targetExists
  }
  return false
}

/**
 * How long to wait before attempt `attempt` (0-based) is retried.
 *
 * @param {number} attempt
 * @returns {number} milliseconds
 */
export const backoffMs = (attempt) => 60 * (attempt + 1)

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
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // SharedArrayBuffer unavailable - skip the backoff rather than fail the write.
  }
}

/**
 * The async counterpart.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
export const jitteredBackoffMs = (attempt) => Math.round(backoffMs(attempt) * (0.5 + Math.random()))

/**
 * An exclusive write lock, for the check-then-rename of a guarded write.
 *
 * A precondition hook that runs and THEN renames is two steps, and another writer
 * can slip between them: it passes its own check while your rename is in flight,
 * then renames over you. Rare, silent, and exactly the failure a guard exists to
 * prevent - so a guard without a lock around it is decoration. Two independent
 * measurements, both with six competing processes:
 *
 *   Helm's Jot board  7 of 720 writes lost without this lock, 0 of 1440 with it
 *                     (helm/scripts/e2e/test-jot-concurrent-writes.mjs, 2026-09-03)
 *   The Jot skill     about 1 in 60 lost with two processes, 0 in ~2400 with it
 *
 * Note what the losing runs still had: a content hash compared immediately before
 * the rename. The guard was right and lost anyway, because being right one step
 * before the swap is not the same as being right AT the swap.
 *
 * What it does NOT cover, and cannot:
 *
 *  - It only binds writers that take it, i.e. code going through this module. The
 *    Jot app and Nib's editor do not, so a write from one of those landing inside
 *    the same two-step window can still be overwritten. That window is one hash
 *    read wide now, rather than the seconds between a read and a write, and
 *    closing it entirely needs the other app to cooperate.
 *  - Nothing across machines. Dropbox can replace a file wholesale; the content
 *    guard sees that and refuses, which is the most that is available.
 *
 * It lives in the system temp directory rather than beside the file it protects,
 * because a `.lock` inside a Dropbox folder would sync to other machines and
 * arrive there as a phantom lock on a file nobody is writing.
 */

/**
 * The MAXIMUM TIME A HOLDER MAY HOLD, not merely a crash timeout - read it that
 * way round or the number looks arbitrary. A waiter breaks any lock older than
 * this, so a holder that stalls past it loses its exclusivity and two writers can
 * rename. The hold is one hash read and one rename, i.e. milliseconds, so five
 * seconds is three orders of magnitude of headroom; the cost of the generosity is
 * that a holder killed mid-write freezes other writers for up to this long.
 *
 * Correctness gets the benefit of the doubt over responsiveness here: a freeze is
 * visible and recoverable, whereas breaking a live holder's lock silently loses a
 * write, which is the entire failure class this module exists for.
 *
 * LOCK_WAIT_MS is the waiter's own patience and must stay LARGER than the stale
 * threshold, or the takeover above can never run - a waiter would give up before
 * the lock it is waiting on became old enough to break. Reaching it at all means
 * writers are queueing continuously, not that one died.
 *
 * Both numbers are matched to the Jot skill's standalone helper on purpose: two
 * implementations of one lock with different timings is a difference nobody will
 * remember to reason about.
 */
const LOCK_STALE_MS = 5000
const LOCK_WAIT_MS = 10000

/**
 * Windows reports a contended `mkdir` as several different things, and the
 * distinction that matters is "someone else has this lock" versus "there is no
 * usable lock here at all". EPERM belongs in the first set - see the mkdir note on
 * `acquireLock`.
 */
const LOCK_CONTENDED_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/** Warn once per lock directory, not once per write - a structural failure repeats forever. */
const warnedAbout = new Set()

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
export function lockPathFor(filePath) {
  const key = crypto.createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `keel-store-${key}.lock`)
}

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
 * not be used at all (no temp directory, read-only, out of space) and the caller
 * is running on its content guard alone: degrading is better than refusing a write
 * over a lock that is only ever a narrowing of an already-narrow window.
 *
 * Throws if the lock is still held after `LOCK_WAIT_MS`, which means another
 * writer is stuck rather than busy. Callers turn that into "nothing was changed".
 *
 * @param {string} filePath
 * @returns {{ lockPath: string | null }}
 */
export function acquireLock(filePath) {
  const lockPath = lockPathFor(filePath)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      return { lockPath }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (!LOCK_CONTENDED_CODES.has(code ?? '')) {
        if (!warnedAbout.has(lockPath)) {
          warnedAbout.add(lockPath)
          process.stderr.write(
            `WARNING: no usable write lock at ${lockPath} (${code ?? /** @type {Error} */ (error)?.message}); ` +
              `falling back to the change guard alone, which leaves a small window against another writer.\n`
          )
        }
        return { lockPath: null }
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath) // the holder died mid-write; see LOCK_STALE_MS
        }
      } catch {
        // Gone, or unreadable - either way the next turn of the loop sorts it out.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `could not get the write lock for ${path.basename(filePath)} within ${LOCK_WAIT_MS}ms ` +
            `(another writer is holding ${lockPath}). Nothing was changed; try again.`
        )
      }
      // Short and jittered: holders keep the lock for milliseconds, and two
      // waiters polling on the same schedule would keep arriving together.
      sleepSync(5 + Math.floor(Math.random() * 15))
    }
  }
}

/**
 * Give the lock back. Never throws - a lock left behind is survivable, because the
 * next writer takes it over as stale.
 *
 * @param {{ lockPath: string | null } | null} lock
 */
export function releaseLock(lock) {
  if (!lock || lock.lockPath === null) {
    return
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.rmdirSync(lock.lockPath)
      return
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (code === 'ENOENT') {
        return // someone already broke it as stale
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        sleepSync(backoffMs(attempt))
        continue
      }
      process.stderr.write(`WARNING: could not release the write lock at ${lock.lockPath} (${code}).\n`)
      return
    }
  }
}
