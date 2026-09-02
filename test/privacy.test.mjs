import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

import {
  MIN_TERM,
  PERVASIVE_MIN_FILES,
  PERVASIVE_MIN_HITS,
  addedLines,
  alreadyInRepo,
  findTerms,
  outgoingMessages,
  parseMessages,
  partitionHits,
  privateTerms,
  report
} from '../src/privacy/index.mjs'

const HOOKS = join(fileURLToPath(new URL('..', import.meta.url)), 'hooks')

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

test('a folder named Ownership does not protect the word "ownership"', () => {
  /*
   * The fourth of these, found the same way as the other three: a push refused over three
   * lines of ordinary English in an orchestrator whose whole subject is which tier owns a
   * piece of work - "a mate continues its own crew", "rather than on ownership". The same
   * word had already been logged as a false positive across every hit of a full audit pass
   * before it ever blocked anything.
   *
   * The control matters more than the assertion here: without it this passes against a
   * derivation that returns nothing at all, which is what a broken guard looks like.
   */
  const dir = mkdtempSync(join(tmpdir(), 'keel-privacy-ownership-'))
  try {
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        categories: [{ name: 'Documents', subs: [{ name: 'Ownership' }, { name: 'Testperson' }] }]
      })
    )
    process.env.NIB_DATA_DIR = dir
    process.env.TEND_DATA_DIR = join(dir, 'nothing-here')
    const { terms } = privateTerms()
    const lower = terms.map((t) => t.toLowerCase())
    assert.equal(lower.includes('ownership'), false, 'an everyday word became a protected term')
    assert.equal(lower.includes('testperson'), true, 'a real name stopped being protected')
  } finally {
    delete process.env.NIB_DATA_DIR
    delete process.env.TEND_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
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

/*
 * The half a diff cannot show.
 *
 * GITHUB-PUSH.md has warned about this since it was written: "Scrubbing file contents does
 * not scrub commit messages, and the usual verification cannot see them. `git log -S`
 * searches diffs, so a term that exists only in a message returns zero hits and the repo
 * looks clean." An employer's domain reached a public repository exactly that way.
 *
 * The guard had the same blind spot. Found on 2026-09-01, in a public repo carrying a private
 * first name in sixteen files AND in two commit messages: the check read `git diff` and only
 * `git diff`, so it could see the first kind and never the second. Half a guard reads as a
 * whole one, which is worse than none - a clean report is what somebody acts on.
 */

test('a commit message is parsed whole, blank lines and all', () => {
  // \x1f between sha and body, \x1e between commits. A message contains newlines and blank
  // lines, so anything that splits on those loses the body after the first paragraph - which
  // is exactly where the explanation, and the name, tend to be.
  const raw = [
    'aaaaaaaaaaaa\x1fSubject line\n\nA body paragraph naming Someone.\n\x1e',
    'bbbbbbbbbbbb\x1fAnother subject\n\x1e'
  ].join('\n')
  const parsed = parseMessages(raw)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].sha, 'aaaaaaaaaaaa')
  assert.match(parsed[0].text, /A body paragraph naming Someone\./)
  assert.equal(parsed[1].sha, 'bbbbbbbbbbbb')
})

test('an empty log is no commits rather than one empty commit', () => {
  assert.deepEqual(parseMessages(''), [])
  assert.deepEqual(parseMessages('\n\n'), [])
})

test('a term in a message body is found, which is the case a diff can never carry', () => {
  const parsed = parseMessages('cccccccccccc\x1fFix the thing\n\nSpotted while pairing with Karlsson.\n\x1e')
  const hits = findTerms(parsed[0].text, ['Karlsson'])
  assert.equal(hits.length, 1)
  assert.match(hits[0].text, /pairing with Karlsson/)
})

test('the report tells somebody a message needs a rebase, not an edit', () => {
  // Being told "rename it and push again" when the only hit is in a message sends somebody
  // through a working tree that is already clean, and then they conclude the guard is wrong.
  const text = report({
    checked: true,
    why: 'public',
    sources: ['somewhere'],
    terms: 1,
    hits: [{ file: 'commit abc12345 (message)', term: 'Karlsson', text: 'pairing with Karlsson', kind: 'message' }]
  })
  assert.match(text, /COMMIT MESSAGE/)
  assert.match(text, /--amend|rebase/)
  // And it says why the usual check could not have found it.
  assert.match(text, /log -S/)
})

