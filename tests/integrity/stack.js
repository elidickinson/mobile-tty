// Everything the integrity tests know about how a session is served. They talk
// to it over the same WebSocket the phone uses, so this is the only file that
// cares what is on the other end.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function startStack({ command }) {
  // The server no longer starts a program on its own — a viewer joins a
  // session /places already knows about — so this seeds a private store with
  // exactly one, rather than reaching into whatever the real ~/.pi store on
  // this machine happens to hold.
  const root = await mkdtemp(join(tmpdir(), 'mtty-integrity-store-'))
  const sessionDir = join(root, 'sessions')
  const cwd = process.cwd()
  const id = randomUUID()
  const slug = join(sessionDir, `-${cwd.replaceAll('/', '-')}-`)
  await mkdir(slug, { recursive: true })
  await writeFile(join(slug, 'a.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)

  const server = spawn('node', ['server/cli.js', '--port', '0', '--', command], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
  })
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
    url: `ws://127.0.0.1:${port}/ws?session=${id}`,
    stop() { server.kill('SIGKILL'); rm(root, { recursive: true, force: true }).catch(() => {}) },
  }
}
