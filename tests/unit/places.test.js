// The folder list is read out of pi's store, which this does not own: the files
// are pi's, the slugs are lossy, and half the directories on a working machine
// name folders that no longer exist. So the questions are what counts as a
// place at all, and whether the path it reports is the real one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlaces, shorten } from '../../server/places.js'

/** A session file the way pi writes one: a header line, then the conversation. */
const sessionFile = cwd => [
  JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-08-13T02:43:46.562Z', cwd }),
  JSON.stringify({ type: 'message', message: { role: 'user' } }),
].join('\n')

const store = async build => {
  // Resolved up front: on macOS the temp root is reached through a symlink, and
  // a place always reports the folder's one true path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mtty-places-')))
  const sessionDir = join(root, 'sessions')
  await mkdir(sessionDir)
  await build({ root, sessionDir })
  return { root, sessionDir }
}

/** pi's own directory naming: the cwd with its separators flattened to dashes. */
const slug = cwd => `-${cwd.replaceAll('/', '-')}-`

const withSession = async (sessionDir, cwd, { at, name = 'a.jsonl', body } = {}) => {
  const dir = join(sessionDir, slug(cwd))
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, body ?? sessionFile(cwd))
  if (at) await utimes(file, at / 1000, at / 1000)
  return file
}

test('a folder with pi history is a place, named by the path in the file', async () => {
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'my-project')) })
  const project = join(root, 'my-project')
  await withSession(sessionDir, project)
  try {
    const places = await readPlaces({ sessionDir })
    assert.equal(places.length, 1)
    assert.equal(places[0].cwd, project, 'the cwd comes from the header, not the slug')
    assert.equal(places[0].name, 'my-project')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder with a dash in its name survives the round trip the slug cannot', async () => {
  // The slug flattens separators to dashes, so `a-b/c` and `a/b/c` produce the
  // same directory name. Reading the header is what makes this exact.
  const { root, sessionDir } = await store(async ({ root }) => { await mkdir(join(root, 'pi-my-stuff')) })
  const project = join(root, 'pi-my-stuff')
  await withSession(sessionDir, project)
  try {
    const [place] = await readPlaces({ sessionDir })
    assert.equal(place.cwd, project)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder that no longer exists is not offered', async () => {
  const { root, sessionDir } = await store(async () => {})
  await withSession(sessionDir, join(root, 'deleted-long-ago'))
  try {
    assert.deepEqual(await readPlaces({ sessionDir }), [], 'spawning there would only fail')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('newest first, by the most recent session in each folder', async () => {
  const { root, sessionDir } = await store(async ({ root }) => {
    await mkdir(join(root, 'old'))
    await mkdir(join(root, 'new'))
  })
  await withSession(sessionDir, join(root, 'old'), { at: Date.UTC(2026, 0, 1) })
  await withSession(sessionDir, join(root, 'new'), { at: Date.UTC(2026, 5, 1) })
  // An older file alongside a newer one must not decide the folder's place.
  await withSession(sessionDir, join(root, 'new'), { name: 'b.jsonl', at: Date.UTC(2025, 0, 1) })
  try {
    assert.deepEqual((await readPlaces({ sessionDir })).map(place => place.name), ['new', 'old'])
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
    assert.deepEqual((await readPlaces({ sessionDir })).map(place => place.name), ['real'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('two paths to one folder are one place, at the path everything else uses', async () => {
  // The case that matters is `/tmp/x` against `/private/tmp/x` on macOS, where
  // the duplicate is of the folder the server is already in — so the list would
  // offer you where you are twice, under two spellings.
  const { root, sessionDir } = await store(async ({ root }) => {
    await mkdir(join(root, 'work'))
    await symlink(join(root, 'work'), join(root, 'link-to-work'))
  })
  await withSession(sessionDir, join(root, 'work'), { at: Date.UTC(2026, 0, 1) })
  await withSession(sessionDir, join(root, 'link-to-work'), { at: Date.UTC(2026, 5, 1) })
  try {
    const places = await readPlaces({ sessionDir })
    assert.equal(places.length, 1)
    assert.equal(places[0].cwd, join(root, 'work'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('no store at all is an empty list, not an error', async () => {
  assert.deepEqual(await readPlaces({ sessionDir: join(tmpdir(), 'mtty-nothing-here') }), [])
})

test('paths are shortened for a phone-width row', () => {
  assert.equal(shorten(join(homedir(), 'projects', 'x')), '~/projects/x')
  assert.equal(shorten(homedir()), '~')
  assert.equal(shorten('/opt/elsewhere'), '/opt/elsewhere')
})
