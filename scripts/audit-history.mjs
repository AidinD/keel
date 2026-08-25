/**
 * Scan every repository's whole history - blobs and commit messages - for
 * private terms.
 *
 * The HEAD audit answers "is it clean now". This answers "was it ever there",
 * which is the question a public repository actually poses: a name removed in a
 * later commit is still one `git log -p` away.
 */
import { execFileSync } from "node:child_process";

import { findTerms, privateTerms } from "../src/privacy/index.mjs";

const REPOS = ["tend", "nib", "jot", "loom", "helm", "brief", "nudge", "pompom", "keel"];
const TEXT = /\.(mjs|js|ts|tsx|md|json|html|css|yml|txt)$/;

const { terms } = privateTerms();
console.log(`${terms.length} terms\n`);

for (const name of REPOS) {
  const root = `D:/Repo/Tools/${name}`;
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });

  let commits = 0;
  try {
    commits = git(["rev-list", "--count", "--all"]).trim();
  } catch {
    continue;
  }

  // Commit messages.
  let messageHits = [];
  try {
    const text = git(["log", "--all", "--format=%H%x09%s%x0a%b"]);
    messageHits = findTerms(text, terms);
  } catch {
    /* nothing */
  }

  // Every text blob that ever existed, once each.
  const blobHits = new Map();
  try {
    const objects = git(["rev-list", "--objects", "--all"]).split("\n");
    const seen = new Set();
    for (const row of objects) {
      const space = row.indexOf(" ");
      if (space < 0) {
        continue;
      }
      const sha = row.slice(0, space);
      const path = row.slice(space + 1);
      if (!TEXT.test(path) || seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      let content = "";
      try {
        content = git(["cat-file", "-p", sha]);
      } catch {
        continue;
      }
      for (const hit of findTerms(content, terms)) {
        const key = `${hit.term}`;
        blobHits.set(key, (blobHits.get(key) ?? 0) + 1);
      }
    }
  } catch {
    /* nothing */
  }

  const total = messageHits.length + [...blobHits.values()].reduce((a, b) => a + b, 0);
  console.log(
    `${name.padEnd(9)}${String(commits).padStart(4)} commits   ${total === 0 ? "clean" : `${total} hits`}`
  );
  if (messageHits.length > 0) {
    console.log(`  messages: ${[...new Set(messageHits.map((h) => h.term))].join(", ")}`);
  }
  if (blobHits.size > 0) {
    console.log(
      `  blobs:    ${[...blobHits.entries()].map(([t, n]) => `${t} (${n})`).join(", ")}`
    );
  }
}
