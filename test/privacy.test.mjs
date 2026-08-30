import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIN_TERM, addedLines, findTerms, privateTerms, report } from '../src/privacy/index.mjs'

/*
 * The guard that replaced a rule.
 *
 * On 2026-08-25 a real colleague's first name, a real project name and a real
 * product name reached a public repository through test fixtures and code
 * comments. There had been a rule against it in a project document and in an
 * agent's memory, and it was broken fifteen times in one evening by somebody who
 * had read it. What follows is the reason the terms are derived rather than
 * listed, and the reason the matching is deliberately narrow.
 */

test('a leak is found on the line that adds it, not on the line that removes it', () => {
  const diff = [
    '--- a/test/fixture.mjs',
    '+++ b/test/fixture.mjs',
    '-  name: "Realperson"',
    '+  name: "Invented"',
    '--- a/README.md',
    '+++ b/README.md',
    '+  Realperson works on Realproject'
  ].join('\n')

  const added = addedLines(diff)
  assert.deepEqual(
    added.map((a) => a.file),
    ['test/fixture.mjs', 'README.md']
  )
  const hits = added.flatMap((line) => findTerms(line.text, ['Realperson', 'Realproject']))
  assert.equal(hits.length, 2, 'the removal is the fix and must not be reported as the problem')
})

test('matching is on whole words, so a name inside a longer word is not a hit', () => {
  // Meta is a real product name and also the first four letters of metadata. A
  // guard that cries wolf is bypassed with --no-verify inside a week.
  assert.deepEqual(findTerms('parsing the metadata here', ['Meta']), [])
  assert.equal(findTerms('shipped to Meta today', ['Meta']).length, 1)
})

test('and is case-insensitive, because a fixture id is lowercase and leaks the same', () => {
  assert.equal(findTerms('const id = "realperson"', ['Realperson']).length, 1)
})

test('short terms are skipped, and the floor is stated rather than hidden', () => {
  // "Bo" or "Ida" would match every third line of ordinary prose. This is the
  // one case the guard cannot cover, and saying so beats a guard nobody trusts.
  assert.ok(MIN_TERM >= 4)
})

