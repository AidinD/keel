# Keel

The shared layer under the desktop suite — Jot, Nib, Loom, Helm, Tend, Brief,
Nudge, PomPom. The keel is the member every other part of a hull attaches to.

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
| `keel/shell.css` | The frameless shell: body as a fixed flex column, the header pinned, the window buttons | runtime |
| `keel/release` | The preflight guards a release has to pass, plus the clean and the process stop | release time |
| `keel/storage` | Atomic writes that survive Dropbox, BOM-safe JSON reads, data-dir resolution | runtime |

That is the planned set. See [DECISIONS.md](DECISIONS.md) for why each one has
the shape it does.

### `keel/shell.css`

Two apps shipped with `body` as the scroller. In a frameless window that takes
the header off screen, and the header is the drag handle and the only close
button — so you are left with a window you can neither move nor close. Tend
carried it as an open P0 with `min-height: calc(100vh - 43px)`, a hardcoded
header height, which is the tell: with a flex column that number does not need
to exist.

```html
<!-- keel first, so anything below can override it -->
<link rel="stylesheet" href="../../node_modules/keel/src/shell/shell.css" />
<link rel="stylesheet" href="app.css" />
```

A bundled app writes `import 'keel/shell.css'` instead. Either way, **verify it
in the packaged build** — a `<link>` into `node_modules` has to resolve out of
the asar, and a stylesheet that fails to load is not an error anywhere.

It provides layout mechanics and the window buttons, and deliberately nothing
else: no palette, no typography, not even the header's hairline or its padding.
A separator and a set of proportions are how an app *looks*, and the first app
this did not suit would fork it. Every colour comes from a token the app defines
— `--bg`, `--text`, `--text-dim`, `--surface-2`, `--critical` — with no
fallbacks, so a missing one looks wrong at once instead of resolving to something
plausible.

`missingTokens(css)` from `keel/shell` says which a consumer has not defined. It
exists because Nib referenced `--accent-soft` from a rule and never defined it,
and CSS said nothing at all for weeks: a missing custom property is not an error,
it is a rule that quietly does less than it says.

### `keel/release`

Four apps grew their own release script. Tend's and Brief's were the same 125
lines apart from the app's name; Nib's was missing two guards and found out by
publishing a release that did nothing and printed "Published"; Loom's guards a
tag instead, because it releases from CI.

The guards are the whole value of a release script — each one is a thing that
went wrong once — so they are what this module shares. The middle is not shared,
because the two paths genuinely differ:

```js
import { appMeta, clean, ghToken, nodeExec, preflight, stopRunningBuild } from 'keel/release'

const exec = nodeExec(root)
const { tag } = appMeta(root)

// publish-from-here                          // or, for a tag-and-let-CI-build app:
preflight(exec, { tag, checks: [              // checks: ['cleanTree', 'onBranch',
  'cleanTree', 'notAlreadyReleased'           //          'nothingUnpushed', 'tagFree']
] })
```

`preflight` returns **every** failure rather than the first: being told about a
dirty tree, fixing it, and only then learning the version is already released is
two round trips for one problem. An unknown check name throws instead of being
skipped, because a guard silently lost to a typo is this module's own failure
mode.

`notAlreadyReleased` is the one to keep if you keep only one. Without it a
release script runs to completion, prints "Published", and changes nothing:
electron-builder treats a release older than two hours as untouchable, skips
`latest.yml` with a notice in the middle of its output, and exits 0. The failure
is shaped exactly like a success.

`stopRunningBuild(folder)` clears the packaged processes holding files in
`dist/`, matched on the **executable's path**. Never by name and never on a
command-line flag: a filter on a Chromium flag once stopped 19 processes at once,
because Chromium passes its flags down to every child it spawns. The spawn is
injectable, which is how the test checks the match is narrow without stopping
anything.

### `keel/storage`

The file primitives under the suite's stores — and deliberately **no store**.

There is no `Store` class here, because the five storage layers are genuinely
different shapes: Jot is one JSON document, Nib a file per note, Tend an
append-only event log with rollover, Brief a disposable JSON plus an append-only
JSONL, Helm a set of small durable stores. An abstraction over those would need a
flag for every difference, which is how a shared thing becomes worse than five
copies. What they all *do* share is writing a file atomically on Windows inside a
Dropbox folder, and reading JSON something else may have touched.

