// The session list is read out of pi's store, which this does not own: the
// files are pi's, the slugs are lossy, and half the directories on a working
// machine name folders that no longer exist. So the questions are what counts
// as a session at all, whether the path it reports is the real one, whether a
// folder with several sessions in it offers all of them, and whether a store
// with far more history than a phone list can show is capped rather than read
// in full every time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlaces, shorten, lastWrite, subfolders, findPlace } from '../../server/places.js'

/** A session file the way pi writes one: a header line, then the conversation. */
const sessionFile = (cwd, id) => [
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-13T02:43:46.562Z', cwd }),
  JSON.stringify({ type: 'message', message: { role: 'user' } }),
].join('\n')

/** A session pi forked off another: the same header, naming the file it came
 *  from. That is how a subagent's run is filed. */
const forkFile = (cwd, id, parent) => JSON.stringify(
  { type: 'session', version: 3, id, timestamp: '2026-08-13T02:43:46.562Z', cwd, parentSession: parent })

const store = async build => {
  // Resolved up front: on macOS the temp root is reached through a symlink, and
  // a session is always reported at the folder's one true path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mtty-places-')))
  const sessionDir = join(root, 'sessions')
  await mkdir(sessionDir)
  await build({ root, sessionDir })
  return { root, sessionDir }
}

/** pi's own directory naming: the cwd with its separators flattened to dashes. */
const slug = cwd => `-${cwd.replaceAll('/', '-')}-`

const withSession = async (sessionDir, cwd, { id = 'x', at, name = `${id}.jsonl`, body } = {}) => {
  const dir = join(sessionDir, slug(cwd))
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, body ?? sessionFile(cwd, id))
  if (at) await utimes(file, at / 1000, at / 1000)
  return file
}

