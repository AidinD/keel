import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SECRETS_FILE_VARIABLE,
  decodeSecret,
  decodeText,
  openSecrets,
  resolveSecretsFile
} from '../src/secret/index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = () => mkdtempSync(join(tmpdir(), 'keel-secret-'))

/** Write a secrets file and hand back an env that points at it. */
function withSecrets(contents, encoding = 'utf8') {
  const path = join(scratch(), 'secrets.json')
  writeFileSync(path, typeof contents === 'string' ? Buffer.from(contents, encoding) : contents)
  return { env: { [SECRETS_FILE_VARIABLE]: path }, path }
}

test('the default location is outside every synced folder and every repo', () => {
  const resolved = resolveSecretsFile({ env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } })
  assert.equal(resolved.path, join('C:\\Users\\x\\AppData\\Roaming', 'keel', 'secrets.json'))
  assert.equal(resolved.overridden, false)
})

test('the override wins and is trimmed', () => {
  const resolved = resolveSecretsFile({
    env: { APPDATA: 'C:\\ignored', [SECRETS_FILE_VARIABLE]: '  D:\\keys\\secrets.json  ' }
  })
  assert.equal(resolved.path, 'D:\\keys\\secrets.json')
  assert.equal(resolved.overridden, true)
})

test('an all-whitespace override is not an override', () => {
  const resolved = resolveSecretsFile({ env: { APPDATA: 'C:\\a', [SECRETS_FILE_VARIABLE]: '   ' } })
  assert.equal(resolved.overridden, false)
})

// --- the three invisible failures ------------------------------------------

test('a byte-order mark never reaches the caller', () => {
  // The failure this prevents: the service answers 400 and explains nothing,
  // because the key it received starts with a character no editor shows.
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('sk-key', 'utf8')])
  assert.equal(decodeSecret(utf8Bom), 'sk-key')

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sk-key', 'utf16le')])
  assert.equal(decodeSecret(utf16le), 'sk-key')

  const utf16be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(Buffer.from('sk-key', 'utf16le')).swap16()
  ])
  assert.equal(decodeSecret(utf16be), 'sk-key')
})

test('UTF-16 with no mark is still read as UTF-16', () => {
  assert.equal(decodeSecret(Buffer.from('sk-key', 'utf16le')), 'sk-key')
})

test('a zero first byte is left as UTF-8 rather than guessed at', () => {
  // The detection keys on a zero in the *second* byte, which real text cannot
  // have. Anything else stays UTF-8, so the heuristic cannot corrupt a key.
  assert.equal(decodeText(Buffer.from([0x00, 0x00])), '\u0000\u0000')
})

test('an odd trailing byte does not throw', () => {
  // `swap16` refuses an odd length, and a malformed file should be a bad value,
  // never a crash on startup.
  const truncated = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x61, 0x00])])
  assert.doesNotThrow(() => decodeSecret(truncated))
})

test('the editor\'s trailing newline is trimmed', () => {
  assert.equal(decodeSecret(Buffer.from('sk-key\r\n', 'utf8')), 'sk-key')
  assert.equal(decodeSecret(Buffer.from('  sk-key  ', 'utf8')), 'sk-key')
})

test('the secrets file itself may be UTF-16, because Notepad offers it', () => {
  const json = JSON.stringify({ openai: 'sk-key' })
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
  const { env } = withSecrets(bytes)
  assert.equal(openSecrets({ app: 'brief', env }).get('openai').value, 'sk-key')
})

// --- reading ----------------------------------------------------------------

test('a string entry is readable by any app and says that it is', () => {
  const { env } = withSecrets(JSON.stringify({ openai: 'sk-key' }))
  const result = openSecrets({ app: 'anything', env }).get('openai')
  assert.equal(result.value, 'sk-key')
  assert.equal(result.found, true)
  assert.equal(result.restricted, false)
  assert.equal(result.reason, null)
})

