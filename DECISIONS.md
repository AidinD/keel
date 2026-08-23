# Keel — decisions

Newest first. Each entry records the decision, what else was considered, and why.

## 2026-08-23 — Tend as the second consumer, and what it caught

Jot proved keel inside a bundler and a TypeScript codebase. Tend is the opposite
on both counts — plain DOM, JS with JSDoc, no build step — and a shared layer that
only works in one of those is not one. Four things came out of the second
migration that the first could not have shown:

**`keel/window` has to be a real `dependency` in an unbundled app.** Jot's
electron-vite inlines it, so a devDependency is right there. Tend ships `src/**`
as-is, so the import survives into the asar and electron-builder has to pack it.
It does — npm symlinks a `file:` dependency and the packer dereferences it — but a
preload that fails to resolve a bare specifier fails *silently*, so Tend's
packaged E2E now clicks maximise and asserts the window resized. That is the only
observable end of the chain from inside the renderer.

**Derive the consumer's type from keel's declaration, don't restate it.** Tend
annotates its preload global in `ui.js`, and the window-control half is
`ReturnType<typeof import('keel/window').windowControlsBridge>`. Writing the three
functions out again would have recreated the exact failure that generated
declarations exist to prevent, one level further out.

**A hand-written `src/index.d.mts` had survived the reversal below.** The drift
test compares `types/` against a fresh generation, so it could not see a
declaration sitting next to the source — and TypeScript *prefers* a `.d.mts` over
the `.mjs` beside it, which means such a file quietly becomes the truth about a
module nobody checks any more. There is now a test that `src/` contains no
declaration files at all. A rule you reversed is not gone until the artefacts it
produced are, which is the same lesson Helm's screenshots taught in a worse way.

**The root barrel names every area.** It exported `icon` and not `window`. Keel is
meant to be imported per-area, and the barrel exists only so `import 'keel'` is
not a dead end — but a courtesy that carries half the package is worse than none,
because you find out by getting `undefined`.

**Two helpers went in for Tend's drawing.** `distSegmentAt` returns the distance
*and* how far along the segment the nearest point is, which is what lets a stroke
taper; `distSegment` is now a thin wrapper on it. `distRoundedRect` is the first
**signed** distance here — every other helper describes a stroke, which is
symmetric about its path, but a plate is filled and filling has to know which side
you are on. It pairs with `coverage(d, 0)` rather than `coverage(d, halfWeight)`.

Tend's icon therefore is **not** byte-identical, unlike the other three
migrations: its generator supersampled 4×4 per pixel where keel computes coverage
analytically. Measured rather than assumed — 1.5% of pixels moved, all on an
outline, none inside a flat area, mean delta 0.18/255. Same geometry, slightly
crisper, sixteen times less arithmetic.

## 2026-08-23 — Window chrome, and the price of having no build step

`keel/window` is the second module: the three IPC handlers and the preload bridge
a frameless title bar needs, in five apps that had each written them out.

**Electron is injected, not imported.** `registerWindowControls({ ipcMain,
BrowserWindow })`. Keel has no electron dependency and should not grow one to
describe two arguments, and the result is a module testable with two object
literals - no electron, no window, no display.

**It fixes a real difference, not just duplication.** Tend reached for
`BrowserWindow.getFocusedWindow()`; Jot and Loom used
`fromWebContents(event.sender)`. The first acts on whatever window is focused,
which is invisible with one window and wrong with two. Consolidating made the
correct form the default, which is a better reason to share code than saving
lines.

### Generated `.d.mts`, checked by a test — after hand-writing them first and being wrong

The icon module got away with being plain JS because it is only imported from
`scripts/`, which is outside every app's tsconfig. The window module is imported
from `src/main` and `src/preload`, and TypeScript immediately said TS7016: no
declaration file.

- **Rejected: `allowJs` in the consumers.** It does not even work on its own -
  TypeScript will not read JS out of `node_modules` without also setting
  `maxNodeModuleJsDepth`. Two obscure flags in five repos to make an import
  typecheck is the kind of setting that works until someone wonders why.
