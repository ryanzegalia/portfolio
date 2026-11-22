// Called by Scene.onBeforeRender, after Three has updated world matrices and before its shadow pass.
// Camera movement alone does not change a world-space shadow. Caster movement/visibility does.
export function createShadowTracker() {
  const previous = new WeakMap()
  let revision = 0, count = 0, previousCount = 0, dirty = false
  const sample = (object) => {
    if (!object.castShadow || !object.isMesh) return
    count++
    const matrix = object.matrixWorld.elements
    let saved = previous.get(object)
    let moved = !saved || saved.revision !== revision - 1
    // Compare with the last significant pose: slow changes still accumulate.
    if (!moved) for (let i = 0; i < 16; i++) {
      if (Math.abs(matrix[i] - saved.matrix[i]) > 0.00001) { moved = true; break }
    }
    if (moved) {
      dirty = true
      if (!saved) { saved = { matrix: new Float64Array(16), revision: 0 }; previous.set(object, saved) }
      saved.matrix.set(matrix)
    }
    saved.revision = revision
  }
  return (scene) => {
    revision++; count = 0; dirty = false
    scene.traverseVisible(sample)
    if (count !== previousCount) dirty = true
    previousCount = count
    return dirty
  }
}
