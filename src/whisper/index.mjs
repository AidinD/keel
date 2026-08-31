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
 *
 * ## Who said it, when the file can answer that
 *
 * A two-channel file is transcribed with `-di`, which labels each segment by
 * which channel was louder. That is not voice recognition and does not pretend
 * to be: it is bookkeeping over an input that was already kept apart - a
 * microphone on the left, the machine's own output on the right - so the labels
 * are as good as that separation was, and whisper says `speaker ?` rather than
 * guessing when the two channels are level.
 *
 * It costs far less than transcribing two files: whisper mixes down to mono for
 * the words and uses the stereo only for the label. Measured on a 50-second
 * clip, 9.3s against 7.9s - eighteen percent, not double.
 *
 * A one-channel file gets no `-di` and no labels, which is what every recording
 * made before this looks like.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
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

/**
 * How many channels a WAV holds, and 0 when the file cannot answer.
 *
 * Read from the header rather than taken on trust from the caller: whether to
 * ask for speaker labels is a fact about the file, and a recording made before
 * the app captured two channels is still sitting in the same folder as one made
 * after. Passing `-di` to a mono file gets a warning and no labels, and NOT
 * passing it to a stereo one silently throws away the only thing that knows who
 * was talking.
 *
 * 0 on anything unreadable or unrecognised, so a caller that only asks "is this
 * two channels" gets a no rather than an exception.
 *
 * @param {string} file
 * @returns {number}
 */
export function wavChannels(file) {
  /** @type {number | undefined} */
  let handle
  try {
    handle = openSync(file, 'r')
    const header = Buffer.alloc(24)
    if (readSync(handle, header, 0, 24, 0) < 24) {
      return 0
    }
    // RIFF/WAVE with `fmt ` first, which is where the channel count is at 22.
    // Anything else is a WAV this was not written to read.
    if (
      header.toString('latin1', 0, 4) !== 'RIFF' ||
      header.toString('latin1', 8, 12) !== 'WAVE' ||
      header.toString('latin1', 12, 16) !== 'fmt '
    ) {
      return 0
    }
    return header.readUInt16LE(22)
  } catch {
    return 0
  } finally {
    if (handle !== undefined) {
      closeSync(handle)
    }
  }
}

/** `[00:00:03.100 --> 00:00:06.000]  text` - what whisper-cli prints per segment. */
const SEGMENT = /^\[(\d{2}:\d{2}:\d{2})\.\d{3} --> (\d{2}:\d{2}:\d{2})\.\d{3}\]\s+(.*)$/

/** What `-di` puts in front of the words: `(speaker 0)`, or `(speaker ?)`. */
const SPEAKER = /^\(speaker (\d+|\?)\)\s*/

/**
 * One line of whisper-cli's output, or null when it is not a segment.
 *
 * Its own function so it can be tested without the 1.5GB payload the rest of
 * this module needs. The output format is the thing most likely to move under
 * us - it already has, between builds - and it is the one part of this that a
 * machine with no engine installed can still check.
 *
 * The label comes off the words rather than staying in them. `(speaker 0)` is
 * whisper's prefix and belongs to the segment, not to the sentence: left in the
 * text it would be read aloud by a summary pass, hit by a reader searching for a
 * word, and counted in every word count downstream.
 *
 * @param {string} line
 * @returns {{ start: string, end: string, text: string, speaker?: string } | null}
 */
export function parseSegment(line) {
  const match = line.trim().match(SEGMENT)
  if (match === null) {
    return null
  }
  const spoken = match[3].trim()
  const who = spoken.match(SPEAKER)
  return {
    start: match[1],
    end: match[2],
    text: who === null ? spoken : spoken.slice(who[0].length),
    ...(who === null ? {} : { speaker: who[1] })
  }
}

/**
 * Transcribe one 16kHz WAV, mono or stereo.
 *
 * `onProgress` is called with a fraction as whisper reports its position, so a
 * long meeting can show something moving. It is derived from the timestamps in
 * the output rather than from whisper's own progress flag, which prints to
 * stderr in a format that has changed between builds.
 *
 * A stereo file also comes back labelled - see the note at the top of this file.
 * `speaker` is `'0'` for the left channel, `'1'` for the right and `'?'` where
 * whisper could not tell; it is absent entirely on a mono file, which is how a
 * caller distinguishes "nobody said" from "it could not tell".
 *
 * @param {object} args
 * @param {string} args.file            Path to the WAV.
 * @param {WhisperLanguage} args.language
 * @param {number} [args.seconds]       Length, for the progress fraction.
 * @param {(fraction: number) => void} [args.onProgress]
 * @param {string[]} [args.roots]        Extra places to look - see whisperCandidates.
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {Promise<{ segments: { start: string, end: string, text: string, speaker?: string }[], text: string }>}
 */
export function transcribe({ file, language, seconds = 0, onProgress, roots = [], env = process.env }) {
  const status = whisperStatus(language, { env, roots })
  if (!status.ready) {
    return Promise.reject(new Error(status.why))
  }

  /*
   * A missing input file, checked here rather than left to the binary.
   *
   * whisper-cli answers an unopenable file by printing its entire usage text and
   * exiting 2 - so the caller gets two hundred lines about VAD padding when what
   * happened is that the audio is not there. Nib puts that message in the note,
   * where it is worse than useless. This says the one true thing instead.
   */
  if (!existsSync(file)) {
    return Promise.reject(new Error(`the audio file is gone: ${file}`))
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
        '-pp',
        // Speaker labels, but only where the file can support them.
        ...(wavChannels(file) === 2 ? ['-di'] : [])
      ],
      { env, windowsHide: true }
    )

    /** @type {{ start: string, end: string, text: string, speaker?: string }[]} */
    const segments = []
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const segment = parseSegment(line)
        if (segment === null) {
          continue
        }
        segments.push(segment)
        if (onProgress !== undefined && seconds > 0) {
          const [h, m, s] = segment.end.split(':').map(Number)
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
