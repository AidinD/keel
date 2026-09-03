import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_ATTEMPTS,
  acquireLock,
  backoffMs,
  isTransientLock,
  jitteredBackoffMs,
  lockPathFor,
  plainReason,
  releaseLock,
  readJsonFile,
  resolveDataDir,
  stripBom,
  tempPathFor,
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync
} from '../src/storage/index.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'keel-storage-'))

/** So a child process can import the same module under test. */
const storageUrl = new URL('../src/storage/index.mjs', import.meta.url).href

/**
 * Below the module's own stale threshold, so "waited for the holder" can be told
 * apart from "broke the holder's lock". Kept loose: the assertion is about which
 * branch ran, not about scheduling precision.
 */
const LOCK_STALE_CEILING = 4000

/** An errno error, the way node throws them. */
function errno(code) {
  const error = new Error(`${code}: simulated`)
  error.code = code
  return error
}

test('EBUSY is always a lock; EPERM only when the target is there', () => {
  // Windows reports a locked file and a permission-denied folder identically, so
  // this distinction is the whole reason the predicate takes two arguments.
  assert.equal(isTransientLock(errno('EBUSY'), false), true)
  assert.equal(isTransientLock(errno('EPERM'), true), true)
  assert.equal(isTransientLock(errno('EPERM'), false), false)
  assert.equal(isTransientLock(errno('EACCES'), true), true)
  assert.equal(isTransientLock(errno('EACCES'), false), false)
  assert.equal(isTransientLock(errno('ENOSPC'), true), false)
  assert.equal(isTransientLock(null, true), false)
})

test('a lone argument keeps the forgiving reading', () => {
  // Helm's callers use it as a plain "could this be a lock?" check.
  assert.equal(isTransientLock(errno('EPERM')), true)
})

test('the backoff grows and stays under half a second in total', () => {
  const waits = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, attempt) => backoffMs(attempt))
  assert.deepEqual(waits, [60, 120, 180])
  assert.ok(waits.reduce((total, wait) => total + wait, 0) < 500)
})

test('the temp path is hidden, unique, and next to its target', () => {
  const first = tempPathFor('D:/data/todos.json')
  const second = tempPathFor('D:/data/todos.json')
  assert.notEqual(first, second, 'two writers must never pick the same temp name')
  assert.ok(first.endsWith('.tmp'))
  assert.ok(first.includes('.todos.json.'))
  // Same directory, so the rename is on one filesystem and therefore atomic.
  assert.ok(first.replace(/[\\/][^\\/]+$/, '').endsWith('data'))
})

test('the sync write lands the content and leaves no temp behind', () => {
  const dir = scratch()
  const target = join(dir, 'nested', 'todos.json')

  const result = writeFileAtomicSync(target, 'hello')

  assert.deepEqual(result, { ok: true })
  assert.equal(readFileSync(target, 'utf8'), 'hello')
  assert.deepEqual(
    readdirSync(join(dir, 'nested')).filter((file) => file.endsWith('.tmp')),
    [],
    'a completed write must leave no orphaned temp file'
  )
})

test('writeJsonAtomicSync pretty-prints with a trailing newline', () => {
  const dir = scratch()
  const target = join(dir, 'x.json')
  writeJsonAtomicSync(target, { a: 1 })
  assert.equal(readFileSync(target, 'utf8'), '{\n  "a": 1\n}\n')
})

test('onBeforeRename refuses the write once, rather than re-asking a stale question', () => {
  const dir = scratch()
  const target = join(dir, 'guarded.json')

  let asked = 0
  const result = writeFileAtomicSync(target, 'new', {
    onBeforeRename: () => {
      asked += 1
      return 'someone else changed it'
    }
  })

  assert.equal(result.ok, false)
  // Asked ONCE. `contents` and whatever the hook compares against are both fixed
  // before the first attempt, so a second ask can only give the same answer -
  // and re-asking used to hide the refusal behind MAX_ATTEMPTS wasted temp
  // files, which is what stopped Helm's Jot bridge from retrying properly.
  assert.equal(asked, 1, 'a refused precondition must not be re-asked with the same stale data')
  assert.equal(result.aborted, true, 'the caller has to be able to tell a refusal from a write failure')
  assert.equal(existsSync(target), false, 'an aborted write must not create the target')
  assert.deepEqual(
    readdirSync(dir).filter((file) => file.endsWith('.tmp')),
    [],
    'an aborted write must remove its temp file'
  )
  assert.ok(result.error.includes('someone else changed it'))
})

