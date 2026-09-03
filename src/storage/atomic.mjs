/**
 * One atomic write, for every durable store in the suite.
 *
 * The discipline - write a temp file, then rename over the target - had been
 * copied into four repos at three different levels of correctness:
 *
 *   Helm  writeFileAtomicSync: retries the rename, retries the temp cleanup,
 *         reports failures in plain language, never throws.
 *   Jot   writeFileAtomic:     retries the rename. Cleans up with a single silent
 *         Nib  (same code)     unlink, and throws on failure.
 *
 * Helm's is the one that learned the most, because Helm broke the most. Both of
 * the things it knows are real:
 *
 *  - **The rename needs retrying.** On Windows it fails with EPERM while another
 *    process holds the target. Every copy that let that throw straight through
 *    lost the write. Observed 2026-07-27.
 *  - **So does the temp cleanup.** The obvious "unlinkSync and swallow" loses a
 *    race: the sync client can grab a lock on the temp file the instant it
 *    appears, so one silent unlink leaves it behind. That is how Helm's dispatch
 *    directory accumulated 1462 orphaned `.tmp` files (found 2026-08-12).
 *
 * Both forms are here, because the callers genuinely differ: Helm's writers are
 * synchronous and want a result they can turn into a toast, while Jot's and Nib's
 * are async and throw. Sharing the parts rather than picking a winner means
 * migrating either one is a swap, not a rewrite.
 */

import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { MAX_ATTEMPTS, acquireLock, backoffMs, delay, isTransientLock, releaseLock, sleepSync } from './lock.mjs'

/**
 * A temp path nobody else will pick.
 *
 * The random suffix is per attempt, so two writers never fight over one fixed
 * `todos.json.tmp`. Jot's data directory still holds one orphan from before this
 * was true.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function tempPathFor(filePath) {
  const directory = path.dirname(filePath)
  const base = path.basename(filePath)
  return path.join(directory, `.${base}.${crypto.randomBytes(4).toString('hex')}.tmp`)
}

/**
 * Turn an errno into something a person can act on.
 *
 * A write failure ends up in a toast someone reads. A bare
 * "EROFS: read-only file system, open '...'" tells them nothing to do about it, so
 * say what happened in words and keep the code in brackets for a bug report.
 *
 * @param {unknown} error
 * @param {string} filePath
 * @param {string} [app] Name to use in the permission message.
 * @returns {string}
 */
export function plainReason(error, filePath, app = 'The app') {
  const err = /** @type {NodeJS.ErrnoException | null} */ (error)
  const code = err?.code ?? ''
  const where = path.dirname(filePath)
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
    return `${app} isn't allowed to write in ${where} - if this is the installed app, its data folder is misconfigured. [${code}]`
  }
  if (code === 'ENOENT') {
    return `the folder ${where} doesn't exist and couldn't be created. [${code}]`
  }
  if (code === 'ENOTDIR') {
    // Something along the path is a file where a folder has to be. Helm's copy
    // did not cover this and leaked the raw errno; keel's own test caught it.
    return `part of the path ${where} is a file, not a folder. [${code}]`
  }
  if (code === 'ENOSPC') {
    return `the disk holding ${where} is full. [${code}]`
  }
  return err?.message ?? String(error)
}

/**
 * Remove a temp file that never made it onto its target.
 *
 * Best-effort - it never throws - but RETRIED, over the same backoff the rename
 * uses, because a transient lock on the temp is exactly as likely as one on the
 * destination. See the header: this is the 1462-orphan lesson.
 *
 * @param {string} temp
 */
export function bestEffortRemove(temp) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.unlinkSync(temp)
      return
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (code === 'ENOENT') {
        return // already gone - e.g. the rename actually took
      }
      // Anything but ENOENT means the temp is still there, so an EPERM/EBUSY is a
      // live lock worth waiting out - the same signal as for the rename.
      if (isTransientLock(error, true) && attempt < MAX_ATTEMPTS - 1) {
        sleepSync(backoffMs(attempt))
        continue
      }
      return // out of attempts, or not a lock - still best-effort, never throws
    }
  }
}

/**
 * Write `contents` to `filePath` atomically, retrying while the target is locked.
 *
 * Returns a result rather than throwing, because every caller of the sync form has
 * a meaningful "the write did not happen" path and a throw is how these failures
 * got lost in the first place.
 *
 * A returned `aborted: true` means the precondition hook refused: nothing was
 * written, and the caller's own data is stale. That is a different answer from
 * every other failure here, and the only one where trying again can help - see
 * the note above the hook below.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {object} [options]
 * @param {(() => string | null)} [options.onBeforeRename] Re-check preconditions
 *   immediately before the rename; return a reason to refuse the write. Runs
 *   under the write lock, together with the rename. Helm's Jot bridge uses it for
 *   its concurrent-edit guard.
 * @param {string} [options.app] Name for the plain-language failure messages.
 * @returns {{ ok: true } | { ok: false, error: string, aborted?: true }}
 */
