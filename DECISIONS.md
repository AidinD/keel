# Keel — decisions

Newest first. Each entry records the decision, what else was considered, and why.

## 2026-09-03 - A precondition hook that is not locked is decoration, and a lock that is not owned is worse

`writeFileAtomicSync` grew an `onBeforeRename` hook so a store could re-check a precondition immediately before the swap - the lost-update guard three consumers needed.
Both of the things around that hook were wrong, in opposite directions, and fixing them wrongly introduced two more.
The whole sequence is here because every wrong version passed its own tests.

**The hook ran outside any lock.**
A check followed by a rename is two steps, and another writer can pass its own check while your rename is in flight and then rename over you.
The hook narrowed the window from seconds to one hash read, which reads like a fix and is not one.
Measured by removing only the lock and re-running a consumer's concurrency test: 7 of 720 contended writes silently lost, and an independent reviewer measured 4, 0 and 3 of 240 in three runs of their own - against 0 of 1440 with the lock, six competing processes, content hash present in every run.
Note their middle run. Loss needs two writers inside the same few microseconds, so a single clean run is not evidence the lock is unnecessary, and the consumer's test now aggregates over rounds for that reason.

**A refused hook was retried.**
The loop treated a refusal like a transient lock and `continue`d, with nothing re-read.
But `contents` and whatever the hook compares against are both fixed by the caller before the first attempt, so all four attempts checked the same stale expectation against the same stale bytes and failed identically - four temp files written and deleted to reach a verdict already reached on the first.
Worse, it buried the one signal the caller needed: "your data is stale, read it again".
A refusal now returns immediately with `aborted: true`, and the retry that can succeed - re-read, re-apply, re-write - belongs to the caller, which is the only layer holding the mutation.
This loop had silently absorbed one such caller's retry when the atomic write was centralised here on 2026-07-27: retrying a write is not retrying a read, and only the second can resolve a concurrent edit.

**Then the lock broke live holders, which is worse than having no lock.**
The first version took over any lock older than five seconds, on the theory that a hold is only a hash read and a rename so anything older is a corpse.
Age cannot tell a corpse from a holder stalled by paging, a long GC, an antivirus scan of the very file it is hashing, a debugger, or a suspended machine.
Review reproduced the consequence end to end: two writers holding one lock, both told `ok: true`, one write gone - with the content hash passing on both sides, because a hash check cannot see a writer that also passed it.
And it cascaded, which the "documented trade-off" had not accounted for: the stalled holder's release deleted the *new* holder's directory, so a third writer walked in mid-rename, and one stall de-serialised the queue indefinitely rather than once.

So liveness decides now, not age.
The holder writes `{pid, nonce}` into the lock directory; a lock is abandoned only when that process no longer exists (`process.kill(pid, 0)`), and `releaseLock` removes the directory only while the nonce inside it is still ours.
Age survives for the one case it can answer: a lock directory with no readable claim, left by something that died between the `mkdir` and its claim.
Pid reuse could in principle make a corpse look alive; the cost is a waiter that waits out its deadline and refuses, never a broken lock.
That asymmetry is the design rule - every remaining ambiguity resolves towards refusing a write rather than towards taking a lock we may not have.

**Classifying `mkdir` failures by errno was wrong in both directions.**
Windows reports contention and an unwritable temp directory with the same codes, so no single look distinguishes them.
Reading `EACCES`/`EPERM` as contention made a stray *file* at the predictable lock path spin for the whole wait and then fail the write - permanently, on every write, with a message claiming another writer held it when nothing did.
Reading them as structural was worse: two separate versions of that fix ran the write with **no lock at all** under ordinary contention, first when a holder released between our `mkdir` and our `stat` (`EEXIST`, path already gone), then in the Windows pending-delete case (`EPERM`, same shape).
Both were caught immediately, and only because the consumer's concurrency test had just been taught to fail on a worker's stderr - `keel/storage` writes a warning exactly when it degrades, and nothing had ever looked at it.

What decides it now is what is *at* the path, plus time: a directory is contention; something that is not a directory is structural; nothing at the path is believed to be a release in flight for 250ms and structural after that.
The grace window is the only property that actually separates them - a pending delete clears in milliseconds, an unwritable directory never does - and it bounds the cost of the ambiguity to a quarter second per write in an already-broken configuration.

