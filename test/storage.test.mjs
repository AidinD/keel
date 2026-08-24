import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_ATTEMPTS,
  backoffMs,
  isTransientLock,
  plainReason,
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

test('onBeforeRename can abort an attempt, and the temp is still cleaned up', () => {
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
  assert.equal(asked, MAX_ATTEMPTS, 'every attempt should re-check')
  assert.equal(existsSync(target), false, 'an aborted write must not create the target')
  assert.deepEqual(
    readdirSync(dir).filter((file) => file.endsWith('.tmp')),
    [],
    'each aborted attempt must remove its own temp file'
  )
  assert.ok(result.error.includes('someone else changed it'))
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