test('the terms come from the private data, not from a list in any repository', () => {
  // A file naming every colleague, committed to the repository it protects, IS
  // the leak. So the source is the store the apps already keep outside the tree.
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-'))
  try {
    mkdirSync(join(dir, 'tend', 'events'), { recursive: true })
    writeFileSync(
      join(dir, 'tend', 'events', 'host-app.jsonl'),
      [
        JSON.stringify({ op: 'people.create', p: { id: 'p1', name: 'Invented Personson' } }),
        JSON.stringify({ op: 'projects.create', p: { id: 'j1', name: 'Madeupproject' } }),
        JSON.stringify({ op: 'touches.create', p: { id: 't1', note: 'ordinary prose here' } }),
        'half a line written during a sync {'
      ].join('\n')
    )
    mkdirSync(join(dir, 'nib'), { recursive: true })
    writeFileSync(
      join(dir, 'nib', 'index.json'),
      JSON.stringify({ categories: [{ name: 'Team', subs: [{ name: 'Anotherperson' }] }] })
    )

    process.env.TEND_DATA_DIR = join(dir, 'tend')
    process.env.NIB_DATA_DIR = join(dir, 'nib')

    const { terms, sources } = privateTerms()

    assert.ok(terms.includes('Invented'), 'a first name is a term on its own')
    assert.ok(terms.includes('Personson'), 'and so is a surname')
    assert.ok(terms.includes('Madeupproject'))
    assert.ok(terms.includes('Anotherperson'), 'Nib folder names count too')
    assert.ok(!terms.includes('Team'), 'the apps own vocabulary is not a leak')
    assert.ok(
      !terms.some((t) => t.toLowerCase() === 'prose'),
      'only names are read, or ordinary words would flood this'
    )
    assert.equal(sources.length, 2, 'and it says where it learned them')
  } finally {
    delete process.env.TEND_DATA_DIR
    delete process.env.NIB_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed line is skipped rather than taking the whole check down', () => {
  // Dropbox writes half a line mid-sync. Every other reader in this suite
  // skips those; a guard that throws on one is a guard that gets disabled.
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-bad-'))
  try {
    mkdirSync(join(dir, 'events'), { recursive: true })
    writeFileSync(join(dir, 'events', 'host-app.jsonl'), '{"op":"people.create","p":{"nam')
    process.env.TEND_DATA_DIR = dir
    assert.doesNotThrow(() => privateTerms())
  } finally {
    delete process.env.TEND_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the report names the term and the file, and says how to proceed', () => {
  const text = report({
    checked: true,
    why: 'public',
    sources: ['somewhere'],
    terms: 3,
    hits: [{ file: 'test/a.mjs', term: 'Invented', text: 'name: "Invented"' }]
  })
  assert.match(text, /test\/a\.mjs/)
  assert.match(text, /Invented/)
  assert.match(text, /--no-verify/, 'a guard with no way past it gets disabled rather than obeyed')
})

test('punctuation inside an identifier is not a word break', () => {
  // The first version treated a dot and a hyphen as boundaries, so a project
  // named after an HTML tag matched `import.meta`, `.row-meta` and `row_meta` in
  // every file in the suite: 284 hits in one repository, none a leak. A guard
  // that noisy gets ignored, which is worse than not having it.
  assert.deepEqual(findTerms('const here = dirname(fileURLToPath(import.meta.url))', ['Meta']), [])
  assert.deepEqual(findTerms('.row-meta { color: red }', ['Meta']), [])
  assert.deepEqual(findTerms('const row_meta = 1', ['Meta']), [])
  assert.equal(findTerms('shipped it to Meta today', ['Meta']).length, 1, 'a real mention still lands')
})

test('a folder named Decisions does not protect the word "decisions"', () => {
  /*
   * Found the way the Conversations one was: a push refused over a JSON schema
   * whose property is, correctly, `decisions` - in a suite where every project
   * keeps a DECISIONS.md and the word is in prose, field names and commit
   * messages constantly.
   *
   * Through the environment, because that is the only seam `privateTerms` has -
   * the note above this test's neighbour explains what happens to anyone who
   * passes directories as arguments instead.
   */
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-decisions-'))
  try {
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        categories: [{ name: 'Documents', subs: [{ name: 'Decisions' }, { name: 'Testperson' }] }]
      })
    )
    process.env.NIB_DATA_DIR = dir
    process.env.TEND_DATA_DIR = join(dir, 'nothing-here')
    const { terms } = privateTerms()
    const lower = terms.map((t) => t.toLowerCase())
    assert.equal(lower.includes('decisions'), false, 'an everyday word became a protected term')
    // The control, without which this passes against a derivation returning
    // nothing at all.
    assert.equal(lower.includes('testperson'), true, 'a real name stopped being protected')
  } finally {
    delete process.env.NIB_DATA_DIR
    delete process.env.TEND_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder named after an everyday word is not turned into a term', () => {
  /*
   * A notes folder called Conversations, in an app whose subject is
   * conversations. It sat in ninety-three lines of already-published source
   * before it was ever flagged - the guard reads changed lines only, so it went
   * unnoticed until one of those lines was edited, and then it blocked a push
   * over prose that was already public.
   *
   * The allow-list is the honest answer and it is an admission, not a fix: those
   * names are not protected. A guard that fires on a word this common is pushed
   * past with --no-verify as a habit, and then it protects nothing at all.
   */
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-everyday-'))
  try {
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        categories: [
          { name: 'Practice', subs: [{ name: 'Conversations' }, { name: 'Onewordname' }] }
        ]
      })
    )
    // Through the environment, which is the only seam there is - and the reason
    // it matters here rather than being a detail: the first version of this test
    // passed the directories as arguments, which `privateTerms` ignores, so it
    // silently read the real notebook on this machine. A test that reads real
    // private data to check a privacy guard is its own small joke.
    process.env.NIB_DATA_DIR = dir
    process.env.TEND_DATA_DIR = join(dir, 'nothing-here')
    const { terms } = privateTerms()
    const lower = terms.map((t) => t.toLowerCase())
    assert.equal(lower.includes('conversations'), false, 'an everyday word became a protected term')
    // The control. Without it the assertion above passes just as well when the
    // derivation is broken and returns nothing at all.
    assert.equal(lower.includes('onewordname'), true, 'a real name stopped being protected')
  } finally {
    delete process.env.NIB_DATA_DIR
    delete process.env.TEND_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a multi-word Nib folder is a book, not a person', () => {
  // "Manager's Path" split into words contributed `Path`, which is in almost
  // every source file ever written. Sub-folders only, and only single words.
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-books-'))
  try {
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        categories: [
          {
            name: 'Books',
            subs: [{ name: "Somebody's Long Book Title" }, { name: 'Onewordname' }]
          }
        ]
      })
    )
    process.env.NIB_DATA_DIR = dir
    process.env.TEND_DATA_DIR = join(dir, 'nothing-here')
    const { terms } = privateTerms()
    assert.ok(terms.includes('Onewordname'), 'a name-shaped folder is still a term')
    assert.ok(!terms.includes('Title'), 'a book title must not contribute ordinary words')
    assert.ok(!terms.includes('Book'))
  } finally {
    delete process.env.NIB_DATA_DIR
    delete process.env.TEND_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})
