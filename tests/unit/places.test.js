// The session list is read out of pi's store, which this does not own: the
// files are pi's, the slugs are lossy, and half the directories on a working
// machine name folders that no longer exist. So the questions are what counts
// as a session at all, whether the path it reports is the real one, whether a
// folder with several sessions in it offers all of them, and whether a store
// with far more history than a phone list can show is capped rather than read
// in full every time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlaces, shorten } from '../../server/places.js'

/** A session file the way pi writes one: a header line, then the conversation. */
const sessionFile = (cwd, id) => [
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-13T02:43:46.562Z', cwd }),
  JSON.stringify({ type: 'message', message: { role: 'user' } }),
].join('\n')

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
    const { sessions, total } = await readPlaces({ sessionDir })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].cwd, project, 'the cwd comes from the header, not the slug')
    assert.equal(sessions[0].name, 'my-project')
    assert.equal(sessions[0].id, 'x')
    assert.equal(total, 1)
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
    const { sessions, total } = await readPlaces({ sessionDir, limit: 2 })
    assert.deepEqual(sessions.map(s => s.id), ['newest', 'middle'], 'the cap keeps the most recent, not an arbitrary subset')
    assert.equal(total, 3, 'total still counts every candidate found, capped or not')
    const everything = await readPlaces({ sessionDir, limit: 99 })
    assert.equal(everything.sessions.length, 3, 'over-provisioned limit lists all three')
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
  assert.deepEqual(await readPlaces({ sessionDir: join(tmpdir(), 'mtty-nothing-here') }), { sessions: [], total: 0 })
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