test('a file-only hit is not told to rebase anything', () => {
  const text = report({
    checked: true,
    why: 'public',
    sources: ['somewhere'],
    terms: 1,
    hits: [{ file: 'src/x.js', term: 'Karlsson', text: 'const owner = "Karlsson"', kind: 'file' }]
  })
  assert.doesNotMatch(text, /COMMIT MESSAGE/)
  assert.match(text, /Rename them and push again/)
})

test('outgoingMessages reads real commits, including a body below the subject', () => {
  const repo = mkdtempSync(join(tmpdir(), 'keel-privacy-msg-'))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  try {
    git('init', '-q')
    git('config', 'user.email', 'p@p')
    git('config', 'user.name', 'p')
    writeFileSync(join(repo, 'a.txt'), 'nothing private here\n')
    git('add', '-A')
    // The name is ONLY in the message. The diff is clean, which is the whole point.
    git('commit', '-q', '-m', 'Tidy the thing\n\nAgreed this with Karlsson before starting.')

    const messages = outgoingMessages(repo)
    assert.ok(messages.length >= 1, 'a commit was read')
    const all = messages.map((m) => m.text).join('\n')
    assert.match(all, /Agreed this with Karlsson/)

    // And prove the diff really is clean, so this is not passing for the wrong reason.
    // Against the empty tree, because there is only one commit and HEAD~1 does not exist -
    // the first version asked for it and failed on its own setup rather than on the code.
    const empty = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'tree', '/dev/null'], {
      encoding: 'utf8'
    }).trim()
    const diff = execFileSync('git', ['-C', repo, 'diff', '--unified=0', empty, 'HEAD'], {
      encoding: 'utf8'
    })
    assert.doesNotMatch(diff, /Karlsson/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a name at the end of a sentence is found, which it was not until 2026-09-01', () => {
  /*
   * The hole that mattered most, and it was in the boundary rule rather than in
   * anything grand. A dot counted as part of a word, so `with Karlsson.` matched
   * nothing while `with Karlsson said` matched - and a name before a full stop is
   * the single most ordinary way a person appears in prose or a commit message.
   * The guard was blind to the common case and sharp on the rare one.
   *
   * Both directions are asserted, because the fix is only worth having if the
   * noise it was protecting against stays gone: 284 false hits in one repository
   * is what made the dot a word character in the first place.
   */
  const found = [
    'pairing with Karlsson.',
    'Karlsson, who reviewed it',
    'with Karlsson!',
    'see Karlsson (the reviewer)',
    '- Karlsson',
    'trailing off with Karlsson...'
  ]
  for (const line of found) {
    assert.equal(findTerms(line, ['Karlsson']).length, 1, `should have found it in: ${line}`)
  }

  const quiet = ['karlsson.js', 'some-karlsson', 'row_karlsson', 'karlssonberg', 'x.karlsson.y']
  for (const line of quiet) {
    assert.deepEqual(findTerms(line, ['Karlsson']), [], `should have stayed quiet on: ${line}`)
  }

  // The original noise cases, unchanged - the reason the rule exists at all.
  assert.deepEqual(findTerms('const here = dirname(fileURLToPath(import.meta.url))', ['Meta']), [])
  assert.deepEqual(findTerms('.row-meta { color: red }', ['Meta']), [])
  assert.equal(findTerms('shipped it to Meta.', ['Meta']).length, 1, 'and the sentence-final case works for any term')
})

/*
 * The fifth exception, and the rule that replaces the first four.
 *
 * Four times a push was refused over a word that was already in the repository hundreds of
 * times - `meta`, `conversation`, `decisions`, `ownership` - and each time the fix was to add
 * that word to a hand-maintained list AFTER it had cost a push. The obvious generalisation,
 * "drop common English words", does not work: `meta` is jargon and `ownership` is not a
 * frequent word, so a frequency list would have caught none of them.
 *
 * What the four actually share is written in `conversation`'s own note: "It appeared
 * ninety-three times in already-published source before it was ever flagged." They are the
 * CODEBASE'S OWN VOCABULARY. That is measurable, so it is measured instead of listed.
 *
 * The dangerous half is the one these checks care most about: a genuine name that is already
 * public a hundred times must still be REPORTED. Refusing the hundred-and-first occurrence
 * protects nothing, but going quiet about it would hide a real leak - which is the one thing
 * this file must never do.
 */

