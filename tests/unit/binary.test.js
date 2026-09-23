// The real bin script: option parsing, the cwd it captures before cd'ing into
// the checkout, and the verb dispatch it execs. Bounded runs — these fail or
// refuse before anything attaches, so they need no pty.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const bin = fileURLToPath(new URL('../../mobile-tty', import.meta.url))

const run = (args, cwd) => new Promise(resolve => {
  const child = spawn('bash', [bin, ...args], {
    cwd,
    // Port 1 on loopback refuses fast: nothing listens there, which is the
    // no-server case `new` is meant to answer plainly.
    env: { ...process.env, MTTY_PORT: '1', MTTY_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  child.on('close', code => resolve({ code, output }))
})

test('new refuses with how to start the server when none answers', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mtty-bin-'))
  try {
    const { code, output } = await run(['new'], scratch)
    assert.equal(code, 0)
    assert.match(output, /server not started; run mobile-tty serve/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('new takes no arguments', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mtty-bin-'))
  try {
    const { code, output } = await run(['new', 'extra'], scratch)
    assert.equal(code, 2)
    assert.match(output, /new takes no arguments/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