export function writeFileAtomicSync(filePath, contents, { onBeforeRename, app } = {}) {
  const directory = path.dirname(filePath)
  let lastError = null

  // The loop is for TRANSIENT LOCKS and nothing else: same bytes, same
  // preconditions, a target someone will let go of shortly. A refused
  // precondition is the opposite case and returns immediately - see below.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const temp = tempPathFor(filePath)
    try {
      fs.mkdirSync(directory, { recursive: true })

      if (onBeforeRename === undefined) {
        fs.writeFileSync(temp, contents, 'utf8')
        fs.renameSync(temp, filePath)
        return { ok: true }
      }

      // THE HOOK AND THE RENAME ARE ONE STEP, or the hook is decoration: another
      // writer that passes its own check while this rename is in flight then
      // renames straight over it. Measured, by removing just this lock and running
      // Helm's own test again: 7 of 720 contended writes silently lost, versus 0 of
      // 1440 with it (scripts/e2e/test-jot-concurrent-writes.mjs, 6 processes).
      // See lock.mjs for what the lock does NOT cover - the Jot app and other
      // machines do not take it.
      let abort = null
      const lock = acquireLock(filePath)
      try {
        // THE TEMP IS WRITTEN INSIDE THE LOCK, and it used to be written before it.
        // These data directories are Dropbox-synced, so a temp file's lifetime is
        // not free: the sync client indexes it and can take a handle on it, which is
        // the exact EPERM-on-rename this module retries for, and an abandoned one is
        // how a dispatch directory once accumulated 1462 orphans. Writing it first
        // left it sitting in a synced folder for the whole lock wait - review
        // measured 3000ms of a 3000ms wait, against microseconds before the lock
        // existed. Inside the lock the hold grows by one file write, which is the
        // same order as the hash read already in here.
        fs.writeFileSync(temp, contents, 'utf8')
        abort = onBeforeRename()
        if (!abort) {
          fs.renameSync(temp, filePath)
          return { ok: true }
        }
      } finally {
        // Released before any backoff below, never held across a sleep: the hold is
        // a temp write, a hash read and a rename, so a waiter is never behind a wait.
        releaseLock(lock)
      }

      // Refused. RETURN, do not retry: `contents` and whatever the hook compares
      // against were both fixed by the caller before the first attempt, so every
      // further attempt re-checks the same stale expectation against the same
      // stale bytes and fails identically - four temp files written and deleted
      // to reach a verdict already reached. The retry that can actually succeed
      // is the caller re-READING and re-applying, which needs this answer, not
      // three more copies of it.
      //
      // THIS LOOP ONCE ATE THAT RETRY. Helm's Jot bridge had its own outer loop -
      // stat, read, mutate, write, and on a collision go round from the read - and
      // the commit that centralised the atomic write here (2026-07-27) dropped it,
      // because an attempt loop was visibly still present. It was the wrong one:
      // retrying a write is not retrying a read, and only one of the two can
      // resolve a concurrent edit. Five weeks of the guard refusing writes that a
      // re-read would have absorbed, with the doc comment still describing the
      // loop that had been deleted.
      bestEffortRemove(temp)
      return { ok: false, error: abort, aborted: true }
    } catch (error) {
      bestEffortRemove(temp)

      // Whether the destination already exists decides whether an EPERM is a lock
      // worth waiting out or a permission problem worth reporting immediately.
      let targetExists = false
      try {
        targetExists = fs.existsSync(filePath)
      } catch {
        // unreadable - treat as absent, i.e. not a lock
      }

      if (isTransientLock(error, targetExists)) {
        if (attempt < MAX_ATTEMPTS - 1) {
          lastError = `${/** @type {NodeJS.ErrnoException} */ (error)?.code} (file locked, likely Dropbox sync)`
          sleepSync(backoffMs(attempt))
          continue
        }
        // Out of attempts. Name the likely CAUSE, not just the errno - "operation
        // not permitted" reads like a bug in the app, when the actionable fact is
        // that something else is holding the file.
        const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
        return {
          ok: false,
          error: `the file stayed locked (${code}) after ${MAX_ATTEMPTS} attempts - Dropbox may be syncing it. Nothing was changed; try again.`
        }
      }

      return { ok: false, error: plainReason(error, filePath, app) }
    }
  }

  // Unreachable: every path above either returns or continues, and the last
  // attempt never continues. Kept so the function still answers with a result
  // rather than `undefined` if that ever stops being true. It used to be the
  // abort path's exit, which is why it used to say "the file kept changing".
  return { ok: false, error: lastError ?? 'the write did not complete' }
}

/**
 * Pretty-printed JSON with a trailing newline, which is the common case.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {Parameters<typeof writeFileAtomicSync>[2]} [options]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeJsonAtomicSync(filePath, value, options) {
  return writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}

/**
 * The async form, which throws.
 *
 * Kept signature-compatible with the copies in Jot and Nib so migrating them is a
 * swap rather than a rewrite - but the temp cleanup is now the retried one, so
 * they stop leaving orphans behind.
 *
 * Still throws when the write genuinely cannot succeed; callers surface that.
 *
 * @param {string} filePath
 * @param {string} contents
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const temp = tempPathFor(filePath)
    try {
      await fsp.writeFile(temp, contents, 'utf8')
      await fsp.rename(temp, filePath)
      return
    } catch (error) {
      bestEffortRemove(temp)
      const targetExists = await fsp
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      if (isTransientLock(error, targetExists) && attempt < MAX_ATTEMPTS - 1) {
        await delay(backoffMs(attempt))
        continue
      }
      throw error
    }
  }
}

/**
 * Pretty-printed JSON with a trailing newline, async.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
