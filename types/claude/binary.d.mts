/**
 * Finding the Claude Code executable, once per process.
 *
 * ## Why a real .exe matters and not just "claude"
 *
 * `spawn` with `shell: true` on Windows does NOT quote the argument array before
 * handing it to cmd.exe - it concatenates. A prompt containing a space is then
 * split into separate shell tokens and the call silently receives only its first
 * word. Nothing errors. The model answers a one-word question and the answer
 * looks merely poor rather than wrong.
 *
 * Resolving the real `claude.exe` and spawning it directly avoids the shell
 * entirely, so Node's own (correct) Windows argument escaping applies. A `.cmd`
 * shim - what an npm-global install leaves behind - can only be run through a
 * shell, which is why one is reported rather than quietly accepted.
 */
/**
 * Overrides resolution. Set by a test to point at a stub, so the machinery
 * around a call can be exercised without spending tokens on every suite run.
 */
export declare const CLAUDE_BINARY_VARIABLE = "KEEL_CLAUDE_BIN";
/**
 * Where the Claude Code executable is, and whether it can be spawned directly.
 *
 * Never throws. A machine without Claude Code installed gets
 * `{ path: 'claude', direct: false, reason: ... }` and the caller decides what
 * that means - for most callers the model layer is simply off, which is a state
 * they have to handle anyway.
 *
 * @param {object} [options]
 * @param {boolean} [options.fresh] Skip the cache. Only a test wants this.
 * @returns {{ path: string, direct: boolean, reason: string | null }}
 */
export declare function resolveClaudeBinary({ fresh }?: {
    fresh?: boolean;
}): {
    path: string;
    direct: boolean;
    reason: string | null;
};
/** Forget the cached resolution. For tests, and for a settings screen that retries. */
export declare function forgetClaudeBinary(): void;
