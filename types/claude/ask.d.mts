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
 * A default invocation loads every MCP server on the machine and every tool
 * definition that comes with them. For a call that only emits JSON and never
 * uses a tool, that is the bulk of the tokens - in Helm, stripping them took a
 * small judging call from roughly $0.068 to $0.015. So: no tools, no MCP, and an
 * empty strict config so nothing is inherited.
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
     * What to ask. Everything the model needs, in one string.
     */
    prompt: string;
    /**
     * Model id. The caller picks the tier; keel deliberately
     * knows no model names, because that is the fact in this area that goes stale.
     */
    model: string;
    /**
     * Replaces the system prompt entirely.
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
 * @property {string} prompt What to ask. Everything the model needs, in one string.
 * @property {string} model Model id. The caller picks the tier; keel deliberately
 *   knows no model names, because that is the fact in this area that goes stale.
 * @property {string} [system] Replaces the system prompt entirely.
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
