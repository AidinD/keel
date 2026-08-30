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
export function whisperRoot({ env = process.env } = {}) {
  const override = env.WHISPER_DIR?.trim()
  if (override) {
    return override
  }
  // keel/src/whisper -> keel/src -> keel -> the folder holding every repo.
  return resolve(here, '..', '..', '..', '.whisper')
}

export function binaryPath(options) {
  return join(whisperRoot(options), 'Release', 'whisper-cli.exe')
}

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
export function whisperStatus(language, options) {
  const root = whisperRoot(options)
  const binary = binaryPath(options)
  if (!existsSync(binary)) {
    return { ready: false, why: `whisper-cli.exe is not in ${root}`, root }
  }
  let model
  try {
    model = modelPath(language, options)
  } catch (error) {
    return { ready: false, why: error.message, root }
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
 * @param {'sv'|'en'} args.language
 * @param {number} [args.seconds]       Length, for the progress fraction.
 * @param {(fraction: number) => void} [args.onProgress]
 * @param {object} [args.env]
 * @returns {Promise<{ segments: { start: string, end: string, text: string }[], text: string }>}
 */
export function transcribe({ file, language, seconds = 0, onProgress, env = process.env }) {
  const status = whisperStatus(language, { env })
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

    const segments = []
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
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
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', fail)
    child.on('close', (code) => {
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