test('a secret can live in its own file', () => {
  const dir = scratch()
  const keyFile = join(dir, 'router.txt')
  writeFileSync(keyFile, Buffer.from('hunter2\r\n', 'utf8'))
  const { env } = withSecrets(JSON.stringify({ router: { file: keyFile } }))
  assert.equal(openSecrets({ app: 'nudge', env }).get('router').value, 'hunter2')
})

test('a missing file is normal, and says where it would go', () => {
  const env = { [SECRETS_FILE_VARIABLE]: join(scratch(), 'absent.json') }
  const secrets = openSecrets({ app: 'brief', env })
  assert.equal(secrets.missing, true)
  assert.equal(secrets.problem, null)
  const result = secrets.get('openai')
  assert.equal(result.found, false)
  assert.match(result.reason ?? '', /there is no secrets file at .*absent\.json/)
})

test('an unreadable file is a problem, and a missing one is not', () => {
  const { env, path } = withSecrets('{ not json')
  const secrets = openSecrets({ app: 'brief', env })
  assert.equal(secrets.missing, false)
  assert.match(secrets.problem ?? '', /is not readable as JSON/)
  // Every get repeats the reason rather than returning a bare null, so a caller
  // that never checks `problem` still gets told.
  assert.match(secrets.get('openai').reason ?? '', /is not readable as JSON/)
  assert.ok(secrets.problem?.includes(path))
})

test('a pointed-at file that is not there names the path', () => {
  const missing = join(scratch(), 'gone.txt')
  const { env } = withSecrets(JSON.stringify({ router: { file: missing } }))
  const result = openSecrets({ app: 'nudge', env }).get('router')
  assert.equal(result.found, false)
  assert.match(result.reason ?? '', /there is no file there/)
  assert.ok(result.reason?.includes(missing))
})

test('empty is not found, and says so rather than returning an empty string', () => {
  const { env } = withSecrets(JSON.stringify({ openai: '   ' }))
  const result = openSecrets({ app: 'brief', env }).get('openai')
  assert.equal(result.value, null)
  assert.match(result.reason ?? '', /there but empty/)
})

test('two lines pasted where one was meant is refused with a reason', () => {
  const { env } = withSecrets(JSON.stringify({ openai: 'sk-one\nsk-two' }))
  const result = openSecrets({ app: 'brief', env }).get('openai')
  assert.equal(result.found, false)
  assert.match(result.reason ?? '', /line break/)
})

test('a genuinely multi-line secret is available on request', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  const { env } = withSecrets(JSON.stringify({ signing: pem }))
  const secrets = openSecrets({ app: 'loom', env })
  assert.equal(secrets.get('signing').found, false)
  assert.equal(secrets.get('signing', { allowMultiline: true }).value, pem)
})

test('a malformed entry names itself instead of being skipped', () => {
  const cases = [
    { openai: 42 },
    { openai: {} },
    { openai: { value: 'a', file: 'b' } },
    // A typo in the permission list must fail closed. Read as "no list", this
    // would have meant "any app may read it".
    { openai: { value: 'a', apps: 'brief' } },
    { openai: { value: 'a', apps: ['brief', 7] } }
  ]
  for (const bad of cases) {
    const { env } = withSecrets(JSON.stringify(bad))
    assert.match(openSecrets({ app: 'brief', env }).problem ?? '', /"openai" should be/)
  }
})

test('a top-level array is not a secrets file', () => {
  const { env } = withSecrets(JSON.stringify(['sk-key']))
  assert.match(openSecrets({ app: 'brief', env }).problem ?? '', /object of named secrets/)
})

// --- per-app permission -----------------------------------------------------

test('an entry can name the apps it is for', () => {
  const { env } = withSecrets(JSON.stringify({ openai: { value: 'sk-key', apps: ['brief'] } }))
  assert.equal(openSecrets({ app: 'brief', env }).get('openai').value, 'sk-key')

  const denied = openSecrets({ app: 'helm', env }).get('openai')
  assert.equal(denied.value, null)
  assert.equal(denied.restricted, true)
  assert.match(denied.reason ?? '', /not shared with helm - the entry allows brief/)
})

