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
// A session pi forked off another -- a subagent's run, or a /fork or /clone,
// which write the same header -- is no row of the list; its writes still count
// as work for the session that spawned it, which is what `lastWrite` below
// knows to follow. An exact id still reaches a fork: `findPlace` answers it,
// so a caller that knows the id needs no menu row.
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// pi's own variable for moving its store, so a machine that has moved it is
// still described correctly here rather than by where it usually lives.
export const PI_SESSIONS = process.env.PI_CODING_AGENT_SESSION_DIR ||
  join(homedir(), '.pi', 'agent', 'sessions')

// The header is the first line and is short — around 150 bytes. Reading a fixed
// window keeps a megabyte-long transcript from being pulled in to learn one
// field, and there are a hundred of these to sweep.
const HEADER_BYTES = 4096

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
 * How a folder is shown wherever it is named: a menu row, the header. One
 * place does it, so a row and the frame that committed the place cannot
 * disagree about the same folder.
 */
export const placeNames = cwd => ({ name: basename(cwd), path: shorten(cwd) })

/** Formats already reported, so a store that has moved on says so once rather
 *  than once per row of every listing. */
const unknownFormats = new Set()

const noteUnknownFormat = (file, header) => {
  const shape = `kind=${header.kind ?? header.type ?? '?'} v=${header.v ?? header.version ?? '?'}`
  if (unknownFormats.has(shape)) return
  unknownFormats.add(shape)
  console.error(`server: ${file} is a session file this reader does not understand (${shape})`)
}

/**
 * A session file's header, or null if it does not look like one.
 *
 * I/O errors are left to propagate — an unreadable store is worth hearing
 * about. A line that does not parse, or lacks an id, is a different thing:
 * the directory holds something this does not recognise, which is a fact
 * about the file rather than a fault, and the answer is simply that there is
 * no session here. A header that does say whose session it is, but in a shape
 * this reader does not know, is different again: pi has moved its store on,
 * and answering "no session here" quietly would empty the menu and leave
 * eviction blind to subagent work, so it is reported instead.
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
  if (header?.type === 'session' && typeof header.cwd === 'string' && typeof header.id === 'string') {
    return header
  }
  // pi's next session format lands here first: a header that identifies its
  // session, but not in any shape above.
  if (header?.kind === 'header' || (typeof header?.id === 'string' && typeof header?.cwd === 'string')) {
    noteUnknownFormat(file, header)
  }
  return null
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
  const stream = createReadStream(file)
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
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
  // A forward pass that stopped early leaves the stream short of its end, and
  // a stream that never ends never closes its file. Every row of a listing
  // pays this read, so one transcript left open per row is what fills the
  // process's descriptor table and makes every later spawn fail.
  stream.destroy()

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

/** A folder path, or null: a link to a folder counts, a link to anything else
 *  does not, and neither does one whose target is gone. */