- **First taken, then reversed: writing the declarations by hand.** It works, and
  it is wrong. The shape then exists twice — once implicitly in the JS, once
  explicitly in the `.d.mts` — with nothing checking that the two agree. Change a
  signature and forget the declaration, and every TypeScript consumer gets types
  that are confidently wrong. A silent lie is worse than the error it replaced.
- **Taken instead: generate them from the JSDoc, commit them, and let a test fail
  if they are stale.** `npm run types` runs `tsc` with `emitDeclarationOnly` into
  `types/`; `npm test` regenerates into a scratch directory and compares. The
  JSDoc is the single source of truth and drift is not possible.

The reason this does not reintroduce the `dist-core` tax is that **only the types
are generated**. Consumers import `src/*.mjs` directly, so editing keel still
changes its consumers immediately with nothing to rebuild. Forgetting to
regenerate costs a failing test, not a stale runtime.

Two details that cost a round each:

- The declarations cannot live beside the source. A `main.d.mts` next to
  `main.mjs` shadows it, and TypeScript then refuses to overwrite what it is
  reading. Hence `declarationDir: "types"` and a `rootDir`.
- `checkJs` is on, which immediately found a genuinely untyped parameter in the
  module I had just written by hand. That is the argument for generation in one
  line: the hand-written declaration had been describing something the
  implementation did not quite say.

### Jot is the first consumer, and keel stays a devDependency there

Jot bundles main and preload with electron-vite, whose `externalizeDepsPlugin`
externalises `dependencies` only. Keeping keel in `devDependencies` therefore
gets it **bundled into `out/`**, so the packaged app has no runtime dependency on
`node_modules` at all and `file:` never has to survive electron-builder.

Helm and Tend have no bundler, so for them keel will have to be a real
dependency. That asymmetry is a consequence of the suite genuinely being two
kinds of app, and it is better stated than smoothed over.

## 2026-08-23 — A commit guard, because a convention had already failed

Seven screenshots of Helm's own dashboard were committed to a public repo and sat
there for five weeks. They showed the real session sidebar: a group labelled with
the employer's name, and entries naming actual prospects and a client pitch. The
fix cost a history rewrite of 734 commits, a force-push of 84 tags, and the repo
going private — and it was forked before any of that, so the content is still in
someone else's copy.

### The root cause was not what it looked like

Worth being precise, because the obvious diagnosis is wrong. The app/data
separation was never broken: Helm keeps its data in `~/.helm`, Jot in
`JOT_DATA_DIR`, Tend in `TEND_DATA_DIR`, and no data file was ever committed
anywhere. The data was correctly outside the repo and ended up inside it anyway,
as pixels.

**A screenshot of a running app is a side channel that no data architecture
protects against.** That is why this guard targets images rather than data files.

The structural fault was test isolation, and it had already been fixed:

- `04fb7d7e` added the E2E harness, and its first version launched `npm start` -
  the real app against the real data directory. That is where the screenshots
  came from.
- `ce4b1bc` later gave every launch its own `--user-data-dir` and a temp
  `HELM_CONFIG_PATH`. The harness has been properly isolated ever since.

So the bug was found and closed a month before the audit. What nobody did was go
back and delete what it had already produced. **The generalisable lesson: when
you fix an isolation bug, the artefacts it already produced are part of the bug.**
A fix that leaves its own evidence in the repo has not finished.

The two lesser findings were not architectural at all. Hardcoded real paths in
test fixtures (`D:/Repo/Northwind-Internal/...`) are fixture hygiene - a test that
needs a path that looks like a work repo should invent one. And internal
codenames in prose are an editorial judgement, not a leak: real context is what
makes a decision log worth keeping.

**The decision: a `pre-commit` hook, not a rule in CLAUDE.md.** Nobody committed
those files carelessly. They were the output of an E2E screenshot harness, and
`git add -A` did the rest. That is a mechanical failure, and a written convention
does not catch mechanical failures — no amount of "remember not to" would have
helped, because nobody was remembering anything at the time.

Design choices worth keeping:

- **Copied into each repo, not imported from here.** A hook must work in a clone
  where nothing is installed, so `node_modules` is not available to it. The cost
  is real duplication; the alternative is a guard that does not run when it
  matters most, which is on a fresh clone.
