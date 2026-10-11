// The registry's own bookkeeping. A child that never came up is the case that
// matters: `/places` and `DELETE /terminal` both read this map, so a lingering
// entry is a session that looks alive and cannot be ended.
//
// The `!proc.pid` branch of `proc.on('error')` — a fork that never produced a
// process — is deliberately uncovered: it needs an execPath that cannot spawn,
// and it settles through the same idempotent path exercised below anyway.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry } from '../../server/registry.js'

const cliPath = fileURLToPath(new URL('../../server/cli.js', import.meta.url))

test('a spawn that fails outright keeps nothing behind', async () => {
  // Not every spawn failure is a program that dies: the fork itself can be
  // refused -- out of file descriptors is the one that happens for real --
  // and then nothing will ever clean up after it. The failure goes to the
  // caller, and the identity file is gone with it.
  const socketDir = await mkdtemp(join(tmpdir(), 'mtty-registry-'))
  try {
    // A command line longer than the OS will exec is refused by spawn()
    // itself, with no process and no exit to come.
    const registry = new Registry({ cliPath: join(socketDir, 'x'.repeat(2 * 1024 * 1024)), program: 'nothing', socketDir })
    await assert.rejects(registry.start('some-conversation', socketDir), { syscall: 'spawn' })
    assert.deepEqual(registry.running(), [])
    assert.deepEqual(await readdir(socketDir), [], 'no identity file left to claim an owner')
  } finally {
    await rm(socketDir, { recursive: true, force: true })
  }
})

test('an idle unwatched session still fills the cap', async () => {
  const socketDir = await mkdtemp(join(tmpdir(), 'mtty-registry-'))
  const registry = new Registry({ cliPath, program: 'sleep', programArgs: ['30'], socketDir, cap: 1 })
  try {
    const child = await registry.start('first', socketDir)
    assert.equal(child.sockets.length, 0)
    assert.equal(await registry.start('second', socketDir), null)
  } finally {
    await registry.endAll()
    await rm(socketDir, { recursive: true, force: true })
  }
})

test('a terminal that dies before it can listen is dropped, identity file and all', async () => {
  const socketDir = await mkdtemp(join(tmpdir(), 'mtty-registry-'))
  try {
    // A cli that cannot be loaded: node starts and dies before listening, so
    // there is no session socket to talk to and no process left in the map.
    const registry = new Registry({ cliPath: join(socketDir, 'missing-cli.js'), program: 'nothing', socketDir })
    const child = await registry.start('some-conversation', socketDir)
    await child.gone
    assert.equal(registry.child(child.processId), undefined)
    assert.deepEqual(registry.running(), [])
    // The next /resume reads these files; one left behind claims an owner.
    await assert.rejects(readFile(child.identityPath, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(socketDir, { recursive: true, force: true })
  }
})
