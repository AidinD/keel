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

import { spawn } from 'node:child_process'

import { resolveClaudeBinary } from './binary.mjs'

/** A model call that has not answered in this long is not going to. */
export const DEFAULT_TIMEOUT_MS = 90_000

/**
 * A backstop against unbounded accumulation if something unexpected keeps
 * writing to stdout. A real structured answer fits in a few kilobytes.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * @typedef {object} AskOptions
 * @property {string} prompt What to ask. Everything the model needs, in one string.
 * @property {string} model Model id. The caller picks the tier; keel deliberately
 *   knows no model names, because that is the fact in this area that goes stale.
 * @property {string} [system] Replaces the system prompt entirely.
 * @property {"low" | "medium" | "high"} [effort]
 * @property {Record<string, any>} [schema] JSON Schema. Given one, the answer is
 *   validated by the CLI and comes back parsed.
 * @property {string} [cwd] Where to run. Affects which project settings load.
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
export function ask({
  prompt,
  model,
  system,
  effort,
  schema,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn
}) {
  return new Promise((resolve) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      resolve({ ok: false, reason: 'Nothing was asked - the prompt was empty.' })
      return
    }

    const binary = resolveClaudeBinary()

    const args = ['-p', prompt, '--model', model, '--output-format', 'json']
    if (schema !== undefined) {
      args.push('--json-schema', JSON.stringify(schema))
    }
    if (system !== undefined) {
      args.push('--system-prompt', system)
    }
    if (effort !== undefined) {
      args.push('--effort', effort)
    }
    // No tools, no MCP servers, nothing inherited from the machine's config.
    args.push('--allowed-tools', '', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config')

    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawnImpl(binary.path, args, {
        cwd,
        // Only where resolution failed to find a real executable. The prompt is
        // then at the mercy of the shell's tokenising, which is why
        // `binary.reason` exists and why a caller should surface it.
        shell: !binary.direct,
        env: process.env,
        windowsHide: true
      })
    } catch (error) {
      resolve({ ok: false, reason: `Could not start Claude Code: ${message(error)}` })
      return
    }

    let out = ''
    let err = ''
    let settled = false

    /**
     * Resolve exactly once and always clear the timer. Without the guard the
     * timeout kills the child, which then emits its own `close`, and a promise
     * that has already resolved quietly resolves again.
     *
     * @param {AskResult} result
     */
    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        reason: `Claude Code did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (out.length < MAX_OUTPUT_BYTES) {
        out += String(chunk)
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (err.length < 8_000) {
        err += String(chunk)
      }
    })

    child.on('error', (error) => {
      finish({ ok: false, reason: binary.reason ?? `Could not run Claude Code: ${message(error)}` })
    })

    child.on('close', () => {
      finish(readAnswer({ out, err, model, schema: schema !== undefined }))
    })
  })
}

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
export function readAnswer({ out, err, model, schema }) {
  if (out.trim() === '') {
    const tail = err.trim().split(/\r?\n/).slice(-3).join(' ')
    return {
      ok: false,
      reason: tail === '' ? 'Claude Code printed nothing at all.' : `Claude Code failed: ${tail}`
    }
  }

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    return { ok: false, reason: 'Claude Code answered with something that is not JSON.' }
  }

  if (parsed?.is_error === true) {
    const detail = String(parsed.result ?? parsed.subtype ?? 'no detail')
    return { ok: false, reason: `Claude Code reported an error: ${detail}` }
  }

  const value = schema ? parsed?.structured_output : parsed?.result
  if (value === undefined || value === null) {
    return {
      ok: false,
      reason: schema
        ? 'Claude Code answered but produced nothing matching the requested shape.'
        : 'Claude Code answered but the reply was empty.'
    }
  }

  return {
    ok: true,
    value,
    model: reportedModel(parsed) ?? model,
    costUsd: typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : null
  }
}

/**
 * Which model actually answered.
 *
 * Asked for rather than assumed: what a caller requests is a name like
 * `claude-haiku-4-5`, and what ran is a dated build of it. Anything the model
 * writes gets stamped with this, and a stamp that records the request rather
 * than the answer is a stamp that can be wrong.
 *
 * @param {any} parsed
 * @returns {string | null}
 */
function reportedModel(parsed) {
  const usage = parsed?.modelUsage
  if (usage === null || typeof usage !== 'object') {
    return null
  }
  const names = Object.keys(usage)
  return names.length === 1 ? names[0] : null
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
