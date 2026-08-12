// One fresh server and one fresh pi per test — the session is the server, so a
// shared one would carry typing and history from every earlier test into the
// next, and this suite's whole job is history integrity. Port 0 lets the OS
// pick, so tests never collide on a port still in TIME_WAIT.
import { test as base, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { expect }

export const test = base.extend({
  baseURL: async ({}, use) => {
    // A scratch pi config dir, mirroring the unit real-pi test: without it pi
    // reads ~/.pi, prints "No models match pattern" warnings from the host's
    // model aliases, and swallows the first keystroke while doing so. The test
    // machine's aliases must never leak into a fixture run.
    const agentDir = mkdtempSync(join(tmpdir(), 'mobile-tty-smoke-'))
    const server = spawn('node', [
      'server/cli.js', '--port', '0', '--index', 'dist/client.html',
      '--', 'pi',
      '-ne', '--offline', '--no-session', '--no-builtin-tools', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
      '--tui-mode', 'regular', '-e', 'tests/real-pi/fixture-extension.ts',
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
    })
    try {
      const port = await new Promise((resolve, reject) => {
        server.stdout.on('data', d => {
          const found = String(d).match(/:(\d+)/)
          if (found) resolve(Number(found[1]))
        })
        server.on('exit', code => reject(new Error(`server exited (${code}) before listening`)))
      })
      await use(`http://127.0.0.1:${port}`)
    } finally {
      server.kill('SIGKILL')
    }
  },
})
