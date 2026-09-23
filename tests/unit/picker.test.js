import test from 'node:test'
import assert from 'node:assert/strict'
import { matching, pickFrom, placeRow } from '../../server/picker.js'

const places = [
  { id: 'alpha-id', name: 'alpha', label: 'Alpha conversation', path: '/work/alpha' },
  { id: 'beta-id', name: 'beta', label: 'Beta conversation', path: '/work/beta' },
]

test('placeRow numbers and marks a session, pads its label, and shows viewers and age', () => {
  const at = Date.now() - 2 * 60_000
  const row = placeRow({ ...places[0], running: true, viewers: 2, at }, 4)
  const title = row.indexOf('Alpha conversation')
  const path = row.indexOf('/work/alpha')

  assert.ok(row.startsWith('  4) ● '))
  assert.equal(path - title, 62, 'the label is padded to 60 columns plus two spaces')
  assert.ok(row.endsWith('/work/alpha  2 watching  2m'))
})

test('matching is case-insensitive across labels, names, paths and ids; empty matches nothing', () => {
  assert.deepEqual(matching(places, 'BETA'), [places[1]])
  assert.deepEqual(matching(places, 'WORK/'), places)
  assert.deepEqual(matching(places, 'BETA-ID'), [places[1]])
  assert.deepEqual(matching(places, ''), [])
})

test('pickFrom pages ten rows, keeps global numbering, and accepts more', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({
    id: String(i + 1), name: `session-${i + 1}`, path: `/work/${i + 1}`, viewers: 0,
  }))
  const answers = ['more', '7']
  const output = []
  const prompts = []
  const choice = await pickFrom(candidates, {
    ask: async prompt => { prompts.push(prompt); return answers.shift() },
    out: line => output.push(line),
  })
  const rows = output.filter(line => /^  \d+\)/.test(line))

  assert.equal(choice.id, '7')
  assert.deepEqual(prompts, ['> ', '> '])
  assert.equal(rows.length, 20, 'the first and second pages show ten rows each')
  assert.match(output[10], /\.\.\. 15 more/)
  assert.match(rows[10], /^  11\)/, 'page two continues global numbering')
})

test('pickFrom returns null for end and EOF answers', async () => {
  const candidate = [places[0]]
  for (const answer of ['end', '99', '']) {
    const choice = await pickFrom(candidate, { ask: async () => answer, out: () => {} })
    assert.equal(choice, null)
  }
})
