/**
 * whisper.cpp, shared by the apps in the suite.
 *
 * Promoted here from Helm, which had it first and proved it: on an RTX 3070 an
 * 11-second clip transcribes in 849ms of GPU work - about thirteen times faster
 * than real time, so a 45-minute meeting is a few minutes rather than a few
 * hours. The binary is spawned as a process rather than linked as a native
 * addon: no compile step, no rebuild per Electron version, and a crash in it
 * cannot take an app's window down.
 *
 * ## Why this lives in keel and the files do not
 *
 * The CUDA DLLs and the model weights are about 1.5GB. That belongs nowhere near
 * a git repository - see the hooks in this package for what a stray binary in a
 * public repo costs - so the payload sits OUTSIDE every repo and this module only
 * resolves the path to it. Same split the suite already uses for its data
 * directories: the code is versioned, the content is not.
 *
 * ## Two models, because one cannot do both languages
 *
 * The Swedish model is KBLab's Swedish-specialised checkpoint, and it is so
 * specialised that it transcribes ENGLISH speech into Swedish words - measured,
 * not assumed: fed an English clip with `-l en` it returned Swedish. So the
 * language is not a flag on one model, it selects which model runs.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Model file per language. The names are what is actually on disk today. */
/** @typedef {'sv' | 'en'} WhisperLanguage */

/** @type {Record<WhisperLanguage, string>} */
const MODELS = {
  sv: 'ggml-model-q5_0.bin',
  en: 'ggml-en.bin'
}

/**
 * Where the binary and the models live.
 *
 * `WHISPER_DIR` first, so a machine that keeps them elsewhere - or a test - can
 * say so. Then the folder beside the checked-out repos, which is where they
 * belong: inside none of them, reachable from all of them.
 */
/**
 * Everywhere the payload might be, best first.
 *
 * The first version walked three levels up from this file and returned that. It
 * is right in a checkout - keel/src/whisper up to the folder holding every repo -
 * and wrong in every installed app: packaged, this module sits inside
 * `app.asar/node_modules/keel/src/whisper`, so the same walk points at
 * `app.asar/node_modules/.whisper`, which does not exist and never will. Helm
 * shipped that way for months and nobody noticed, because the person running it
 * runs a checkout.
 *
 * So this answers with candidates and lets `whisperRoot` pick the one that is
 * really there. The order is deliberate: an explicit setting, then whatever the
 * app knows about itself, then where an installed app can keep 1.5GB, then the
 * checkout.
 *
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string[]}
 */
export function whisperCandidates({ env = process.env, roots = [] } = {}) {
  /** @type {string[]} */
  const found = []
  /** @param {string | undefined} path */
  const add = (path) => {
    if (typeof path === 'string' && path.trim().length > 0 && !found.includes(path)) {
      found.push(path)
    }
  }

  add(env.WHISPER_DIR?.trim())
  // Whatever the app itself knows - its own userData folder, typically. keel
  // cannot work this out: it has no idea which app is asking.
  for (const root of roots) {
    add(root)
  }
  // Where an installed app can keep something this size without asking.
  if (env.LOCALAPPDATA) {
    add(join(env.LOCALAPPDATA, 'whisper'))
  }
  // The checkout layout: keel/src/whisper -> keel/src -> keel -> the repo folder.
  add(resolve(here, '..', '..', '..', '.whisper'))
  return found
}

/**
 * Where the binary and the models actually are.
 *
 * The first candidate that holds `whisper-cli.exe`; when none do, the first
 * candidate anyway, so a caller has a path to name in its error. "Not in <path>"
 * can be acted on and "not found" cannot.
 *
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string}
 */
export function whisperRoot(options = {}) {
  /*
   * An explicit setting is the answer, right or wrong.
   *
   * Searching past a WHISPER_DIR that does not hold the engine would mean
   * somebody points the app at a new folder, gets no error, and keeps using the
   * old one - which is precisely the failure this suite spent a day chasing in
   * two other apps. A wrong setting must produce a complaint about that setting,
   * not a quiet fallback to a guess that happens to work on this machine.
   */
  const { env = process.env } = options
  const explicit = env.WHISPER_DIR?.trim()
  if (explicit) {
    return explicit
  }

  const candidates = whisperCandidates(options)
  const installed = candidates.find((candidate) =>
    existsSync(join(candidate, 'Release', 'whisper-cli.exe'))
  )
  return installed ?? candidates[0] ?? ''
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string}
 */
