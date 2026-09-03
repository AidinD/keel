/**
 * The file primitives under the suite's stores - and only the primitives.
 *
 * There is no `Store` class here, on purpose. The five storage layers are
 * genuinely different shapes: Jot is one JSON document, Nib is a file per note,
 * Tend is an append-only event log with rollover, Brief is a disposable JSON plus
 * an append-only JSONL, Helm is a set of small durable stores. An abstraction over
 * those would be a flag for every difference, which is how a shared thing becomes
 * worse than five copies.
 *
 * What they DO all do is write a file atomically on Windows in a Dropbox folder,
 * and read a JSON file that something else may have touched. That is what is here,
 * and it is where all the incidents are.
 */
export { MAX_ATTEMPTS, acquireLock, backoffMs, delay, isTransientLock, jitteredBackoffMs, lockPathFor, releaseLock, sleepSync } from './lock.mjs';
export { bestEffortRemove, plainReason, tempPathFor, writeFileAtomic, writeFileAtomicSync, writeJsonAtomic, writeJsonAtomicSync } from './atomic.mjs';
export { readJsonFile, stripBom } from './json.mjs';
export { resolveDataDir } from './dataDir.mjs';
