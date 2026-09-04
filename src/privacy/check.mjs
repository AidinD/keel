/**
 * Refuse a push that would put a private name into a public repository.
 *
 * Runs as a pre-push hook, which is the last moment anything is still local. A
 * pre-commit hook would be earlier and worse: a commit is fixable with an amend,
 * a push to a public repository is not - it is in somebody's clone, in a fork,
 * and in GitHub's caches within seconds.
 *
 * It only looks at what is about to leave. Scanning the whole tree on every push
 * would turn a hook into a chore and, worse, would fail on history it cannot
 * change, teaching everybody to pass `--no-verify`.
 */

import { execFileSync } from "node:child_process";

import { findTerms, privateTerms } from "./terms.mjs";

/**
 * Is this repository visible to anybody?
 *
 * Checked rather than assumed, because the answer changes and the day it changes
 * is exactly the day nobody re-reads the hook. A repository whose visibility
 * cannot be determined is treated as public: guessing wrong in that direction
 * costs a moment, and guessing wrong in the other direction is the whole
 * problem.
 *
 * @param {string} cwd
 * @returns {{ public: boolean, why: string }}
 */
export function isPublic(cwd) {
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (out === "PRIVATE" || out === "INTERNAL") {
      return { public: false, why: `the repository is ${out.toLowerCase()}` };
    }
    return { public: true, why: `the repository is ${out.toLowerCase() || "of unknown visibility"}` };
  } catch {
    return { public: true, why: "the repository's visibility could not be read, so it is treated as public" };
  }
}

/**
 * The diff about to be pushed, as text.
 *
 * `@{push}..HEAD` is what is actually ahead of the tracked remote branch. When
 * there is no upstream yet - a brand new branch - everything on it is new, so
 * the comparison falls back to the default branch.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function outgoingDiff(cwd) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  for (const range of ["@{push}..HEAD", "origin/HEAD..HEAD", "HEAD~20..HEAD"]) {
    try {
      return git(["diff", "--unified=0", range]);
    } catch {
      // No upstream, no origin/HEAD, or fewer than twenty commits. Try the next.
    }
  }
  try {
    return git(["diff", "--unified=0", "HEAD"]);
  } catch {
    return "";
  }
}

/**
 * Only the lines being added. A removal that mentions a name is a line being
 * taken out, which is the fix rather than the problem.
 *
 * @param {string} diff
 * @returns {{ file: string, text: string }[]}
 */
export function addedLines(diff) {
  /** @type {{ file: string, text: string }[]} */
  const added = [];
  let file = "unknown";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file, text: line.slice(1) });
    }
  }
  return added;
}

/**
 * The messages of the commits about to be pushed.
 *
 * A separate read from the diff, because `git diff` does not contain them and never will -
 * and that is the blind spot this project has already been bitten by. GITHUB-PUSH.md states
 * it plainly: "Scrubbing file contents does not scrub commit messages, and the usual
 * verification cannot see them. `git log -S` searches diffs, so a term that exists only in a
 * message returns zero hits and the repo looks clean." An employer's domain sat in a public
 * commit message that way.
 *
 * Found again on 2026-09-01, this time in the guard itself: a public repo carried a private
 * first name in sixteen files AND in two commit messages, and this check could only ever have
 * seen the first kind.
 *
 * Same ranges as the diff, and the same reason for each fallback.
 *
 * @param {string} cwd
 * @returns {{ sha: string, text: string }[]}
 */
export function outgoingMessages(cwd) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  // A unit separator between the sha and the body, and a record separator between commits:
  // a message contains newlines and blank lines, so splitting on those loses half of it.
  const format = "--format=%H%x1f%B%x1e";
  for (const range of ["@{push}..HEAD", "origin/HEAD..HEAD", "HEAD~20..HEAD"]) {
    try {
      return parseMessages(git(["log", format, range]));
    } catch {
      // No upstream, no origin/HEAD, or fewer than twenty commits. Try the next.
    }
  }
  try {
    return parseMessages(git(["log", format, "-1"]));
  } catch {
    return [];
  }
}

