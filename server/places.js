// The sessions you have used pi in, read out of pi's own session store.
//
// pi keys sessions by working directory and gives each one its own id:
// ~/.pi/agent/sessions/<slug>/*.jsonl, one directory per cwd, one file per
// session. The slug is lossy -- a path containing a dash is indistinguishable
// from a separator -- so the real path comes from the session file itself,
// whose first line is a header carrying both the cwd and the id verbatim.
// A session STARTED with a fresh `--session-id` is filed flat in the store
// root instead of a slug dir, so root-level .jsonl files are scanned too; the
// header's cwd is what says where either kind belongs.
//
// One row per session, not per folder: a folder used for several concurrent
// or historical conversations offers all of them, since a phone list can only
// usefully be sorted one way -- by how recently each one was touched.
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
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

// A session id becomes a file name (`mtty-<id>.sock`) and part of a join URL;
// anything outside this shape would be either a path-traversal attempt or a
// name no client could have learned from this list in the first place.
const ID_SHAPE = /^[A-Za-z0-9_-]+$/

// The window a label read is allowed before it stops: renaming appends a new
// session_info at the end of a file, so a bounded read from the end catches it
// without walking the whole transcript. Sized like pi-fast-resume's: their
// measurement had every rename at EOF, 32KB covers a rename followed by dozens
// of turns of continued writing.
const TAIL_BYTES = 32 * 1024

/** A label is at most a phone row: long first asks are truncated on display. */
const LABEL_MAX = 80

const clip = text => {
  const line = (text ?? '').trim().split('\n')[0]
  return line.length > LABEL_MAX ? line.slice(0, LABEL_MAX - 1) + '…' : line
}

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
 * The row's label: pi's own name for the session if it ever got one, else the
 * first thing the user asked, else nothing.
 *
 * pi appends a `session_info` entry every time a session is named -- `/name`,
 * `--name`, an extension setting one -- and the LAST one in file order is the
 * name (an empty name is an explicit clear). Sessions are named either at
 * once (named at start, the event sits in the first lines) or right after the
 * first exchange, so the forward pass reads header + first user message + the
 * reply that follows, stopping at the first name or a bit past it; a rename
 * anywhere later is caught by a bounded read from the end of the file, which
 * also catches renames the forward pass could never see. Further-past renames
 * are accepted as showing the older name, the same tradeoff pi-fast-resume
 * makes with the same size.
 */
const readLabel = async (file, size) => {
  let named
  let firstUser
  let afterFirst = 0
  let stop = false
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  rl.on('line', line => {
    if (stop) return
    const entry = tryParse(line)
    if (!entry) return
    if (entry.type === 'session_info') {
      // The latest name in file order wins. An empty name is an explicit
      // clear — it unsets, and the label falls back to the first ask.
      named = entry.name?.trim() || undefined
    } else if (entry.type === 'message' && entry.message?.role === 'user') {
      firstUser ??= entry.message.content
    } else if (firstUser !== undefined && entry.type === 'message') {
      // The reply to the first ask, then a little slack: pi names the session
      // right after it, and renames ride the same window. A few entries past
      // that, whatever the label is going to be is already on disk.
      afterFirst++
      if (afterFirst >= 4) { stop = true; rl.close() }
    }
  })
  await new Promise(resolve => rl.on('close', resolve))

  // The tail can only hold a later name than anything the forward pass saw if
  // it stopped short of EOF, and the read must then start past it.
  if (stop && size > TAIL_BYTES) {
    const handle = await open(file, 'r')
    try {
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(TAIL_BYTES), 0, TAIL_BYTES, size - TAIL_BYTES)
      for (const line of buffer.subarray(0, bytesRead).toString().split('\n')) {
        const entry = tryParse(line)
        // In the tail, later still wins — and an empty name is as much a
        // "later" as a real one: a late clear has to unset, too, or an old
        // title would outlive its own removal.
        if (entry?.type === 'session_info') {
          named = entry.name?.trim() || undefined
        }
      }
    } finally {
      await handle.close()
    }
  }
  // A name that was cleared falls back to the first ask, like a name that was
  // never set: `named` is undefined both ways.
  return clip(named ?? textOf(firstUser))
}

const tryParse = line => {
  try { return JSON.parse(line) } catch { return null }
}

/** The text of a user message, however pi chose to lay it out. */
const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(part => part.type === 'text').map(part => part.text).join(' ')
  }
  return content?.text ?? ''
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

export { canonical }

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
  if (!header || !ID_SHAPE.test(header.id)) return null
  const cwd = await canonical(header.cwd)
  if (!cwd) return null
  const size = (await stat(file)).size
  // A transcript with no conversation in it yet has nothing to label it with;
  // the folder name is the honest row then, and the only one there is.
  const label = await readLabel(file, size) || basename(cwd)
  return { id: header.id, cwd, name: basename(cwd), path: shorten(cwd), at, label }
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

  // Slug folders per cwd, plus the store root itself: a session started with
  // a fresh `--session-id` is filed flat there, not under any folder, and is
  // as much a place as the rest. The root's own .jsonl files are read
  // directly — they are files, not a folder to list;
  const folders = entries.filter(entry => entry.isDirectory())
  const flat = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => ({ file: join(sessionDir, entry.name), at: 0 }))
  const found = await Promise.all([
    ...flat.map(async candidate => ({ ...candidate, at: (await stat(candidate.file)).mtimeMs })),
    ...folders.map(entry => listFolder(join(sessionDir, entry.name))),
  ])
  const candidates = found.flat().sort((a, b) => b.at - a.at)

  const sessions = []
  for (const candidate of candidates.slice(0, limit)) {
    const row = await resolve(candidate)
    if (row) sessions.push(row)
  }
  return { sessions, total: candidates.length }
}
