import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * The guard is COPIED into each sibling rather than imported, because a hook has
 * to run in a clone where `npm install` has not happened yet. That decision is
 * right and it has no drift detection, which is the gap this file closes.
 *
 * Two things went wrong before it existed:
 *  - a 2026-08-23 rollout reached seven of nine repos, and nobody noticed the
 *    two it missed until an audit a day later;
 *  - Loom's copy drifted and nobody knew, so the next edit would not have been
 *    noticed either.
 *
 * `no-leaky-assets.mjs` is pinned byte-for-byte. `pre-commit` may differ - Loom
 * legitimately appends a version bump - but the guard line has to be there and
 * has to come first, so nothing has a side effect before a refusal.
 *
 * Siblings that are not checked out are skipped rather than failed: keel has to
 * be testable on a machine that only has keel.
 */

const here = dirname(fileURLToPath(import.meta.url))
const keel = join(here, '..')
const tools = join(keel, '..')

const SIBLINGS = ['jot', 'nib', 'loom', 'helm', 'tend', 'brief', 'nudge', 'pompom']

const canonicalGuard = readFileSync(join(keel, 'hooks', 'no-leaky-assets.mjs'), 'utf8')

/*
 * The privacy guard, rolled out 2026-08-25 after real colleague and project
 * names reached a public repository through test fixtures. Pinned here for the
 * same reason as the asset guard: the previous rollout of a hook reached seven
 * of nine repos and nobody noticed the two it missed for a day.
 */
const canonicalPrivacy = readFileSync(join(keel, 'hooks', 'no-private-names.mjs'), 'utf8')
const canonicalPrePush = readFileSync(join(keel, 'hooks', 'pre-push'), 'utf8')

/** Siblings that are actually on this disk. */
const present = SIBLINGS.filter((name) => existsSync(join(tools, name, 'package.json')))

test('the canonical guard checks suspect paths before the allowlist', () => {
  // The ordering IS the fix for the blind spot; assert it here too so a
  // well-meaning refactor cannot quietly put the allowlist back on top.
  const pathIndex = canonicalGuard.indexOf('SUSPECT_PATH.test(path)')
  const allowIndex = canonicalGuard.indexOf('ALLOWED.some(')
  assert.ok(pathIndex > 0 && allowIndex > 0, 'both checks must exist')
  assert.ok(
    pathIndex < allowIndex,
    'SUSPECT_PATH must be tested before ALLOWED, or a screenshot in build/ is never examined'
  )
})

test('every sibling on this disk carries the canonical guard, byte for byte', () => {
  assert.ok(present.length > 0, 'no siblings checked out - nothing verified')
  const drifted = []
  for (const name of present) {
    const path = join(tools, name, '.githooks', 'no-leaky-assets.mjs')
    if (!existsSync(path)) {
      drifted.push(`${name}: MISSING`)
      continue
    }
    if (readFileSync(path, 'utf8') !== canonicalGuard) {
      drifted.push(`${name}: drifted from keel/hooks`)
    }
  }
  assert.deepEqual(drifted, [], `re-copy from keel/hooks: ${drifted.join(', ')}`)
})

test('every sibling runs the guard first in its pre-commit', () => {
  const bad = []
  for (const name of present) {
    const path = join(tools, name, '.githooks', 'pre-commit')
    if (!existsSync(path)) {
      bad.push(`${name}: no pre-commit`)
      continue
    }
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    const first = lines[0]
    if (first !== '#!/bin/sh' && !first?.includes('no-leaky-assets.mjs')) {
      bad.push(`${name}: first command is not the guard`)
      continue
    }
    const guardLine = lines.find((line) => line.includes('no-leaky-assets.mjs'))
    if (guardLine === undefined) {
      bad.push(`${name}: pre-commit never runs the guard`)
      continue
    }
    if (!guardLine.includes('|| exit 1')) {
      bad.push(`${name}: guard failure is not fatal`)
      continue
    }
    // Nothing with a side effect may run before the guard.
    const beforeGuard = lines.slice(1, lines.indexOf(guardLine))
    if (beforeGuard.length > 0) {
      bad.push(`${name}: ${beforeGuard.length} command(s) run before the guard`)
    }
  }
  assert.deepEqual(bad, [], bad.join('; '))
})

test('every sibling activates the hook through its prepare script', () => {
  // core.hooksPath is per-clone config and is never committed, which is the
  // usual reason a committed hook quietly does nothing. `prepare` is what turns
  // it on when someone runs npm install.
  const bad = []
  for (const name of present) {
    const manifest = JSON.parse(readFileSync(join(tools, name, 'package.json'), 'utf8'))
    const prepare = manifest.scripts?.prepare ?? ''
    if (!prepare.includes('core.hooksPath')) {
      bad.push(name)
    }
  }
  assert.deepEqual(bad, [], `missing prepare script setting core.hooksPath: ${bad.join(', ')}`)
})

test('every sibling ignores the directories that leak', () => {
  const bad = []
  for (const name of present) {
    const path = join(tools, name, '.gitignore')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const missing = ['screenshots', 'captures'].filter((entry) => !text.includes(entry))
    if (missing.length > 0) {
      bad.push(`${name}: ${missing.join(', ')}`)
    }
  }
  assert.deepEqual(bad, [], `add to .gitignore: ${bad.join(' | ')}`)
})

test('every sibling on this disk carries the privacy guard, byte for byte', () => {
  const drifted = present.filter((name) => {
    const path = join(tools, name, '.githooks', 'no-private-names.mjs')
    return !existsSync(path) || readFileSync(path, 'utf8') !== canonicalPrivacy
  })
  assert.deepEqual(drifted, [], 'these siblings are missing the privacy guard or have an old copy')
})

test('and a pre-push hook that runs it first', () => {
  // First, so nothing has a side effect before a refusal.
  const wrong = present.filter((name) => {
    const path = join(tools, name, '.githooks', 'pre-push')
    if (!existsSync(path)) {
      return true
    }
    const body = readFileSync(path, 'utf8')
    const lines = meaningful(body)
    return lines[0] !== 'node .githooks/no-private-names.mjs || exit 1'
  })
  assert.deepEqual(wrong, [], 'these siblings have no pre-push hook, or run something before the guard')
})

test('the canonical pre-push runs the guard and nothing else first', () => {
  assert.equal(meaningful(canonicalPrePush)[0], 'node .githooks/no-private-names.mjs || exit 1')
})

/**
 * A shell script's lines with the blanks and the comments taken out.
 *
 * @param {string} body
 * @returns {string[]}
 */
function meaningful(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}
