/**
 * The release plumbing every app in the suite had written out for itself.
 *
 * Tend's and Brief's scripts were the same 125 lines apart from the app's name.
 * Nib's was missing the dirty-tree check and, until it published a release that
 * quietly did nothing, the already-released check too. Loom's guards the tag
 * instead, because it releases from CI.
 *
 * What is shared is the guards and the diagnosis when something is locked. What
 * is not shared is the middle - build locally and publish, or tag and let CI
 * build - so this module deliberately supplies parts rather than one `release()`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export * from './checks.mjs'
export { stopRunningBuild, stopScript } from './processes.mjs'

/**
 * An `Exec` backed by a real synchronous spawn: trimmed stdout, throws on a
 * non-zero exit. stderr is left alone so gh's own messages still reach the
 * terminal.
 *
 * @param {string} root Working directory.
 * @returns {(command: string, args: string[]) => string}
 */
export function nodeExec(root) {
  return (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
}

/**
 * Name, version and tag from an app's package.json.
 *
 * @param {string} root
 * @returns {{ name: string, version: string, tag: string }}
 */
export function appMeta(root) {
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return { name, version, tag: `v${version}` }
}

/**
 * A GitHub token from the logged-in gh CLI.
 *
 * Read at release time rather than kept anywhere: a long-lived GH_TOKEN in a
 * shell profile or a dotfile is a credential with no expiry sitting in a place
 * that gets committed by accident.
 *
 * @param {(command: string, args: string[]) => string} exec
 * @returns {string}
 */
export function ghToken(exec) {
  let token = ''
  try {
    token = exec('gh', ['auth', 'token'])
  } catch {
    throw new Error('Could not get a token from `gh auth token` - is the gh CLI logged in?')
  }
  if (token === '') {
    throw new Error('`gh auth token` returned nothing.')
  }
  return token
}

/**
 * Clear build output directories, and say something useful when one is locked.
 *
 * `out/` in particular is not optional. electron-builder packages whatever is
 * already sitting there without a word of complaint, so a skipped clean ships the
 * previous build's code under a new version number - which is exactly what
 * happened to Jot on 2026-08-04.
 *
 * @param {string} root
 * @param {string[]} [directories]
 * @param {(message: string) => void} [log]
 */
export function clean(root, directories = ['out', 'dist'], log = console.log) {
  for (const directory of directories) {
    const path = join(root, directory)

    // Old installers are deleted rather than left to pile up: a folder holding
    // three versions makes it far too easy to hand someone the wrong one.
    if (existsSync(path)) {
      const stale = readdirSync(path).filter((file) =>
        ['.exe', '.blockmap', '.yml'].some((extension) => file.endsWith(extension))
      )
      if (stale.length > 0) {
        log(`Removing ${stale.length} file(s) from a previous build in ${directory}/.`)
      }
    }

    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      throw new Error(
        `Could not clear ${path}: ${error instanceof Error ? error.message : String(error)}\n\n` +
          'Something still holds a file there. A packaged build left running by the app\n' +
          'test harness is the usual cause - stopRunningBuild() clears exactly those.'
      )
    }
  }
  log(`Cleaned ${directories.map((directory) => `${directory}/`).join(' and ')}`)
}
