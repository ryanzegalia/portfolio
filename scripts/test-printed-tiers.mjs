import assert from 'node:assert/strict'
import { CASE_SURFACES, fullCaseSurface, wallDimensions, wallSurfaceLimit, WALL_LIMIT, PHONE_WALL_LIMIT } from '../src/three/printed-tiers.js'
const view = { slug: 'held', slugs: new Set(['held', 'previous', 'next']), back: false }
for (const slug of view.slugs) assert.equal(fullCaseSurface('cartFront', slug, view), true)
assert.equal(fullCaseSurface('cartFront', 'far-away', view), false)
assert.equal(fullCaseSurface('cartBack', 'held', view), false)
view.back = true
assert.equal(fullCaseSurface('cartBack', 'held', view), true)
assert.equal(fullCaseSurface('cartBack', 'next', view), false)
assert.equal(fullCaseSurface('bookletTextures', 'held', view), false)
assert.equal(fullCaseSurface('woodTexture', 'held', view), false)
view.slugs.clear()
assert.equal(fullCaseSurface('cartFront', 'held', view), false)
for (const limit of [WALL_LIMIT, PHONE_WALL_LIMIT]) {
  const [w, h] = wallDimensions(1024, 1824, limit)
  assert.equal(h, limit)
  assert.ok(Math.abs(w / h - 1024 / 1824) < 0.002)
  assert.ok(w * h < 1024 * 1824 / 4)
}
assert.deepEqual(wallDimensions(100, 100, WALL_LIMIT), [100, 100])
assert.equal(CASE_SURFACES.has('tapeShell'), true)
assert.equal(wallSurfaceLimit('pcFront'), 896)
assert.equal(wallSurfaceLimit('cartFront'), 640)
assert.equal(wallSurfaceLimit('cartBack'), 320)
assert.equal(wallSurfaceLimit('tapeShell'), 256)
assert.equal(wallSurfaceLimit('pcFront', true), 384)
assert.equal(wallSurfaceLimit('cartBack', true), 192)
console.log('printed-tiers: held/neighbour/back/put-away residency and both wall size budgets pass')
