/**
 * Borrowing Claude Code's own sign-in for a single, structured question.
 *
 * The value here is not the spawn - that is sixty lines. It is that an app
 * gains a model layer with no second credential to store, that the ways such a
 * call fails invisibly on Windows are handled once instead of remembered in
 * every app, and that the ninth app does not rediscover why `--bare` is the
 * wrong flag.
 *
 * Helm has the sibling of this for whole sessions: streaming, tools, resume.
 * That half has deliberately not been folded in - it is a different shape with
 * different failure modes. `ask` is the one-shot half, which Helm itself
 * repeats at several call sites and which is the obvious next migration.
 *
 * ```js
 * import { ask, resolveClaudeBinary } from 'keel/claude'
 * ```
 *
 * See `ask.mjs` for what a call is stripped down to and why, and `binary.mjs`
 * for why a shim is reported rather than quietly accepted.
 */
export { ask, readAnswer, DEFAULT_TIMEOUT_MS } from './ask.mjs';
export { CLAUDE_BINARY_VARIABLE, forgetClaudeBinary, resolveClaudeBinary } from './binary.mjs';
