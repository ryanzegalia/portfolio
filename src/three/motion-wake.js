// Imperative changes (decoded print textures, ref-only input) need a frame even
// when React has nothing to commit. No timer or RAF runs while the shelf sleeps.
const listeners = new Set()
export const wakeShelf = () => { for (const wake of listeners) wake() }
export const onShelfWake = (wake) => { listeners.add(wake); return () => listeners.delete(wake) }
let pending = false
export const continueShelfMotion = () => { pending = true }
export const takeShelfMotion = () => { const value = pending; pending = false; return value }

// Sample the actual pose, not guessed animation durations. Compare against the
// last significant pose, so slow movement accumulates instead of disappearing.
// Reuse the sample buffer and weak records: static cases allocate nothing per
// frame, and removed objects are not retained by the tracker.
export function createPoseTracker(epsilon = 0.000001) {
  const previous = new WeakMap(), values = []
  let revision = 0, previousCount = 0, count = 0, length = 0, changed = false
  // Do not truncate this scratch array: V8 may discard its backing storage.
  const value = (v) => { values[length++] = v }
  const material = (mat) => {
    if (mat) {
      value(mat.opacity); value(Number(mat.visible))
      value(mat.color?.r ?? 0); value(mat.color?.g ?? 0); value(mat.color?.b ?? 0)
    }
  }
  const sample = (object) => {
    count++
    const p = object.position, q = object.quaternion, s = object.scale
    length = 0
    value(p.x); value(p.y); value(p.z)
    value(q.x); value(q.y); value(q.z); value(q.w)
    value(s.x); value(s.y); value(s.z); value(Number(object.visible))
    if (object.isLight) {
      value(object.intensity); value(object.color.r); value(object.color.g); value(object.color.b)
    }
    if (Array.isArray(object.material)) for (const mat of object.material) material(mat)
    else material(object.material)
    let old = previous.get(object)
    let moved = !old || old.revision !== revision - 1 || old.values.length !== length
    if (!moved) for (let i = 0; i < length; i++) {
      if (Math.abs(values[i] - old.values[i]) > epsilon) { moved = true; break }
    }
    if (moved) {
      changed = true
      if (!old) { old = { values: [], revision: 0 }; previous.set(object, old) }
      old.values.length = length
      for (let i = 0; i < length; i++) old.values[i] = values[i]
    }
    old.revision = revision
  }
  return (scene, camera) => {
    revision++; count = 0; changed = false
    scene.traverse(sample)
    if (previous.get(camera)?.revision !== revision) sample(camera)
    if (count !== previousCount) changed = true
    previousCount = count
    return changed
  }
}