/**
 * @param {string} raw
 * @returns {{ sha: string, text: string }[]}
 */
export function parseMessages(raw) {
  /** @type {{ sha: string, text: string }[]} */
  const out = [];
  for (const record of String(raw || "").split("\x1e")) {
    const trimmed = record.replace(/^\s+/, "");
    if (!trimmed) {
      continue;
    }
    const sep = trimmed.indexOf("\x1f");
    if (sep < 0) {
      continue;
    }
    out.push({ sha: trimmed.slice(0, sep), text: trimmed.slice(sep + 1) });
  }
  return out;
}

/**
 * How much of the repository a term has to already occupy before guarding it is hopeless.
 *
 * Both numbers have to be met. Occurrences alone would catch a single file that happens to
 * repeat a real name twenty times - a leak, not vocabulary. Spread across several files is
 * what says the word belongs to the codebase's own subject matter.
 */
export const PERVASIVE_MIN_HITS = 10;
export const PERVASIVE_MIN_FILES = 3;

/**
 * Is this term already all over the published repository?
 *
 * The question this answers is not "is it private" but "can this gate still do anything about
 * it". Four times now a push has been refused over a word that was already in the repository
 * hundreds of times - `meta`, `conversation`, `decisions`, `ownership` - and each time the fix
 * was to add the word to a hand-maintained list AFTER it had cost a push. The common thread
 * was never how common the word is in English: `meta` is jargon and `ownership` is not a
 * frequent word. It is that the word is the CODEBASE'S OWN vocabulary. `conversation`'s own
 * note records the shape exactly: "It appeared ninety-three times in already-published source
 * before it was ever flagged - the guard only reads changed lines, so it went unnoticed until
 * one of those lines was edited."
 *
 * So the signal is measured rather than listed: count what is already committed.
 *
 * THE DANGEROUS CASE IS HANDLED BY REPORTING, NOT BY SILENCE. If a genuine private name is
 * already in the repository ninety-three times, refusing the ninety-fourth protects nothing -
 * the name is public, and what is needed is a history rewrite, not a blocked push. So a
 * pervasive term is still surfaced, with its count, and the message says which of the two
 * situations the reader is in. Dropping it quietly would be the version of this that hides a
 * real leak, and that is the one thing this file must never do.
 *
 * Only ever called for a term that has already HIT, so a clean push pays nothing for it.
 *
 * @param {string} cwd
 * @param {string} term
 * @returns {{ pervasive: boolean, count: number, files: number }}
 */
