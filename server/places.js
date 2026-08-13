// The folders you have used pi in, read out of pi's own session store.
//
// pi keys sessions by working directory: ~/.pi/agent/sessions/<slug>/*.jsonl,
// one directory per cwd. The slug is lossy — a path containing a dash is
// indistinguishable from a separator — so the real path comes from the session
// file itself, whose first line is a header carrying it verbatim.
//
// This is the whole reason the server can do something no pi extension can: an
// extension cannot change the cwd of the process it lives in, and a phone has
// no shell to change it from. Spawning is the only way to be somewhere else.
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// pi's own variable for moving its store, so a machine that has moved it is
// still described correctly here rather than by where it usually lives.
export const PI_SESSIONS = process.env.PI_CODING_AGENT_SESSION_DIR ||
  join(homedir(), '.pi', 'agent', 'sessions')

// The header is the first line and is short — around 150 bytes. Reading a fixed
// window keeps a megabyte-long transcript from being pulled in to learn one
// field, and there are a hundred of these to sweep.
const HEADER_BYTES = 4096

/** `~/projects/x` rather than `/Users/you/projects/x`: phone-width matters. */
export const shorten = path => {
  const home = homedir()
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * The cwd a session file was recorded in, or null if it is not a session file.
 *
 * I/O errors are left to propagate — an unreadable store is worth hearing
 * about. A line that does not parse is a different thing: the directory holds
 * something this does not recognise, which is a fact about the file rather than
 * a fault, and the answer is simply that there is no place here.
 */
const readCwd = async file => {
  const handle = await open(file, 'r')
  let line
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0)
    ;[line] = buffer.subarray(0, bytesRead).toString().split('\n')
  } finally {
    await handle.close()
  }
  let header
  try {
    header = JSON.parse(line)
  } catch {
    return null
  }
  return header?.type === 'session' && typeof header.cwd === 'string' ? header.cwd : null
}

/**
 * The one true path of an existing folder, or null if it is not one any more.
 *
 * Resolved rather than taken as written, because `/tmp/x` and `/private/tmp/x`
 * are the same folder and would otherwise be offered as two — including as a
 * second copy of the one you are already in, which is where this shows up.
 */
const canonical = async path => {
  let real
  try {
    real = await realpath(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return (await stat(real)).isDirectory() ? real : null
}

const readPlace = async dir => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
  if (files.length === 0) return null

  const dated = await Promise.all(files.map(async name => ({ name, at: (await stat(join(dir, name))).mtimeMs })))
  const newest = dated.sort((a, b) => b.at - a.at)[0]

  const recorded = await readCwd(join(dir, newest.name))
  if (!recorded) return null
  // pi keeps a slug for ever, so the store accumulates folders that no longer
  // exist — mostly temp directories from benchmark runs. Spawning into one
  // would fail, so it is not a place.
  const cwd = await canonical(recorded)
  if (!cwd) return null

  return { ...placeFor(cwd), at: newest.at }
}

/**
 * Every folder with pi history, newest first.
 *
 * Sorted by recency because that is the only ordering a phone list can be
 * scrolled by usefully: what you want is nearly always in the first few rows.
 */
export async function readPlaces({ sessionDir = PI_SESSIONS } = {}) {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (err) {
    // No store is an answer rather than a fault: pi may simply never have run.
    if (err.code === 'ENOENT') return []
    throw err
  }

  const found = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => readPlace(join(sessionDir, entry.name))))

  // Sorted before the folders are made unique, so where two of pi's slugs name
  // the same folder it is the most recently used of them that survives.
  const seen = new Set()
  const places = []
  for (const place of found.filter(Boolean).sort((a, b) => b.at - a.at)) {
    if (seen.has(place.cwd)) continue
    seen.add(place.cwd)
    places.push(place)
  }
  return places
}

/** The place for a directory with no pi history yet — the one the server started in. */
export const placeFor = cwd => ({ cwd, name: basename(cwd) || cwd, path: shorten(cwd), at: 0 })
