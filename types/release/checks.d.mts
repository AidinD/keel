/**
 * The preflight checks a release has to pass, and the incidents behind each one.
 *
 * Four apps grew their own release script and none of them had the same set of
 * guards - Nib was missing the two that matter most, and found out by publishing
 * a release that did nothing and said "Published". The guards are the whole value
 * of a release script; the build command in the middle is the easy part.
 *
 * `exec` is injected, the way electron is in `keel/window`. That keeps this
 * testable without running git or gh, and it keeps keel free of any opinion about
 * how a consumer prefers to spawn processes.
 *
 * @typedef {(command: string, args: string[]) => string} Exec
 *   Runs a command and returns its trimmed stdout. MUST throw on a non-zero
 *   exit: several checks read a thrown error as "absent", which is the answer
 *   they want.
 *
 * @typedef {object} Context
 * @property {string} [version] From package.json, without a leading v.
 * @property {string} [tag] Usually `v${version}`.
 * @property {string} [branch] The branch a release may be cut from.
 * @property {string} [upstream] The ref unpushed commits are measured against.
 *
 * @typedef {{ name: string, message: string }} Failure
 */
export type Exec = (command: string, args: string[]) => string;
export type Context = {
    /**
     * From package.json, without a leading v.
     */
    version?: string;
    /**
     * Usually `v${version}`.
     */
    tag?: string;
    /**
     * The branch a release may be cut from.
     */
    branch?: string;
    /**
     * The ref unpushed commits are measured against.
     */
    upstream?: string;
};
export type Failure = {
    name: string;
    message: string;
};
/**
 * Refuse a release from a dirty tree.
 *
 * Untracked files count. Loom's version passed `--untracked-files=no`, which is
 * the more forgiving reading and the wrong one: a file the build reads but nobody
 * committed is in the installer on this machine and absent everywhere else, which
 * is the hardest kind of difference to explain later.
 *
 * @param {Exec} exec @returns {Failure | null}
 */
export declare function cleanTree(exec: Exec): Failure | null;
/**
 * Refuse a version that is already on GitHub.
 *
 * This is the important one. Without it the script runs to completion, prints
 * "Published", and changes nothing: electron-builder treats a release older than
 * two hours as untouchable and skips `latest.yml` with a notice in the middle of
 * its output, then exits 0. The failure is shaped exactly like a success, and the
 * updater carries on offering the old build. It happened to Nib on 2026-08-24 -
 * an entire release was a no-op that reported success.
 *
 * @param {Exec} exec @param {Context} context @returns {Failure | null}
 */
export declare function notAlreadyReleased(exec: Exec, { tag }: Context): Failure | null;
/**
 * Refuse a release from a side branch.
 *
 * @param {Exec} exec @param {Context} context @returns {Failure | null}
 */
export declare function onBranch(exec: Exec, { branch }: Context): Failure | null;
/**
 * Refuse a release with commits that only exist locally.
 *
 * Matters most where CI builds from the pushed tag: the tag would be reachable
 * only on this machine, and the release would be built from an older tree than
 * the tag claims.
 *
 * @param {Exec} exec @param {Context} context @returns {Failure | null}
 */
export declare function nothingUnpushed(exec: Exec, { upstream }: Context): Failure | null;
/**
 * Refuse a tag that already exists, locally or on origin.
 *
 * Separate from `notAlreadyReleased` on purpose: a tag can exist without a
 * release (a failed CI run leaves exactly that), and a release can exist without
 * a local tag. Loom hit the first case twice, v1.1.16 and v1.2.3, when
 * electron-builder created the tag itself and CI then died on "a release with the
 * same tag name already exists".
 *
 * @param {Exec} exec @param {Context} context @returns {Failure | null}
 */
export declare function tagFree(exec: Exec, { tag }: Context): Failure | null;
/**
 * The catalogue, so a consumer names the checks it wants instead of re-deriving
 * them. Order here is the order `preflight` runs them in, cheapest first.
 *
 * @type {Record<string, (exec: Exec, context: Context) => Failure | null>}
 */
export declare const CHECKS: Record<string, (exec: Exec, context: Context) => Failure | null>;
/**
 * Run the named checks in catalogue order and return every failure.
 *
 * Every failure, not the first: being told about a dirty tree, fixing it, and
 * only then learning the version is already released is two round trips for one
 * problem.
 *
 * A check whose name is not in the catalogue throws, rather than being skipped -
 * a silently ignored guard is the failure mode this whole module exists to stop.
 *
 * @param {Exec} exec
 * @param {Context & { checks: string[] }} options
 * @returns {Failure[]}
 */
export declare function preflight(exec: Exec, { checks, ...context }: Context & {
    checks: string[];
}): Failure[];