test('a real write failure is not reported as an abort', () => {
  // The distinction the caller retries on: `aborted` means "your data is stale,
  // re-read", and nothing else may claim it - a caller that retries a full disk
  // just burns attempts.
  const dir = scratch()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'in the way')

  const result = writeFileAtomicSync(join(blocker, 'child', 'x.json'), 'x', { onBeforeRename: () => null })

  assert.equal(result.ok, false)
  assert.equal(result.aborted, undefined)
})

test('the guarded write holds the lock across hook and rename, and gives it back', () => {
  const dir = scratch()
  const target = join(dir, 'locked.json')
  const lockPath = lockPathFor(target)

  let heldDuringHook = false
  const result = writeFileAtomicSync(target, 'through', {
    onBeforeRename: () => {
      heldDuringHook = existsSync(lockPath)
      return null
    }
  })

  assert.equal(result.ok, true)
  assert.equal(heldDuringHook, true, 'the hook must run while the lock is held')
  assert.equal(existsSync(lockPath), false, 'and the lock must be released afterwards')
})

test('the lock is still held AT the rename, not merely at some point during the hook', () => {
  // The assertion above this one - "was the lock there while the hook ran" - passes
  // when the lock is released BEFORE the rename, which re-opens the entire window
  // this module exists to close. Mutation testing found that hole: narrowing the
  // lock to cover only the hook survived every suite. So observe the lock from
  // inside the rename itself, which is the only moment that matters.
  const dir = scratch()
  const target = join(dir, 'spans.json')
  const lockPath = lockPathFor(target)

  let heldAtRename = null
  const realRename = fs.renameSync
  try {
    fs.renameSync = (from, to) => {
      if (to === target) {
        heldAtRename = existsSync(lockPath)
      }
      return realRename.call(fs, from, to)
    }
    assert.equal(writeFileAtomicSync(target, 'x', { onBeforeRename: () => null }).ok, true)
  } finally {
    fs.renameSync = realRename
  }

  assert.equal(heldAtRename, true, 'a lock that does not span the rename is not a lock')
  assert.equal(existsSync(lockPath), false, 'and it is released after the rename, not before it')
})

test('the temp file is created inside the lock, not before it', () => {
  // A temp written before the lock sits in a Dropbox-synced directory for the whole
  // lock wait, where the sync client indexes it and can take a handle on it - which
  // is the EPERM-on-rename this module retries for, and how orphaned temps happen.
  const dir = scratch()
  const target = join(dir, 'ordered.json')
  const lockPath = lockPathFor(target)

  let tempsWhenLockTaken = null
  const realMkdir = fs.mkdirSync
  try {
    fs.mkdirSync = (dirPath, options) => {
      const result = realMkdir.call(fs, dirPath, options)
      if (dirPath === lockPath) {
        tempsWhenLockTaken = readdirSync(dir).filter((file) => file.endsWith('.tmp')).length
      }
      return result
    }
    assert.equal(writeFileAtomicSync(target, 'x', { onBeforeRename: () => null }).ok, true)
  } finally {
    fs.mkdirSync = realMkdir
  }

  assert.equal(tempsWhenLockTaken, 0, 'the temp must not exist yet when the lock is taken')
})

test('a LIVE holder past the age threshold keeps its lock', () => {
  // THE LOST-UPDATE BUG THIS REPLACED. The takeover rule used to be age alone, which
  // cannot tell a dead holder from one stalled by paging, a long GC, an antivirus
  // scan of the file it is hashing, or a suspended machine. Review reproduced the
  // consequence: two writers holding one lock, both told ok:true, one write gone.
  const dir = scratch()
  const target = join(dir, 'liveholder.json')
  const lockPath = lockPathFor(target)

  // A lock that is very old and claimed by a process that certainly exists: this one.
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'someone-elses', at: 0 }))
  const longAgo = new Date(Date.now() - 600_000)
  utimesSync(lockPath, longAgo, longAgo)

  assert.throws(
    () => acquireLock(target),
    /live writer is holding/,
    'an old lock whose holder is alive must be waited for and then refused, never broken'
  )
  assert.equal(existsSync(lockPath), true, 'and it must still be there afterwards')

  // And the holder's own claim is not something a stranger may delete on the way out.
  releaseLock({ lockPath, nonce: 'not-the-holders-nonce' })
  assert.equal(existsSync(lockPath), true, 'releaseLock must not remove a lock it does not own')

  rmSync(lockPath, { recursive: true, force: true })
})