```js
import { writeJsonAtomicSync, readJsonFile, resolveDataDir } from 'keel/storage'

const result = writeJsonAtomicSync(path, state, { app: 'Jot' })
if (!result.ok) toast(`Could not save: ${result.error}`)   // plain language, not an errno
```

**The write retries twice, not once.** The rename needs retrying because on
Windows it fails with EPERM while another process holds the target — Helm lost a
board update to exactly that on 2026-07-27. Less obviously, **the temp cleanup
needs retrying too**: the sync client can grab a lock on the temp file the instant
it appears, so the usual "unlinkSync and swallow" leaves it behind. That is how
Helm's dispatch directory accumulated 1462 orphaned `.tmp` files. Jot's and Nib's
copies only knew the first half, and Jot's live data directory still holds an
orphan.

**EPERM needs a second fact to interpret.** Windows reports a locked file and a
permission-denied folder identically, so `isTransientLock(error, targetExists)`
takes whether the destination exists: you can only fight over a file that is
there. Retrying a permission problem just spends 377ms before giving a wrong
answer, which Helm's pre-release review measured.

**Both forms are here.** `writeFileAtomicSync` returns `{ ok, error }` and never
throws, because its callers run straight from IPC handlers and have a real "the
write did not happen" path — a throw is how those failures got lost. The async
`writeFileAtomic` throws, keeping the signature Jot and Nib already call. Picking
one winner would have made a migration into a rewrite.

`stripBom` is one line and had been retyped in five files, which is exactly why:
PowerShell writes UTF-8 with a BOM by default, `JSON.parse` refuses it, and a BOM
is invisible in every editor. `readJsonFile` uses it, and distinguishes *absent*
(normal on first run, no warning) from *unreadable* (something is wrong, warn).

`resolveDataDir` shares the eight lines Jot and Nib each wrote, and the reasoning
that keeps getting lost with them — in particular that the override exists partly
because a sandboxed process's writes under `%APPDATA%` are redirected into a
private overlay the app never sees. Migration of existing data is **not** here: the
apps' versions differ, and they *copy*, so pointing the variable at a scratch
folder duplicates real data somewhere you did not intend.

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

Linked from a sibling repo. Which flag depends on what the app takes from keel,
and on whether it bundles:

```bash
npm install --save-dev file:../keel   # keel/icon only, or the app bundles
npm install --save file:../keel       # keel/window in an app with no build step
```

`keel/icon` is a **build-time** dependency. It renders icons in a script; it
never ships inside an app, so a devDependency keeps it out of every packaging
question. `keel/window` is different: it runs in the app. A bundler inlines it
(Jot's electron-vite does, and `externalizeDepsPlugin` externalises
`dependencies` only, so a devDependency is exactly right there) — but an app that
ships its source unbuilt still has a live `import` at runtime, and then keel has
to be a real dependency or electron-builder will not pack it. Tend is that case.

Either way, verify it in the packaged app rather than in development. A preload
that cannot resolve `keel/window` fails silently: the window buttons simply stop
doing anything, with nothing in the log.

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

**One exception, and it is worth knowing before you panic at a diff.** An app
whose generator supersampled a hard in-or-out test — Tend's did, 4×4 per pixel —
cannot come out byte-identical, because keel computes coverage from the distance
instead of sampling it. That is a genuine improvement and a genuine change. Prove
it is only anti-aliasing: decode both PNGs, and check that every pixel that moved
had a neighbour of a different colour in the original. A changed pixel in the
middle of a flat area is a geometry change, and those you do have to look at.

Then say so in the app, because a fresh clone of it needs this repo checked out
alongside — and **will not tell anyone so**. Measured on npm 11.6.2: with the
sibling missing, both `npm install` and `npm ci` link `file:../keel` to a
dangling symlink, print "added 1 package", and exit 0. For a devDependency the
failure surfaces later, as `ERR_MODULE_NOT_FOUND` from `npm run icon`; for an app
that imports `keel/window` at runtime it surfaces as window buttons that do
nothing. A green install is not evidence keel is there, so write it down:

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
