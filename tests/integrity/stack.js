// Everything the integrity tests know about how a session is served. They talk
// to it over the same WebSocket the phone uses, so this is the only file that
// cares what is on the other end.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'

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
  const server = spawn('node', ['server/cli.js', '--port', String(port), '--', command],
    { stdio: 'ignore' })
  await waitForPort(port)
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    stop() { server.kill('SIGKILL') },
  }
}
