// The registry's own bookkeeping. A child that never came up is the case that
// matters: `/places` and `DELETE /terminal` both read this map, so a lingering
// entry is a session that looks alive and cannot be ended.
//
// The `!proc.pid` branch of `proc.on('error')` — a fork that never produced a
// process — is deliberately uncovered: it needs an execPath that cannot spawn,
// and it settles through the same idempotent path exercised below anyway.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../../server/registry.js'

test('a terminal that dies before it can listen is dropped, identity file and all', async () => {
  const socketDir = await mkdtemp(join(tmpdir(), 'mtty-registry-'))
  try {
    // A cli that cannot be loaded: node starts and dies before listening, so
    // there is no session socket to talk to and no process left in the map.
    const registry = new Registry({ cliPath: join(socketDir, 'missing-cli.js'), program: 'nothing', socketDir })
    const child = registry.start('some-conversation', socketDir)
    await child.gone
    assert.equal(registry.child(child.processId), undefined)
    assert.deepEqual(registry.running(), [])
    // The next /resume reads these files; one left behind claims an owner.
    await assert.rejects(readFile(child.identityPath, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(socketDir, { recursive: true, force: true })
  }
})
