# Keel — decisions

Newest first. Each entry records the decision, what else was considered, and why.

## 2026-08-24 — `keel/storage`: the primitives, and no store

The fifth module, and the last of the planned set. It is the one where the API
question was supposed to be hard, and the survey answered it in the other
direction.

**There is no store abstraction, because there is no shared store.** The five
layers are different shapes and each shape is right for its app: Jot is one JSON
document, Nib a file per note (which is what makes embedded images survivable and
what stops two machines colliding), Tend an append-only event log with rollover
and multiple writers, Brief a disposable JSON beside an append-only JSONL, Helm a
set of small durable stores. An interface over those would need a flag per
difference and would end up worse than the five copies. What they genuinely share
is *file mechanics on Windows in a Dropbox folder*, which is a much smaller and
much more duplicated thing.

**The duplication was measured, not assumed.** `stripBom` appears identically in
five files across Tend and Brief alone; the atomic write is in four repos; the
data-dir resolution is the same eight lines in Jot and Nib with different names.

**Three levels of correctness, and the best one was not the newest.** Helm's
`writeFileAtomicSync` retries the rename, retries the temp cleanup, reports
failures in plain language and never throws. Jot's and Nib's `writeFileAtomic`
retries only the rename, cleans up with a single silent unlink, and throws. Helm's
is ahead because Helm broke more: the silent unlink loses a race with the sync
client, which is how its dispatch directory reached 1462 orphaned `.tmp` files.
Jot's live data directory still holds one orphan. So the shared version is Helm's
lessons applied to both call styles.

**Both call styles are kept, deliberately.** The sync form returns
`{ ok, error }` because its callers run straight from IPC handlers and have a real
"the write did not happen" path — throwing is how those failures got lost in the
first place. The async form throws, which is the signature Jot and Nib already
call. Choosing one winner would have turned a swap into a rewrite in three apps,
and the shape of the return value is a property of the caller, not of the write.

**Its own test found a hole in the code it inherited.** `plainReason` had no case
for `ENOTDIR`, so a file sitting where a folder has to be produced the raw errno
in a user-facing toast — the exact failure the function exists to prevent. Helm's
copy has had that hole all along.

**Migration is not in here.** Jot and Nib each pair data-dir resolution with a
"move the old data across" step, and those differ — one file versus a whole
notebook. They also *copy* rather than move, which makes pointing the environment
variable at a scratch folder a way to duplicate real data somewhere unintended.
That happened on 2026-08-24 with Nib. A step with that much local knowledge and
that sharp an edge belongs next to the data it understands.

## 2026-08-24 — `keel/release`: share the guards, not the release

The fourth module. Four apps had a release script and none of them had the same
set of checks.

**The evidence, before deciding anything.** Tend's and Brief's scripts were the
same 125 lines apart from the app's name — including a byte-identical
`stop-running-build.mjs` beside each. Nib's was missing the dirty-tree check
entirely and, until 2026-08-24, the already-released check too; it found out by
publishing a release that did nothing and printed "Published". Loom's is a
different shape again, because it releases by pushing a tag and letting CI build.

**So the module shares the guards and deliberately does not share the release.**
There is no `release()` function. The two paths differ in the middle — build here
and publish, or tag and let CI build — and a single entry point covering both
would need a flag for every difference, which is how a shared thing becomes worse
than four copies. What is common is the *checking*, and checking is where all four
incidents live.

**`preflight` returns every failure, not the first.** Being told about a dirty
tree, fixing it, and only then learning the version is already released is two
round trips for one problem. The old scripts all exited on the first failure;
running the migrated Tend script against a real dirty tree reported both at once,
which is a small thing that will save a minute every time.

**An unknown check name throws.** `preflight(exec, { checks: ['cleanTre'] })` is
an error, not a no-op. A guard silently lost to a typo is precisely the failure
this module exists to prevent, and quietly skipping unknown names would reproduce
it inside the thing meant to fix it.

