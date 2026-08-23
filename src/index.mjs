// Keel is deliberately imported per-area rather than as one barrel: a build
// script has no business pulling in renderer code, and vice versa. This exists
// only so `import ... from 'keel'` is not a dead end.
export * as icon from './icon/index.mjs'
