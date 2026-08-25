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
 * Check what is about to be pushed. Returns what it found; decides nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string[]} [opts.extra]
 * @returns {{ checked: boolean, why: string, sources: string[], terms: number,
 *   hits: { file: string, term: string, text: string }[] }}
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
    }[];
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
