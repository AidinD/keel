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

import { execFileSync } from 'node:child_process'

/**
 * Overrides resolution. Set by a test to point at a stub, so the machinery
 * around a call can be exercised without spending tokens on every suite run.
 */
export const CLAUDE_BINARY_VARIABLE = 'KEEL_CLAUDE_BIN'

/** @type {{ path: string, direct: boolean, reason: string | null } | null} */
let cached = null

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
export function resolveClaudeBinary({ fresh = false } = {}) {
  if (cached !== null && !fresh) {
    return cached
  }

  const override = process.env[CLAUDE_BINARY_VARIABLE]
  if (override) {
    cached = { path: override, direct: override.toLowerCase().endsWith('.exe'), reason: null }
    return cached
  }

  /** @type {string[]} */
  let candidates = []
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    candidates = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    candidates = []
  }

  if (candidates.length === 0) {
    cached = {
      path: 'claude',
      direct: false,
      reason:
        'Claude Code is not on the PATH. `where claude` (or `which claude`) found nothing, ' +
        'so anything that needs a model is off.'
    }
    return cached
  }

  // Prefer a real executable. On Windows the same install often appears twice -
  // once as a .cmd shim and once as the .exe it wraps - and only the second can
  // be spawned without a shell.
  const exact = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'))
  if (exact !== undefined || process.platform !== 'win32') {
    cached = { path: exact ?? candidates[0], direct: true, reason: null }
    return cached
  }

  cached = {
    path: candidates[0],
    direct: false,
    reason:
      `Only a shim was found (${candidates[0]}), not a real claude.exe. Running it needs a ` +
      'shell, and a shell on Windows drops everything in the prompt after the first space.'
  }
  return cached
}

/** Forget the cached resolution. For tests, and for a settings screen that retries. */
export function forgetClaudeBinary() {
  cached = null
}
