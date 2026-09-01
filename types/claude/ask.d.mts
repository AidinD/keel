/**
 * One question to Claude Code, answered in a shape you declared.
 *
 * ## Why the command line and not the API
 *
 * Because it needs no key. The `claude` executable is already signed in on this
 * machine, and spawning it borrows that session - so an app in the suite gains a
 * model layer without a second credential to store, rotate, or leak. The cost is
 * a process launch per call, which is nothing next to the round trip that
 * follows it.
 *
 * `--bare` is deliberately NOT passed. It sounds like the lean choice and is the
 * opposite: it forces API-key authentication instead of the subscription.
 *
 * ## Why the call is stripped down
 *
 * A default invocation is an agent session: every tool definition that ships
 * with Claude Code, every MCP server configured on the machine, the preamble
 * that explains all of it, and whatever the machine's own settings say about
 * effort. For a call that only emits JSON and never uses a tool, that is almost
 * the whole bill. Measured on one cheap-tier call with a one-sentence question
 * and a two-field schema:
 *
 * | The call | Input tokens | Cost |
 * |---|---|---|
 * | tool definitions loaded | ~48,000 over 3 turns | 5.7 cents |
 * | tool definitions gone | ~1,800 over 2 turns | 0.5 cents |
 *
 * `--allowed-tools ''` looks like the flag that does this and is not: it is a
 * permission filter over tools that are still defined, so the definitions are
 * still sent and still paid for on every turn. `--tools ''` is the one that
 * removes them. The same swap took a writing-tier call from 26 cents to 2.3.
 *
 * The system prompt is the second half of the same problem. A call that passes
 * none does not get a short prompt - it gets the full agent preamble, roughly
 * 23,000 tokens a turn, which on the cheap tier costs several times the answer.
 * It also answers worse, because the preamble describes an agent with tools and
 * files and a one-shot extraction is neither. So a default one is always sent
 * and `system` only replaces it.
 *
 * The machine's settings are the third. An `effortLevel` in a user settings file
 * applies to a spawned call like any other, so the same question costs whatever
 * the person at this desk last chose for their own interactive sessions - 5.6
 * cents against 2.3 on the measured writing-tier call, for a setting the caller
 * never asked for. `--setting-sources ''` cuts it out. The price of that flag is
 * that an `apiKeyHelper` in a settings file is no longer read; these calls are
 * the subscription's, so that is the intended trade, but it is the thing to
 * remember if a consumer ever needs API-key auth.
 *
 * Nothing is written to disk either. Without `--no-session-persistence` every
 * call leaves a full session transcript in the Claude Code projects directory,
 * which for an app that asks about somebody's notes means a second copy of them
 * somewhere the app does not manage.
 *
 * ## The prompt goes in on stdin
 *
 * Not as `-p <prompt>`, which is where it used to go and which has a ceiling:
 * Windows caps a command line at 32,767 characters, and `spawn` answers a longer
 * one with `ENAMETOOLONG` before the process exists. Nib hit it on the first
 * long meeting it summarised - a 53-minute transcript is around 40,000
 * characters on its own - and the failure scales with exactly the input the
 * feature is for. A 20-minute meeting worked, so nothing looked wrong until
 * something was worth summarising.
 *
 * stdin has no such limit. Measured: 45,072 characters through it, exit 0, the
 * schema still honoured. It also takes the prompt out of the shell's reach on
 * the fallback path below, where a quoted argument was previously at the mercy
 * of whatever the shell made of it.
 *
 * The pipe is closed the instant the prompt is written. The CLI waits three
 * seconds for piped input before concluding there is none, and that wait is for
 * an open pipe that never receives anything - an immediate EOF costs nothing.
 *
 * The working directory is part of the same problem and is easy to miss.
 * Claude Code loads the CLAUDE.md files it finds from the current directory
 * upwards, so a call made from inside a repository quietly carries that
 * project's instructions into a question that has nothing to do with it. The
 * same trivial extraction measured 8.3 cents from a repo and 2.7 from a
 * neutral directory - a third of the cost, for context that could only have
 * confused the answer. So `cwd` defaults to somewhere with no project in it,
 * and a caller that genuinely wants a project's own instructions has to say so.
 *
 * ## What it is not
 *
 * Not a session. There is no conversation, no resume, no streaming, no tool use.
 * That is a different thing with different failure modes and it lives in Helm.
 * This is for the kind of call where you know the question and the shape of the
 * answer before you ask - a draft, an extraction, a judgement.
 *
 * ```js
 * import { ask } from 'keel/claude'
 *
 * const answer = await ask({
 *   prompt: 'Extract any commitments from this note.',
 *   model: 'claude-haiku-4-5-20251001',
 *   schema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] }
 * })
 * if (!answer.ok) {
 *   warn(answer.reason)   // already a sentence a person can act on
 * }
 * ```
 */
