// A WebGL implementation may allocate a smaller drawing buffer than the canvas requests
// (ANGLE OpenGL does this under allocation pressure). Three's getDrawingBufferSize reports
// the requested size, not that allocation. A full-size viewport in a half-size buffer crops
// the scene to its bottom-left quarter, then the browser stretches that quarter to the canvas.
// Update Three's own viewport, so shadow passes restore the same authoritative dimensions.
export function syncDrawingBuffer(renderer, camera, viewport) {
  const context = renderer.getContext()
  const width = context.drawingBufferWidth
  const height = context.drawingBufferHeight
  if (!width || !height || context.isContextLost() || renderer.getRenderTarget() !== null) return
  const ratio = renderer.getPixelRatio()
  renderer.getViewport(viewport)
  if (viewport.x !== 0 || viewport.y !== 0 || viewport.z !== width / ratio || viewport.w !== height / ratio) {
    renderer.setViewport(0, 0, width / ratio, height / ratio)
  }
  const aspect = width / height
  if (camera.isPerspectiveCamera && camera.aspect !== aspect) {
    camera.aspect = aspect
    camera.updateProjectionMatrix()
  }
}
