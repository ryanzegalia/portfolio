import assert from 'node:assert/strict'
import { syncDrawingBuffer } from '../src/three/drawing-buffer.js'
const context = { drawingBufferWidth: 2145, drawingBufferHeight: 1137, isContextLost: () => false }
let view = [0, 0, 2145, 1137], writes = 0, projections = 0, ratio = 1
const renderer = {
  getContext: () => context, getRenderTarget: () => null, getPixelRatio: () => ratio,
  getViewport: (v) => Object.assign(v, { x: view[0], y: view[1], z: view[2], w: view[3] }),
  setViewport: (...v) => { view = v; writes++ },
}
const camera = { isPerspectiveCamera: true, aspect: 2145 / 1137, updateProjectionMatrix: () => projections++ }
const viewport = {}
syncDrawingBuffer(renderer, camera, viewport)
assert.equal(writes, 0)
context.drawingBufferWidth = 1072; context.drawingBufferHeight = 568
syncDrawingBuffer(renderer, camera, viewport)
assert.deepEqual(view, [0, 0, 1072, 568]); assert.equal(camera.aspect, 1072 / 568)
syncDrawingBuffer(renderer, camera, viewport)
assert.equal(writes, 1); assert.equal(projections, 1)
// A CSS resize can overwrite the renderer viewport without changing its constrained allocation.
view = [0, 0, 1901, 1137]
syncDrawingBuffer(renderer, camera, viewport)
assert.deepEqual(view, [0, 0, 1072, 568])
// Device-pixel ratio is applied by Three, so its public viewport stays in logical pixels.
ratio = 1.5
syncDrawingBuffer(renderer, camera, viewport)
assert.deepEqual(view, [0, 0, 1072 / 1.5, 568 / 1.5])
context.drawingBufferWidth = 2145; context.drawingBufferHeight = 1137
syncDrawingBuffer(renderer, camera, viewport)
assert.equal(camera.aspect, 2145 / 1137)
context.drawingBufferWidth = 0
const before = writes
syncDrawingBuffer(renderer, camera, viewport)
assert.equal(writes, before)
console.log('drawing-buffer: full, constrained, resize, DPR, recovery and zero-size checks pass')
