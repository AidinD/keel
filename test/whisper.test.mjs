/**
 * Where the engine is looked for.
 *
 * The bug these exist for shipped in an installer and was invisible for months:
 * the path was worked out by walking up from the module's own file, which is
 * right in a checkout and wrong inside an asar, and the only person running it
 * ran a checkout. So the interesting cases here are all "somewhere other than a
 * developer's machine".
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  parseSegment,
  wavChannels,
  whisperCandidates,
  whisperRoot,
  whisperStatus
} from '../src/whisper/index.mjs'

/** A WAV header, which is all `wavChannels` ever reads. */
function wav(dir, name, { channels = 1, riff = 'RIFF', wave = 'WAVE', fmt = 'fmt ' } = {}) {
  const header = Buffer.alloc(44)
  header.write(riff, 0)
  header.writeUInt32LE(36, 4)
  header.write(wave, 8)
  header.write(fmt, 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(16000, 24)
  const path = join(dir, name)
  writeFileSync(path, header)
  return path
}

/** A folder that looks like an installed engine. */
function payload(dir, { model = true } = {}) {
  mkdirSync(join(dir, 'Release'), { recursive: true })
  writeFileSync(join(dir, 'Release', 'whisper-cli.exe'), 'not really a binary')
  if (model) {
    writeFileSync(join(dir, 'ggml-model-q5_0.bin'), 'not really a model')
  }
  return dir
}

/** @type {string} */
let scratch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'keel-whisper-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('finding the engine', () => {
  it('obeys WHISPER_DIR even when it is wrong', () => {
    // Searching past it would mean pointing the app somewhere new, getting no
    // error, and quietly still using the old place.
    const empty = join(scratch, 'empty-but-set')
    payload(join(scratch, 'would-have-worked'))
    assert.equal(
      whisperRoot({ env: { WHISPER_DIR: empty }, roots: [join(scratch, 'would-have-worked')] }),
      empty
    )
  })

  it('takes WHISPER_DIR ahead of everything', () => {
    const chosen = payload(join(scratch, 'chosen'))
    const other = payload(join(scratch, 'other'))
    const root = whisperRoot({ env: { WHISPER_DIR: chosen }, roots: [other] })
    assert.equal(root, chosen)
  })

  it("takes the app's own folder ahead of the checkout", () => {
    const owned = payload(join(scratch, 'userdata'))
    assert.equal(whisperRoot({ env: {}, roots: [owned] }), owned)
  })

  it('leaves the checkout layout last, where it belongs', () => {
    // It is the developer's convenience and everyone else's wrong answer, so it
    // is only reached when nothing better exists.
    const candidates = whisperCandidates({ env: { WHISPER_DIR: 'C:/set' }, roots: ['C:/app'] })
    assert.equal(candidates[0], 'C:/set')
    assert.equal(candidates[1], 'C:/app')
    assert.ok(candidates[candidates.length - 1].endsWith('.whisper'))
  })

  it('skips a candidate that does not actually hold the binary', () => {
    // The packaged case: a path that is computed correctly and empty. Returning
    // it would be the old bug with more steps.
    const empty = join(scratch, 'asar-ish')
    mkdirSync(empty, { recursive: true })
    const real = payload(join(scratch, 'real'))
    assert.equal(whisperRoot({ env: {}, roots: [empty, real] }), real)
  })

  it('still answers with one of the places it looked', () => {
    // So the caller can say WHERE it looked; "not found" cannot be acted on.
    //
    // Asserted against the candidate list rather than against a fixed path,
    // because the last candidate is the checkout layout - which exists on the
    // machine this is usually run on and does not exist in CI. A test whose
    // result depends on that is a test that passes for the wrong reason
    // somewhere.
    const nothing = join(scratch, 'nothing')
    const options = { env: {}, roots: [nothing] }
    assert.ok(whisperCandidates(options).includes(whisperRoot(options)))
  })

  it('never repeats a candidate', () => {
    const same = join(scratch, 'same')
    const list = whisperCandidates({ env: { WHISPER_DIR: same }, roots: [same, same] })
    assert.equal(list.filter((entry) => entry === same).length, 1)
  })
})