test('a DEAD holder past the age threshold loses its lock at once', () => {
  const dir = scratch()
  const target = join(dir, 'deadholder.json')
  const lockPath = lockPathFor(target)

  // A pid that certainly does not exist: a child process we waited for.
  const corpse = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  assert.equal(corpse.status, 0)

  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: corpse.pid, nonce: 'gone', at: Date.now() }))

  const started = Date.now()
  const lock = acquireLock(target)
  const waited = Date.now() - started
  assert.equal(lock.lockPath, lockPath)
  assert.ok(waited < 500, `a dead holder's lock is taken over immediately, not waited out (${waited}ms)`)
  releaseLock(lock)
  assert.equal(existsSync(lockPath), false)
})

test('a taken-over holder does not delete the new holder`s lock on its way out', () => {
  // The cascade review traced: A stalls, B takes over, A's release deletes B's
  // directory, C walks in while B is renaming, B's release deletes C's. One stalled
  // holder de-serialises the queue indefinitely rather than once.
  const dir = scratch()
  const target = join(dir, 'cascade.json')

  const first = acquireLock(target)
  // Simulate the takeover: someone else replaced the claim with their own.
  writeFileSync(join(first.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'the-new-holder', at: Date.now() }))

  releaseLock(first)
  assert.equal(existsSync(first.lockPath), true, "the stale holder must leave the new holder's lock alone")

  rmSync(first.lockPath, { recursive: true, force: true })
})

test('anything that is not a lock directory degrades at once, instead of spinning', () => {
  // Reading a permission error as contention made a stray FILE at the lock path -
  // or an unwritable temp directory - spin for the whole wait and then fail, on
  // every write, permanently, while reporting "another writer is holding it" when
  // nobody was. Measured by review at 10s per write with no self-healing.
  const dir = scratch()
  const target = join(dir, 'wedged.json')
  const lockPath = lockPathFor(target)

  writeFileSync(lockPath, 'not a lock directory')
  const started = Date.now()
  const lock = acquireLock(target)
  const waited = Date.now() - started
  assert.equal(lock.lockPath, null, 'it must degrade to the content guard, not wait for a phantom holder')
  assert.ok(waited < 500, `and it must decide that at once (${waited}ms)`)

  // The write itself must still succeed rather than being refused over the lock.
  assert.equal(writeFileAtomicSync(target, 'through', { onBeforeRename: () => null }).ok, true)
  assert.equal(readFileSync(target, 'utf8'), 'through')

  rmSync(lockPath, { force: true })
})

test('a lock released between the failed mkdir and the check is contention, not a missing lock', () => {
  // The first version of the path-based classification degraded here, so ordinary
  // contention - a holder releasing in the microseconds between our mkdir and our
  // stat - made the write proceed with NO lock, silently. Caught by the concurrency
  // test's worker-stderr check on its first run, which is the only reason it is not
  // still in there: nothing else looks at that warning.
  const dir = scratch()
  const target = join(dir, 'vanishing.json')
  const lockPath = lockPathFor(target)
  const original = fs.mkdirSync
  let denied = 0
  let lock

  try {
    fs.mkdirSync = (dirPath, options) => {
      // Fail exactly as a contended mkdir does, while leaving the path empty - the
      // state a released lock leaves behind.
      if (dirPath === lockPath && denied < 2) {
        denied += 1
        throw errno('EEXIST')
      }
      return original.call(fs, dirPath, options)
    }
    lock = acquireLock(target)
  } finally {
    fs.mkdirSync = original
  }

  assert.equal(denied, 2, 'the simulated contention must have fired')
  assert.ok(lock.lockPath, 'it must keep trying and end up HOLDING the lock, not running unlocked')
  releaseLock(lock)
})

test('...and stays contention however long it lasts, not just briefly', () => {
  // The same misclassification, third instance: EEXIST-with-nothing-there was
  // treated as a release in flight only for a short grace window, and past it the
  // write proceeded with no lock. Under a loaded machine - the full test suite runs
  // four files at a time - ordinary contention lands in that branch for longer than
  // any short window. EEXIST is positive evidence that something WAS there, so no
  // time limit belongs on it.
  const dir = scratch()
  const target = join(dir, 'stubborn.json')
  const lockPath = lockPathFor(target)
  const original = fs.mkdirSync
  const denyUntil = Date.now() + 600 // comfortably past LOCK_TRANSIENT_GRACE_MS
  let lock

  try {
    fs.mkdirSync = (dirPath, options) => {
      if (dirPath === lockPath && Date.now() < denyUntil) {
        throw errno('EEXIST')
      }
      return original.call(fs, dirPath, options)
    }
    lock = acquireLock(target)
  } finally {
    fs.mkdirSync = original
  }

  assert.ok(lock.lockPath, 'sustained contention must not degrade into running unlocked')
  releaseLock(lock)
})