export function alreadyInRepo(cwd, term) {
  try {
    // -F so a term with regex characters is a literal; -I to skip binaries; --name-only plus
    // -c would be two calls, so count lines and distinct files from one output.
    const out = execFileSync("git", ["-C", cwd, "grep", "-I", "-F", "-i", "-c", "--", term, "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    let count = 0;
    let files = 0;
    for (const line of out.split(/\r?\n/)) {
      // "HEAD:path/to/file:12"
      const at = line.lastIndexOf(":");
      if (at < 0) {
        continue;
      }
      const n = Number(line.slice(at + 1));
      if (!Number.isFinite(n)) {
        continue;
      }
      files += 1;
      count += n;
    }
    return { pervasive: count >= PERVASIVE_MIN_HITS && files >= PERVASIVE_MIN_FILES, count, files };
  } catch {
    // git grep exits non-zero when it finds nothing, and also when something is wrong. Both
    // answer this question the same way: no evidence that the term is already everywhere, so
    // the gate keeps its teeth. Failing towards blocking is the safe direction here.
    return { pervasive: false, count: 0, files: 0 };
  }
}

/**
 * Check what is about to be pushed. Returns what it found; decides nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string[]} [opts.extra]
 * `hits` is only what can still be guarded. A term the repository already publishes in force
 * moves to `published` (with a count in `pervasive`) and does NOT block - see alreadyInRepo
 * for why refusing the ninety-fourth occurrence of an already-public word protects nothing.
 *
 * @returns {{ checked: boolean, why: string, sources: string[], terms: number,
 *   hits: { file: string, term: string, text: string, kind: "file" | "message" }[],
 *   published?: { file: string, term: string, text: string, kind: "file" | "message" }[],
 *   pervasive?: { term: string, count: number, files: number }[] }}
 */
export function checkOutgoing({ cwd = process.cwd(), extra = [] } = {}) {
  const visibility = isPublic(cwd);
  if (!visibility.public) {
    return { checked: false, why: visibility.why, sources: [], terms: 0, hits: [] };
  }

  const { terms, sources } = privateTerms({ extra });
  if (terms.length === 0) {
    return {
      checked: false,
      why: "no private data could be read, so there is nothing to compare against - which is itself worth knowing",
      sources,
      terms: 0,
      hits: []
    };
  }

  /** @type {{ file: string, term: string, text: string, kind: "file" | "message" }[]} */
  const hits = [];
  for (const line of addedLines(outgoingDiff(cwd))) {
    for (const found of findTerms(line.text, terms)) {
      hits.push({ file: line.file, term: found.term, text: found.text, kind: "file" });
    }
  }
  // The half git diff cannot show. Tagged, because the two need different fixes: a file is
  // edited, a message needs a rebase - and being told "it is in the diff" when it is not is
  // how somebody concludes the guard is wrong and pushes anyway.
  for (const commit of outgoingMessages(cwd)) {
    for (const found of findTerms(commit.text, terms)) {
      hits.push({ file: `commit ${commit.sha.slice(0, 8)} (message)`, term: found.term, text: found.text, kind: "message" });
    }
  }

  // Measured only for terms that actually hit, so a clean push pays nothing for it.
  const split = partitionHits(hits, (term) => alreadyInRepo(cwd, term));

  return { checked: true, why: visibility.why, sources, terms: terms.length, ...split };
}

/**
 * Would putting this text into this repository publish something private?
 *
 * The push gate answers that question about a diff. This answers it about text that has not
 * been written yet, and it exists because a push is not the only way content enters a
 * repository: an application can generate a file and commit it on the user's behalf, and by
 * the time the push gate sees it the content is already in local history and has to be
 * rewritten out rather than simply not written.
 *
 * The case that prompted it: a session tool saves a handoff note into whichever repository the
 * session is rooted in and commits it itself. Nobody reads it first, and it carries whatever
 * the session was about. Refusing before the commit costs a warning; refusing at the push
 * costs a history rewrite.
 *
 * Same visibility gate, same derived terms and the same pervasiveness split as the push gate,
 * so a caller cannot end up with a second, softer definition of private.
 *
 * WHAT THE CALLER MUST DO WITH A REFUSAL: not commit. It must NOT also discard the text -
 * saving is saving, and a note lost to a guard is a worse outcome than the one being
 * prevented. Uncommitted content in a working tree has not been published.
 *
 * @param {object} args
 * @param {string} args.text The content about to be committed.
 * @param {string} [args.cwd] The repository it would be committed into.
 * @param {string} [args.label] What to call it in the report, e.g. a filename.
 * @param {string[]} [args.extra] Extra terms, as privateTerms takes them.
 * @returns {{ checked: boolean, why: string, sources: string[], terms: number,
 *   hits: { file: string, term: string, text: string, kind: "file" | "message" }[],
 *   published: { file: string, term: string, text: string, kind: "file" | "message" }[],
 *   pervasive: { term: string, count: number, files: number }[] }}
 */
export function checkText({ text, cwd = process.cwd(), label = "the text", extra = [] }) {
  const empty = { hits: [], published: [], pervasive: [] };
  const visibility = isPublic(cwd);
  if (!visibility.public) {
    return { checked: false, why: visibility.why, sources: [], terms: 0, ...empty };
  }

  const { terms, sources } = privateTerms({ extra });
  if (terms.length === 0) {
    return {
      checked: false,
      why: "no private data could be read, so there is nothing to compare against - which is itself worth knowing",
      sources,
      terms: 0,
      ...empty
    };
  }

  /** @type {{ file: string, term: string, text: string, kind: "file" | "message" }[]} */
  const hits = [];
  for (const found of findTerms(String(text ?? ""), terms)) {
    hits.push({ file: label, term: found.term, text: found.text, kind: "file" });
  }

  const split = partitionHits(hits, (term) => alreadyInRepo(cwd, term));
  return { checked: true, why: visibility.why, sources, terms: terms.length, ...split };
}

/**
 * Split hits into what this gate can still do something about, and what the repository
 * already publishes in force.
 *
 * Separate from checkOutgoing and pure, so the rule can be checked without a repository, a
 * remote and a push - the three things that made the old shape untestable.
 *
 * NOTHING IS DROPPED. A pervasive term moves to `published` and is reported; it just stops
 * refusing the push. See alreadyInRepo for why silence would be the dangerous version.
 *
 * @param {{ file: string, term: string, text: string, kind: "file" | "message" }[]} hits
 * @param {(term: string) => { pervasive: boolean, count: number, files: number }} lookUp
 */
export function partitionHits(hits, lookUp) {
  const pervasive = new Map();
  for (const term of new Set(hits.map((h) => h.term))) {
    const seen = lookUp(term);
    if (seen && seen.pervasive) {
      pervasive.set(term, seen);
    }
  }
  return {
    // `hits` stays the blocking set, so every existing caller keeps its meaning.
    hits: hits.filter((h) => !pervasive.has(h.term)),
    // Surfaced, never silently dropped: if one of these is a genuine name then the leak
    // already happened and a blocked push would not undo it - what is needed is a history
    // rewrite, and the reader has to be told which of the two situations they are in.
    published: hits.filter((h) => pervasive.has(h.term)),
    pervasive: [...pervasive.entries()].map(([term, seen]) => ({ term, ...seen }))
  };
}

/**
 * What to print when something was found.
 *
 * Names the term and the file rather than telling somebody to go and look, and
 * says how to proceed - a guard with no way past it is a guard that gets
 * disabled rather than obeyed.
 *
 * @param {ReturnType<typeof checkOutgoing>} result
 * @returns {string}
 */
export function report(result) {
  const lines = [
    "",
    `This push would put ${result.hits.length} private ${result.hits.length === 1 ? "reference" : "references"} into a public repository.`,
    ""
  ];

  const byTerm = new Map();
  for (const hit of result.hits) {
    const list = byTerm.get(hit.term) ?? [];
    list.push(hit);
    byTerm.set(hit.term, list);
  }

  for (const [term, hits] of byTerm) {
    lines.push(`  ${term}`);
    for (const hit of hits.slice(0, 4)) {
      lines.push(`    ${hit.file}: ${hit.text}`);
    }
    if (hits.length > 4) {
      lines.push(`    and ${hits.length - 4} more`);
    }
  }

  lines.push(
    "",
    "These came from the names in your own Tend and Nib data, so this is not a",
    "guess about what looks like a name. Rename them and push again.",
    ""
  );

  // A message needs a different fix from a file, and saying "rename it and push again" to
  // somebody whose only hit is in a commit message sends them looking through a working tree
  // that is already clean - and then concluding the guard is broken.
  if (result.hits.some((hit) => hit.kind === "message")) {
    const n = result.hits.filter((hit) => hit.kind === "message").length;
    lines.push(
      `${n} of ${n === 1 ? "these is" : "these are"} in a COMMIT MESSAGE, not in a file. Editing the`,
      "working tree will not touch it: the message needs rewording, with",
      "`git commit --amend` for the last one or a rebase for an older one.",
      "",
      "This is the half `git log -S` cannot see - it searches diffs, so a term",
      "that only ever lived in a message returns zero and the repo reads clean.",
      ""
    );
  }

  lines.push(
    "If one of them is genuinely a coincidence, push with --no-verify - but a",
    "coincidence in a test fixture usually means the fixture should be invented",
    "rather than borrowed.",
    ""
  );
  return lines.join("\n");
}
