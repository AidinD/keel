# Keel

The shared layer under the desktop suite — Jot, Nib, Loom, Helm, Tend, Nudge,
PomPom. The keel is the member every other part of a hull attaches to.

Not an app. Nothing here has a window.

## Why

The suite is seven Electron apps that deliberately look and behave like one
family, and each of them had grown its own copy of the same plumbing. As of
2026-08-23, before this package existed:

- the same icon generator, copy-pasted into **four** repos and byte-identical in
  three of them
- the frameless header re-implemented **five** times
- the same three window-control IPC handlers, **five** times
- `.gitattributes` missing from **seven** repos, including one where a batch file
  needed a CRLF exception
- two competing release paths in Loom, which raced and produced duplicate draft
  releases twice

None of that is interesting work, and all of it has to be right in every app.

## What's here

| Import | What it is | When it runs |
| --- | --- | --- |
| `keel/icon` | PNG encode/decode, multi-size `.ico`, distance-field helpers for drawing a mark | build time |
| `keel/window` | The three IPC handlers and the preload bridge a frameless title bar needs | runtime |

More to come — storage adapter, release script. See [DECISIONS.md](DECISIONS.md)
for the shape and the order.

### `keel/window`

Every app in the suite is frameless, so every app answers the same three messages
from its header row. Electron is **injected**, so keel has no electron dependency
and the whole thing is testable with two object literals:

```js
// main
import { registerWindowControls } from 'keel/window'
registerWindowControls({ ipcMain, BrowserWindow })

// preload
import { windowControlsBridge } from 'keel/window'
contextBridge.exposeInMainWorld('app', { ...windowControlsBridge(ipcRenderer), /* ... */ })
```

It acts on **the window that sent the message**, never on the focused one. Tend
used `BrowserWindow.getFocusedWindow()`, which is invisible with a single window
and wrong the moment there are two — or when a click arrives while focus is
elsewhere. Making the correct form the default is most of why this module exists.

`close` is a plain `window.close()`, so an app that intercepts its own `close`
event to hide into a tray keeps working without knowing keel is there. Jot does
exactly that, and it still does.

## Using it

Plain ESM with JSDoc types and **no build step**. Helm and Tend are JavaScript,
the rest are TypeScript, and JS-with-JSDoc is consumed happily by both — so
there is no `dist/` to rebuild by hand every time something changes.

Linked from a sibling repo:

```bash
npm install --save-dev file:../keel
```

`keel/icon` is a **build-time** dependency. It renders icons in a script; it
never ships inside an app. Install it as a devDependency and it stays out of
every packaging question.

```js
import { renderIco, renderPng, coverage, diagonalRamp, distArc, SMALL_BELOW } from 'keel/icon'

const brass = diagonalRamp([232, 181, 92], [201, 126, 62])

function shade(x, y, size) {
  const weight = size < SMALL_BELOW ? 0.13 : 0.09   // two drawings, see below
  const alpha = coverage(distArc(x, y, size / 2, size / 2, size * 0.3, 0, 294), (size * weight) / 2)
  if (alpha === 0) return [0, 0, 0, 0]
  const [r, g, b] = brass(x, y, size)
  return [r, g, b, Math.round(255 * alpha)]
}

writeFileSync('resources/icon.ico', renderIco(shade))
writeFileSync('resources/icon.png', renderPng(512, shade))
```

## Two rules the icon module encodes

**Two drawings, not one.** Below `SMALL_BELOW` (32px), draw a simpler, heavier
version of the mark. At 16px a stroke at its true weight lands under a pixel,
counters close up, and detail turns to porridge. Every app in the suite that
skipped this shipped a soft taskbar icon; every one that measured it landed on
the same threshold.

**Ship every size.** `DEFAULT_LADDER` includes 20 and 24, which are the two
everyone forgets and the two that matter most: the taskbar asks for them at 125%
and 150% display scaling, which is where most laptops actually sit. A missing
frame means Windows resamples a neighbour, which is the soft icon you were trying
to avoid.

## Adopting it without changing your icons

The PNG encoder is byte-for-byte the one the apps each carried, so migrating is
supposed to produce an **empty diff**. Verify it rather than trusting it:

```bash
node scripts/generate-icon.mjs
git status --short resources/    # expect no output
```

That is how Jot was migrated. If the diff is not empty, something about the
geometry changed too and it wants looking at.

Then say so in the app, because `file:../keel` means a fresh clone of it will
**fail `npm install`** without this repo checked out alongside:

- its **README** — the sibling-checkout requirement, under Develop
- its **CLAUDE.md** — the same fact, where a session will actually read it
- an **`icon` script** in package.json, so the command is the same in every app

Skipping that is how a public repo ends up un-clonable by anyone but its author.

## The commit guard

`hooks/` holds the suite's shared `pre-commit`. It refuses to add an image, media
or data file outside `resources/`, `build/` and `assets/`, and anything whose path
mentions a screenshot.

It exists because of a real incident: seven screenshots of Helm's own dashboard
sat in a **public** repo from July to August 2026. They showed the live session
sidebar — a group labelled with the employer's name, entries naming real prospects
and a client pitch. Nobody added them carelessly; they were the output of an E2E
screenshot harness and `git add -A` did the rest. Taking them back meant rewriting
734 commits and force-pushing 84 tags, and by then the repo had been forked.

Installing it in a repo:

```bash
cp ../keel/hooks/pre-commit ../keel/hooks/no-leaky-assets.mjs .githooks/
npm pkg set scripts.prepare="git config core.hooksPath .githooks"
git config core.hooksPath .githooks          # for this clone, now
```

Three things worth knowing:

- **The hook is copied, not imported.** A hook has to run in a clone where
  `npm install` has not happened yet, so it cannot live in `node_modules`. The
  canonical copy is here; if you change it, copy it out again.
- **`prepare` is what makes it real.** `core.hooksPath` is per-clone config and
  is never committed, which is the usual reason a committed hook quietly does
  nothing. Running it from `prepare` means `npm install` turns it on.
- **It only checks newly added files.** Being nagged about a file that was
  reviewed months ago is how people learn to type `--no-verify` by reflex.

If a repo already has a `pre-commit` — Loom bumps its patch version in one — put
the guard **first**, so a refusal happens before anything with a side effect.

## Types

Keel ships JavaScript, and a TypeScript consumer cannot read JS out of
`node_modules`. So `types/` holds `.d.mts` files — **generated from the JSDoc,
not written by hand**:

```bash
npm run types    # regenerate after changing any signature
```

`npm test` fails if they are stale, which is the point: a hand-written
declaration can quietly disagree with its implementation, and then the compiler
lies to every consumer. The JSDoc is the single source of truth.

Only the *types* are generated. Consumers import `src/*.mjs` directly, so editing
keel still takes effect immediately with nothing to rebuild.

## Tests

```bash
npm test
```
