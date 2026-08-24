import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SHELL_TOKENS, missingTokens } from '../src/shell/index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src', 'shell', 'shell.css'), 'utf-8')

/**
 * The stylesheet is the substance here, so the tests read it as text.
 *
 * That is unusual and it is the right call: the properties below are not style
 * choices, they are the difference between a window you can close and one you
 * cannot. Two apps shipped without them.
 */

test('body is a fixed flex column and never the scroller', () => {
  // The whole reason this file exists. A scrolling body takes the header with
  // it, and in a frameless window that row is the drag handle and the only
  // close button.
  // Matched on its contents rather than its position: `html,\nbody {` also ends
  // in `body {`, and matching that one asserted nothing at all.
  const body = /\nbody \{([^}]*display:\s*flex[^}]*)\}/.exec(css)
  assert.ok(body, 'there is a body rule laying out a flex column')
  assert.match(body[1], /display:\s*flex/)
  assert.match(body[1], /flex-direction:\s*column/)
  assert.match(body[1], /overflow:\s*hidden/)
})

test('html and body are given a height, or the flex column collapses', () => {
  assert.match(css, /html,\s*\n?body \{[^}]*height:\s*100%/)
})

test('the header does not shrink and does not grow', () => {
  const header = /\.app-header \{([^}]*)\}/.exec(css)
  assert.ok(header)
  assert.match(header[1], /flex:\s*none/)
  // No hardcoded height, which is the thing a `calc(100vh - 43px)` elsewhere
  // has to be kept in sync with. Tend had exactly that, and it was the tell.
  assert.equal(/height:/.test(header[1]), false, 'the header states no height')
})

test('the scroll region can shrink inside the column', () => {
  const scroll = /\.app-scroll \{([^}]*)\}/.exec(css)
  assert.ok(scroll)
  assert.match(scroll[1], /flex:\s*1/)
  // Without min-height the flex item refuses to shrink below its content and
  // pushes the header off the top - which looks exactly like the bug this
  // file fixes, from a different cause.
  assert.match(scroll[1], /min-height:\s*0/)
  assert.match(scroll[1], /overflow-y:\s*auto/)
})

test('the header is a drag region and its controls are not', () => {
  assert.match(css, /\.app-header \{[^}]*-webkit-app-region:\s*drag/)
  // Without the opt-out a button inside the header cannot be clicked at all:
  // the drag handle swallows the press.
  const optOut = /\.app-header button,[\s\S]*?\{([^}]*)\}/.exec(css)
  assert.ok(optOut)
  assert.match(optOut[1], /-webkit-app-region:\s*no-drag/)
})

test('no colour is written as a literal - every one comes from a token', () => {
  // The boundary that keeps this a utility rather than a theme. A shared
  // stylesheet with its own palette would fight whichever app loaded it.
  const literals = css.match(/:\s*(#[0-9a-f]{3,8}|rgba?\()/gi) ?? []
  assert.deepEqual(literals, [], `found literal colours: ${literals.join(', ')}`)
})

test('every token the stylesheet reads is declared in SHELL_TOKENS', () => {
  // The pair that keeps the list honest. Nib referenced --accent-soft from a
  // rule and never defined it, and CSS said nothing at all - a missing custom
  // property is not an error, it is a rule that quietly does less.
  const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]))
  for (const token of used) {
    assert.ok(SHELL_TOKENS.includes(/** @type {any} */ (token)), `--${token} is used but not listed`)
  }
  for (const token of SHELL_TOKENS) {
    assert.ok(used.has(token), `--${token} is listed but not used`)
  }
})

test('missingTokens names what a consumer has not defined', () => {
  assert.deepEqual(missingTokens(':root { --bg: #000; }').sort(), [
    'critical',
    'surface-2',
    'text',
    'text-dim'
  ])
  assert.deepEqual(
    missingTokens(SHELL_TOKENS.map((t) => `--${t}: #000;`).join('\n')),
    [],
    'a complete set reports nothing'
  )
})

test('missingTokens is not fooled by a token named inside a comment', () => {
  // The declaration is what matters, and a doc comment listing the tokens -
  // which this package's own README does - must not count as defining them.
  assert.ok(missingTokens('/* needs --bg and --text */').includes('bg'))
})
