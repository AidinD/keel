/**
 * One place the suite's credentials live, and one way to read them.
 *
 * The value here is not the reading - that is forty lines. It is that the ninth
 * app does not invent a ninth convention, that "where is that key" has one answer,
 * and that the three ways a hand-saved key fails invisibly are handled once
 * instead of remembered eight times.
 *
 * This module can only read. See `read.mjs` for why that is a guarantee rather
 * than an omission, and what was rejected to get here.
 *
 * ```js
 * import { openSecrets } from 'keel/secret'
 *
 * const secrets = openSecrets({ app: 'brief' })
 * const key = secrets.get('openai')
 * if (!key.found) {
 *   warn(key.reason)   // already a sentence a person can act on
 * }
 * ```
 */

export { decodeSecret, decodeText } from './decode.mjs'
export { SECRETS_FILE_VARIABLE, resolveSecretsFile } from './location.mjs'
export { openSecrets } from './read.mjs'
