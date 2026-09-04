/**
 * The guard that keeps private names out of public repositories.
 *
 * A rule in a document was the previous control and it failed: broken fifteen
 * times in one evening by somebody who had read it and meant to follow it. This
 * runs on every push whether anybody remembers or not, and it works out what to
 * look for from the private data the apps already hold rather than from a list
 * that would itself be the leak if committed.
 */
export { MIN_TERM, findTerms, privateTerms } from "./terms.mjs";
export { addedLines, alreadyInRepo, checkOutgoing, checkText, partitionHits, isPublic, outgoingDiff, outgoingMessages, parseMessages, report, PERVASIVE_MIN_FILES, PERVASIVE_MIN_HITS } from "./check.mjs";
