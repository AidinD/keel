// Keel is meant to be imported per-area - `keel/icon`, `keel/window` - rather
// than as one barrel: a build script has no business pulling in window code,
// and vice versa. This exists only so `import ... from 'keel'` is not a dead
// end, and it names every area, because a courtesy barrel that carries half
// the package is worse than none - you find out by getting `undefined`.
export * as icon from './icon/index.mjs'
export * as release from './release/index.mjs'
export * as shell from './shell/index.mjs'
export * as window from './window/index.mjs'