**The wait came down from 10s to 2s, and the temp moved inside the lock.**
These writers are synchronous and are called straight from Electron IPC handlers, so the lock wait is a window in which the whole app is frozen.
Review measured a successful write blocking for 22.6 seconds, against a `sleepSync` comment that justified the blocking design with "the total is bounded to a few hundred milliseconds".
A dead holder's lock is now taken over at once, so reaching the deadline means a *live* writer is wedged, and the honest answer to that is a refused write rather than a longer freeze.
Writing the temp file inside the lock rather than before it fixed a second-order problem review found: these data directories are Dropbox-synced, and a temp that used to exist for microseconds was sitting there for the entire lock wait (measured 3000ms of a 3000ms wait), which is how the sync client takes a handle on it and produces the `EPERM`-on-rename this module retries for.
It also, unexpectedly, cut the collision rate for every caller by serialising the whole write - which made an earlier measured refusal-rate regression in another consumer unreproducible.

**What was considered and rejected.**
Locking every write, not just guarded ones: `fleetState.json` is rewritten every ~5s with no precondition to protect, so a mutex round trip per write buys nothing, and last-writer-wins is the accepted deal for those stores.
Putting the lock beside the file it protects: inside a synced folder it would arrive on another machine as a phantom lock on a file nobody is writing, so it lives in the system temp directory and is therefore explicitly per-machine.
Refusing the write when no lock can be taken at all: the lock is a narrowing of an already-narrow window, so losing it must not cost the user their write - it warns once and falls back to the content guard.
Keeping the age rule and documenting the live-holder trade: rejected once review showed it cascades rather than costing one write.
Refreshing the lock's mtime during a long hold, as an alternative to the liveness check: it keeps age as the mechanism and only moves the threshold, so a holder that stalls *without* running code still loses its lock.

**What the lock does not cover, stated because it will be assumed otherwise.**
It binds only writers that take it.
Jot's own app writes the same board and does not, so an app write landing inside the same two-step window can still be overwritten; closing that needs the other app to cooperate.
Nothing across machines is enforceable either - Dropbox can replace a file wholesale, and the content guard refusing is the most that is available.

**The lock's name and the claim inside it are a cross-process contract.**
Two writers only exclude each other if they compute the same path and agree on the ownership protocol, so `lockPathFor` is path-derived and lowercased rather than random.
One standalone script outside the suite reimplements both, because it has to run from any directory with no package resolution; its own test asserts the literal name and drives this module directly, in both directions, so a rename or a protocol change on either side fails there rather than silently leaving each side holding a private lock.

## 2026-08-31 - What a one-shot model call was actually paying for

A consumer measured its own model buttons and found a single cheap-tier call with a one-sentence question and a two-field answer costing 8.8 cents, and a writing-tier call with the same size of question costing 32.9 cents.
Shortening the requested answer from four paragraphs to three sentences moved the second one by 0.3 cents, which ruled out the answer and pointed at everything sent before it.
A price like that is not an accounting detail: these apps print the cost under the answer, and a button that says 33 cents is a button nobody presses.

**What the money was.** Four things, none of them the question.

`--allowed-tools ''` does not stop the tool definitions being sent.
It is a permission filter over tools that remain defined, so every built-in tool's schema went up with every turn - measured at roughly 24,000 tokens per turn, 48,000 over the three turns a structured call takes.
`--tools ''` is the flag that removes them, and swapping one for the other took the measured cheap-tier call from 5.7 cents to 0.5 and the writing-tier one from 26 cents to 2.3.
This module had claimed since it was written that the call carried no tools. It carried all of them.

A call that passes no system prompt does not get a small one.
It gets the whole agent preamble, around 23,000 tokens a turn, describing an agent with tools, files and a next turn - none of which a one-shot extraction has.
It is also worse: on the same test question the preamble produced a false positive that the same model with a two-line system prompt did not.
So a near-empty default is always sent now, and `system` replaces it rather than filling a hole.

The machine's own settings priced the call too.
An `effortLevel` in a user settings file applies to a spawned call like any other, so the same question cost whatever the person at that desk last chose for their interactive sessions: 5.6 cents against 2.3 on the measured writing-tier call.
`--setting-sources ''` cuts it out and makes the price the same on every machine.

And the CLI waits three seconds for piped input before concluding there is none, which an open, never-written stdin pipe pays on every single call.

**What was rejected.** `--bare`, again and for the same reason as before: it forces API-key authentication, and the point of this module is that there is no second credential.
Dropping `--json-schema` and asking for JSON in the prompt: it is genuinely cheaper, one turn instead of two, 0.29 cents against 0.53, because a structured answer is a tool call whose result gets fed back for a second turn.
It was rejected anyway - the validation is the contract, and a parse of fenced JSON that usually works is the kind of thing that fails on the entry somebody actually wrote.
Reusing a session across calls, to amortise the fixed context: there is nothing left to amortise once the tools are gone, and it would trade a stateless call for a stateful one.

