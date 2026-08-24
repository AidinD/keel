import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { ask, readAnswer, forgetClaudeBinary, resolveClaudeBinary, CLAUDE_BINARY_VARIABLE } from '../src/claude/index.mjs'

/**
 * A stand-in for a spawned `claude`, so the machinery around a call can be
 * exercised without spending tokens or needing the executable installed.
 *
 * Every one of these tests is a way a real call fails. None of them are
 * reachable from a happy-path test against the real binary, which is why the
 * parsing is a separate exported function in the first place.
 */
function fakeChild({ stdout = '', stderr = '', fail = null, silent = false }) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }

  queueMicrotask(() => {
    if (fail !== null) {
      child.emit('error', fail)
      return
    }
    if (silent) {
      return
    }
    if (stdout !== '') {
      child.stdout.emit('data', stdout)
    }
    if (stderr !== '') {
      child.stderr.emit('data', stderr)
    }
    child.emit('close', 0)
  })

  return child
}

/** The shape the CLI prints with `--output-format json`. */
function cliJson(extra) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...extra })
}

test('the binary resolution can be pointed at a stub', () => {
  const before = process.env[CLAUDE_BINARY_VARIABLE]
  process.env[CLAUDE_BINARY_VARIABLE] = 'C:\\stub\\claude.exe'
  forgetClaudeBinary()
  try {
    const resolved = resolveClaudeBinary()
    assert.equal(resolved.path, 'C:\\stub\\claude.exe')
    assert.equal(resolved.direct, true, 'an .exe can be spawned without a shell')
    assert.equal(resolved.reason, null)
  } finally {
    if (before === undefined) {
      delete process.env[CLAUDE_BINARY_VARIABLE]
    } else {
      process.env[CLAUDE_BINARY_VARIABLE] = before
    }
    forgetClaudeBinary()
  }
})

test('a structured answer comes back parsed', async () => {
  const answer = await ask({
    prompt: 'anything',
    model: 'test-model',
    schema: { type: 'object' },
    spawnImpl: () => fakeChild({ stdout: cliJson({ structured_output: { items: ['one'] }, total_cost_usd: 0.01 }) })
  })

  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, { items: ['one'] })
  assert.equal(answer.costUsd, 0.01)
})

test('the call is stripped of tools and MCP servers', async () => {
  /** @type {string[]} */
  let seen = []
  await ask({
    prompt: 'anything',
    model: 'test-model',
    spawnImpl: (_path, args) => {
      seen = args
      return fakeChild({ stdout: cliJson({ result: 'fine' }) })
    }
  })

  assert.ok(seen.includes('--strict-mcp-config'), 'nothing should be inherited from the machine config')
  assert.equal(seen[seen.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
  assert.equal(seen[seen.indexOf('--allowed-tools') + 1], '')
  assert.ok(!seen.includes('--bare'), '--bare would force API-key auth instead of the subscription')
})

test('it runs outside any project, so no CLAUDE.md is dragged into the question', async () => {
  /** @type {any} */
  let options
  await ask({
    prompt: 'anything',
    model: 'test-model',
    spawnImpl: (_path, _args, opts) => {
      options = opts
      return fakeChild({ stdout: cliJson({ result: 'fine' }) })
    }
  })

  assert.notEqual(options.cwd, process.cwd(), 'inheriting the caller cwd loads that repo instructions')
  assert.ok(typeof options.cwd === 'string' && options.cwd.length > 0)
})

test('a caller that wants a project context can still say so', async () => {
  /** @type {any} */
  let options
  await ask({
    prompt: 'anything',
    model: 'test-model',
    cwd: 'C:\\some\\repo',
    spawnImpl: (_path, _args, opts) => {
      options = opts
      return fakeChild({ stdout: cliJson({ result: 'fine' }) })
    }
  })

  assert.equal(options.cwd, 'C:\\some\\repo')
})

test('the prompt is one argument, so a space in it cannot split the call', async () => {
  /** @type {string[]} */
  let seen = []
  const prompt = 'Draft a brief for the conversation tomorrow'
  await ask({
    prompt,
    model: 'test-model',
    spawnImpl: (_path, args) => {
      seen = args
      return fakeChild({ stdout: cliJson({ result: 'fine' }) })
    }
  })

  assert.equal(seen[seen.indexOf('-p') + 1], prompt)
})

test('a hung call gives up and kills the child rather than dangling', async () => {
  /** @type {any} */
  let child
  const answer = await ask({
    prompt: 'anything',
    model: 'test-model',
    timeoutMs: 20,
    spawnImpl: () => {
      child = fakeChild({ silent: true })
      return child
    }
  })

  assert.equal(answer.ok, false)
  assert.match(answer.reason, /did not answer/)
  assert.equal(child.killed, true)
})

test('a timeout and the close that follows it resolve once, not twice', async () => {
  /** @type {any} */
  let child
  const answer = await ask({
    prompt: 'anything',
    model: 'test-model',
    timeoutMs: 20,
    spawnImpl: () => {
      child = fakeChild({ silent: true })
      return child
    }
  })

  // A killed child still emits close. If that were not guarded the promise
  // would settle a second time - silently, since a settled promise ignores it,
  // and the timer would leak.
  child.emit('close', 1)
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /did not answer/)
})

test('a missing executable is data, not a rejection', async () => {
  const answer = await ask({
    prompt: 'anything',
    model: 'test-model',
    spawnImpl: () => fakeChild({ fail: new Error('spawn claude ENOENT') })
  })

  assert.equal(answer.ok, false)
  assert.match(answer.reason, /ENOENT|not on the PATH/)
})

test('an empty prompt is refused before anything is spawned', async () => {
  let spawned = false
  const answer = await ask({
    prompt: '   ',
    model: 'test-model',
    spawnImpl: () => {
      spawned = true
      return fakeChild({})
    }
  })

  assert.equal(answer.ok, false)
  assert.equal(spawned, false)
})

test('the CLI reporting its own error is not read as an answer', () => {
  const answer = readAnswer({
    out: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }),
    err: '',
    model: 'test-model',
    schema: false
  })

  assert.equal(answer.ok, false)
  assert.match(answer.reason, /Credit balance/)
})

test('output that is not JSON is a reason, not a crash', () => {
  const answer = readAnswer({ out: 'Please log in first', err: '', model: 'test-model', schema: false })
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /not JSON/)
})

test('silence carries the tail of stderr, so the reason is actionable', () => {
  const answer = readAnswer({ out: '', err: 'line one\nInvalid API key', model: 'test-model', schema: false })
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /Invalid API key/)
})

test('a schema that produced nothing is not silently reported as success', () => {
  const answer = readAnswer({
    out: cliJson({ result: 'here is some prose instead' }),
    err: '',
    model: 'test-model',
    schema: true
  })

  assert.equal(answer.ok, false)
  assert.match(answer.reason, /requested shape/)
})

test('the model recorded is the one that answered, not the one asked for', () => {
  const answer = readAnswer({
    out: cliJson({ result: 'fine', modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10 } } }),
    err: '',
    model: 'claude-haiku-4-5',
    schema: false
  })

  assert.equal(answer.ok, true)
  assert.equal(answer.model, 'claude-haiku-4-5-20251001')
})
