/**
 * Where the suite's credentials live, and the three properties that decide it.
 *
 * **Outside every synced folder.** The apps' data is deliberately in Dropbox so a
 * desktop and a laptop share one board. A credential in that folder is a
 * credential in a directory with a sharing history, and one that follows the data
 * to every machine and every restore. So: `%APPDATA%`, per machine, never synced.
 *
 * **Outside every repository.** Nothing here is reachable by `git add -A`, which
 * is how the accidents actually happen - see the commit hook in `hooks/`, which
 * exists because an E2E harness's output got committed to a public repo and
 * stayed there for seven weeks.
 *
 * **One location for all of them.** The point is not the reading, which is a
 * handful of lines. It is that app number nine does not invent a ninth
 * convention, and that "where is that key" has one answer.
 *
 * A note on `%APPDATA%` specifically, because it bit this suite before: a
 * sandboxed process's *writes* under that folder are redirected into a private
 * per-package overlay the rest of the system never sees, while its *reads* fall
 * through to the real filesystem. That asymmetry ruined a day in Jot. Here it is
 * harmless by construction - this module only ever reads, so it always sees the
 * real file.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The per-machine override, for a path that is not under `%APPDATA%`. */
export const SECRETS_FILE_VARIABLE = 'KEEL_SECRETS_FILE'

/**
 * Work out which file to read.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ path: string, variable: string, overridden: boolean }}
 */
export function resolveSecretsFile({ env = process.env } = {}) {
  const override = env[SECRETS_FILE_VARIABLE]
  if (typeof override === 'string' && override.trim() !== '') {
    return { path: override.trim(), variable: SECRETS_FILE_VARIABLE, overridden: true }
  }

  // `homedir()` is the fallback for the non-Windows case rather than a real
  // target. The suite is Windows-only today; a missing `%APPDATA%` there means
  // something is very wrong, and landing in the home directory is a better
  // failure than joining onto `undefined`.
  const base = env.APPDATA ?? homedir()
  return {
    path: join(base, 'keel', 'secrets.json'),
    variable: SECRETS_FILE_VARIABLE,
    overridden: false
  }
}
