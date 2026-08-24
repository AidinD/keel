/**
 * Stop the app running out of one folder, and nothing else.
 *
 * `dist/` cannot be cleared while a packaged build holds a file in it, and an app
 * test harness starts exactly such a process - so packaging and releasing both
 * have to clear the way first.
 *
 * The match is on the executable's path, deliberately. Matching by name also
 * closes the installed copy, and other Electron apps are usually running: a broad
 * kill takes down whatever someone is working in. That has happened - a filter on
 * a command-line flag rather than a path stopped 19 processes at once, because
 * Chromium passes its flags down to every child it spawns. Path matching is the
 * narrowest thing that actually works.
 *
 * PowerShell does the looking, so there is no process-inspection dependency here,
 * and the whole thing is a no-op off Windows. The spawn is injectable, which is
 * how the test checks the match is narrow without stopping anything.
 */

import { execFileSync } from 'node:child_process'

/**
 * Build the PowerShell one-liner. Exported so a test can read it without
 * starting a process, which is the only way to check the matching is narrow.
 *
 * @param {string} folder Absolute path.
 * @returns {string}
 */
export function stopScript(folder) {
  // Single-quoted PowerShell strings take backslashes literally, so a Windows
  // path needs no escaping beyond doubling any quote inside it. Statements are
  // separated with semicolons: joining the lines with spaces is a parser error.
  const root = folder.replace(/'/g, "''")
  return [
    `$root = '${root}'`,
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root) } | ForEach-Object { Write-Host (\'Stopping pid \' + $_.ProcessId + \': \' + $_.ExecutablePath); Stop-Process -Id $_.ProcessId -Force }'
  ].join('; ')
}

/**
 * @param {string} folder Absolute path. Only processes whose executable lives
 *   inside it are stopped.
 * @param {object} [deps]
 * @param {(command: string, args: string[]) => void} [deps.spawn] Injected so a
 *   test can assert what would be run. Defaults to a real synchronous spawn.
 * @param {(message: string) => void} [deps.log]
 * @param {string} [deps.platform] Defaults to `process.platform`.
 */
export function stopRunningBuild(folder, { spawn, log = console.log, platform } = {}) {
  if ((platform ?? process.platform) !== 'win32') {
    return
  }

  const run = spawn ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit' }))

  try {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', stopScript(folder)])
  } catch (error) {
    log(`Could not check for running builds: ${error instanceof Error ? error.message : String(error)}`)
  }
}
