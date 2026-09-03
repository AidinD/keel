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
 * The fallback age rule, for the ONE case age can answer: a lock directory with no
 * readable claim inside it.
 *
 * This used to be the whole takeover rule - break any lock older than this - and
 * that was a silent lost-update bug, because age cannot tell a dead holder from a
 * slow one. Liveness answers it instead; see `lockIsAbandoned`. What is left for
 * age is a directory created by something that died between the mkdir and its
 * claim, or by a build of this module that predates the claim.
 */
const LOCK_STALE_MS = 5000

/**
 * How long a waiter will wait before giving up and failing the write.
 *
 * SHORT ON PURPOSE, and it used to be 10000. These writers are synchronous and are
 * called straight from Electron IPC handlers, so this number is a window in which
 * the whole app is frozen - no window, no menus, no other IPC. An independent
 * review measured a successful write blocking for 22.6 seconds against a busy
 * competitor, and `sleepSync`'s own comment justifying the blocking design promised
 * "a few hundred milliseconds".
 *
 * Two seconds is roughly a thousand holds' worth of headroom, because a hold is a
 * temp write, a hash read and a rename. Reaching it does not mean a holder died -
 * a dead holder's lock is taken over at once, see `lockIsAbandoned` - it means a
 * live one is wedged, and the honest answer to that is a refused write rather than
 * a longer freeze.
 *
 * Neither retry loop above this re-acquires after a timeout: a thrown acquire is
 * not a transient lock and not an abort, so both loops return it. One user action
 * therefore waits at most once.
 */
const LOCK_WAIT_MS = 2000

/**
 * How long an AMBIGUOUS "the path is empty but mkdir failed" answer is believed to
 * be a release in flight rather than a directory we can never create in.
 *
 * Only the codes below are ambiguous. Windows produces them for both cases - EPERM
 * while another process's rmdir is still pending, EPERM for a directory this user
 * may not write in - so no single look can tell those apart. What tells them apart
 * is that one clears within milliseconds and the other never does, so time is the
 * only honest discriminator. A quarter of a second is many times longer than a
 * pending delete needs, and it bounds the cost of the ambiguity: a genuinely
 * unusable temp directory pays this once per write before degrading, instead of
 * paying the full lock wait.
 *
 * EEXIST is deliberately NOT in this set and is never subject to the window - see
 * the branch in `acquireLock`. Putting it here made ordinary contention under load
 * degrade to no lock at all.
 */
const LOCK_TRANSIENT_GRACE_MS = 250

/** The AMBIGUOUS codes: a release in flight and a real fault both produce these. */
const RELEASE_IN_FLIGHT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/** @param {string | undefined} code */
const couldBeReleaseInFlight = (code) => RELEASE_IN_FLIGHT_CODES.has(code ?? '')

/** Warn once per lock directory, not once per write - a structural failure repeats forever. */
const warnedAbout = new Set()

