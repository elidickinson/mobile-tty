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

// A machine with months of history can have thousands of session files
// across every folder pi has ever run in. Nothing needs to read all of them
// to answer "what are the 50 most recent" -- see readPlaces below.
const DEFAULT_LIMIT = 50

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

/**
 * Every `.jsonl` path in one folder, with its mtime and nothing else read.
 *
 * A stat is metadata only — no open, no content — which is what lets every
 * candidate across the whole store be ranked before anything pays to parse
 * one. Ranking first and reading second is the whole point of the split.
 */
const listFolder = async dir => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
  return Promise.all(files.map(async name => {
    const file = join(dir, name)
    return { file, at: (await stat(file)).mtimeMs }
  }))
}

/** A ranked candidate resolved into a session row, or null if it turns out
 *  not to be one — pi's store accumulates files this does not recognise and
 *  folders that no longer exist, same as before, just discovered later now. */
const resolve = async ({ file, at }) => {
  const header = await readHeader(file)
  if (!header) return null
  const cwd = await canonical(header.cwd)
  if (!cwd) return null
  return { id: header.id, cwd, name: basename(cwd), path: shorten(cwd), at }
}

/**
 * Every session pi has a transcript for, newest first, capped at `limit`.
 *
 * `total` counts every candidate file found, whether or not it made the cut
 * (or turned out, once read, not to be a real session) — the caller's
 * honest answer to "is this everything, or is more being held back."
 *
 * Sorted by recency because that is the only ordering a phone list can be
 * scrolled by usefully: what you want is nearly always in the first few rows,
 * and past `limit` nothing on a real machine's worth of history is going to
 * be — a stat of every file gets that ranking, and only the ones that make
 * the cut are ever actually opened and parsed.
 */
export async function readPlaces({ sessionDir = PI_SESSIONS, limit = DEFAULT_LIMIT } = {}) {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (err) {
    // No store is an answer rather than a fault: pi may simply never have run.
    if (err.code === 'ENOENT') return { sessions: [], total: 0 }
    throw err
  }

  const found = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => listFolder(join(sessionDir, entry.name))))
  const candidates = found.flat().sort((a, b) => b.at - a.at)

  const sessions = []
  for (const candidate of candidates.slice(0, limit)) {
    const row = await resolve(candidate)
    if (row) sessions.push(row)
  }
  return { sessions, total: candidates.length }
}