test('a word the repository already uses everywhere is not something this gate can guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-pervasive-'))
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
    git('init', '-q')
    git('config', 'user.email', 'test@keel.local')
    git('config', 'user.name', 'keel test')

    // The codebase's own vocabulary: spread across files, the way a subject word is.
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(join(dir, `module${n}.js`), Array.from({ length: 5 }, (_, i) => `// ownership rule ${i}`).join('\n'))
    }
    // A real name, mentioned once. This is the control: without it, a lookup that called
    // everything pervasive would pass every assertion above it.
    writeFileSync(join(dir, 'fixture.js'), 'const who = "Testperson"\n')
    // A name repeated inside ONE file. Occurrences alone would call this vocabulary; it is
    // a leak, and the file count is what tells the two apart.
    writeFileSync(join(dir, 'leak.js'), Array.from({ length: 20 }, () => 'Realperson').join('\n'))
    git('add', '-A')
    git('commit', '-qm', 'seed')

    const vocabulary = alreadyInRepo(dir, 'ownership')
    assert.equal(vocabulary.pervasive, true, 'a word across four files and twenty lines is the codebase talking about itself')
    assert.ok(vocabulary.count >= PERVASIVE_MIN_HITS, `counted ${vocabulary.count} occurrences`)
    assert.ok(vocabulary.files >= PERVASIVE_MIN_FILES, `across ${vocabulary.files} files`)

    assert.equal(alreadyInRepo(dir, 'Testperson').pervasive, false, 'a name mentioned once is still guardable')
    assert.equal(
      alreadyInRepo(dir, 'Realperson').pervasive,
      false,
      'twenty occurrences in ONE file is a leak, not vocabulary - both thresholds have to be met'
    )
    assert.equal(alreadyInRepo(dir, 'Neverwritten').pervasive, false, 'a word that is not there at all is not pervasive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pervasive term stops blocking but is still reported', () => {
  const hits = [
    { file: 'src/a.js', term: 'ownership', text: 'rather than on ownership.', kind: 'file' },
    { file: 'commit abc12345 (message)', term: 'ownership', text: 'Ownership applies', kind: 'message' },
    { file: 'src/b.js', term: 'Testperson', text: 'const who = "Testperson"', kind: 'file' }
  ]
  const split = partitionHits(hits, (term) =>
    term === 'ownership' ? { pervasive: true, count: 93, files: 12 } : { pervasive: false, count: 0, files: 0 }
  )

  assert.deepEqual(
    split.hits.map((h) => h.term),
    ['Testperson'],
    'only the guardable term still refuses the push'
  )
  // The half that matters most. Dropping these silently is how a guard hides a real leak.
  assert.equal(split.published.length, 2, 'both pervasive hits are kept and reported, not discarded')
  assert.deepEqual(split.pervasive, [{ term: 'ownership', pervasive: true, count: 93, files: 12 }], 'with the count, so the reader can judge')

  // A push carrying ONLY pervasive terms must not be refused - and must not go quiet either.
  const onlyPervasive = partitionHits(hits.slice(0, 2), () => ({ pervasive: true, count: 93, files: 12 }))
  assert.equal(onlyPervasive.hits.length, 0, 'nothing left to block on')
  assert.equal(onlyPervasive.published.length, 2, 'but the reader is still told what is in there')

  // And the reverse: a lookup that finds nothing must change nothing.
  const nothingKnown = partitionHits(hits, () => ({ pervasive: false, count: 0, files: 0 }))
  assert.equal(nothingKnown.hits.length, 3, 'with no pervasive terms the gate keeps all its teeth')
  assert.equal(nothingKnown.published.length, 0, 'and reports nothing as already-published')
})

test('the hook reports a pervasive term without refusing the push', () => {
  /*
   * Source-level, because reaching this for real needs a public remote and an outgoing push.
   * What is pinned is the decision: the report runs BEFORE the exit-0 clean path, so a push
   * that is otherwise clean still says what it carried, and nothing in that branch exits 1.
   */
  const hook = readFileSync(join(HOOKS, 'no-private-names.mjs'), 'utf8')
  const reportAt = hook.indexOf('result.pervasive')
  const cleanExit = hook.indexOf('if (result.hits.length === 0)')
  assert.ok(reportAt > 0, 'the hook looks at the pervasive terms at all')
  assert.ok(reportAt < cleanExit, 'and reports them before the clean-push early exit, or an otherwise clean push says nothing')
  const between = hook.slice(reportAt, cleanExit)
  assert.equal(/process\.exit\(1\)/.test(between), false, 'reporting a pervasive term never refuses the push')
  assert.ok(/history/.test(between), 'and the message says what to do if it IS private - the history, not this push')
})