/** The claim inside the lock directory: who holds it, and which hold this is. */
const OWNER_FILE = 'owner.json'

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
export function acquireLock(filePath) {
  const lockPath = lockPathFor(filePath)
  const nonce = crypto.randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS
  const graceUntil = Date.now() + LOCK_TRANSIENT_GRACE_MS
  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      // CLAIM IT IMMEDIATELY. The directory alone says "someone holds this"; the
      // claim inside says who, which is what stops a waiter breaking a live hold
      // and stops a release deleting a directory that is no longer ours. A failed
      // claim is not fatal - the directory still excludes, and a lock with no
      // readable claim falls back to the age rule below.
      try {
        fs.writeFileSync(
          path.join(lockPath, OWNER_FILE),
          JSON.stringify({ pid: process.pid, nonce, at: Date.now() }),
          'utf8'
        )
      } catch {
        // Held anyway, just anonymously.
      }
      return { lockPath, nonce }
    } catch (error) {
      // WHAT IS ACTUALLY AT THE PATH decides this, not the errno alone. Windows
      // reports a contended mkdir as EEXIST, EPERM, EACCES or EBUSY depending on
      // whether a delete is still pending, and reports an unwritable temp directory
      // with those same codes - so a code-only classification has to guess, and
      // guessing wrong is expensive in BOTH directions:
      //
      //   Calling a structural problem "contention": a stray FILE at the lock path,
      //   or an unwritable temp directory, spun for the whole wait and then failed
      //   the write - permanently, on every write, while reporting "another writer
      //   is holding it" when nothing was. Review measured 10s per write, no
      //   self-healing.
      //
      //   Calling contention "structural": the write proceeds with NO lock at all,
      //   which is the data-loss window this module exists to close.
      //
      // So: a directory at the path is contention; something else at the path is
      // structural; nothing at the path is judged by the errno, because that is
      // either a holder who released a moment ago or a create that cannot succeed.
      const present = lockPathState(lockPath)
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (present === 'absent' && code === 'EEXIST') {
        // EEXIST IS POSITIVE EVIDENCE OF CONTENTION, and no time limit applies to
        // it. `mkdir` only reports EEXIST when something was at the path at that
        // instant, and if a `stat` a microsecond later finds nothing, the only
        // explanation is a holder that released in between. No structural fault
        // produces this combination: an unwritable or missing temp directory
        // reports EPERM, EACCES, ENOENT, EROFS or ENOSPC, never EEXIST-with-nothing
        // -there. (A stray FILE at the path does report EEXIST, but then the stat
        // above says 'other', which is handled below.)
        //
        // This was inside the grace window until the full test suite ran with four
        // tests in parallel: under load, ordinary contention keeps landing in this
        // branch for longer than any short window, and past it the write proceeded
        // with NO lock. Third time the same misclassification shipped in one
        // afternoon, and the third time the concurrency test's worker-stderr check
        // was the only thing that noticed.
        continue
      }
      if (present === 'absent' && couldBeReleaseInFlight(code) && Date.now() < graceUntil) {
        // Nothing at the path, and a code that a release in flight produces: the
        // holder let go in the microseconds between our mkdir and our look, or
        // Windows still has its delete pending. Ordinary contention - and reading it
        // as "no lock is possible here" runs the write with NO lock, silently. Both
        // early versions of this classification did exactly that; the concurrency
        // test's worker-stderr check caught each one on its first run, first for
        // EEXIST and then for the EPERM pending-delete case.
        //
        // The grace window is what separates this from a genuinely unusable temp
        // directory, which reports the same codes: a release in flight clears in
        // milliseconds, an unwritable directory never does. That is the only
        // property that actually distinguishes them, so it is the one used.
        continue
      }
      if (present !== 'directory') {
        if (!warnedAbout.has(lockPath)) {
          warnedAbout.add(lockPath)
          process.stderr.write(
            `WARNING: no usable write lock at ${lockPath} (${code ?? /** @type {Error} */ (error)?.message}` +
              `${present === 'other' ? ', and something that is not a lock directory is at that path' : ''}); ` +
              `falling back to the change guard alone, which leaves a small window against another writer.\n`
          )
        }
        return { lockPath: null, nonce: null }
      }
      // A real lock directory is there, so this is genuine contention. Break it only
      // if its holder is provably gone.
      if (lockIsAbandoned(lockPath) && removeLockDir(lockPath)) {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(
          `could not get the write lock for ${path.basename(filePath)} within ${LOCK_WAIT_MS}ms ` +
            `(a live writer is holding ${lockPath}). Nothing was changed; try again.`
        )
      }
      // Short and jittered: holders keep the lock for milliseconds, and two
      // waiters polling on the same schedule would keep arriving together.
      sleepSync(5 + Math.floor(Math.random() * 15))
    }
  }
}

