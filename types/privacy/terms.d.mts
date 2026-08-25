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
/**
 * Shorter than this and a name is a substring of ordinary prose.
 *
 * Four is the smallest that is not "Bo", "Ida" or "Ali" matching every third
 * line. A short first name is the one case this cannot cover, and saying so is
 * better than a guard nobody trusts.
 */
export declare const MIN_TERM = 4;
/**
 * The terms to look for, and where they were learned from.
 *
 * Split into words as well as kept whole: a roster holds "Nadia Ohlsson" and a
 * comment leaks "Nadia".
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extra] Terms no data source knows, such as an employer.
 * @returns {{ terms: string[], sources: string[] }}
 */
export declare function privateTerms({ extra }?: {
    extra?: string[];
}): {
    terms: string[];
    sources: string[];
};
/**
 * Where a term appears in some text.
 *
 * Word boundaries, so "Meta" does not match "metadata" and a name does not match
 * a longer word containing it. Case-insensitive, because a fixture id is
 * lowercase and leaks just as well.
 *
 * @param {string} text
 * @param {string[]} terms
 * @returns {{ term: string, line: number, text: string }[]}
 */
export declare function findTerms(text: string, terms: string[]): {
    term: string;
    line: number;
    text: string;
}[];
