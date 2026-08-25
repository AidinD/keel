/**
 * Scan every repository on this disk for private terms, whole tree.
 *
 * The pre-push hook only sees what is about to leave. This is the audit: it
 * reads what is already committed, which is the question "has anything leaked to
 * GitHub" actually asks.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findTerms, privateTerms } from "../src/privacy/index.mjs";

const REPOS = ["tend", "nib", "jot", "loom", "helm", "brief", "nudge", "pompom", "keel"];
const TEXT = /\.(mjs|js|ts|tsx|md|json|html|css|yml|txt)$/;

const { terms, sources } = privateTerms();
console.log(`${terms.length} terms, from:`);
for (const s of sources) {
  console.log(`  ${s}`);
}
console.log("");

let total = 0;
for (const name of REPOS) {
  const root = `D:/Repo/Tools/${name}`;
  let visibility = "?";
  try {
    visibility = execFileSync("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    continue;
  }

  let files = [];
  try {
    files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  } catch {
    continue;
  }

  const hits = [];
  for (const file of files) {
    if (file.trim() === "" || !TEXT.test(file)) {
      continue;
    }
    let text = "";
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const hit of findTerms(text, terms)) {
      hits.push(`  ${file}:${hit.line}  [${hit.term}]  ${hit.text.slice(0, 78)}`);
    }
  }

  total += visibility === "PUBLIC" ? hits.length : 0;
  console.log(
    `${(visibility === "PUBLIC" ? "PUBLIC" : "private").padEnd(8)}${name.padEnd(9)}${hits.length === 0 ? "clean" : `${hits.length} hits`}`
  );
  for (const hit of hits) {
    console.log(hit);
  }
}

console.log(`\n${total} hits in public repositories.`);
