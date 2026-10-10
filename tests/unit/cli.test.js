// server/cli.js's own option parsing: flags after `--` belong to the program,
// and a value that would refuse every start is a typo rather than a setting.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const cli = fileURLToPath(new URL('../../server/cli.js', import.meta.url))

const run = (args, { wantListening = false } = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', d => { output += d; if (wantListening && output.includes('listening')) child.kill() })
  child.stderr.on('data', d => { output += d })
  child.on('close', code => resolve({ code, output }))
})

test('the program\'s own flags after -- are not the server\'s', async () => {
  const { code, output } = await run(['--port', '0', '--', 'sleep', '30', '--cap', '0'], { wantListening: true })
  assert.match(output, /listening/)
  assert.equal(code, 0)
})

test('a cap given no value is refused', async () => {
  const { code, output } = await run(['--cap', '--', 'true'])
  assert.equal(code, 2)
  assert.match(output, /--cap/)
})
