import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The committed declarations must match what the source says.
 *
 * Keel ships JavaScript, and a TypeScript consumer cannot read JS out of
 * node_modules, so `types/` has to exist. It is generated from the JSDoc rather
 * than written by hand for one reason: a hand-written declaration can disagree
 * with its implementation and nothing notices, and then the compiler lies
 * confidently to every consumer. This test is what makes that impossible - the
 * JSDoc is the single source of truth, and if `npm run types` would change
 * anything, this fails.
 */

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...walk(path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

test('the committed declarations are what the source generates', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'keel-types-'))
  try {
    // The tsc entrypoint directly rather than through npx: spawning a .cmd on
    // Windows needs shell:true, and reaching for a shell to run a local binary
    // is a habit worth not having.
    execFileSync(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--declarationDir', scratch],
      { cwd: root, stdio: 'pipe' }
    )

    const fresh = walk(scratch).map((path) => relative(scratch, path))
    const committed = walk(join(root, 'types')).map((path) => relative(join(root, 'types'), path))

    assert.deepEqual(
      committed,
      fresh,
      'types/ has different files than the source generates - run `npm run types`'
    )

    for (const file of fresh) {
      assert.equal(
        readFileSync(join(root, 'types', file), 'utf-8'),
        readFileSync(join(scratch, file), 'utf-8'),
        `types/${file} is stale - run \`npm run types\``
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('no declaration file lives beside the source', () => {
  // The drift test above compares `types/` against a fresh generation, so it
  // cannot see a hand-written declaration sitting in `src/` - and one did
  // survive there for a while, left over from the first attempt at this. It was
  // harmless only by luck: TypeScript prefers a `.d.mts` over the `.mjs` beside
  // it, so such a file quietly becomes the truth about a module nobody is
  // checking any more.
  const strays = walk(join(root, 'src')).filter((path) => path.endsWith('.d.mts') || path.endsWith('.d.ts'))
  assert.deepEqual(
    strays.map((path) => relative(root, path)),
    [],
    'declarations belong in types/, generated - see DECISIONS.md'
  )
})

test('every export in the map points at something that exists', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  for (const [name, entry] of Object.entries(pkg.exports)) {
    // An asset export is a bare path. It has no declaration and should not be
    // required to have one - but it does have to exist, which is the half of
    // this test that catches a typo in a stylesheet path nobody imports in JS.
    if (typeof entry === 'string') {
      assert.doesNotThrow(() => statSync(join(root, entry)), `${name} points at ${entry}, which does not exist`)
      continue
    }

    assert.ok(entry.types, `${name} has no types condition`)
    assert.doesNotThrow(
      () => statSync(join(root, entry.types)),
      `${name} points at ${entry.types}, which does not exist`
    )
    assert.doesNotThrow(
      () => statSync(join(root, entry.default)),
      `${name} points at ${entry.default}, which does not exist`
    )
  }
})