**The trade in `--setting-sources ''`.** An `apiKeyHelper` in a settings file is no longer read.
These calls are the subscription's by design, so that is the intended direction, but a consumer that ever needs API-key authentication will find this flag in its way rather than a missing key.

**What it costs now.** End to end through `ask`, the same two calls: 0.6 cents and 2.6 cents, against 8.8 and 32.9.
What remains on the writing tier is the model thinking, which is the part that is doing the work; `effort` is the caller's lever on it.

**Where the numbers came from.** Every figure above is a real call, read out of the CLI's own `usage` and `total_cost_usd`, one variable changed at a time, with the parent process's `CLAUDE_*` environment removed so a session's own settings could not leak into the measurement.
That last point is worth keeping: `ask` passes the parent environment through, so an app launched from inside a Claude Code session inherits that session's effort setting.

## 2026-08-24 — Nudge and PomPom, and what the survey missed

The package was declared complete with six consumers. Nudge and PomPom were in
the header line of this README the whole time and in none of the counts.

**What they were carrying.** Their own icon generators (227 and 302 lines, the
same PNG and ICO writers), no `.gitattributes`, and a release script with **no
guards at all** — byte-identical to each other, and the same version Nib had
before it published a release that did nothing and printed "Published". So both
could have lost a release the same way, and neither had a check that the tree
matched a commit.

**The measurement was of the apps in front of me, and it read as a total.** Every
count in the Why section above — four repos, five times, seven repos — came from
grepping the apps that happened to be checked out and open. That is a floor, and
writing it down as a number made it look like a ceiling. The fix is not a better
grep; it is saying so, which the README now does.

**Signed versus unsigned, and why the empty diff still held.** These two draw with
SIGNED distances — negative inside — and union shapes with a plain `Math.min`,
where keel's primitives are unsigned and `coverage` subtracts the half-weight
itself. The two are algebraically the same, which is not the same as bitwise. So
the migration keeps the arithmetic in the original order — `distRing(...) - half`,
exactly what the local `sdRing` did — and calls `coverage(signed, 0)`. Both icons
came out byte-identical, which is the only evidence that reasoning was right.

**PomPom keeps its shapes.** An ellipse, and a polygon that knows inside from
outside. keel has neither, and its `distPolygon` is unsigned — a filled body
cannot use it. Moving them would have meant either a second polygon function in
keel or a flag on the first, for one consumer. It also had a dead `sdCone` left
over from a rejected version of the leaves, which the migration removed.

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

## 2026-08-24 - `keel/secret`: a read, not a vault

### Built with no consumer, and the reason is not speculation
- **Decision:** ship `keel/secret` while nothing in the suite reads a credential.
A survey of all ten repos found zero reads of an environment variable holding a key, token or password.
- **Why anyway:** the pattern existed once, in the app that had an LLM vendor, and was verified against real failures.
It was deleted with the vendor, and nothing recorded it.
The next app to need a key would have written it from memory and missed the same three things - which is the exact failure mode this package exists to stop, and the reason the icon generator had four copies.
- **What that reasoning does *not* license:** the write path.
See below.

### Read-only, guaranteed by a test rather than by intent
- **Decision:** no write API in the module, and a test that reads the module's own source and fails if one appears.
- **Why:** a credential must never end up anywhere the person did not put it themselves.
That is a promise about every future edit, not about today's code, so it needs an enforcement that survives someone adding a convenient `save()`.
- A second, narrower test asserts the module imports only `readFileSync`, `homedir` and `join` from Node.
The guarantee is easier to keep if the module never holds a tool that could break it.