test('every errno that means "no usable lock" degrades fast, not just ENOSPC', () => {
  const dir = scratch()
  const target = join(dir, 'errnos.json')
  const lockPath = lockPathFor(target)
  const original = fs.mkdirSync

  for (const code of ['ENOSPC', 'ENOENT', 'EROFS', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY']) {
    let lock
    const started = Date.now()
    try {
      fs.mkdirSync = (dirPath, options) => {
        if (dirPath === lockPath) {
          throw errno(code)
        }
        return original.call(fs, dirPath, options)
      }
      lock = acquireLock(target)
    } finally {
      fs.mkdirSync = original
    }
    const waited = Date.now() - started
    assert.equal(lock.lockPath, null, `${code} must degrade`)
    assert.ok(waited < 500, `${code} must degrade at once, not spin (${waited}ms)`)
  }
})

test('an unguarded write takes no lock - last writer wins is the accepted deal there', () => {
  // fleetState.json is rewritten every ~5s. A mutex round trip per write buys
  // nothing when there is no precondition to protect, so it is not paid.
  const dir = scratch()
  const target = join(dir, 'plain.json')
  const lockPath = lockPathFor(target)
  let asked = false
  const original = fs.mkdirSync
  try {
    fs.mkdirSync = (dirPath, options) => {
      if (dirPath === lockPath) {
        asked = true
      }
      return original.call(fs, dirPath, options)
    }
    writeFileAtomicSync(target, 'x')
  } finally {
    fs.mkdirSync = original
  }
  assert.equal(asked, false)
  assert.equal(readFileSync(target, 'utf8'), 'x')
})

test('lockPathFor is stable, path-derived and case-insensitive', () => {
  // It is a cross-process contract: two writers only exclude each other if they
  // compute the same path, and on Windows D:\X\a.json and d:\x\a.json are one
  // file. The Jot skill's standalone helper has to compute this same name.
  assert.equal(lockPathFor('D:/Repo/A/todos.json'), lockPathFor('d:/repo/a/TODOS.JSON'))
  assert.notEqual(lockPathFor('D:/Repo/A/todos.json'), lockPathFor('D:/Repo/B/todos.json'))
  assert.match(lockPathFor('D:/Repo/A/todos.json'), /keel-store-[0-9a-f]{16}\.lock$/)
})

test('a released lock is available again', () => {
  const dir = scratch()
  const target = join(dir, 'mutex.json')

  const first = acquireLock(target)
  assert.equal(existsSync(first.lockPath), true)
  releaseLock(first)
  assert.equal(existsSync(first.lockPath), false)

  const second = acquireLock(target)
  assert.equal(second.lockPath, first.lockPath, 'the same file must map to the same lock')
  releaseLock(second)
})

test('a second process waits for the holder instead of walking in', async () => {
  // Cross-process is the only exclusivity that means anything here - two Jot
  // writers are two processes - so this test spends a real child process on it.
  const dir = scratch()
  const target = join(dir, 'contended.json')
  const marker = join(dir, 'held')

  const holder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { acquireLock, releaseLock, sleepSync } from ${JSON.stringify(storageUrl)}
     import { writeFileSync } from 'node:fs'
     const lock = acquireLock(${JSON.stringify(target)})
     writeFileSync(${JSON.stringify(marker)}, 'held')
     sleepSync(400)
     releaseLock(lock)`
  ])
  let childStderr = ''
  holder.stderr.on('data', (chunk) => {
    childStderr += chunk
  })
  const exited = new Promise((resolve) => holder.on('exit', resolve))

  // Wait for the child to actually be holding it before racing for it - bounded,
  // so a child that fails to start fails this test instead of hanging the suite.
  const giveUp = Date.now() + 10_000
  while (!existsSync(marker)) {
    assert.ok(Date.now() < giveUp, `the holder process never took the lock: ${childStderr || 'no output'}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const started = Date.now()
  const mine = acquireLock(target)
  const waited = Date.now() - started
  releaseLock(mine)
  await exited

  assert.ok(waited > 100, `the lock must be waited for, not walked into (waited ${waited}ms)`)
  assert.ok(waited < LOCK_STALE_CEILING, `and must not have been broken as stale (waited ${waited}ms)`)
})

test('a lock left behind by a killed holder is taken over, not waited on forever', () => {
  // Backdated by hand rather than by killing a process, so the test stays fast:
  // the takeover only cares how old the directory is.
  const dir = scratch()
  const target = join(dir, 'abandoned.json')
  const lockPath = lockPathFor(target)
  mkdirSync(lockPath, { recursive: true })
  const longAgo = new Date(Date.now() - 60_000)
  utimesSync(lockPath, longAgo, longAgo)

  const started = Date.now()
  const lock = acquireLock(target)
  const waited = Date.now() - started
  releaseLock(lock)

  assert.equal(lock.lockPath, lockPath)
  assert.ok(waited < 500, `a stale lock must be broken at once (waited ${waited}ms)`)
})

test('no usable lock degrades to the change guard instead of refusing the write', () => {
  // No temp directory, read-only, out of space: a lock is a narrowing of an
  // already-narrow window, so losing it must not cost the user their write.
  const dir = scratch()
  const target = join(dir, 'nolock.json')
  const original = fs.mkdirSync
  let lock
  try {
    fs.mkdirSync = (dirPath, options) => {
      if (dirPath === lockPathFor(target)) {
        throw errno('ENOSPC')
      }
      return original.call(fs, dirPath, options)
    }
    lock = acquireLock(target)
  } finally {
    fs.mkdirSync = original
  }
  assert.equal(lock.lockPath, null)
  releaseLock(lock) // and a degraded handle must be releasable without crashing
})

test('releaseLock tolerates nothing to release', () => {
  releaseLock({ lockPath: null })
  releaseLock(null)
})

test('jitteredBackoffMs stays on backoffMs, spread 50-150%', () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const base = backoffMs(attempt)
    let distinct = new Set()
    for (let i = 0; i < 200; i += 1) {
      const value = jitteredBackoffMs(attempt)
      assert.ok(value >= Math.floor(base * 0.5), `${value} >= ${base * 0.5}`)
      assert.ok(value <= Math.ceil(base * 1.5), `${value} <= ${base * 1.5}`)
      distinct.add(value)
    }
    // The point of the jitter is that two writers get DIFFERENT waits.
    assert.ok(distinct.size > 1, 'a fixed wait would keep two writers in lockstep')
  }
})

