/**
 * Reading a JSON file that a synced folder and other tools also touch.
 *
 * `stripBom` had been written out identically in five files across Tend and Brief
 * alone. It is one line, which is exactly why it kept being retyped - and exactly
 * why forgetting it once produces a parse error nobody can see, since a BOM is
 * invisible in every editor and `JSON.parse` refuses it.
 *
 * PowerShell is where the BOMs come from: `Out-File` and `>` write UTF-8 with a
 * BOM by default on Windows, so any data file an external script has touched may
 * have one.
 */

import { readFileSync } from 'node:fs'

/**
 * Drop a leading byte-order mark, if there is one.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/**
 * Read and parse a JSON file, reporting problems rather than throwing.
 *
 * A missing file and an unreadable one are different answers: absent means "there
 * is nothing here yet", which is normal on first run, while unparseable means
 * something is wrong and a person should be told. Returning the fallback for both
 * but only warning about the second is what lets a caller do the right thing
 * without a try/catch at every call site.
 *
 * @template T
 * @param {string} path
 * @param {object} options
 * @param {T} options.fallback Returned when the file is absent or unreadable.
 * @param {(message: string) => void} [options.onWarning] Called for an unreadable
 *   file. Not called for a missing one.
 * @param {string} [options.label] Name used in the warning. Defaults to the path.
 * @returns {{ value: T, missing: boolean, problem: string | null }}
 */
export function readJsonFile(path, { fallback, onWarning = () => {}, label }) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (code === 'ENOENT') {
      return { value: fallback, missing: true, problem: null }
    }
    const problem = `${label ?? path} could not be opened: ${describe(error)}`
    onWarning(problem)
    return { value: fallback, missing: false, problem }
  }

  try {
    return { value: JSON.parse(stripBom(raw)), missing: false, problem: null }
  } catch (error) {
    const problem = `${label ?? path} could not be read: ${describe(error)}`
    onWarning(problem)
    return { value: fallback, missing: false, problem }
  }
}

/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? error.message : String(error))