### A plain file outside the synced folder, not the OS credential store
- **Decision:** `%APPDATA%\keel\secrets.json`, per machine, overridable with `KEEL_SECRETS_FILE`.
- **Alternative rejected - Electron's `safeStorage` / a keychain binding.** On Windows these encrypt with the account on *that* machine, so the blob cannot be read on the second one.
The suite deliberately runs two machines against one synced board, so this produces something that looks portable and silently is not.
- **And the encryption buys less than it appears to.** An app that starts unattended must be able to decrypt on its own, so anything running as that user can decrypt too.
Encryption at rest protects against an accidental *file read* - a stray script, a backup, a synced folder - and against nothing else.
A path outside every synced folder and every repository covers that case at a fraction of the moving parts.
- **Alternative rejected - a hosted secrets manager (Bitwarden).** Its password-manager CLI is free but needs the master password to unlock and returns a session that dies with the terminal, which is exactly wrong for an app that starts with Windows.
Secrets Manager machine-account tokens fix that, and the token is then itself a plaintext credential on disk: N secrets become one, bought with a network call at every app start plus a cache for when it fails.
- **What was taken from it instead:** the password manager stays the source of truth a person edits, and this file is the local copy pasted in once per machine.
That keeps rotation and "where did I put it" without making app startup depend on the network.
- `%APPDATA%` is normally a trap for this suite, because a sandboxed process's writes there are redirected into a private overlay while its reads fall through to the real filesystem.
A module that only reads is immune to that by construction.

### The caller has to name itself
- **Decision:** `openSecrets({ app })` is required and throws when omitted; an entry may list the apps allowed to read it.
- **Why:** taken from Automic Vault, which gates on *what is being done* rather than only on who asks - it passes `gh issue list` and stops `gh auth token`.
That tool is macOS-only, but the weakest useful version of its idea is five lines, and it is the one design choice here that is hard to add later.
The same key handed to everything is a key whose misuse is invisible.
- **A malformed permission list is a malformed entry.** `"apps": "brief"` is refused rather than read as "no list", because a typo must never fail in the permissive direction.
- `names()` reports what is configured without returning values, so a settings window can show state without becoming a way around the check.

### Rotating tokens are deliberately not served
- **Decision:** the module handles credentials a person places and that never rotate.
An OAuth refresh token - obtained by the app, replaced by the provider during use - must be written, and is left out.
- **Why not both:** two kinds of secret with two threat models, and pretending they are one makes the module worse.
`safeStorage` *is* the right answer for the rotating kind, and its machine-bound encryption is harmless there because re-authenticating on the second machine is a one-time click.
- **Why not now:** the only candidate consumer is a calendar integration that may well be built a way that needs no credential at all.
The shape of a cache for a token nobody holds is a guess.

## 2026-08-24 - The permission check is a discipline aid, and using it outside the suite

### The app name is self-declared, and that is a documented limit rather than a gap
- **Decision:** keep the per-app check, and state plainly in the module, the README and here that it is not a security boundary.
- **Why it matters to write down:** the check reads like access control, so the next reader will assume it is.
Anything that can open the file can also pass `app: 'brief'` and take whatever Brief may have.
- **What it does buy, and it is not nothing:** a wrong reader becomes a visible refusal instead of silence, and the call site documents which secret an app is entitled to.
Both are worth having in a suite maintained by one author.
- **What real enforcement would take:** the operating system telling the module which binary is asking.
That is exactly what Automic Vault does with verified launchers, and it is macOS-only with no cheap Windows equivalent.
- **The rule that follows:** never put a secret in this file that some process on this machine must not have.
Everything in it is readable by anything running as this user, and an `apps` list does not change that.

### Using `keel/secret` from an app outside the family
- **Distribution is the easy half.** Keel is consumed as `file:../keel`, so an outside app needs keel published to npm or the four files vendored.
The file format is not secret and publishing it costs nothing.
- **The permission check is the hard half**, for the reason above: an outside app's entry in `apps` means only that it was polite enough to name itself honestly.
- **So the split is by what the secret is worth, not by which app wants it.** A shared file is right for credentials whose blast radius is this machine anyway.
A secret that must be withheld from some process on this machine needs a mechanism this file cannot provide.

### Migrating the credentials that exist today: mostly not possible, and that is the finding
- **Surveyed 2026-08-24.** Five real credentials exist on this machine, and the consumer of every one of them is either the agent harness or a third-party tool, not an app in this suite.
Three sit in the harness's own MCP configuration, one is a Cloudflare token in a repo `.env` read by a CLI, and one is a GitHub token already held in the Windows credential store by `gh`.
- **Only one is even a candidate:** a local stdio MCP server whose key arrives as an environment variable, which a launcher shim could read from here instead.
The other two MCP credentials travel as an HTTP `Authorization` header on a remote transport, so there is no process to wrap.
- **Decision: do not migrate any of them yet.** Copying a secret into a second file means two places to rotate and one that gets forgotten, and it buys nothing while nothing reads this module.
- **The trigger to revisit is the first app in this suite that needs a key**, at which point the module already exists - which was the whole reason for building it early.
