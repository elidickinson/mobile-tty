// The live children: one pi per session id, kept running once joined.
//
// A join spawns a child on demand (see server/cli.js's --internal-socket mode,
// which is exactly server/index.js's single-session server bound to a Unix
// socket instead of a port) and leaves it running after the viewer goes away —
// that is the whole point. A cap keeps them from accumulating without bound:
// past it, the child nobody has looked at longest is ended to make room for
// the one just asked for.
/**
 * The live children: one pi per session id, kept running once joined.
 *
 * A join spawns a child on demand (see server/cli.js's --internal-socket mode,
 * which is exactly server/index.js's single-session server bound to a Unix
 * socket instead of a port) and leaves it running after the viewer goes away —
 * that is the whole point. A cap keeps them from accumulating without bound:
 * past it, the child nobody has looked at longest is ended to make room for
 * the one just asked for. Children listen on Unix sockets in the directory
 * given by `socketDir` — meant to be a fresh private directory per supervisor
 * (see cli.js), not the shared tmpdir, where any local user could squat on a
 * predictable socket name and answer joins meant for us.
 */
import { fork } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

const KILL_GRACE_MS = 2_000

// pi's own flag for resuming by id, and the test for whether naming one means
// anything: `bash --session-id x` is an invalid option, not a session.
const SESSION_FLAG = '--session-id'
const takesSessionId = command => basename(command) === 'pi'

export class Registry {
  #children = new Map() // id -> { proc, socketPath, cwd, joinedAt, gone, sockets }
  #cliPath
  #program
  #programArgs
  #socketDir
  #cap
  #theme

  constructor({ cliPath, program, programArgs = [], socketDir, cap = 4, theme = 'dark' }) {
    this.#cliPath = cliPath
    this.#program = program
    this.#programArgs = programArgs
    this.#socketDir = socketDir
    this.#cap = cap
    this.#theme = theme
  }

  has(id) { return this.#children.has(id) }

  /** The running child itself, or undefined — its cwd pins where a session lives. */
  child(id) { return this.#children.get(id) }

  /**
   * Call back when `id`'s child is gone, however it went — eviction, wedge,
   * plain exit. The returned function unregisters. A connected viewer registers
   * here so the supervisor can cut its browser side the moment the session is
   * over rather than waiting on a dead socket to be noticed.
   */
  watch(id, fn) {
    const child = this.#children.get(id)
    if (!child) { fn(); return () => {} }
    child.sockets.push(fn)
    return () => {
      const at = child.sockets.indexOf(fn)
      if (at !== -1) child.sockets.splice(at, 1)
    }
  }

  /** ids of every session currently running, oldest-joined first. */
  running() {
    return [...this.#children.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt).map(([id]) => id)
  }

  /**
   * The running child for `id`, spawning one in `cwd` if none is up yet.
   *
   * `cwd` is only used on the way up: an already-running child keeps whatever
   * folder it started in, and touching it here just marks it as the most
   * recently looked-at one for eviction purposes.
   */
  ensure(id, cwd) {
    const existing = this.#children.get(id)
    if (existing) {
      existing.joinedAt = Date.now()
      return existing
    }

    this.#evictIfFull(id)

    // The socket name is only a short prefix of the id, not the whole of it:
    // a Unix socket path must fit in 104 bytes on macOS, and tmpdir + a uuid
    // does not. The directory is this supervisor's alone (0700, fresh per
    // run), so a short name cannot collide with anything but a sibling here.
    const socketPath = join(this.#socketDir, `mtty-${id.slice(0, 8)}.sock`)
    // The session id goes to pi alone: it is pi's own flag, and appending it to
    // any other program's command line breaks it (bash exits on the unknown
    // option before printing a prompt). The child learns its id from the socket
    // path either way.
    const program = this.#program
    const runtimeArgs = takesSessionId(program) ? [...this.#programArgs, SESSION_FLAG, id] : [...this.#programArgs]
    // fork(), not spawn(): it wires up an IPC channel for free, and
    // --internal-socket's own handler listens for that channel's 'disconnect'
    // to end itself if this process ever goes away without the chance to ask
    // nicely first (a crash, or someone signalling the wrong pid) — otherwise
    // an orphaned child has nothing tying its life to ours at all. `stdio`
    // spells out 'ignore' for the three inherited streams explicitly, since
    // fork()'s own default is to pipe them back here rather than drop them.
    const proc = fork(this.#cliPath, [
      '--internal-socket', socketPath, '--internal-cwd', cwd,
      '--theme', this.#theme, '--', program, ...runtimeArgs,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    // A child that cannot even start must not wedge the process that spawned
    // it — see the unhandled 'error' rule node-pty and node's own child_process
    // both apply here.
    proc.on('error', err => console.error(`server: session ${id} could not start`, err))

    const child = { proc, socketPath, cwd, joinedAt: Date.now(), sockets: [] }
    child.gone = new Promise(resolve => {
      proc.on('exit', () => {
        if (this.#children.get(id) === child) this.#children.delete(id)
        rm(socketPath, { force: true }).catch(() => {})
        for (const fn of child.sockets.splice(0)) fn()
        resolve()
      })
    })
    this.#children.set(id, child)
    return child
  }

  /** Ask a session to end, and wait until it actually has. */
  async end(id) {
    const child = this.#children.get(id)
    if (!child) return
    child.proc.kill('SIGTERM')
    const escalate = setTimeout(() => child.proc.kill('SIGKILL'), KILL_GRACE_MS)
    escalate.unref()
    await child.gone
    clearTimeout(escalate)
  }

  async endAll() {
    await Promise.all(this.running().map(id => this.end(id)))
  }

  #evictIfFull(spawning) {
    if (this.#children.size < this.#cap) return
    // The child being spawned right now is never the eviction candidate, even
    // though it is not in the map yet: rejoining a session joined long ago is
    // exactly the case an LRU exists to serve, not to refuse.
    const [oldest] = this.running().filter(id => id !== spawning)
    // Not awaited: the new session can start spawning immediately, and the
    // evicted one's socket file is cleaned up by its own exit handler above.
    this.end(oldest).catch(err => console.error(`server: could not end session ${oldest}`, err))
  }
}