import { spawn } from 'node:child_process';
/** A model call that has not answered in this long is not going to. */
export declare const DEFAULT_TIMEOUT_MS = 90000;
export type AskOptions = {
    /**
     * What to ask. Everything the model needs, in one
     * string. Sent on stdin, so there is no length limit to design around - a
     * whole meeting transcript is a normal argument here.
     */
    prompt: string;
    /**
     * Model id. The caller picks the tier; keel deliberately
     * knows no model names, because that is the fact in this area that goes stale.
     */
    model: string;
    /**
     * Replaces the system prompt entirely. Given none, a
     * near-empty default is sent rather than nothing, because nothing means Claude
     * Code's full agent preamble - around 23,000 tokens a turn, on a call that has
     * no tools and no next turn.
     */
    system?: string;
    effort?: "low" | "medium" | "high";
    /**
     * JSON Schema. Given one, the answer is
     * validated by the CLI and comes back parsed.
     */
    schema?: Record<string, any>;
    /**
     * Where to run. Defaults to a directory with no
     * project in it, so no CLAUDE.md is dragged into the question. Pass one only
     * when the project's own instructions are genuinely part of what you are asking.
     */
    cwd?: string;
    timeoutMs?: number;
    /**
     * Test seam.
     */
    spawnImpl?: typeof spawn;
};
export type AskResult = {
    ok: true;
    value: any;
    model: string;
    costUsd: number | null;
} | {
    ok: false;
    reason: string;
};
/**
 * @typedef {object} AskOptions
 * @property {string} prompt What to ask. Everything the model needs, in one
 *   string. Sent on stdin, so there is no length limit to design around - a
 *   whole meeting transcript is a normal argument here.
 * @property {string} model Model id. The caller picks the tier; keel deliberately
 *   knows no model names, because that is the fact in this area that goes stale.
 * @property {string} [system] Replaces the system prompt entirely. Given none, a
 *   near-empty default is sent rather than nothing, because nothing means Claude
 *   Code's full agent preamble - around 23,000 tokens a turn, on a call that has
 *   no tools and no next turn.
 * @property {"low" | "medium" | "high"} [effort]
 * @property {Record<string, any>} [schema] JSON Schema. Given one, the answer is
 *   validated by the CLI and comes back parsed.
 * @property {string} [cwd] Where to run. Defaults to a directory with no
 *   project in it, so no CLAUDE.md is dragged into the question. Pass one only
 *   when the project's own instructions are genuinely part of what you are asking.
 * @property {number} [timeoutMs]
 * @property {typeof spawn} [spawnImpl] Test seam.
 */
/**
 * @typedef {{ ok: true, value: any, model: string, costUsd: number | null }
 *   | { ok: false, reason: string }} AskResult
 */
/**
 * Ask once and resolve with the answer, or with a reason there isn't one.
 *
 * Never rejects. A model layer is an enhancement in every app that has one, and
 * an enhancement that can take the caller down with it is a liability - so every
 * failure, including a missing executable and a hung child, comes back as data.
 *
 * @param {AskOptions} options
 * @returns {Promise<AskResult>}
 */
export declare function ask({ prompt, model, system, effort, schema, cwd, timeoutMs, spawnImpl }: AskOptions): Promise<AskResult>;
/**
 * Turn whatever the process printed into an answer or a reason.
 *
 * Split out and exported so the parsing can be tested without spawning
 * anything: every branch here is a way a call fails in production and none of
 * them are reachable from a happy-path test.
 *
 * @param {object} input
 * @param {string} input.out
 * @param {string} input.err
 * @param {string} input.model
 * @param {boolean} input.schema
 * @returns {AskResult}
 */
export declare function readAnswer({ out, err, model, schema }: {
    out: string;
    err: string;
    model: string;
    schema: boolean;
}): AskResult;
