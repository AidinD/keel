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
 * Check what is about to be pushed. Returns what it found; decides nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string[]} [opts.extra]
 * @returns {{ checked: boolean, why: string, sources: string[], terms: number,
 *   hits: { file: string, term: string, text: string }[] }}
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

  /** @type {{ file: string, term: string, text: string }[]} */
  const hits = [];
  for (const line of addedLines(outgoingDiff(cwd))) {
    for (const found of findTerms(line.text, terms)) {
      hits.push({ file: line.file, term: found.term, text: found.text });
    }
  }

  return { checked: true, why: visibility.why, sources, terms: terms.length, hits };
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
    "",
    "If one of them is genuinely a coincidence, push with --no-verify - but a",
    "coincidence in a test fixture usually means the fixture should be invented",
    "rather than borrowed.",
    ""
  );
  return lines.join("\n");
}
