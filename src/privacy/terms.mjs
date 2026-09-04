/**
 * The words that must never reach a public repository, worked out rather than
 * listed.
 *
 * ## Why there is no list in the repo
 *
 * The obvious implementation is a deny-list file next to the hook. It cannot be:
 * a file naming every colleague, committed to the repository it is protecting,
 * IS the leak. Any list has to live outside the tree, and a list outside the
 * tree is a list that drifts out of date the first time somebody joins.
 *
 * So the terms are derived from the private data these apps already hold. The
 * names that must not appear are exactly the ones in Tend's roster and Nib's
 * folders, and those directories are already outside every repository - that is
 * the whole reason `TEND_DATA_DIR` and `NIB_DATA_DIR` exist. Nothing to
 * maintain, nothing secret committed, and a person added tonight is protected
 * before they can be leaked.
 *
 * ## Why a rule was not enough
 *
 * There was one, in a project document and in an agent's memory, and it was
 * broken fifteen times in a single evening while writing test fixtures at speed.
 * A rule that depends on somebody remembering is a reminder, not a control. This
 * runs on every push whether anybody remembers or not.
 *
 * ## What it deliberately does not do
 *
 * Judge. It reports what it found and where; deciding whether "Meta" in a
 * sentence about metadata is a leak is not something a substring match can do,
 * and a guard that cries wolf gets bypassed with `--no-verify` within a week.
 * Hence the length floor and the word boundaries.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shorter than this and a name is a substring of ordinary prose.
 *
 * Four is the smallest that is not "Bo", "Ida" or "Ali" matching every third
 * line. A short first name is the one case this cannot cover, and saying so is
 * better than a guard nobody trusts.
 */
export const MIN_TERM = 4;

/**
 * Words that are never a leak however they appear, because they are the app's
 * own vocabulary.
 */
const ALLOWED = new Set([
  "team",
  "work",
  "books",
  "notes",
  "private",
  "documents",
  "projects",
  "people",
  "personal",
  // Turned up by the first full scan as terms, and every one of them was a
  // folder named after something public - a book, a shelf, a template set.
  "path",
  "manager",
  "friends",
  "influence",
  "templates",
  // A project named after an HTML tag. `<meta charset>`, `const meta of`, a
  // "meta row" in prose - the word is unavoidable in any web codebase, and
  // thirty false positives per repository would get this whole guard ignored.
  // Stated rather than silently dropped: THIS ONE NAME IS NOT PROTECTED HERE.
  // Care is the only control for it, which is exactly why it is written down.
  "meta",
  // A notes folder named after its subject, in an app whose subject is
  // conversations. It appeared ninety-three times in already-published source
  // before it was ever flagged - the guard only reads changed lines, so it went
  // unnoticed until one of those lines was edited, and then it blocked a push
  // over ordinary prose that was already public.
  //
  // Same reasoning as `meta`, and the same admission: THIS WORD IS NOT PROTECTED
  // HERE. A guard that fires on a word this common gets pushed past with
  // --no-verify as a habit, and then it protects nothing at all - which is a
  // worse outcome than one unprotected folder name.
  "conversation",
  "conversations",
  // A notes folder named Decisions, in a suite where every substantial project
  // keeps a DECISIONS.md and the word appears in prose, in field names and in
  // commit messages constantly. It blocked a push over a JSON schema whose
  // property is, correctly, `decisions`.
  //
  // Same admission as the two above: THIS WORD IS NOT PROTECTED HERE. Renaming
  // the field to dodge the guard would have made the code worse to read, which is
  // the trade that turns a guard into something people route around.
  "decision",
  "decisions",
  // A notes folder named Ownership, in a suite whose whole subject is which tier owns a
  // piece of work. "a mate continues its own crew", "ownership applies the same way",
  // "rather than on ownership" - three hits in one push, all of them ordinary English about
  // exactly the thing the code does, and the same word was already logged as a false
  // positive across all 29 hits of a full audit pass.
  //
  // Same admission as the three above: THIS WORD IS NOT PROTECTED HERE. The alternative was
  // rewording prose to dodge the guard, and a guard people write around is one that stops
  // being read.
  "ownership"
]);