test('a folder with pi history is a session, named by the path in the file', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'my-project')) })
  const project = join(root, 'my-project')
  await withSession(sessionDir, project)
  try {
    const { sessions, more } = await readPlaces({ sessionDir })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].cwd, project, 'the cwd comes from the header, not the slug')
    assert.equal(sessions[0].name, 'my-project')
    assert.equal(sessions[0].id, 'x')
    assert.equal(more, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder with a dash in its name survives the round trip the slug cannot', async () => {
  // The slug flattens separators to dashes, so `a-b/c` and `a/b/c` produce the
  // same directory name. Reading the header is what makes this exact.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'pi-my-stuff')) })
  const project = join(root, 'pi-my-stuff')
  await withSession(sessionDir, project)
  try {
    const { sessions: [session] } = await readPlaces({ sessionDir })
    assert.equal(session.cwd, project)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder that no longer exists is not offered', async () => {
  const { root, sessionDir } = await store(async () => {})
  await withSession(sessionDir, join(root, 'deleted-long-ago'))
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions, [], 'spawning there would only fail')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder with several sessions offers all of them, newest first', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'busy')) })
  const project = join(root, 'busy')
  await withSession(sessionDir, project, { id: 'old', at: Date.UTC(2026, 0, 1) })
  await withSession(sessionDir, project, { id: 'new', at: Date.UTC(2026, 5, 1) })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions.map(s => s.id), ['new', 'old'])
    assert.ok(sessions.every(s => s.cwd === project), 'both sessions are in the same folder')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('newest first, across every folder', async () => {
  const { root, sessionDir } = await store(async ({ root }) => {
    await mkdir(join(root, 'old'))
    await mkdir(join(root, 'new'))
  })
  await withSession(sessionDir, join(root, 'old'), { id: 'a', at: Date.UTC(2026, 0, 1) })
  await withSession(sessionDir, join(root, 'new'), { id: 'b', at: Date.UTC(2026, 5, 1) })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions.map(session => session.name), ['new', 'old'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the folder walk offers folders only, and none that are hidden', async () => {
  const { root } = await store(async () => {})
  const here = join(root, 'here')
  await mkdir(here)
  const listed = [join(here, 'keep'), join(here, 'to-folder')]
  await mkdir(listed[0])
  await mkdir(join(here, '.hidden'))
  await writeFile(join(here, 'a-file'), 'text')
  await symlink(listed[0], listed[1])
  await symlink(join(here, 'a-file'), join(here, 'to-file'))
  await symlink(join(here, 'gone'), join(here, 'broken'))
  try {
    const found = await subfolders(here)
    assert.equal(found.cwd, here)
    assert.deepEqual(found.dirs, listed, 'a link to a folder stays; a link to a file or to nothing does not')
    assert.equal(found.parent, root)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('past `limit`, only the most recent sessions are read at all', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  // All three bodies are valid, so the cap is what decides what comes back:
  // a broken-body trick would prove only that the cap decides what is READ,
  // not that it decides what is listed.
  await withSession(sessionDir, project, { id: 'oldest', at: Date.UTC(2020, 0, 1) })
  await withSession(sessionDir, project, { id: 'middle', at: Date.UTC(2024, 0, 1) })
  await withSession(sessionDir, project, { id: 'newest', at: Date.UTC(2026, 0, 1) })
  try {
    const { sessions, more } = await readPlaces({ sessionDir, limit: 2 })
    assert.deepEqual(sessions.map(s => s.id), ['newest', 'middle'], 'the cap keeps the most recent, not an arbitrary subset')
    assert.equal(more, true, 'a row past the cap says there is more')
    const everything = await readPlaces({ sessionDir, limit: 99 })
    assert.equal(everything.sessions.length, 3, 'over-provisioned limit lists all three')
    assert.equal(everything.more, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('directories that name no folder are skipped, not fatal', async () => {
  const { root, sessionDir } = await store(async ({ root, sessionDir }) => {
    await mkdir(join(root, 'real'))
    await mkdir(join(sessionDir, 'empty'))
  })
  await withSession(sessionDir, join(root, 'real'))
  await withSession(sessionDir, join(root, 'garbled'), { body: 'not json at all\n' })
  await withSession(sessionDir, join(root, 'other-shape'), { body: `${JSON.stringify({ type: 'message' })}\n` })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions.map(session => session.name), ['real'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session whose header has no id is skipped, not fatal', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'real')) })
  await withSession(sessionDir, join(root, 'real'), {
    body: `${JSON.stringify({ type: 'session', version: 3, cwd: join(root, 'real') })}\n`,
  })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a conversation is found by id wherever it falls in the ranking', async () => {
  // A join and a migration name one session by id: it must not matter whether
  // that conversation is among the newest, since a window on a long list is
  // no place to look one thing up.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  try {
    await withSession(sessionDir, project, { id: 'oldest', at: Date.UTC(2020, 0, 1) })
    await withSession(sessionDir, project, { id: 'newest', name: 'newest.jsonl', at: Date.UTC(2026, 0, 1) })
    const found = await findPlace({ sessionDir, id: 'oldest', cwd: project })
    assert.equal(found?.id, 'oldest')
    assert.equal(await findPlace({ sessionDir, id: 'nope' }), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session forked from another is not a place of its own', async () => {
  // A subagent's run is filed as its own session naming its parent; the list
  // shows the session that spawned it, not the machinery behind it.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  try {
    const parent = await withSession(sessionDir, project, { id: 'mine' })
    await withSession(sessionDir, project, { id: 'sub', body: forkFile(project, 'sub', parent) })
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions.map(s => s.id), ['mine'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a fork still writing keeps its parent busy, however deep it runs', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  const long = Date.now() - 600_000
  try {
    const parent = await withSession(sessionDir, project, { id: 'mine', at: long })
    const fork = await withSession(sessionDir, project,
      { id: 'sub', body: forkFile(project, 'sub', parent), at: long })
    // Somebody else's session in the same folder being written right now is
    // not this session's work.
    await withSession(sessionDir, project, { id: 'other', name: 'other.jsonl' })
    assert.ok(await lastWrite(parent) < Date.now() - 60_000, "somebody else's session writing is not this one's work")

    // A subagent's subagent, two links up the chain from the parent, is.
    await withSession(sessionDir, project, { id: 'deep', body: forkFile(project, 'deep', fork) })
    assert.ok(await lastWrite(parent) > Date.now() - 60_000, "a subagent's subagent counts as its parent's work")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a wall of forks does not push the real sessions out of the window', async () => {
  // Subagent runs are written constantly and are not rows of the list, so on a
  // working machine they sit above everything worth finding. A limit that
  // spent itself on them would come back showing almost nothing.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  const old = Date.UTC(2020, 0, 1)
  try {
    const parent = await withSession(sessionDir, project, { id: 'mine', at: old })
    await withSession(sessionDir, project, { id: 'other', name: 'other.jsonl', at: old })
    await withSession(sessionDir, project, { id: 'fork1', body: forkFile(project, 'fork1', parent) })
    await withSession(sessionDir, project, { id: 'fork2', body: forkFile(project, 'fork2', parent) })
    const { sessions, more } = await readPlaces({ sessionDir, limit: 2 })
    assert.deepEqual(sessions.map(s => s.id).sort(), ['mine', 'other'])
    assert.equal(more, false, 'forks past the window are not more rows')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session in a folder that is gone is not a row', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  try {
    await withSession(sessionDir, project, { id: 'mine' })
    await rm(project, { recursive: true })
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a session file in a format this reader does not know is reported, once', async () => {
  // pi moving its store to a new header shape must not fail silently: the
  // list would empty and hide sessions.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'proj')) })
  const project = join(root, 'proj')
  const future = JSON.stringify(
    { v: 4, kind: 'header', id: 'mine', storageVersion: 1, createdAt: Date.now(), cwd: project })
  await withSession(sessionDir, project, { id: 'mine', body: future })
  await withSession(sessionDir, project, { id: 'also', name: 'also.jsonl', body: future })
  const said = []
  const was = console.error
  console.error = (...args) => said.push(args.join(' '))
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.deepEqual(sessions, [], 'a header it cannot read is no session it can list')
  } finally {
    console.error = was
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(said.length, 1, 'reported once, not once per file')
  assert.match(said[0], /kind=header v=4/)
})

test('two paths to one folder report the one everything else uses', async () => {
  // The case that matters is `/tmp/x` against `/private/tmp/x` on macOS: a
  // session recorded under either spelling should still display the same way.
  const { root, sessionDir } = await store(async ({ root }) => {
    await mkdir(join(root, 'work'))
    await symlink(join(root, 'work'), join(root, 'link-to-work'))
  })
  await withSession(sessionDir, join(root, 'link-to-work'), { id: 'x' })
  try {
    const { sessions: [session] } = await readPlaces({ sessionDir })
    assert.equal(session.cwd, join(root, 'work'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('no store at all is an empty list, not an error', async () => {
  assert.deepEqual(await readPlaces({ sessionDir: join(tmpdir(), 'mtty-nothing-here') }), { sessions: [], more: false })
})

test('paths are shortened for a phone-width row', () => {
  assert.equal(shorten(join(homedir(), 'projects', 'x')), '~/projects/x')
  assert.equal(shorten(homedir()), '~')
  assert.equal(shorten('/opt/elsewhere'), '/opt/elsewhere')
})

test('a session pi filed flat in the store root is listed too, by its own cwd', async () => {
  // A session started fresh with a minted --session-id lands at the root, not
  // in a per-cwd folder; the header inside is what says where it belongs.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'side')) })
  const flat = join(sessionDir, '2026-06-01T00-00-00-000Z_flat.jsonl')
  await writeFile(flat, sessionFile(join(root, 'side'), 'flat'))
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, 'flat')
    assert.equal(sessions[0].cwd, join(root, 'side'))
    assert.equal(sessions[0].name, 'side')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the label is pi\'s name for the session when it has one', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  await withSession(sessionDir, join(root, 'app'), {
    id: 'named',
    body: [
      JSON.stringify({ type: 'session', version: 3, id: 'named', cwd: join(root, 'app') }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'fix the login bug' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } }),
      JSON.stringify({ type: 'session_info', name: 'Fix the login bug' }),
    ].join('\n'),
  })
  try {
    const [{ sessions }] = [await readPlaces({ sessionDir })]
    assert.equal(sessions[0].label, 'Fix the login bug')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an unnamed session is labeled by its first ask, clipped to a row', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  const question = ('ask about ' + 'something '.repeat(30)).trim()
  await withSession(sessionDir, join(root, 'app'), {
    id: 'anon',
    body: [
      JSON.stringify({ type: 'session', version: 3, id: 'anon', cwd: join(root, 'app') }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'max' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: question }] } }),
    ].join('\n'),
  })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.ok(sessions[0].label.startsWith('ask about something'), 'falls back to the first user text')
    assert.ok(sessions[0].label.length <= 80, `clipped to a row, not ${sessions[0].label.length}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a listing holds no transcript file open once it is done', async () => {
  // Every row of a listing is labelled by reading its transcript, and a
  // forward pass that stops early used to leave that file open for good: one
  // descriptor per row, forever, until the process ran out and could spawn
  // nothing. The count must come back to where it started, however often the
  // list is read.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  // Past the few entries the label is read from, so the forward pass stops
  // early and leaves the rest unread -- the case that used to leak.
  const talk = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(256) } })).join('\n')
  for (const id of ['a', 'b', 'c']) {
    await withSession(sessionDir, join(root, 'app'), {
      id,
      body: [
        JSON.stringify({ type: 'session', version: 3, id, cwd: join(root, 'app') }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'the question' } }),
        talk,
      ].join('\n'),
    })
  }
  // /dev/fd is this process's own open descriptors on macOS and Linux.
  const openFiles = () => readdirSync('/dev/fd').length
  try {
    await readPlaces({ sessionDir })
    const before = openFiles()
    for (let round = 0; round < 3; round++) await readPlaces({ sessionDir })
    assert.equal(openFiles(), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a rename deep in the file wins over the early name: the tail is read', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  const filler = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1024) } })).join('\n')
  await withSession(sessionDir, join(root, 'app'), {
    id: 'renamed',
    body: [
      JSON.stringify({ type: 'session', version: 3, id: 'renamed', cwd: join(root, 'app') }),
      JSON.stringify({ type: 'session_info', name: 'early name' }),
      filler,
      JSON.stringify({ type: 'session_info', name: 'late rename' }),
    ].join('\n'),
  })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.equal(sessions[0].label, 'late rename')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an explicit clear of the name is honored, falling back to the first ask', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  await withSession(sessionDir, join(root, 'app'), {
    id: 'cleared',
    body: [
      JSON.stringify({ type: 'session', version: 3, id: 'cleared', cwd: join(root, 'app') }),
      JSON.stringify({ type: 'session_info', name: 'will be cleared' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'the first question' } }),
      JSON.stringify({ type: 'session_info', name: '' }),
    ].join('\n'),
  })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.equal(sessions[0].label, 'the first question')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a clear deep in the file is honored too, even though the tail find it', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'app')) })
  // Same shape as the deep rename: too big for the forward pass to reach, so
  // only the tail read sees the clear — and it must unset the early name
  // exactly as a late rename would have replaced it.
  const filler = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1024) } })).join('\n')
  await withSession(sessionDir, join(root, 'app'), {
    id: 'late-cleared',
    body: [
      JSON.stringify({ type: 'session', version: 3, id: 'late-cleared', cwd: join(root, 'app') }),
      JSON.stringify({ type: 'session_info', name: 'early name' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'the first question' } }),
      filler,
      JSON.stringify({ type: 'session_info', name: '' }),
    ].join('\n'),
  })
  try {
    const { sessions } = await readPlaces({ sessionDir })
    assert.equal(sessions[0].label, 'the first question')
  } finally { await rm(root, { recursive: true, force: true }) }
})
