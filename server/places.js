// The sessions you have used pi in, read out of pi's own session store.
//
// pi keys sessions by working directory and gives each one its own id:
// ~/.pi/agent/sessions/<slug>/*.jsonl, one directory per cwd, one file per
// session. The slug is lossy -- a path containing a dash is indistinguishable
// from a separator -- so the real path comes from the session file itself,
// whose first line is a header carrying both the cwd and the id verbatim.
//
// One row per session, not per folder: a folder used for several concurrent
// or historical conversations offers all of them, since a phone list can only
// usefully be sorted one way -- by how recently each one was touched.
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
 * A session file's header, or null if it does not look like one.
 *
 * I/O errors are left to propagate — an unreadable store is worth hearing
 * about. A line that does not parse, or lacks an id, is a different thing:
 * the directory holds something this does not recognise, which is a fact
 * about the file rather than a fault, and the answer is simply that there is
 * no session here.
 */
const readHeader = async file => {
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
  return header?.type === 'session' && typeof header.cwd === 'string' && typeof header.id === 'string'
    ? header
    : null
}

/**
 * The one true path of an existing folder, or null if it is not one any more.
 *
 * Resolved rather than taken as written, because `/tmp/x` and `/private/tmp/x`
 * are the same folder and a session recorded under one spelling should still
 * display the way everything else on the list does.
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

/** Every session recorded in one folder's directory under the store. */
const readFolder = async dir => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
  const rows = await Promise.all(files.map(async name => {
    const file = join(dir, name)
    const [header, stats] = await Promise.all([readHeader(file), stat(file)])
    if (!header) return null
    // pi keeps a slug for ever, so the store accumulates folders that no
    // longer exist — mostly temp directories from benchmark runs. Spawning
    // into one would fail, so it is not a session that can be offered.
    const cwd = await canonical(header.cwd)
    if (!cwd) return null
    return { id: header.id, cwd, name: basename(cwd), path: shorten(cwd), at: stats.mtimeMs }
  }))
  return rows.filter(Boolean)
}

/**
 * Every session pi has a transcript for, newest first.
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
    .map(entry => readFolder(join(sessionDir, entry.name))))

  return found.flat().sort((a, b) => b.at - a.at)
}