/**
 * A user environment variable, read from where Windows keeps it.
 *
 * Same reason the apps themselves do this: `process.env` only carries what was
 * inherited, and a hook runs from whatever shell git happened to use.
 *
 * @param {string} name
 * @returns {string | null}
 */
function stored(name) {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const match = /\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+)/.exec(out);
    const value = match?.[1]?.trim() ?? "";
    return value === "" ? null : value.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? "");
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function dataDir(name, fallback) {
  return process.env[name]?.trim() || stored(name) || fallback;
}

/**
 * Every name Tend knows: people and projects, in every mode it has a store for.
 *
 * Reduced from the event log by hand rather than by importing Tend, so this stays
 * usable from a hook in any repository without depending on one app's source.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function tendNames(dir) {
  const events = join(dir, "events");
  if (!existsSync(events)) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  for (const file of readdirSync(events)) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    let text = "";
    try {
      text = readFileSync(join(events, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      // Only the two collections that carry a human or a product name. A note
      // or a promise is prose and would flood this with ordinary words.
      if (!/"(people|projects)\.(create|update)"/.test(line)) {
        continue;
      }
      try {
        const name = JSON.parse(line)?.p?.name;
        if (typeof name === "string") {
          found.push(name);
        }
      } catch {
        // A half-written line during a sync. Skipped, like every other reader.
      }
    }
  }
  return found;
}

/**
 * The name-shaped sub-folders in Nib.
 *
 * Sub-folders only, and only single words. A notebook's categories are `Books`,
 * `Projects`, `Documents` - vocabulary, not people - and its sub-folders are a
 * mix: one person per folder in some, one book per folder in others. A book
 * title is not private, and treating it as private is actively harmful: the
 * first version of this read every folder name and split it into words, so
 * "Manager's Path" contributed `Path`, which appears in almost every source file
 * ever written. The scan came back with 284 hits in one repository and nothing
 * in it was a leak.
 *
 * A guard that cries wolf is bypassed within a week, so precision here matters
 * more than reach. The one thing this misses - a multi-word private name that
 * exists only in Nib - goes in `private-terms.txt`, which is what that file is
 * for.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function nibNames(dir) {
  const index = join(dir, "index.json");
  if (!existsSync(index)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(index, "utf8").replace(/^﻿/, ""));
    /** @type {string[]} */
    const found = [];
    for (const category of parsed.categories ?? []) {
      for (const sub of category.subs ?? []) {
        const name = String(sub.name ?? "").trim();
        if (name !== "" && !/[\s'".:,\-]/.test(name)) {
          found.push(name);
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * The subjects a handoff store has filed, one per file.
 *
 * ## The gap this closes
 *
 * Everything above finds a NAME - a person, a project, a product. On 2026-09-03
 * a public repository turned out to be carrying the opposite kind of private
 * thing: not who somebody is, but what their life is about. Illustrative
 * examples and test fixtures had been drawn from one person's actual subjects,
 * so a reader could read off their hobbies, their health habits and the fact
 * they were job-hunting. The guard reported the push clean, correctly - it knew
 * thirty names and not one subject.
 *
 * A handoff store keyed by TOPIC is exactly the missing roster: one markdown
 * file per durable life or work subject, already outside every repository, and
 * self-maintaining in the same way Tend's roster is - a subject filed tonight is
 * covered before it can be leaked.
 *
 * ## Kept WHOLE, never split into words
 *
 * This is the one source whose values must not go through the word split, and
 * the reason is the mistake this module already made once with Nib: a slug like
 * `model-trains` splits into `model`, which appears in ordinary prose
 * and in identifiers, and a guard that cries wolf is bypassed within a week. A
 * hyphenated slug is specific enough to mean something on its own; its
 * individual words are not.
 *
 * A single-word subject that IS ordinary vocabulary still gets through as a
 * term, and that is deliberate rather than overlooked: the pervasiveness check
 * downstream already treats a word that is everywhere in a repository as that
 * codebase's own vocabulary and says so, while the same word arriving in a
 * repository that has never used it is worth a second look. That is the correct
 * split of labour, and neither half is a substring match pretending to judge.
 *
 * @param {string} dir The meta home - the folder holding `.helm/`.
 * @returns {string[]}
 */
function handoffTopics(dir) {
  const handoffs = join(dir, ".helm", "handoffs");
  if (!existsSync(handoffs)) {
    return [];
  }
  try {
    return readdirSync(handoffs)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3).trim())
      .filter((slug) => slug !== "");
  } catch {
    return [];
  }
}

/**
 * Where the meta home is, for the one purpose of finding that store.
 *
 * `~/.claude/CLAUDE.md` is a stub that imports the real rules file from wherever
 * it is synced to; the folder holding that file is the meta home.
 *
 * This is deliberately a SECOND implementation of a rule that already lives in
 * one of the apps, which is normally the thing to avoid. Importing it would make
 * this hook depend on one application being installed, and it runs in nine
 * repositories where eight of them do not have it - a hook that throws is a hook
 * somebody disables, and then nothing at all is protected. The cost of the two
 * drifting apart is bounded and visible: this source reports no topics, and the
 * printed source list is one line shorter.
 *
 * @returns {string}
 */
function metaHome() {
  const home = homedir();
  const override = dataDir("HELM_META_HOME", "");
  if (override !== "") {
    return override;
  }
  try {
    const stub = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    const imported = stub.match(/^@(.+?CLAUDE\.md)\s*$/m);
    if (imported) {
      const dir = join(imported[1].trim(), "..");
      if (existsSync(dir)) {
        return dir;
      }
    }
  } catch {
    // No stub, or unreadable. The home directory is the honest fallback.
  }
  return home;
}

/**
 * Terms no data source knows, read from beside the private data.
 *
 * An employer's name is not in anybody's roster, so it has to be written down
 * somewhere - and the one place it must not be written down is a file in the
 * repository it is protecting. That is the same mistake the derived terms exist
 * to avoid, one level up, and the guard caught it in its own source on the first
 * push.
 *
 * One term per line, `#` for a comment, missing file means no extra terms.
 *
 * This is also where a name goes when it must be protected FOREVER rather than
 * while it happens to be in the data. Derivation is self-maintaining in one
 * direction only: a person added tonight is covered before they can be leaked,
 * and a person whose folder is deleted stops being covered even though the
 * person is still real and their name still must not appear. Five names went
 * that way on the first day this existed, unnoticed until a term count dropped.
 *
 * @param {string} dir The Tend data directory.
 * @returns {string[]}
 */
function extraTerms(dir) {
  const file = join(dir, "private-terms.txt");
  if (!existsSync(file)) {
    return [];
  }
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * The terms to look for, and where they were learned from.
 *
 * Split into words as well as kept whole: a roster holds "Nadia Ohlsson" and a
 * comment leaks "Nadia".
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extra] Terms from a caller. Prefer the file beside the
 *   data - anything passed here has to be written down in a repository.
 * @returns {{ terms: string[], sources: string[] }}
 */
export function privateTerms({ extra = [] } = {}) {
  const home = homedir();
  const tend = dataDir("TEND_DATA_DIR", join(home, "AppData", "Roaming", "tend"));
  const nib = dataDir("NIB_DATA_DIR", join(home, "AppData", "Roaming", "nib"));

  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const raw = [];
  // Values that must NOT be split into words - see handoffTopics.
  /** @type {string[]} */
  const whole = [];

  for (const dir of [tend, `${tend.replace(/[\\/]+$/, "")}-private`]) {
    const names = tendNames(dir);
    if (names.length > 0) {
      sources.push(`${dir} (${names.length} names)`);
      raw.push(...names);
    }
  }

  const folders = nibNames(nib);
  if (folders.length > 0) {
    sources.push(`${nib} (${folders.length} folders)`);
    raw.push(...folders);
  }

  const meta = metaHome();
  const topics = handoffTopics(meta);
  if (topics.length > 0) {
    sources.push(`${join(meta, ".helm", "handoffs")} (${topics.length} topics)`);
    whole.push(...topics);
  }

  const alsoTheirs = extraTerms(tend);
  if (alsoTheirs.length > 0) {
    sources.push(`${join(tend, "private-terms.txt")} (${alsoTheirs.length} terms)`);
    raw.push(...alsoTheirs);
  }

  raw.push(...extra);

  const terms = new Set();
  for (const value of raw) {
    for (const word of String(value).split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= MIN_TERM && !ALLOWED.has(word.toLowerCase())) {
        terms.add(word);
      }
    }
  }

  for (const value of whole) {
    const term = String(value).trim();
    if (term.length >= MIN_TERM && !ALLOWED.has(term.toLowerCase())) {
      terms.add(term);
    }
  }

  return { terms: [...terms].sort((a, b) => b.length - a.length), sources };
}

/**
 * Where a term appears in some text.
 *
 * A boundary here is not the regex kind. In code a dot, a hyphen and an
 * underscore sit INSIDE a name rather than ending one: `import.meta`,
 * `.row-meta` and `row_meta` are each a single identifier, and treating that
 * punctuation as a word break made a project named after a common word match
 * every source file in the suite - forty-four hits in one repository, none of
 * them a leak.
 *
 * The cost is a leak written as `project-meta` going unseen, and it is worth
 * paying. The names that matter most are people, and a person's name does not
 * turn up inside an identifier by accident.
 *
 * ## The full stop had to stop counting (2026-09-01)
 *
 * Treating `.` and `-` as part of a word cost far more than that paragraph
 * knew. A dot ends a sentence at least as often as it joins an identifier, so
 * `pairing with Karlsson.` matched NOTHING while `pairing with Karlsson said`
 * matched - and a name at the end of a sentence is the single most common way a
 * person appears in prose and in a commit message. The guard was blind to the
 * ordinary case and sharp on the rare one.
 *
 * Found while extending this check to read commit messages, where a public
 * repository turned out to carry a private first name in two of them.
 *
 * So the punctuation only joins when something joins to it: a dot or a hyphen
 * followed by another letter or digit is still an identifier (`karlsson.js`,
 * `row-meta`), and one followed by a space or a line end is punctuation. Same
 * on the left, so `some-karlsson` stays a single identifier while `- Karlsson`
 * in a list does not.
 *
 * ## A MULTI-WORD term skips the punctuation rule (2026-09-03)
 *
 * Everything above is an argument about a single short word: `Meta` must not
 * match `import.meta`, because a name that happens to be an ordinary word turns
 * up inside identifiers constantly. That argument does not transfer to a term
 * that already contains a hyphen or a space. Such a term IS identifier-shaped
 * and does not appear by accident.
 *
 * Applying the single-word rule to those cost a real leak. A private subject
 * filed as a hyphenated slug was in the term list, and the line that leaked it
 * wrote that slug followed by `.md` - where the dot-then-letter is exactly the
 * identifier-joining case the rule refuses to break on. The term was known, the
 * line was in the diff, and the guard reported the push clean.
 *
 * So a term containing a hyphen or a space keeps only the alphanumeric
 * boundaries, and a variant of it (`<slug>-log`) matches too, which is what a
 * reader wants - a variant of a private subject is the same private subject. A
 * single word still gets the full rule, unchanged.
 *
 * Case-insensitive, because a fixture id is lowercase and leaks just as well.
 *
 * @param {string} text
 * @param {string[]} terms
 * @returns {{ term: string, line: number, text: string }[]}
 */
export function findTerms(text, terms) {
  /** @type {{ term: string, line: number, text: string }[]} */
  const hits = [];
  const lines = text.split("\n");
  for (const term of terms) {
    // A term that is already several words cannot land inside an identifier by
    // accident, so it does not need - and must not have - the rule that keeps a
    // single common word from matching `import.meta`. See the note above.
    const multiWord = /[-\s]/.test(term);
    const before = multiWord ? "(?<![\\p{L}\\p{N}_])" : "(?<![\\p{L}\\p{N}_])(?<![\\p{L}\\p{N}][.-])";
    const after = multiWord ? "(?![\\p{L}\\p{N}_])" : "(?![\\p{L}\\p{N}_])(?![.-][\\p{L}\\p{N}])";
    const pattern = new RegExp(`${before}${escape(term)}${after}`, "iu");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push({ term, line: index + 1, text: line.trim().slice(0, 120) });
      }
    });
  }
  return hits;
}

/** @param {string} value */
function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