- **Wired through `prepare`.** `core.hooksPath` is per-clone config and never
  committed. A committed hook with nobody pointing git at it is the standard way
  this fails silently, so `npm install` sets it.
- **Only newly added files are checked.** Re-flagging a file that was reviewed
  long ago trains people to pass `--no-verify` reflexively, which disables the
  guard for the one commit where it would have mattered.
- **Allowlist by directory, deny by extension.** `resources/`, `build/` and
  `assets/` are where the family legitimately keeps binaries. Everything else
  with pixels in it is refused. That is deliberately blunt: a guard that tries to
  judge whether a particular image is sensitive would be wrong occasionally and
  trusted completely.

**For any future app in the suite:** install the hook when you create the repo,
not after. And treat a screenshot harness as producing output that belongs in
`.gitignore` by default — its whole job is to capture whatever was on screen.

## 2026-08-23 — What Keel is, and the shape it has to have

### A separate repo linked with `file:`, not a monorepo
- **Decision:** its own repo at `D:\Repo\Tools\keel`, consumed as
  `npm install --save-dev file:../keel`.
- **Alternative rejected — an npm workspace monorepo.** The suite is seven
  independent repos with seven independent release pipelines and seven GitHub
  release histories. Folding them into one tree is a far larger change than the
  duplication it would remove, and it was never the problem being solved.
- **Alternative rejected — publishing to npm.** Adds a release ceremony to every
  change in a package whose only consumers are on the same disk.

### Plain ESM with JSDoc, and no build step
- **Decision:** ship source. No TypeScript compile, no `dist/`.
- **Why:** the consumers are split — Helm and Tend are JavaScript with
  `jsconfig.json`, the rest are TypeScript. JS annotated with JSDoc typechecks in
  both, so one form serves everyone.
- **And specifically to avoid the `dist-core` tax.** Jot already exports
  `@jot/core` to Helm through a built `dist-core` directory, which has to be
  rebuilt by hand after every change. That is tolerable with one consumer and
  tiresome with five.

### Framework-agnostic core, React kept at arm's length
- **Decision:** everything in the core works for all seven apps. Anything
  React-only goes behind its own entry point.
- **Why:** five apps are React (Jot, Nib, Loom, Nudge, PomPom) and two are plain
  DOM (Helm, Tend). A shared React header component would serve five of seven and
  quietly leave the other two out — which is how the duplication started.
- The icon pipeline, storage, release script and CSS are all framework-agnostic
  by nature. The header markup is not, so it will be a thin per-app concern with
  shared CSS underneath.

### The icon module first
- **Decision:** `keel/icon` before anything else.
- **Why, in order:** it is the most duplicated (four copies, byte-identical in
  three); it is pure Node with no framework question to settle; and it runs at
  build time, so a bug in it cannot crash a running app. That makes it the
  cheapest place to find out whether the whole idea works.

### The encoder stays byte-compatible on purpose
- **Decision:** the PNG writer produces exactly what the apps' own copies did —
  no row filtering, deflate level 9, IHDR/IDAT/IEND.
- **Why:** it makes migration verifiable instead of a matter of taste. Regenerate,
  and `git status resources/` should print nothing. Jot was migrated this way and
  the diff was empty; anything else would have meant the geometry moved too.
- A nicer encoder (row filters, smaller files) would have been a real
  improvement and is deliberately not taken, because it would have made every
  migration an eyeball exercise across eight sizes.

### `resample` weights colour by alpha
- **Decision:** when building an icon from raster artwork, average colour
  weighted by alpha rather than straight.
- **Why:** the transparent background's RGB is usually black. Averaging it in
  leaves a dark halo around the mark's edge — visible on Helm's wheel, which is
  the one app whose icon comes from artwork rather than geometry.

### What is deliberately not in here yet
Window chrome, the storage adapter and the release script are all planned and all
have five-way duplication behind them. They are not here because the icon module
had to prove the packaging approach first, and because the API will change once a
brand-new app (Brief) is the third consumer — migrating five apps against a v1
API and then changing it means doing the work twice.
