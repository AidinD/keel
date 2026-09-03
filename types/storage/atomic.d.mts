/**
 * One atomic write, for every durable store in the suite.
 *
 * The discipline - write a temp file, then rename over the target - had been
 * copied into four repos at three different levels of correctness:
 *
 *   Helm  writeFileAtomicSync: retries the rename, retries the temp cleanup,
 *         reports failures in plain language, never throws.
 *   Jot   writeFileAtomic:     retries the rename. Cleans up with a single silent
 *         Nib  (same code)     unlink, and throws on failure.
 *
 * Helm's is the one that learned the most, because Helm broke the most. Both of
 * the things it knows are real:
 *
 *  - **The rename needs retrying.** On Windows it fails with EPERM while another
 *    process holds the target. Every copy that let that throw straight through
 *    lost the write. Observed 2026-07-27.
 *  - **So does the temp cleanup.** The obvious "unlinkSync and swallow" loses a
 *    race: the sync client can grab a lock on the temp file the instant it
 *    appears, so one silent unlink leaves it behind. That is how Helm's dispatch
 *    directory accumulated 1462 orphaned `.tmp` files (found 2026-08-12).
 *
 * Both forms are here, because the callers genuinely differ: Helm's writers are
 * synchronous and want a result they can turn into a toast, while Jot's and Nib's
 * are async and throw. Sharing the parts rather than picking a winner means
 * migrating either one is a swap, not a rewrite.
 */
/**
 * A temp path nobody else will pick.
 *
 * The random suffix is per attempt, so two writers never fight over one fixed
 * `todos.json.tmp`. Jot's data directory still holds one orphan from before this
 * was true.
 *
 * @param {string} filePath
 * @returns {string}
 */
export declare function tempPathFor(filePath: string): string;
/**
 * Turn an errno into something a person can act on.
 *
 * A write failure ends up in a toast someone reads. A bare
 * "EROFS: read-only file system, open '...'" tells them nothing to do about it, so
 * say what happened in words and keep the code in brackets for a bug report.
 *
 * @param {unknown} error
 * @param {string} filePath
 * @param {string} [app] Name to use in the permission message.
 * @returns {string}
 */
export declare function plainReason(error: unknown, filePath: string, app?: string): string;
/**
 * Remove a temp file that never made it onto its target.
 *
 * Best-effort - it never throws - but RETRIED, over the same backoff the rename
 * uses, because a transient lock on the temp is exactly as likely as one on the
 * destination. See the header: this is the 1462-orphan lesson.
 *
 * @param {string} temp
 */
export declare function bestEffortRemove(temp: string): void;
/**
 * Write `contents` to `filePath` atomically, retrying while the target is locked.
 *
 * Returns a result rather than throwing, because every caller of the sync form has
 * a meaningful "the write did not happen" path and a throw is how these failures
 * got lost in the first place.
 *
 * A returned `aborted: true` means the precondition hook refused: nothing was
 * written, and the caller's own data is stale. That is a different answer from
 * every other failure here, and the only one where trying again can help - see
 * the note above the hook below.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {object} [options]
 * @param {(() => string | null)} [options.onBeforeRename] Re-check preconditions
 *   immediately before the rename; return a reason to refuse the write. Runs
 *   under the write lock, together with the rename. Helm's Jot bridge uses it for
 *   its concurrent-edit guard.
 * @param {string} [options.app] Name for the plain-language failure messages.
 * @returns {{ ok: true } | { ok: false, error: string, aborted?: true }}
 */
export declare function writeFileAtomicSync(filePath: string, contents: string, { onBeforeRename, app }?: {
    onBeforeRename?: (() => string | null);
    app?: string;
}): {
    ok: true;
} | {
    ok: false;
    error: string;
    aborted?: true;
};
/**
 * Pretty-printed JSON with a trailing newline, which is the common case.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {Parameters<typeof writeFileAtomicSync>[2]} [options]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export declare function writeJsonAtomicSync(filePath: string, value: unknown, options?: Parameters<typeof writeFileAtomicSync>[2]): {
    ok: true;
} | {
    ok: false;
    error: string;
};
/**
 * The async form, which throws.
 *
 * Kept signature-compatible with the copies in Jot and Nib so migrating them is a
 * swap rather than a rewrite - but the temp cleanup is now the retried one, so
 * they stop leaving orphans behind.
 *
 * Still throws when the write genuinely cannot succeed; callers surface that.
 *
 * @param {string} filePath
 * @param {string} contents
 * @returns {Promise<void>}
 */
export declare function writeFileAtomic(filePath: string, contents: string): Promise<void>;
/**
 * Pretty-printed JSON with a trailing newline, async.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export declare function writeJsonAtomic(filePath: string, value: unknown): Promise<void>;