/**
 * What is at the lock path: our kind of directory, something else, or nothing.
 *
 * @param {string} lockPath
 * @returns {'directory' | 'other' | 'absent'}
 */
function lockPathState(lockPath) {
  try {
    return fs.statSync(lockPath).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT' ? 'absent' : 'other'
  }
}

/**
 * Is this lock's holder gone, or just slow?
 *
 * AGE ALONE CANNOT ANSWER THIS, and answering it with age was a silent lost-update
 * bug. The old rule broke any lock older than `LOCK_STALE_MS`, which cannot tell a
 * dead holder from a holder that hit a paging stall, a long GC, an antivirus scan
 * of the very file it is hashing, a debugger pause or a machine suspend. Review
 * reproduced the consequence end to end: two writers holding "the" lock at once,
 * both told `ok: true`, one write gone - with the content hash present and passing
 * on both sides, because a hash check cannot see a writer that also passed it.
 *
 * So ask the operating system instead. The holder writes its pid into the lock, and
 * a lock is abandoned only when that process no longer exists. A slow holder keeps
 * its lock and the waiter waits, which is the entire point of a lock.
 *
 * The age rule survives for one case it is right about: a lock directory with no
 * readable claim, left by something that died between the mkdir and the write, or
 * by an older build of this module.
 */
/**
 * @param {string} lockPath
 * @returns {boolean}
 */
function lockIsAbandoned(lockPath) {
  let owner = null
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf8'))
  } catch {
    // No claim, or an unreadable one - fall through to the age rule.
  }
  if (owner && Number.isInteger(owner.pid)) {
    return !processExists(owner.pid)
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false // gone already, or unreadable; the next turn of the loop sorts it out
  }
}

/**
 * Does this process still exist?
 *
 * Signal 0 checks for a process without touching it. EPERM means it exists and is
 * not ours to signal, which still answers the question that matters here. Pid reuse
 * could in principle make a dead holder look alive; the cost of that is a waiter
 * that waits out its deadline and refuses, never a broken lock.
 */
/**
 * @param {number} pid
 * @returns {boolean}
 */
function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  if (pid === process.pid) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === 'EPERM'
  }
}

/**
 * Remove a lock directory and the claim inside it. True if it is gone afterwards.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
function removeLockDir(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Do we still hold this lock?
 *
 * Asked before releasing, because a release that does not check ownership deletes
 * whatever happens to be at the path - and if our lock was taken over while we were
 * stalled, that is the NEW holder's lock. Review traced the cascade: A stalls, B
 * takes over, A's release deletes B's directory, C walks in while B is still
 * renaming, B's release deletes C's. One stalled holder de-serialises the queue
 * indefinitely rather than once, which is far worse than the bounded trade the
 * comment here used to claim.
 */
/**
 * @param {{ lockPath: string | null, nonce?: string | null }} lock
 * @returns {boolean}
 */
function stillOurs(lock) {
  if (lock.lockPath === null) {
    return false
  }
  if (!lock.nonce) {
    return true // anonymous hold (the claim could not be written) - nothing better to go on
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(lock.lockPath, OWNER_FILE), 'utf8')).nonce === lock.nonce
  } catch {
    return false // no claim, or someone else's - not ours to delete
  }
}

/**
 * Give the lock back. Never throws - a lock left behind is survivable, because the
 * next writer takes it over once its holder is gone.
 *
 * @param {{ lockPath: string | null, nonce?: string | null } | null} lock
 */
export function releaseLock(lock) {
  if (!lock || lock.lockPath === null) {
    return
  }
  if (!stillOurs(lock)) {
    process.stderr.write(
      `WARNING: the write lock at ${lock.lockPath} is no longer ours - it was taken over mid-write, ` +
        `so it is being left alone rather than deleted out from under its new holder.\n`
    )
    return
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(lock.lockPath, { recursive: true })
      return
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (code === 'ENOENT') {
        return // already gone - e.g. broken as abandoned while we were stalled
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