export function binaryPath(options) {
  return join(whisperRoot(options), 'Release', 'whisper-cli.exe')
}

/**
 * @param {WhisperLanguage} language
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string}
 */
export function modelPath(language, options) {
  const name = MODELS[language]
  if (name === undefined) {
    throw new Error(`No whisper model for language "${language}". Known: ${Object.keys(MODELS).join(', ')}`)
  }
  return join(whisperRoot(options), name)
}

/**
 * Whether transcription can run for a language, and if not, why.
 *
 * Returns a reason rather than a bare false: "not installed" and "installed but
 * the English model is missing" need different things from the person reading it,
 * and an app that only knows "unavailable" has to guess which to say.
 */
/**
 * @param {WhisperLanguage} language
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {{ ready: true, root: string, binary: string, model: string }
 *   | { ready: false, why: string, root: string, model?: string }}
 */
export function whisperStatus(language, options = {}) {
  const { env = process.env } = options
  const root = whisperRoot(options)
  const binary = binaryPath(options)
  if (!existsSync(binary)) {
    const looked = whisperCandidates(options)
    return {
      ready: false,
      why:
        `whisper-cli.exe is not in ${root}` +
        (looked.length > 1 ? ` (${looked.length} places tried)` : '') +
        (env.WHISPER_DIR
          ? '. WHISPER_DIR is set to that path - point it somewhere else, or unset it to search the usual places.'
          : '. Set WHISPER_DIR to the folder holding Release/ and the models.'),
      root
    }
  }
  let model
  try {
    model = modelPath(language, options)
  } catch (error) {
    return { ready: false, why: error instanceof Error ? error.message : String(error), root }
  }
  if (!existsSync(model)) {
    return { ready: false, why: `the ${language} model is not in ${root}`, root, model }
  }
  return { ready: true, root, binary, model }
}

/** `[00:00:03.100 --> 00:00:06.000]  text` - what whisper-cli prints per segment. */
const SEGMENT = /^\[(\d{2}:\d{2}:\d{2})\.\d{3} --> (\d{2}:\d{2}:\d{2})\.\d{3}\]\s+(.*)$/

/**
 * Transcribe one 16kHz mono WAV.
 *
 * `onProgress` is called with a fraction as whisper reports its position, so a
 * long meeting can show something moving. It is derived from the timestamps in
 * the output rather than from whisper's own progress flag, which prints to
 * stderr in a format that has changed between builds.
 *
 * @param {object} args
 * @param {string} args.file            Path to the WAV.
 * @param {WhisperLanguage} args.language
 * @param {number} [args.seconds]       Length, for the progress fraction.
 * @param {(fraction: number) => void} [args.onProgress]
 * @param {string[]} [args.roots]        Extra places to look - see whisperCandidates.
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {Promise<{ segments: { start: string, end: string, text: string }[], text: string }>}
 */
export function transcribe({ file, language, seconds = 0, onProgress, roots = [], env = process.env }) {
  const status = whisperStatus(language, { env, roots })
  if (!status.ready) {
    return Promise.reject(new Error(status.why))
  }

  return new Promise((done, fail) => {
    const child = spawn(
      status.binary,
      [
        '-m', status.model,
        '-f', file,
        '-l', language,
        // One thread per physical core is the usual sweet spot; the GPU does the
        // work regardless, and oversubscribing the CPU only adds contention.
        '-t', '6',
        // Print timestamps: they are what makes a transcript navigable, and the
        // summary pass uses them to point at moments.
        '-pp'
      ],
      { env, windowsHide: true }
    )

    /** @type {{ start: string, end: string, text: string }[]} */
    const segments = []
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.trim().match(SEGMENT)
        if (match === null) {
          continue
        }
        segments.push({ start: match[1], end: match[2], text: match[3].trim() })
        if (onProgress !== undefined && seconds > 0) {
          const [h, m, s] = match[2].split(':').map(Number)
          onProgress(Math.min(1, (h * 3600 + m * 60 + s) / seconds))
        }
      }
    })
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      stderr += chunk
    })

    child.on('error', fail)
    child.on('close', (/** @type {number | null} */ code) => {
      if (code !== 0) {
        fail(new Error(`whisper-cli exited ${code}: ${stderr.split('\n').slice(-4).join(' ').trim()}`))
        return
      }
      done({
        segments,
        text: segments.map((segment) => segment.text).join(' ').trim()
      })
    })
  })
}