**`cleanTree` counts untracked files, which Loom's version did not.** Loom passed
`--untracked-files=no`. That is the forgiving reading and the wrong one: a file
the build reads but nobody committed is in the installer on this machine and
absent everywhere else, which is the hardest kind of difference to explain later.
The stricter default is the one that would have caught it.

**`exec` is injected, the way electron is in `keel/window`.** Nineteen tests run
without spawning git, gh or PowerShell — the fake is a map from `command arg arg`
to stdout, where an `Error` value means a non-zero exit. That is also what makes
the messages testable, and the messages are most of the value: each one names the
incident behind its check.

**`stopRunningBuild` matches on the executable's path, and the script is
exported so a test can read it.** Never by process name, which would also close
an installed copy, and never on a command-line flag: a filter on
`remote-debugging-port` once stopped 19 processes at once, because Chromium passes
its flags down to every child it spawns. `stopScript()` exists purely so a test
can assert the filter mentions `ExecutablePath.StartsWith` and mentions neither
`ProcessName` nor `CommandLine` — a dangerous helper whose narrowness is checked
rather than commented.

**Alternative rejected — one script in keel, invoked by each app.** A shared
executable would have to know each app's build command, its output directories,
whether it publishes or tags, and whether it runs tests first. Those are four
different scripts wearing one name. Sharing the parts leaves each app's script
readable as a description of how that app releases, which is what a person opening
it actually wants to know.

## 2026-08-24 — `keel/shell.css`: the layout, and nothing that is taste

The third module. `body` as a fixed flex column, the header pinned, one scrolling
region, the window buttons.

**It closes a live bug in two apps.** Brief shipped with a scrolling body and so
did Tend, where it was an open P0. In a frameless window that takes the header
off screen and the header is the drag handle and the only close button — the
window becomes unmovable and unclosable. Tend's `min-height: calc(100vh - 43px)`
was the tell: a hardcoded header height, kept in sync by hand, which a flex
column removes the need for entirely.

**The boundary is the interesting decision.** Layout mechanics and the window
buttons — no palette, no typography, no spacing, and not even the header's
hairline rule or its padding. A separator and a set of proportions are how an app
looks rather than how it works, and a shared stylesheet that reached into those
would be a theme pretending to be a utility. The first app it did not suit would
fork it, and then there would be seven again.

That boundary is enforced rather than stated: a test asserts the stylesheet
contains **no literal colour at all**. Every one comes from a token the consumer
defines.

**No fallbacks in the `var()` calls, on purpose.** A missing custom property is
not an error in CSS — it is a rule that quietly does less than it says. Nib
referenced `--accent-soft` from a rule and never defined it, and that background
painted nothing for weeks with no complaint from anywhere. So `SHELL_TOKENS`
lists what the sheet reads, `missingTokens()` reports what a consumer lacks, and
a test holds the list and the stylesheet in agreement in both directions —
listed-but-unused fails too, which is how `--line-soft` was caught being
documented and never written.

**Each app still arranges its own interior.** Tend has a rail and a main column;
Brief has one column. keel provides only the part that is identical, so Tend puts
`overflow-y` on its own `main` and the rail stays put while the list scrolls.
Trying to serve both interiors from here is how the shared thing becomes the
thing everyone works around.

**Verify it in the packaged build.** The unbundled apps reach it with a `<link>`
into `node_modules`, which has to resolve out of the asar. Both E2E harnesses now
assert `getComputedStyle(document.body).display === "flex"` before asserting
anything about scrolling — a stylesheet that failed to load is silent, and the
scroll assertions would then be testing the app's own CSS by accident.

**The exports-map test grew a case.** `./shell.css` is a bare path with no
declaration, which the old test treated as a missing `types` condition. It now
asserts a string export points at a file that exists, which still catches the
typo that would otherwise only show up as an unstyled window.

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

*Written 2026-08-23. All three landed within two days: window chrome the same
day, the shell stylesheet, the release module and the storage primitives on
2026-08-24. The prediction that storage would be the hard API question was right
about the difficulty and wrong about the answer — the survey said not to build a
store at all. See that entry.*