test('the app name is compared case- and whitespace-insensitively', () => {
  const { env } = withSecrets(JSON.stringify({ openai: { value: 'sk-key', apps: [' Brief '] } }))
  assert.equal(openSecrets({ app: 'brief', env }).get('openai').value, 'sk-key')
})

test('an empty apps list is the off switch, not a free-for-all', () => {
  const { env } = withSecrets(JSON.stringify({ openai: { value: 'sk-key', apps: [] } }))
  const result = openSecrets({ app: 'brief', env }).get('openai')
  assert.equal(result.found, false)
  assert.match(result.reason ?? '', /allows no app at all/)
})

test('a caller with no name is refused loudly', () => {
  // Permission that can be skipped by leaving an argument out is not permission,
  // so this throws rather than reporting - it is a bug in the calling code.
  const { env } = withSecrets(JSON.stringify({ openai: 'sk-key' }))
  assert.throws(() => openSecrets({ app: '', env }), /needs the name of the app/)
  assert.throws(
    () => openSecrets(/** @type {never} */ ({ env })),
    /needs the name of the app/
  )
})

// --- the inventory ----------------------------------------------------------

test('names() describes the entries without handing over any values', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'router.txt'), 'hunter2')
  const { env } = withSecrets(
    JSON.stringify({
      openai: { value: 'sk-key', apps: ['brief'] },
      router: { file: join(dir, 'router.txt') },
      helmOnly: { value: 'nope', apps: ['helm'] }
    })
  )

  const summaries = openSecrets({ app: 'brief', env }).names()
  assert.deepEqual(
    summaries.map(({ name, source, readable, apps }) => ({ name, source, readable, apps })),
    [
      { name: 'openai', source: 'value', readable: true, apps: ['brief'] },
      { name: 'router', source: 'file', readable: true, apps: null },
      { name: 'helmOnly', source: 'value', readable: false, apps: ['helm'] }
    ]
  )

  // A settings window can render this. It must never be a way around the
  // permission check, or the check is decoration.
  const serialised = JSON.stringify(summaries)
  assert.ok(!serialised.includes('sk-key'))
  assert.ok(!serialised.includes('hunter2'))
  assert.ok(!serialised.includes('nope'))
})

// --- the guarantee ----------------------------------------------------------

test('the module cannot write, and that is enforced rather than intended', () => {
  // The whole promise is that a credential never ends up anywhere the person did
  // not put it. A comment saying so is worth nothing the day someone adds a
  // convenient `save()`; this is what makes it hold.
  const written =
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|rmSync|rmdirSync|truncate|chmod|openSync|exec|execFile|execFileSync|spawn|spawnSync|fetch)\b/

  const files = readdirSync(join(root, 'src', 'secret'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = readFileSync(join(root, 'src', 'secret', file), 'utf-8')
    assert.equal(
      written.test(source),
      false,
      `src/secret/${file} names a write or a network call - see read.mjs on why there is no write path`
    )
  }
})

test('nothing outside reading is imported from node', () => {
  // A narrower version of the test above: the guarantee is easier to keep if the
  // module simply never holds a tool that could break it.
  const allowed = new Map([
    ['node:fs', ['readFileSync']],
    ['node:os', ['homedir']],
    ['node:path', ['join']]
  ])

  for (const file of readdirSync(join(root, 'src', 'secret'))) {
    const source = readFileSync(join(root, 'src', 'secret', file), 'utf-8')
    for (const match of source.matchAll(/import \{([^}]+)\} from '(node:[^']+)'/g)) {
      const bindings = match[1].split(',').map((name) => name.trim())
      assert.deepEqual(bindings, allowed.get(match[2]), `src/secret/${file} imports ${match[2]}`)
    }
  }
})
