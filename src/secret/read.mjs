/**
 * Reading a credential, and refusing to do anything else with one.
 *
 * ## The shape, and why it is this small
 *
 * One file, read only, returning a string or a plain reason there isn't one. No
 * writing, no vault, no network. Each of those was considered and each was
 * rejected for a specific reason rather than for being hard:
 *
 * **Not the operating system's own credential store** (`safeStorage`, the keychain
 * bindings). On Windows it encrypts with the account *on this machine*, so the
 * stored blob cannot be read on the second one - and this suite is deliberately
 * two machines sharing one synced board. Something that looks portable and
 * silently is not is worse than something plainly local. The deeper reason: an app
 * that starts without anyone typing a password must be able to decrypt on its own,
 * so anything running as that user can decrypt too. Encryption at rest here
 * protects against an accidental *file read* - a stray script, a backup, a synced
 * folder - and against nothing else. A path outside every synced folder and every
 * repository already covers that, at a fraction of the moving parts.
 *
 * **Not a hosted secrets manager.** Bitwarden was the candidate, and its password
 * manager command line cannot serve this: unlocking needs the master password and
 * hands back a session that dies with the terminal, which is exactly wrong for an
 * app that starts with Windows. Its Secrets Manager machine-account tokens do
 * solve that, and then the token itself is a credential in plaintext on disk - N
 * secrets become one, which is a real gain, bought with a network call on every app
 * start and a cache for when it fails. The arrangement that gets the gain without
 * the cost is organisational rather than technical: the password manager stays the
 * source of truth a person edits, and this file is the local copy pasted in once
 * per machine.
 *
 * **No write path at all.** A credential must never end up anywhere the person did
 * not put it themselves, and the cheapest way to guarantee that is a module that
 * cannot write. `test/secret.test.mjs` reads this source and fails if a write API
 * ever appears in it. Rotating tokens - the kind the app obtains and the provider
 * replaces - genuinely need writing and are deliberately not served here; that is
 * a different mechanism with a different threat model, and it waits for a real
 * consumer.
 *
 * ## Per-app permission
 *
 * `openSecrets` requires the caller to name itself, and an entry may list which
 * apps it is for. The idea is taken from Automic Vault, which gates on *what is
 * being done* rather than only on who is asking - it will pass `gh issue list`
 * and stop `gh auth token`. That tool is macOS-only and unusable here, but the
 * weakest useful version of its idea is five lines: the same key handed to
 * everything is a key whose misuse is invisible, and naming the caller is what
 * makes a wrong reader show up as a refusal instead of as nothing at all.
 *
 * **The name is self-declared, so this is a discipline aid and not a boundary.**
 * Any code that can read the file can also pass `app: 'brief'` and get whatever
 * Brief may have. Within one author's own suite that is the whole value - it turns
 * a wrong reader into a visible refusal, and it documents intent at the call site.
 * It is worth nothing against code that wants the key: enforcing it would need the
 * operating system to say which binary is asking, which is precisely what Automic
 * Vault does with verified launchers on macOS and which has no cheap Windows
 * equivalent. The rule that follows: **never put a secret in this file that some
 * process on this machine must not have.** Everything here is readable by anything
 * running as this user, and the `apps` list does not change that.
 *
 * ## The file
 *
 * ```json
 * {
 *   "openai": { "value": "sk-...", "apps": ["brief"] },
 *   "router": { "file": "D:\\keys\\router.txt" },
 *   "scratch": "a plain string, readable by any app"
 * }
 * ```
 *
 * A string is the shorthand for "any app may read this", and the result says so,
 * so an app can surface it. `"apps": []` is the off switch - the entry stays
 * documented and nothing may read it.
 */

import { readFileSync } from 'node:fs'

import { decodeSecret, decodeText } from './decode.mjs'
import { resolveSecretsFile } from './location.mjs'

/**
 * @typedef {object} Secret
 * @property {string | null} value The credential, or null when there isn't one.
 * @property {boolean} found
 * @property {string | null} reason Why not, in words a person can act on.
 * @property {boolean} restricted Whether the entry names the apps allowed to read it.
 */

/**
 * @typedef {object} SecretSummary
 * @property {string} name
 * @property {string[] | null} apps Null when the entry is readable by any app.
 * @property {'value' | 'file'} source
 * @property {boolean} readable Whether *this* app can read it, right now.
 * @property {string | null} problem
 */

/**
 * Open the secrets file for one app.
 *
 * The file is read once, here. Call this again to pick up an edit - which is what
 * a "test this connection" button in a settings window should do, since the whole
 * point of a hand-edited file is that it changes without a rebuild.
 *
 * A missing file is not a problem: it is the normal state of a machine where
 * nothing needs a credential yet. An unreadable one is a problem and says so.
 *
 * @param {object} options
 * @param {string} options.app Who is asking, e.g. `'brief'`. Required on purpose.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{
 *   path: string,
 *   overridden: boolean,
 *   missing: boolean,
 *   problem: string | null,
 *   get: (name: string, options?: { allowMultiline?: boolean }) => Secret,
 *   names: () => SecretSummary[]
 * }}
 */
