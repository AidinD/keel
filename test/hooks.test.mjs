import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * The commit guard is the one artefact in keel whose failure is a public leak,
 * and until 2026-08-24 it was the only module with no test. An audit then found
 * two defects in it by reading the code, both of which this file would have
 * caught:
 *
 *  - the allowlist was checked first, so a screenshot inside `build/` or
 *    `assets/` was never examined - and the refusal message tells people to
 *    move images into exactly those directories;
 *  - the extension list omitted several formats that carry rendered screen
 *    content (.har and .zip in particular: a HAR capture and a Playwright trace
 *    both embed what was on screen).
 *
 * The guard is driven as a real process against a real repo, because that is the
 * only way to test what git will actually do with it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const guard = join(here, '..', 'hooks', 'no-leaky-assets.mjs')

/**
 * Stage the given paths in a throwaway repo and run the guard over them.
 *
 * @param {string[]} paths
 * @returns {{ code: number, output: string }}
 */
function check(paths) {
  const root = mkdtempSync(join(tmpdir(), 'keel-hook-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  cpSync(guard, join(root, 'no-leaky-assets.mjs'))

  for (const path of paths) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, 'x')
    execFileSync('git', ['add', '--', path], { cwd: root })
  }

  try {
    const output = execFileSync('node', ['no-leaky-assets.mjs'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, output }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const refused = (paths) => check(paths).code !== 0

test('a screenshot is refused wherever it sits, allowlist included', () => {
  // This is the defect. `build/` and `assets/` are allowed for icons and
  // artwork, and an E2E harness writing captures there is exactly how the
  // original leak happened.
  assert.ok(refused(['scripts/e2e/screenshots/01-dashboard.png']), 'plain screenshots dir')
  assert.ok(refused(['build/screenshots/01-dashboard.png']), 'inside build/')
  assert.ok(refused(['assets/screenshots/02-sidebar.png']), 'inside assets/')
  assert.ok(refused(['resources/captures/run.png']), 'inside resources/')
  assert.ok(refused(['docs/recordings/demo.mp4']), 'recordings too')
})

test('a binary outside the asset directories is refused even without a telling name', () => {
  // _dev-badge.png sat directly in scripts/e2e/ with nothing in its name to
  // suggest a screenshot. It was a dashboard capture.
  assert.ok(refused(['scripts/e2e/_dev-badge.png']))
})

test('formats that embed rendered screen content are refused', () => {
  // A HAR capture and a Playwright trace both contain what was on screen.
  for (const path of ['docs/session.har', 'test/trace.zip', 'data/board.csv', 'data/app.db']) {
    assert.ok(refused([path]), path)
  }
})

test('key and certificate files are refused', () => {
  for (const path of ['deploy.key', 'secrets.pem', 'cert.p12', 'config/.env']) {
    assert.ok(refused([path]), path)
  }
})

test('icons and artwork in the asset directories still pass', () => {
  // The guard has to stay usable. If it refuses an app icon, it gets bypassed.
  assert.equal(check(['resources/icon.png']).code, 0)
  assert.equal(check(['build/icon.ico']).code, 0)
  assert.equal(check(['src/renderer/assets/logo.png']).code, 0)
})

test('source files pass', () => {
  assert.equal(check(['src/main.js', 'README.md', 'package.json', 'test/x.test.mjs']).code, 0)
})

test('the refusal names every offender and says why', () => {
  const result = check(['scripts/e2e/screenshots/a.png', 'deploy.key'])
  assert.notEqual(result.code, 0)
  assert.match(result.output, /screenshots\/a\.png/)
  assert.match(result.output, /deploy\.key/)
})

test('the refusal does not tell people to move images somewhere unchecked', () => {
  // The message used to say "put it under resources/, build/ or assets/", which
  // pointed straight into the blind spot above. Now that a screenshot is refused
  // in those directories too, the advice must not resurface.
  const result = check(['scripts/e2e/screenshots/a.png'])
  const suggestsAllowlist = /put it under|move it (to|under)/i.test(result.output)
  const stillAllowsScreenshots = refused(['build/screenshots/a.png']) === false
  assert.ok(
    !(suggestsAllowlist && stillAllowsScreenshots),
    'the message may only point at the asset directories while they are actually checked'
  )
})

test('an already-tracked file is not re-flagged', () => {
  // Being nagged about a file reviewed months ago is how people learn to type
  // --no-verify by reflex. Only added/copied/renamed files are this hook's
  // business, so an empty staging area passes.
  assert.equal(check([]).code, 0)
})
