import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHECKS,
  appMeta,
  clean,
  cleanTree,
  ghToken,
  notAlreadyReleased,
  nothingUnpushed,
  onBranch,
  preflight,
  stopRunningBuild,
  stopScript,
  tagFree
} from '../src/release/index.mjs'

/**
 * A stand-in for a real spawn. Keys are `command arg arg ...`; a string value is
 * stdout, an Error value is thrown the way a non-zero exit does.
 */
function fakeExec(responses) {
  const seen = []
  const exec = (command, args) => {
    const key = [command, ...args].join(' ')
    seen.push(key)
    const response = responses[key]
    if (response === undefined) {
      throw new Error(`nothing stubbed for: ${key}`)
    }
    if (response instanceof Error) {
      throw response
    }
    return response
  }
  exec.seen = seen
  return exec
}

test('a clean tree passes and a dirty one reports what is dirty', () => {
  assert.equal(cleanTree(fakeExec({ 'git status --porcelain': '' })), null)

  const failure = cleanTree(fakeExec({ 'git status --porcelain': ' M src/app.js' }))
  assert.equal(failure?.name, 'cleanTree')
  assert.ok(failure.message.includes(' M src/app.js'))
})

test('untracked files count as dirty', () => {
  // Not --untracked-files=no: a file the build reads but nobody committed is in
  // the installer here and absent everywhere else.
  const exec = fakeExec({ 'git status --porcelain': '?? scratch.json' })
  assert.notEqual(cleanTree(exec), null)
  assert.deepEqual(exec.seen, ['git status --porcelain'])
})

test('an existing GitHub release is refused, and a missing one passes', () => {
  const missing = fakeExec({
    'gh release view v1.2.3 --json tagName': new Error('release not found')
  })
  assert.equal(notAlreadyReleased(missing, { tag: 'v1.2.3' }), null)

  const present = fakeExec({ 'gh release view v1.2.3 --json tagName': '{"tagName":"v1.2.3"}' })
  const failure = notAlreadyReleased(present, { tag: 'v1.2.3' })
  assert.equal(failure?.name, 'notAlreadyReleased')
  assert.ok(failure.message.includes('latest.yml'))
})

test('the already-released message explains the silent no-op', () => {
  // The whole reason this check exists: electron-builder exits 0 and prints
  // "Published" while skipping latest.yml, so the message has to say so.
  const exec = fakeExec({ 'gh release view v9.9.9 --json tagName': 'v9.9.9' })
  const failure = notAlreadyReleased(exec, { tag: 'v9.9.9' })
  assert.ok(failure.message.includes('leaves the updater on the old build'))
})

test('branch and unpushed checks', () => {
  assert.equal(onBranch(fakeExec({ 'git rev-parse --abbrev-ref HEAD': 'main' }), {}), null)

  const elsewhere = fakeExec({ 'git rev-parse --abbrev-ref HEAD': 'spike/icons' })
  assert.ok(onBranch(elsewhere, {}).message.includes('On spike/icons, not main'))

  assert.equal(nothingUnpushed(fakeExec({ 'git log --oneline origin/main..HEAD': '' }), {}), null)
  const behind = fakeExec({ 'git log --oneline origin/main..HEAD': 'abc123 wip' })
  assert.ok(nothingUnpushed(behind, {}).message.includes('abc123 wip'))
})

test('a custom branch and upstream are honoured', () => {
  const exec = fakeExec({
    'git rev-parse --abbrev-ref HEAD': 'release',
    'git log --oneline upstream/release..HEAD': ''
  })
  assert.equal(onBranch(exec, { branch: 'release' }), null)
  assert.equal(nothingUnpushed(exec, { upstream: 'upstream/release' }), null)
})

test('tagFree checks local before remote, and stops at the first', () => {
  const local = fakeExec({ 'git tag --list v2.0.0': 'v2.0.0' })
  assert.ok(tagFree(local, { tag: 'v2.0.0' }).message.includes('already exists locally'))
  // The remote was never asked - a local hit is enough, and asking origin costs a
  // network round trip.
  assert.deepEqual(local.seen, ['git tag --list v2.0.0'])

  const remote = fakeExec({
    'git tag --list v2.0.0': '',
    'git ls-remote --tags origin refs/tags/v2.0.0': 'deadbeef refs/tags/v2.0.0'
  })
  assert.ok(tagFree(remote, { tag: 'v2.0.0' }).message.includes('already on origin'))

  const free = fakeExec({
    'git tag --list v2.0.0': '',
    'git ls-remote --tags origin refs/tags/v2.0.0': ''
  })
  assert.equal(tagFree(free, { tag: 'v2.0.0' }), null)
})