const asFolder = async (here, name) => {
  const path = join(here, name)
  try {
    return (await stat(path)).isDirectory() ? path : null
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** List non-hidden subfolders for the new-session walk. */
export const subfolders = async dir => {
  const here = await canonical(dir)
  if (!here) return null
  const names = (await readdir(here)).filter(name => !name.startsWith('.'))
  const dirs = (await Promise.all(names.map(name => asFolder(here, name)))).filter(Boolean).sort()
  return { cwd: here, parent: here === '/' ? null : dirname(here), dirs }
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

/** A ranked candidate is a row of the list or it is not: the header says whose
 *  session it is, and the folder it names still has to exist. Checked before
 *  anything pays for a label, because most of a real store is forks and
 *  folders that are gone — and forks are written constantly, so they cluster
 *  at the top of the ranking where the newest writes are. */
const isRow = async ({ file, at }, { forks = false } = {}) => {
  const header = await readHeader(file)
  if (!header || !ID_SHAPE.test(header.id)) return null
  // A subagent's run is filed as a session of its own naming its parent, and
  // belongs to the session that spawned it rather than to the phone list.
  // A caller that names an exact id wants whatever transcript that id names,
  // fork or not, so the filter is the listing's, not the lookup's.
  if (!forks && header.parentSession) return null
  const cwd = await canonical(header.cwd)
  return cwd ? { file, at, id: header.id, cwd } : null
}

/** A row with its label: a pass over the transcript plus a bounded tail, the
 *  one expensive read here, and so paid only for the rows returned. A
 *  transcript with no conversation in it yet has nothing to label it with;
 *  the folder name is the honest row then, and the only one there is. */
const labelled = async row => {
  const { file, ...rest } = row
  return {
    ...rest,
    ...placeNames(row.cwd),
    label: await readLabel(file, (await stat(file)).size) || basename(row.cwd),
  }
}

/**
 * Every `.jsonl` in the store, newest first, with nothing but a stat read.
 *
 * Sorted by recency because that is the only ordering a phone list can be
 * scrolled by usefully: what you want is nearly always in the first few rows.
 * A machine with months of history has thousands of these, so callers read
 * headers down this ranking only until they have what they came for.
 */
const ranked = async sessionDir => {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (err) {
    // No store is an answer rather than a fault: pi may simply never have run.
    if (err.code === 'ENOENT') return []
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
  return found.flat().sort((a, b) => b.at - a.at)
}

/** A running terminal's row, labelled from the transcript its identity names.
 *  Pi writes that file with the first entry, so until then there is none and
 *  the folder name is the label, as for any transcript with nothing in it. */
const liveRow = async ({ file, ...running }) => {
  let info
  try {
    info = file && await stat(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  if (!info) return running
  return { ...running, at: info.mtimeMs, label: await readLabel(file, info.size) || running.label }
}

/**
 * A window on the list: `limit` rows from `offset`, and whether any lie past it.
 *
 * `live` is what the running terminals have open. Those lead the list -- what
 * is alive is what is worth finding first -- and their transcripts are skipped
 * further down, so a running session is one row in one place.
 *
 * `limit` counts ROWS rather than files. A cap on files would be spent almost
 * entirely on forks and folders that are gone — the bulk of a real store, and
 * the files written most often — and would come back holding whatever rows
 * happened to sit among them. Headers are read down the ranking only until the
 * window and one row past it are found; nothing counts the rest.
 */
export async function readPlaces({ sessionDir = PI_SESSIONS, offset = 0, limit = Infinity, live = [] } = {}) {
  const rows = (await Promise.all(live.map(liveRow))).sort((a, b) => b.at - a.at)
  const end = offset + limit
  for (const candidate of await ranked(sessionDir)) {
    if (rows.length > end) break
    const row = await isRow(candidate)
    if (row && !live.some(running => running.id === row.id && running.cwd === row.cwd)) rows.push(row)
  }
  const sessions = []
  for (const row of rows.slice(offset, end)) {
    sessions.push(row.file ? await labelled(row) : row)
  }
  return { sessions, more: rows.length > end }
}

/** The one row for a conversation, wherever it falls in the ranking: a join or
 *  a migration names a session by id, and no listing window is where to look
 *  one thing up. Newest first, so the session just tapped is found at once. */
export async function findPlace({ sessionDir = PI_SESSIONS, id, cwd }) {
  // An id outside this shape could never have come from a listing, and the
  // sweep below reads headers across the whole store before giving up.
  if (!ID_SHAPE.test(id ?? '')) return null
  for (const candidate of await ranked(sessionDir)) {
    const row = await isRow(candidate, { forks: true })
    if (row?.id === id && (!cwd || row.cwd === cwd)) return labelled(row)
  }
  return null
}

/** Whether `candidate` is `root`, or was forked from something that was.
 *  Paths are resolved before they are compared: pi writes `parentSession` the
 *  way it spells the path, and an alias of one folder is that folder. A file
 *  gone mid-walk ends the chain -- nothing to prove either way, and not worth
 *  failing a listing over. */
const descendedFrom = async (candidate, root) => {
  try {
    const wanted = await realpath(root)
    // Fork chains are subagent-deep; anything longer is not one of ours.
    for (let at = candidate, up = 0; at && up < 16; up++) {
      if ((await realpath(at)) === wanted) return true
      at = (await readHeader(at))?.parentSession
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return false
}

/**
 * When anything in this session's world was last written: its own transcript,
 * or any session forked from it. pi records a subagent's run as a session
 * file naming its parent, so a session that looks parked may be doing all its
 * work through subagents -- and ending it would orphan that work. Zero when
 * there is nothing to read, as for a program that keeps no store.
 *
 * Forks nest -- a subagent's subagent names the subagent's file -- so each
 * file is followed up its parent chain rather than assumed related, the
 * folder holding sessions this one has nothing to do with. A file that
 * cannot beat the newest related one already seen is no look at all.
 */
export async function lastWrite(file) {
  const dir = dirname(file)
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
  let last = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const candidate = join(dir, name)
    const at = (await stat(candidate)).mtimeMs
    if (at <= last) continue
    if (await descendedFrom(candidate, file)) last = at
  }
  return last
}