describe('what it reports when it cannot run', () => {
  it('names the path it settled on, and says how to fix it', () => {
    // WHISPER_DIR pinned to somewhere empty, so the answer cannot depend on
    // whether this machine happens to have a checkout with the engine in it.
    const status = whisperStatus('sv', { env: { WHISPER_DIR: join(scratch, 'missing') } })
    assert.equal(status.ready, false)
    assert.match(status.why, /whisper-cli\.exe is not in/)
    assert.match(status.why, /WHISPER_DIR/)
  })

  it('separates "no engine" from "no model for that language"', () => {
    // Two different problems needing two different actions: install the engine,
    // or fetch one more file. A caller told only "unavailable" has to guess.
    const half = payload(join(scratch, 'half'), { model: false })
    const status = whisperStatus('sv', { env: { WHISPER_DIR: half } })
    assert.equal(status.ready, false)
    assert.match(status.why, /the sv model is not in/)
  })

  it('is ready when both halves are there', () => {
    const whole = payload(join(scratch, 'whole'))
    const status = whisperStatus('sv', { env: { WHISPER_DIR: whole } })
    assert.equal(status.ready, true)
    assert.equal(status.model, join(whole, 'ggml-model-q5_0.bin'))
  })

  it('refuses a language it has no model name for', () => {
    const whole = payload(join(scratch, 'whole'))
    // @ts-expect-error - deliberately outside the two supported languages
    const status = whisperStatus('de', { env: { WHISPER_DIR: whole } })
    assert.equal(status.ready, false)
    assert.match(status.why, /No whisper model for language/)
  })
})

/*
 * Reading the channel count off the file, rather than being told.
 *
 * Whether to ask whisper for speaker labels is a fact about the file: the folder
 * holds recordings from before the app captured two channels and after it, and
 * both get transcribed by the same call.
 */
describe('how many channels a file has', () => {
  it('reads a mono header as one and a stereo header as two', () => {
    assert.equal(wavChannels(wav(scratch, 'one.wav', { channels: 1 })), 1)
    assert.equal(wavChannels(wav(scratch, 'two.wav', { channels: 2 })), 2)
  })

  it('answers 0 for a file that is not there', () => {
    // A caller asking "is this stereo" wants a no, not an exception - the
    // missing-file complaint belongs to `transcribe`, which says it properly.
    assert.equal(wavChannels(join(scratch, 'nothing.wav')), 0)
  })

  it('answers 0 for something that is not a WAV at all', () => {
    const path = join(scratch, 'not-a-wav.bin')
    writeFileSync(path, Buffer.alloc(64, 7))
    assert.equal(wavChannels(path), 0)
  })

  it('answers 0 when the header is too short to hold the answer', () => {
    const path = join(scratch, 'truncated.wav')
    writeFileSync(path, Buffer.from('RIFF'))
    assert.equal(wavChannels(path), 0)
  })

  it('answers 0 when `fmt ` is not the first chunk', () => {
    // The count is only at offset 22 in the layout this suite writes. A file
    // with a LIST chunk in front of it would put something else there, and
    // reading that as a channel count is worse than admitting ignorance.
    assert.equal(wavChannels(wav(scratch, 'odd.wav', { channels: 2, fmt: 'LIST' })), 0)
  })
})

/*
 * What whisper-cli prints, parsed.
 *
 * The one part of this module a machine with no engine installed can still
 * check - and the format has already moved once between builds.
 */
describe('reading a line of output', () => {
  it('takes the timestamps and the words off a plain segment', () => {
    const segment = parseSegment('[00:00:03.100 --> 00:00:06.000]  Hej och valkommen.')
    assert.deepEqual(segment, { start: '00:00:03', end: '00:00:06', text: 'Hej och valkommen.' })
  })

  it('lifts the speaker out of the words rather than leaving it in them', () => {
    const segment = parseSegment('[00:00:22.000 --> 00:00:24.000]  (speaker 1) om andra saker.')
    assert.equal(segment?.speaker, '1')
    assert.equal(segment?.text, 'om andra saker.')
  })

  it("keeps whisper's own doubt instead of resolving it", () => {
    // `speaker ?` is the segment sitting across a turn, and it is the most
    // honest thing in the output. Rounding it to a name would be a guess with
    // somebody's name on it.
    const segment = parseSegment('[00:00:24.000 --> 00:00:26.000]  (speaker ?) sa vi kan forsoka.')
    assert.equal(segment?.speaker, '?')
    assert.equal(segment?.text, 'sa vi kan forsoka.')
  })

  it('leaves speaker absent on a mono file rather than inventing one', () => {
    // Absent and '?' mean different things: "there were no labels" against
    // "there were, and this segment could not be told apart".
    const segment = parseSegment('[00:00:00.000 --> 00:00:02.000]  Ingen etikett har.')
    assert.equal('speaker' in (segment ?? {}), false)
  })

  it('ignores every line that is not a segment', () => {
    assert.equal(parseSegment('whisper_init_from_file_with_params_no_state: loading model'), null)
    assert.equal(parseSegment(''), null)
  })
})