test('onBeforeRename returning null lets the write through', () => {
  const dir = scratch()
  const target = join(dir, 'ok.json')
  const result = writeFileAtomicSync(target, 'through', { onBeforeRename: () => null })
  assert.deepEqual(result, { ok: true })
  assert.equal(readFileSync(target, 'utf8'), 'through')
})

test('a write into an impossible place fails with plain language, not an errno', () => {
  // A file where a directory has to be, so mkdir fails with something that is not
  // a lock and must be reported immediately rather than retried.
  const dir = scratch()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'in the way')

  const result = writeFileAtomicSync(join(blocker, 'child', 'x.json'), 'x', { app: 'Jot' })

  assert.equal(result.ok, false)
  assert.doesNotMatch(result.error, /^E[A-Z]+:/, 'the message must not start with a bare errno')
})

test('plainReason names the cause and keeps the code for a bug report', () => {
  assert.match(plainReason(errno('EROFS'), 'D:/data/x.json', 'Jot'), /^Jot isn't allowed to write/)
  assert.match(plainReason(errno('EROFS'), 'D:/data/x.json', 'Jot'), /\[EROFS\]/)
  assert.match(plainReason(errno('ENOSPC'), 'D:/data/x.json'), /disk holding D:.data is full/)
  assert.match(plainReason(errno('ENOENT'), 'D:/data/x.json'), /doesn't exist and couldn't be created/)
  // Anything unrecognised falls back to the message rather than inventing one.
  assert.equal(plainReason(new Error('something odd'), 'x'), 'something odd')
})

test('plainReason without an app name still reads as a sentence', () => {
  assert.match(plainReason(errno('EPERM'), 'D:/data/x.json'), /^The app isn't allowed to write/)
})

test('the async write lands the content and leaves no temp behind', async () => {
  const dir = scratch()
  const target = join(dir, 'deep', 'notes.json')

  await writeFileAtomic(target, 'async')

  assert.equal(readFileSync(target, 'utf8'), 'async')
  assert.deepEqual(
    readdirSync(join(dir, 'deep')).filter((file) => file.endsWith('.tmp')),
    []
  )
})

test('the async write throws on a real failure rather than returning', async () => {
  // Signature-compatible with the copies in Jot and Nib, which throw.
  const dir = scratch()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'in the way')
  await assert.rejects(() => writeFileAtomic(join(blocker, 'child', 'x.json'), 'x'))
})

test('writeJsonAtomic matches the sync form byte for byte', async () => {
  const dir = scratch()
  await writeJsonAtomic(join(dir, 'a.json'), { a: 1 })
  writeJsonAtomicSync(join(dir, 'b.json'), { a: 1 })
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), readFileSync(join(dir, 'b.json'), 'utf8'))
})