export function openSecrets({ app, env = process.env }) {
  if (typeof app !== 'string' || app.trim() === '') {
    // Thrown rather than reported: a caller with no name is a mistake in the
    // code, not a state the machine can be in, and permission that can be
    // skipped by omission is not permission.
    throw new TypeError('openSecrets needs the name of the app that is asking')
  }

  const asking = app.trim()
  const { path, overridden } = resolveSecretsFile({ env })
  const loaded = load(path)
  const entries = loaded.entries

  /** @type {(name: string, options?: { allowMultiline?: boolean }) => Secret} */
  const get = (name, { allowMultiline = false } = {}) => {
    if (loaded.problem !== null) {
      return { value: null, found: false, reason: loaded.problem, restricted: false }
    }

    const entry = entries.get(name)
    if (entry === undefined) {
      const reason = loaded.missing
        ? `there is no secrets file at ${path}, so "${name}" has nowhere to be`
        : `${path} has no entry called "${name}"`
      return { value: null, found: false, reason, restricted: false }
    }

    const restricted = entry.apps !== null
    if (entry.apps !== null && !entry.apps.some((allowed) => sameApp(allowed, asking))) {
      const allowed = entry.apps.length === 0 ? 'no app at all' : entry.apps.join(', ')
      return {
        value: null,
        found: false,
        reason: `"${name}" is not shared with ${asking} - the entry allows ${allowed}`,
        restricted
      }
    }

    const resolved = resolve(entry, name, allowMultiline)
    return { ...resolved, restricted }
  }

  /** @type {() => SecretSummary[]} */
  const names = () =>
    [...entries.entries()].map(([name, entry]) => {
      const attempt = get(name)
      return {
        name,
        apps: entry.apps,
        source: entry.file === null ? /** @type {const} */ ('value') : /** @type {const} */ ('file'),
        readable: attempt.found,
        problem: attempt.reason
      }
    })

  return { path, overridden, missing: loaded.missing, problem: loaded.problem, get, names }
}

/**
 * @typedef {object} Entry
 * @property {string | null} value
 * @property {string | null} file
 * @property {string[] | null} apps
 */

/**
 * Read and validate the file itself.
 *
 * Deliberately not `readJsonFile` from `keel/storage`: that one reads as UTF-8,
 * and this is the one file in the suite most likely to have been saved by hand
 * from Notepad, where the encoding dropdown is right there.
 *
 * @param {string} path
 * @returns {{ entries: Map<string, Entry>, missing: boolean, problem: string | null }}
 */
function load(path) {
  const empty = new Map()

  /** @type {Uint8Array} */
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (code === 'ENOENT') {
      return { entries: empty, missing: true, problem: null }
    }
    return {
      entries: empty,
      missing: false,
      problem: `${path} could not be opened: ${describe(error)}`
    }
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(decodeText(bytes).trim())
  } catch (error) {
    return {
      entries: empty,
      missing: false,
      problem: `${path} is not readable as JSON: ${describe(error)}`
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      entries: empty,
      missing: false,
      problem: `${path} should hold an object of named secrets`
    }
  }

  /** @type {Map<string, Entry>} */
  const entries = new Map()
  for (const [name, raw] of Object.entries(parsed)) {
    const entry = readEntry(raw)
    if (entry === null) {
      return {
        entries: empty,
        missing: false,
        problem: `${path}: "${name}" should be a string, or an object with a value or a file`
      }
    }
    entries.set(name, entry)
  }

  return { entries, missing: false, problem: null }
}

/**
 * @param {unknown} raw
 * @returns {Entry | null} Null when the entry is malformed.
 */
function readEntry(raw) {
  if (typeof raw === 'string') {
    return { value: raw, file: null, apps: null }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const record = /** @type {Record<string, unknown>} */ (raw)
  const value = typeof record.value === 'string' ? record.value : null
  const file = typeof record.file === 'string' ? record.file : null
  if (value === null && file === null) {
    return null
  }
  if (value !== null && file !== null) {
    return null
  }

  // A malformed `apps` is refused rather than ignored. `"apps": "brief"` is an
  // easy thing to hand-write, and ignoring it would silently mean "any app may
  // read this" - a typo must never fail in the permissive direction.
  if (record.apps === undefined) {
    return { value, file, apps: null }
  }
  if (!Array.isArray(record.apps)) {
    return null
  }
  const listed = /** @type {unknown[]} */ (record.apps)
  const apps = /** @type {string[]} */ (listed.filter((name) => typeof name === 'string'))
  if (apps.length !== listed.length) {
    return null
  }

  return { value, file, apps }
}

/**
 * Turn an entry into the credential, or into the reason there isn't one.
 *
 * @param {Entry} entry
 * @param {string} name
 * @param {boolean} allowMultiline
 * @returns {{ value: string | null, found: boolean, reason: string | null }}
 */
function resolve(entry, name, allowMultiline) {
  /** @type {string} */
  let text
  if (entry.file === null) {
    text = (entry.value ?? '').trim()
  } else {
    try {
      text = decodeSecret(readFileSync(entry.file))
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      const reason =
        code === 'ENOENT'
          ? `"${name}" points at ${entry.file}, and there is no file there`
          : `"${name}" points at ${entry.file}, which could not be opened: ${describe(error)}`
      return { value: null, found: false, reason }
    }
  }

  if (text === '') {
    return { value: null, found: false, reason: `"${name}" is there but empty` }
  }

  // A credential with a line break inside it is almost always two lines pasted
  // where one was meant, and it fails the same invisible way a byte-order mark
  // does: the service rejects it and explains nothing. Refused with a reason
  // instead. Genuinely multi-line secrets exist - a PEM-encoded private key is
  // one - so the caller can say so.
  if (!allowMultiline && /[\r\n]/.test(text)) {
    return {
      value: null,
      found: false,
      reason: `"${name}" contains a line break, so it is probably more than just the secret`
    }
  }

  return { value: text, found: true, reason: null }
}

/** @param {string} a @param {string} b */
const sameApp = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? error.message : String(error))
