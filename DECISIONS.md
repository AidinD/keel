# Keel — decisions

Newest first. Each entry records the decision, what else was considered, and why.

## 2026-08-23 — A commit guard, because a convention had already failed

Seven screenshots of Helm's own dashboard were committed to a public repo and sat
there for five weeks. They showed the real session sidebar: a group labelled with
the employer's name, and entries naming actual prospects and a client pitch. The
fix cost a history rewrite of 734 commits, a force-push of 84 tags, and the repo
going private — and it was forked before any of that, so the content is still in
someone else's copy.

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
