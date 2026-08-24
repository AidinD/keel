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
export type Secret = {
    /**
     * The credential, or null when there isn't one.
     */
    value: string | null;
    found: boolean;
    /**
     * Why not, in words a person can act on.
     */
    reason: string | null;
    /**
     * Whether the entry names the apps allowed to read it.
     */
    restricted: boolean;
};
export type SecretSummary = {
    name: string;
    /**
     * Null when the entry is readable by any app.
     */
    apps: string[] | null;
    source: 'value' | 'file';
    /**
     * Whether *this* app can read it, right now.
     */
    readable: boolean;
    problem: string | null;
};
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
export declare function openSecrets({ app, env }: {
    app: string;
    env?: NodeJS.ProcessEnv;
}): {
    path: string;
    overridden: boolean;
    missing: boolean;
    problem: string | null;
    get: (name: string, options?: {
        allowMultiline?: boolean;
    }) => Secret;
    names: () => SecretSummary[];
};
export type Entry = {
    value: string | null;
    file: string | null;
    apps: string[] | null;
};
