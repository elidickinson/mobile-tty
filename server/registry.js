// Live PTYs have their own stable IDs. Pi's conversation ID is only the
// initial transcript to open; /new and /resume can change it in the same PTY.
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastWrite } from './places.js'

const KILL_GRACE_MS = 2_000
// How long a session must be left alone before it can be ended to free a slot
// for a new one. Generous on purpose: the question is whether anyone is
// coming back to this in the next few minutes, not whether the model is done.
const IDLE_MS = 10 * 60_000
const SESSION_EXTENSION = fileURLToPath(new URL('../pi-extensions/mtty-session.ts', import.meta.url))
const takesSessionId = command => basename(command) === 'pi'

/** When this PTY was last seen doing anything at all. */
const touchedAt = child => Math.max(child.joinedAt, child.lastOutputAt ?? 0)

export class Registry {
  #children = new Map() // processId -> child
  #cliPath
  #program
  #programArgs
  #socketDir
  #cap
  #theme
  #nextSocket = 0
  #evicting = new Set()
  #idleMs

  constructor({ cliPath, program, programArgs = [], socketDir, cap = 4, theme = 'dark', idleMs = IDLE_MS }) {
    this.#cliPath = cliPath
    this.#program = program
    this.#programArgs = programArgs
    this.#socketDir = socketDir
    this.#cap = cap
    this.#theme = theme
    this.#idleMs = idleMs
  }

  child(processId) { return this.#children.get(processId) }

  /** The conversation this PTY currently has open. */
  current(child) {
    return JSON.parse(readFileSync(child.identityPath, 'utf8'))
  }

  owner(sessionId, cwd) {
    return [...this.#children.values()].find(child => {
      const current = this.current(child)
      return current.id === sessionId && current.cwd === cwd
    })
  }

  watch(processId, fn) {
    const child = this.child(processId)
    if (!child) { fn('pi exited'); return () => {} }
    child.sockets.push(fn)
    return () => {
      const at = child.sockets.indexOf(fn)
      if (at !== -1) child.sockets.splice(at, 1)
    }
  }

  running() {
    return [...this.#children.values()].sort((a, b) => a.joinedAt - b.joinedAt)
  }

  /** Join a current conversation if it is live, otherwise start another PTY.
   *  Null when the pool is full and nothing in it may be ended to make room. */
  async ensure(sessionId, cwd) {
    const existing = this.owner(sessionId, cwd)
    if (existing) {
      existing.joinedAt = Date.now()
      return existing
    }
    return this.start(sessionId, cwd)
  }

  async start(sessionId, cwd) {
    if (!(await this.#makeRoom())) return null
    const processId = randomUUID()
    // Short, unique names within this supervisor's private directory. Neither
    // transport nor runtime identity is derived from a Pi conversation ID.
    const socketPath = join(this.#socketDir, `mtty-${++this.#nextSocket}.sock`)
    const identityPath = join(this.#socketDir, `mtty-${this.#nextSocket}.identity`)
    writeFileSync(identityPath, JSON.stringify({ id: sessionId, cwd, at: Date.now() }))
    const program = this.#program
    const runtimeArgs = takesSessionId(program)
      ? [...this.#programArgs, '-e', SESSION_EXTENSION, '--session-id', sessionId]
      : [...this.#programArgs]
    const proc = fork(this.#cliPath, [
      '--internal-socket', socketPath, '--internal-cwd', cwd,
      '--theme', this.#theme, '--', program, ...runtimeArgs,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, MTTY_IDENTITY: identityPath, MTTY_PROCESS_ID: processId } })
    const child = { processId, sessionId, proc, socketPath, identityPath, cwd, joinedAt: Date.now(), sockets: [] }
    this.#children.set(processId, child)
    let settled = false
    let resolveGone
    child.gone = new Promise(resolve => { resolveGone = resolve })
    // 'error' and 'exit' can both arrive for one child, and the rest of the
    // supervisor reads this map as "which PTYs exist": settling twice would
    // drop an entry (and its identity file) out from under a live child.
    const settle = () => {
      if (settled) return
      settled = true
      if (this.child(processId) === child) this.#children.delete(processId)
      for (const fn of child.sockets.splice(0)) fn(child.endReason ?? 'pi exited')
      // The files go before `gone` resolves: a stale identity file still in
      // the directory is one the next /resume would read as a live owner.
      Promise.all([rm(socketPath, { force: true }), rm(identityPath, { force: true }), rm(`${identityPath}.tmp`, { force: true })])
        .catch(err => console.error(`server: could not clean up terminal ${processId}`, err))
        .finally(resolveGone)
    }
    proc.on('exit', settle)
    // The child says when its PTY last moved. At zero viewers it is the only
    // sign that somebody is still working through this session.
    proc.on('message', msg => { if (msg?.mtty === 'activity') child.lastOutputAt = msg.at })
    proc.on('error', err => {
      // No pid means the fork itself failed and there is no exit to come.
      // Anything else is a live child reporting a signal or IPC problem, which
      // is not a reason to forget that it exists.
      if (proc.pid) return void console.error(`server: terminal ${processId} reported an error`, err)
      console.error(`server: terminal ${processId} could not start`, err)
      settle()
    })
    return child
  }

  async end(processId, reason = 'ended by a terminal') {
    const child = this.child(processId)
    if (!child) return
    child.endReason = reason
    child.proc.kill('SIGTERM')
    const escalate = setTimeout(() => child.proc.kill('SIGKILL'), KILL_GRACE_MS)
    escalate.unref()
    await child.gone
    clearTimeout(escalate)
  }

  async endAll() {
    await Promise.all(this.running().map(child => this.end(child.processId, 'server stopped')))
  }

  /**
   * Free a slot for one more, or report that nothing may be ended. A session
   * is only a victim when nobody is watching it and nothing has touched it for
   * `idleMs` -- pi's own writes count, so a session that handed work to a
   * subagent stays busy even while it sits at its prompt. Of those, the one
   * written longest ago goes: what is in a session beats when it was opened.
   */
  async #makeRoom() {
    if (this.#children.size - this.#evicting.size < this.#cap) return true
    const since = Date.now() - this.#idleMs
    const victims = []
    for (const child of this.running()) {
      if (this.#evicting.has(child.processId)) continue
      if (child.sockets.length > 0) continue
      if (touchedAt(child) > since) continue
      const { file } = this.current(child)
      // Writes to the transcript and to any fork of it, and the PTY where
      // nothing is written down, as for a program that keeps no store.
      const written = Math.max(child.lastOutputAt ?? 0, file ? await lastWrite(file) : 0)
      if (written > since) continue
      victims.push({ child, written })
    }
    const victim = victims.sort((a, b) => a.written - b.written)[0]?.child
    if (!victim) return false
    this.#evicting.add(victim.processId)
    this.end(victim.processId, 'evicted to make room')
      .catch(err => console.error(`server: could not end terminal ${victim.processId}`, err))
      .finally(() => this.#evicting.delete(victim.processId))
    return true
  }
}
