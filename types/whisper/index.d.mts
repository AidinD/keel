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
export type WhisperLanguage = 'sv' | 'en';
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
export declare function whisperCandidates({ env, roots }?: {
    env?: NodeJS.ProcessEnv;
    roots?: string[];
}): string[];
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
export declare function whisperRoot(options?: {
    env?: NodeJS.ProcessEnv;
    roots?: string[];
}): string;
/**
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string}
 */
export declare function binaryPath(options?: {
    env?: NodeJS.ProcessEnv;
    roots?: string[];
}): string;
/**
 * @param {WhisperLanguage} language
 * @param {{ env?: NodeJS.ProcessEnv, roots?: string[] }} [options]
 * @returns {string}
 */
export declare function modelPath(language: WhisperLanguage, options?: {
    env?: NodeJS.ProcessEnv;
    roots?: string[];
}): string;
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
export declare function whisperStatus(language: WhisperLanguage, options?: {
    env?: NodeJS.ProcessEnv;
    roots?: string[];
}): {
    ready: true;
    root: string;
    binary: string;
    model: string;
} | {
    ready: false;
    why: string;
    root: string;
    model?: string;
};
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
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {Promise<{ segments: { start: string, end: string, text: string }[], text: string }>}
 */
export declare function transcribe({ file, language, seconds, onProgress, env }: {
    file: string;
    language: WhisperLanguage;
    seconds?: number;
    onProgress?: (fraction: number) => void;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    segments: {
        start: string;
        end: string;
        text: string;
    }[];
    text: string;
}>;
