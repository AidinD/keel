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

test('every export in the map has a declaration beside it', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  for (const [name, entry] of Object.entries(pkg.exports)) {
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