test('overwriting an existing file keeps the new content', () => {
  const dir = scratch()
  const target = join(dir, 'x.json')
  writeFileAtomicSync(target, 'first')
  writeFileAtomicSync(target, 'second')
  assert.equal(readFileSync(target, 'utf8'), 'second')
})

test('stripBom removes a leading BOM and nothing else', () => {
  const bom = String.fromCharCode(0xfeff)
  assert.equal(stripBom(`${bom}{"a":1}`), '{"a":1}')
  assert.equal(stripBom('{"a":1}'), '{"a":1}')
  // Only leading: a BOM in the middle is data, however unlikely.
  assert.equal(stripBom(`{"a":"${bom}"}`), `{"a":"${bom}"}`)
  assert.equal(stripBom(''), '')
})

test('readJsonFile parses a file written with a BOM', () => {
  // PowerShell's Out-File writes UTF-8 with a BOM by default, so any file an
  // external script has touched may have one - and JSON.parse refuses it.
  const dir = scratch()
  const target = join(dir, 'x.json')
  writeFileSync(target, `${String.fromCharCode(0xfeff)}{"a":1}`, 'utf8')

  const result = readJsonFile(target, { fallback: null })
  assert.deepEqual(result.value, { a: 1 })
  assert.equal(result.problem, null)
})

test('a missing file is absent, not a problem', () => {
  const warnings = []
  const result = readJsonFile(join(scratch(), 'nope.json'), {
    fallback: { empty: true },
    onWarning: (message) => warnings.push(message)
  })
  assert.deepEqual(result, { value: { empty: true }, missing: true, problem: null })
  // First run is normal. Warning about it teaches people to ignore warnings.
  assert.deepEqual(warnings, [])
})

test('an unparseable file warns and falls back', () => {
  const dir = scratch()
  const target = join(dir, 'broken.json')
  writeFileSync(target, '{ not json')

  const warnings = []
  const result = readJsonFile(target, {
    fallback: [],
    onWarning: (message) => warnings.push(message),
    label: 'todos.json'
  })

  assert.deepEqual(result.value, [])
  assert.equal(result.missing, false, 'the file is there - it just cannot be read')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^todos\.json could not be read: /)
})

test('resolveDataDir prefers the variable and falls back to userData', () => {
  assert.deepEqual(
    resolveDataDir({ variable: 'JOT_DATA_DIR', fallback: 'C:/users/a/AppData/jot', env: {} }),
    { dir: 'C:/users/a/AppData/jot', overridden: false, variable: 'JOT_DATA_DIR' }
  )
  assert.deepEqual(
    resolveDataDir({
      variable: 'JOT_DATA_DIR',
      fallback: 'C:/users/a/AppData/jot',
      env: { JOT_DATA_DIR: 'D:/Dropbox/jot' }
    }),
    { dir: 'D:/Dropbox/jot', overridden: true, variable: 'JOT_DATA_DIR' }
  )
})

test('a blank or whitespace-only variable is not an override', () => {
  // An unset variable and one set to nothing should behave the same; a shell
  // profile with `set JOT_DATA_DIR=` is the usual way to get the second.
  for (const value of ['', '   ']) {
    const result = resolveDataDir({ variable: 'JOT_DATA_DIR', fallback: 'fallback', env: { JOT_DATA_DIR: value } })
    assert.equal(result.overridden, false, `${JSON.stringify(value)} should not override`)
    assert.equal(result.dir, 'fallback')
  }
})

test('surrounding whitespace is trimmed off an override', () => {
  const result = resolveDataDir({
    variable: 'JOT_DATA_DIR',
    fallback: 'fallback',
    env: { JOT_DATA_DIR: '  D:/Dropbox/jot  ' }
  })
  assert.deepEqual(result, { dir: 'D:/Dropbox/jot', overridden: true, variable: 'JOT_DATA_DIR' })
})
