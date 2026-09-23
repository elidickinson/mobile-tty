// The live children: one pi per session id, kept running once joined.
//
// A join spawns a child on demand (see server/cli.js's --internal-socket mode,
// which is exactly server/index.js's single-session server bound to a Unix
// socket instead of a port) and leaves it running after the viewer goes away —
// that is the whole point. A cap keeps them from accumulating without bound:
// past it, the child nobody has looked at longest is ended to make room for
// the one just asked for.
import { fork } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const KILL_GRACE_MS = 2_000

export class Registry {
  #children = new Map() // id -> { proc, socketPath, cwd, joinedAt, gone }
  #cliPath
  #program
  #programArgs
  #socketDir
  #cap

  constructor({ cliPath, program, programArgs = [], socketDir, cap = 4 }) {
    this.#cliPath = cliPath
    this.#program = program
    this.#programArgs = programArgs
    this.#socketDir = socketDir
    this.#cap = cap
  }

  has(id) { return this.#children.has(id) }

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

    this.#evictIfFull()

    const socketPath = join(this.#socketDir, `mtty-${id}.sock`)
    // fork(), not spawn(): it wires up an IPC channel for free, and
    // --internal-socket's own handler listens for that channel's 'disconnect'
    // to end itself if this process ever goes away without the chance to ask
    // nicely first (a crash, or someone signalling the wrong pid) — otherwise
    // an orphaned child has nothing tying its life to ours at all. `stdio`
    // spells out 'ignore' for the three inherited streams explicitly, since
    // fork()'s own default is to pipe them back here rather than drop them.
    const proc = fork(this.#cliPath, [
      '--internal-socket', socketPath, '--internal-cwd', cwd,
      '--', this.#program, ...this.#programArgs, '--session-id', id,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    // A child that cannot even start must not wedge the process that spawned
    // it — see the unhandled 'error' rule node-pty and node's own child_process
    // both apply here.
    proc.on('error', err => console.error(`server: session ${id} could not start`, err))

    const child = { proc, socketPath, cwd, joinedAt: Date.now() }
    child.gone = new Promise(resolve => {
      proc.on('exit', () => {
        if (this.#children.get(id) === child) this.#children.delete(id)
        rm(socketPath, { force: true }).catch(() => {})
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

  #evictIfFull() {
    if (this.#children.size < this.#cap) return
    const [oldest] = this.running()
    // Not awaited: the new session can start spawning immediately, and the
    // evicted one's socket file is cleaned up by its own exit handler above.
    this.end(oldest).catch(err => console.error(`server: could not end session ${oldest}`, err))
  }
}
