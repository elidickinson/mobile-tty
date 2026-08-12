// Everything the integrity tests know about how a session is served. They talk
// to it over the same WebSocket the phone uses, so replacing what runs here is
// the only change they need when the server takes over from ttyd and dtach.
import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { rmSync } from 'node:fs'

const reachable = port => new Promise(resolve => {
  const sock = connect(port, '127.0.0.1')
  sock.on('connect', () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
})

const waitForPort = async (port, deadline = Date.now() + 10_000) => {
  while (Date.now() < deadline) {
    if (await reachable(port)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`nothing listening on ${port}`)
}

export async function startStack({ port, command }) {
  const socket = `/tmp/mtty-integrity-${port}.sock`
  rmSync(socket, { force: true })
  const ttyd = spawn('ttyd', ['-W', '-p', String(port), '-i', '127.0.0.1',
    'dtach', '-A', socket, '-r', 'winch', '-z', command], { stdio: 'ignore' })
  await waitForPort(port)

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    stop() {
      ttyd.kill('SIGKILL')
      // `dtach -A` leaves a master that outlives whatever started it. The socket
      // path is unique to this run, so matching on it cannot reach anything else.
      try { execFileSync('pkill', ['-f', socket]) } catch {}
      rmSync(socket, { force: true })
    },
  }
}
