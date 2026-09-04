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
export declare function isPublic(cwd: string): {
    public: boolean;
    why: string;
};
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
export declare function outgoingDiff(cwd: string): string;
/**
 * Only the lines being added. A removal that mentions a name is a line being
 * taken out, which is the fix rather than the problem.
 *
 * @param {string} diff
 * @returns {{ file: string, text: string }[]}
 */
export declare function addedLines(diff: string): {
    file: string;
    text: string;
}[];
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
export declare function outgoingMessages(cwd: string): {
    sha: string;
    text: string;
}[];
/**
 * @param {string} raw
 * @returns {{ sha: string, text: string }[]}
 */
export declare function parseMessages(raw: string): {
    sha: string;
    text: string;
}[];
/**
 * How much of the repository a term has to already occupy before guarding it is hopeless.
 *
 * Both numbers have to be met. Occurrences alone would catch a single file that happens to
 * repeat a real name twenty times - a leak, not vocabulary. Spread across several files is
 * what says the word belongs to the codebase's own subject matter.
 */
export declare const PERVASIVE_MIN_HITS = 10;
export declare const PERVASIVE_MIN_FILES = 3;
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
export declare function alreadyInRepo(cwd: string, term: string): {
    pervasive: boolean;
    count: number;
    files: number;
};
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
export declare function checkOutgoing({ cwd, extra }?: {
    cwd?: string;
    extra?: string[];
}): {
    checked: boolean;
    why: string;
    sources: string[];
    terms: number;
    hits: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    published?: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    pervasive?: {
        term: string;
        count: number;
        files: number;
    }[];
};
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
export declare function checkText({ text, cwd, label, extra }: {
    text: string;
    cwd?: string;
    label?: string;
    extra?: string[];
}): {
    checked: boolean;
    why: string;
    sources: string[];
    terms: number;
    hits: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    published: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    pervasive: {
        term: string;
        count: number;
        files: number;
    }[];
};
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
export declare function partitionHits(hits: {
    file: string;
    term: string;
    text: string;
    kind: "file" | "message";
}[], lookUp: (term: string) => {
    pervasive: boolean;
    count: number;
    files: number;
}): {
    hits: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    published: {
        file: string;
        term: string;
        text: string;
        kind: "file" | "message";
    }[];
    pervasive: any[];
};
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
export declare function report(result: ReturnType<typeof checkOutgoing>): string;
