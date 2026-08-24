/**
 * The release plumbing every app in the suite had written out for itself.
 *
 * Tend's and Brief's scripts were the same 125 lines apart from the app's name.
 * Nib's was missing the dirty-tree check and, until it published a release that
 * quietly did nothing, the already-released check too. Loom's guards the tag
 * instead, because it releases from CI.
 *
 * What is shared is the guards and the diagnosis when something is locked. What
 * is not shared is the middle - build locally and publish, or tag and let CI
 * build - so this module deliberately supplies parts rather than one `release()`.
 */
export * from './checks.mjs';
export { stopRunningBuild, stopScript } from './processes.mjs';
/**
 * An `Exec` backed by a real synchronous spawn: trimmed stdout, throws on a
 * non-zero exit. stderr is left alone so gh's own messages still reach the
 * terminal.
 *
 * @param {string} root Working directory.
 * @returns {(command: string, args: string[]) => string}
 */
export declare function nodeExec(root: string): (command: string, args: string[]) => string;
/**
 * Name, version and tag from an app's package.json.
 *
 * @param {string} root
 * @returns {{ name: string, version: string, tag: string }}
 */
export declare function appMeta(root: string): {
    name: string;
    version: string;
    tag: string;
};
/**
 * A GitHub token from the logged-in gh CLI.
 *
 * Read at release time rather than kept anywhere: a long-lived GH_TOKEN in a
 * shell profile or a dotfile is a credential with no expiry sitting in a place
 * that gets committed by accident.
 *
 * @param {(command: string, args: string[]) => string} exec
 * @returns {string}
 */
export declare function ghToken(exec: (command: string, args: string[]) => string): string;
/**
 * Clear build output directories, and say something useful when one is locked.
 *
 * `out/` in particular is not optional. electron-builder packages whatever is
 * already sitting there without a word of complaint, so a skipped clean ships the
 * previous build's code under a new version number - which is exactly what
 * happened to Jot on 2026-08-04.
 *
 * @param {string} root
 * @param {string[]} [directories]
 * @param {(message: string) => void} [log]
 */
export declare function clean(root: string, directories?: string[], log?: (message: string) => void): void;
