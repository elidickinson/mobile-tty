import { test } from 'node:test'
import assert from 'node:assert/strict'
import { velocity, DEAD_ZONE, MAX_V } from '../src/nub.js'

test('inside the dead zone the nub does nothing', () => {
  assert.equal(velocity(0), 0)
  assert.equal(velocity(DEAD_ZONE), 0)
  assert.equal(velocity(-DEAD_ZONE), 0)
})

test('past the dead zone speed rises with displacement and keeps its sign', () => {
  const a = velocity(DEAD_ZONE + 5)
  const b = velocity(DEAD_ZONE + 25)
  assert.ok(a > 0 && b > a, 'further pull is faster')
  assert.equal(velocity(-(DEAD_ZONE + 25)), -b, 'symmetric about zero')
})

test('speed is capped so a full-thumb pull cannot fly off the buffer', () => {
  assert.equal(velocity(10_000), MAX_V)
  assert.equal(velocity(-10_000), -MAX_V)
})

test('gain scales speed without moving the dead zone', () => {
  assert.equal(velocity(DEAD_ZONE + 2, 3), velocity(DEAD_ZONE + 2, 1) * 3)
  assert.equal(velocity(DEAD_ZONE, 10), 0)
})

test('the curve starts gently — a small pull creeps rather than jumps', () => {
  assert.ok(velocity(DEAD_ZONE + 3) < 1, 'sub-pixel-per-frame at the low end')
})
