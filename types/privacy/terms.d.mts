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
 * @param {string[]} [opts.extra] Terms from a caller. Prefer the file beside the
 *   data - anything passed here has to be written down in a repository.
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
export declare function findTerms(text: string, terms: string[]): {
    term: string;
    line: number;
    text: string;
}[];
