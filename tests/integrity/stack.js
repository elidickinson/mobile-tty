// Everything the integrity tests know about how a session is served. They talk
// to it over the same WebSocket the phone uses, so this is the only file that
// cares what is on the other end.
import { spawn } from 'node:child_process'

export async function startStack({ command }) {
  const server = spawn('node', ['server/cli.js', '--port', '0', '--', command],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  // Port 0 and read back what it bound: a fixed one collides with itself across
  // runs while the last socket is still in TIME_WAIT.
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', d => {
      const found = String(d).match(/:(\d+)/)
      if (found) resolve(Number(found[1]))
    })
    server.on('exit', code => reject(new Error(`server exited (${code}) before listening`)))
  })
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    stop() { server.kill('SIGKILL') },
  }
}