test('preflight reports every failure, not just the first', () => {
  // Being told about a dirty tree, fixing it, and only then learning the version
  // is already released is two round trips for one problem.
  const exec = fakeExec({
    'git status --porcelain': ' M a.js',
    'gh release view v1.0.0 --json tagName': 'v1.0.0'
  })
  const failures = preflight(exec, { tag: 'v1.0.0', checks: ['cleanTree', 'notAlreadyReleased'] })
  assert.deepEqual(
    failures.map((failure) => failure.name),
    ['cleanTree', 'notAlreadyReleased']
  )
})

test('preflight runs only the checks it was asked for', () => {
  const exec = fakeExec({ 'git status --porcelain': '' })
  assert.deepEqual(preflight(exec, { checks: ['cleanTree'] }), [])
  assert.deepEqual(exec.seen, ['git status --porcelain'])
})

test('preflight throws on an unknown check rather than skipping it', () => {
  // A guard silently ignored because of a typo is the exact failure mode this
  // module exists to prevent.
  assert.throws(
    () => preflight(fakeExec({}), { checks: ['cleanTree', 'noSuchGuard'] }),
    (error) => error.message.includes('Unknown release check(s): noSuchGuard')
  )
})

test('every catalogue entry is exported by name', () => {
  const named = { cleanTree, onBranch, nothingUnpushed, tagFree, notAlreadyReleased }
  assert.deepEqual(Object.keys(CHECKS).sort(), Object.keys(named).sort())
  for (const [name, check] of Object.entries(CHECKS)) {
    assert.equal(check, named[name], `CHECKS.${name} is not the exported ${name}`)
  }
})

test('ghToken reads the CLI and refuses an empty answer', () => {
  assert.equal(ghToken(fakeExec({ 'gh auth token': 'gho_abc' })), 'gho_abc')
  assert.throws(() => ghToken(fakeExec({ 'gh auth token': '' })), /returned nothing/)
  assert.throws(
    () => ghToken(fakeExec({ 'gh auth token': new Error('not logged in') })),
    /is the gh CLI logged in/
  )
})

test('appMeta reads name, version and tag', () => {
  const root = mkdtempSync(join(tmpdir(), 'keel-release-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tend', version: '0.1.8' }))
  assert.deepEqual(appMeta(root), { name: 'tend', version: '0.1.8', tag: 'v0.1.8' })
})

test('clean removes the directories and reports stale installers', () => {
  const root = mkdtempSync(join(tmpdir(), 'keel-release-'))
  mkdirSync(join(root, 'dist'))
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'dist', 'Tend-0.1.7-setup.exe'), 'x')
  writeFileSync(join(root, 'dist', 'latest.yml'), 'x')
  writeFileSync(join(root, 'dist', 'notes.txt'), 'x')

  const lines = []
  clean(root, ['out', 'dist'], (line) => lines.push(line))

  assert.equal(existsSync(join(root, 'dist')), false)
  assert.equal(existsSync(join(root, 'out')), false)
  assert.ok(
    lines.some((line) => line.includes('2 file(s)')),
    `expected a count of 2 installers, got: ${JSON.stringify(lines)}`
  )
  assert.ok(lines.some((line) => line.includes('Cleaned out/ and dist/')))
})

test('clean is happy when the directories are not there', () => {
  const root = mkdtempSync(join(tmpdir(), 'keel-release-'))
  clean(root, ['out', 'dist'], () => {})
  assert.equal(existsSync(join(root, 'dist')), false)
})

test('the stop script matches on the executable path, not the name', () => {
  const script = stopScript('D:/Repo/Tools/tend/dist')
  assert.ok(script.includes('ExecutablePath.StartsWith($root)'))
  // Never a name or command-line match: a filter on a Chromium flag once stopped
  // 19 processes at once, because the flags are passed down to every child.
  assert.doesNotMatch(script, /ProcessName|CommandLine|taskkill/)
})

test('a quote in the path is doubled, not left to break the script', () => {
  assert.ok(stopScript("C:/it's/dist").includes("$root = 'C:/it''s/dist'"))
})

test('stopRunningBuild is a no-op off Windows and spawns once on it', () => {
  let spawned = 0
  stopRunningBuild('C:/x/dist', {
    spawn: () => {
      spawned += 1
    },
    platform: 'linux'
  })
  assert.equal(spawned, 0)

  const calls = []
  stopRunningBuild('C:/x/dist', {
    spawn: (command, args) => calls.push({ command, args }),
    platform: 'win32'
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.includes('-NonInteractive'))
})

test('a failing spawn is reported, not thrown', () => {
  // Not being able to look is not a reason to abandon the release; the clean step
  // fails with a clear message if something really is holding a file.
  const lines = []
  stopRunningBuild('C:/x/dist', {
    spawn: () => {
      throw new Error('powershell missing')
    },
    log: (line) => lines.push(line),
    platform: 'win32'
  })
  assert.ok(lines.join('\n').includes('Could not check for running builds: powershell missing'))
})
