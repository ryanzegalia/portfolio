// What the visitor's graphics chip did with the store: which GPU and browser drew it, how big the
// drawing buffer came out, whether the GPU context was lost, and any shader that failed to build.
// A friend's Pixel Fold showed a black store while the page around it worked (2026-10-30), and
// nothing here could see why. Open the site with ?gfx to see this report on screen.
const report = { gpu: '', webgl: '', maxTexture: 0, extensions: {}, lost: 0, restored: 0, shaderErrors: [], errors: [], frames: 0, calls: 0, triangles: 0, canvas: '', buffer: '', dpr: 0 }
let renderer = null
let state
const listeners = new Set()
export function graphicsState() {
  if (state) return state
  // Probe once, before the store allocates its renderer. Release this tiny context immediately.
  let gpu = ''
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (ctx) {
      const debug = ctx.getExtension('WEBGL_debug_renderer_info')
      gpu = debug ? ctx.getParameter(debug.UNMASKED_RENDERER_WEBGL) : ''
      ctx.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch { /* Context creation is handled by the Canvas boundary, not a UA guess. */ }
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('gfx-gpu')) gpu = new URLSearchParams(location.search).get('gfx-gpu')
  const forced = import.meta.env.DEV && new URLSearchParams(location.search).get('gfx-mode') === 'safe'
  const risky = /Mali|PowerVR/i.test(gpu) || (/Android/i.test(navigator.userAgent) && !gpu)
  // PowerVR (Pixel 10 Pro Fold, Firefox, 2026-10-30): safe mode with shadows lost the context twice and
  // failed a shader link inside 3 s; the same store without shadows drew 400+ clean frames. Start there.
  const shadows = !/PowerVR/i.test(gpu)
  state = { mode: forced || risky ? 'safe' : 'normal', reason: forced ? 'forced-safe' : risky ? 'gpu-compatibility' : '', generation: 0, retried: false, shadows }
  report.probeGpu = gpu
  report.startShadows = shadows
  report.mode = state.mode
  report.reason = state.reason
  report.attempts = []
  return state
}
function transition(next) {
  state = { ...graphicsState(), ...next }
  report.mode = state.mode
  report.reason = state.reason
  queueMicrotask(() => { for (const notify of listeners) notify(state) })
}
export function graphicsFailure(reason, detail, generation = graphicsState().generation) {
  const current = graphicsState()
  if (current.mode === 'list' || generation !== current.generation) return
  if (detail) keep(report.errors, detail)
  report.attempts.push({ mode: current.mode, reason, pixels: report.pixels || [] })
  transition(current.retried
    ? { mode: 'list', reason }
    : { mode: 'safe-retry', reason, retried: true, generation: current.generation + 1 })
}
export function chooseList() { transition({ mode: 'list', reason: 'chosen' }) }
export function onGraphicsFailure(notify) {
  listeners.add(notify)
  notify(graphicsState())
  return () => listeners.delete(notify)
}

// Two small grids, synchronously AFTER rendering to the screen, before the browser clears it.
// Never judge loading time, frame rate, or an offscreen/environment render as a broken store.
function watchFirstFrames(gl, invalidate) {
  const original = gl.render
  const ctx = gl.getContext()
  const pixel = new Uint8Array(4)
  let samples = 0, lastSample = -Infinity, empty = 0
  report.pixels = []
  const forced = import.meta.env.DEV && new URLSearchParams(location.search).get('gfx-fail')
  const { mode, generation } = graphicsState()
  let sampleTimer
  let shadowSized = false
  gl.render = function (...args) {
    if (!shadowSized && mode !== 'normal' && !gl.getRenderTarget()) {
      args[0].traverse(object => { if (object.isLight && object.shadow) object.shadow.mapSize.set(1024, 1024) })
      shadowSized = true
    }
    const result = original.apply(this, args)
    const now = performance.now()
    if (samples >= 2 || document.hidden || ctx.isContextLost() || gl.getRenderTarget() || gl.info.render.triangles < 100 || now - lastSample < 750 || ctx.drawingBufferWidth < 32 || ctx.drawingBufferHeight < 32) return result
    let min = 255, max = 0, sum = 0, sum2 = 0
    // 7 x 5 points spanning the middle 80% of the visible store, 140 bytes per sample.
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
      ctx.readPixels(Math.floor(ctx.drawingBufferWidth * (0.1 + x * 0.8 / 6)), Math.floor(ctx.drawingBufferHeight * (0.1 + y * 0.8 / 4)), 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel)
      const v = (forced === 'black' || (forced === 'black-once' && mode !== 'safe-retry')) ? 0 : Math.max(pixel[0], pixel[1], pixel[2])
      min = Math.min(min, v); max = Math.max(max, v); sum += v; sum2 += v * v
    }
    const mean = sum / 35, variance = sum2 / 35 - mean * mean
    const blank = max <= 32 && max - min <= 3
    const measurement = { min, max, mean: +mean.toFixed(2), variance: +variance.toFixed(2), blank }
    report.pixels.push(measurement)
    console.info('[shelf:gfx] first-frame pixels', JSON.stringify(measurement))
    samples++; lastSample = now
    if (samples === 1) sampleTimer = setTimeout(() => invalidate?.(), 800)
    empty = blank ? empty + 1 : 0
    if (empty === 2) graphicsFailure('black', undefined, generation)
    if (samples === 2) gl.render = original
    return result
  }
  return () => { clearTimeout(sampleTimer); gl.render = original }
}

const keep = (list, text) => {
  if (list.length < 6) list.push(String(text).slice(0, 300))
}

window.addEventListener('error', (e) => keep(report.errors, e.message || e.error))
window.addEventListener('unhandledrejection', (e) => keep(report.errors, e.reason?.message || e.reason))

// Called once from the Canvas's onCreated with three's renderer.
export function watchRenderer(gl, invalidate) {
  const generation = graphicsState().generation
  let disposed = false
  renderer = gl
  const ctx = gl.getContext()
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
  report.gpu = dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)
  report.webgl = ctx.getParameter(ctx.VERSION)
  report.maxTexture = ctx.getParameter(ctx.MAX_TEXTURE_SIZE)
  const names = ctx.getSupportedExtensions() || []
  for (const x of ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'EXT_texture_filter_anisotropic']) report.extensions[x] = names.includes(x)
  const canvas = gl.domElement
  let lostTimer
  const onLost = (event) => {
    event.preventDefault()
    // R3F deliberately loses its old context on unmount; that is not a device failure.
    if (disposed || graphicsState().generation !== generation || graphicsState().mode === 'list') return
    report.lost++
    clearTimeout(lostTimer)
    lostTimer = setTimeout(() => {
      if (ctx.isContextLost()) graphicsFailure('lost', undefined, generation)
    }, 5000)
  }
  const onRestored = () => {
    if (disposed || graphicsState().generation !== generation || graphicsState().mode === 'list') return
    report.restored++
    clearTimeout(lostTimer)
    transition({ generation: graphicsState().generation + 1, reason: 'context-restored' })
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  const stopFrames = watchFirstFrames(gl, invalidate)
  // three logs a failed shader and draws nothing with it; keep the reason as well
  gl.debug.onShaderError = (c, program, vs, fs) => {
    const log = [c.getProgramInfoLog(program), c.getShaderInfoLog(vs), c.getShaderInfoLog(fs)].filter(Boolean).join(' | ')
    keep(report.shaderErrors, log || 'link failed without a log')
    console.error('THREE.WebGLProgram: shader error', log)
    // Notify outside three's render call, not during React's scene commit.
    queueMicrotask(() => { if (!disposed) graphicsFailure('shader', undefined, generation) })
  }
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('gfx-fail') === 'shader') {
    queueMicrotask(() => gl.debug.onShaderError({ getProgramInfoLog: () => 'Forced shader failure', getShaderInfoLog: () => '' }, null, null, null))
  }
  if (new URLSearchParams(location.search).has('gfx')) showPanel()
  return () => {
    disposed = true
    stopFrames()
    clearTimeout(lostTimer)
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    if (renderer === gl) { gfxReport(); renderer = null }
  }
}

export function gfxReport() {
  if (renderer) {
    const ctx = renderer.getContext()
    report.frames = renderer.info.render.frame
    report.calls = renderer.info.render.calls
    report.triangles = renderer.info.render.triangles
    report.canvas = `${renderer.domElement.width}x${renderer.domElement.height}`
    report.buffer = `${ctx.drawingBufferWidth}x${ctx.drawingBufferHeight}`
    report.dpr = renderer.getPixelRatio()
    report.antialias = ctx.getContextAttributes()?.antialias
    report.shadows = renderer.shadowMap.enabled
    report.contextLostNow = ctx.isContextLost()
  }
  return { ...report, extensions: { ...report.extensions }, ua: navigator.userAgent, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, viewport: `${innerWidth}x${innerHeight}` }
}

function showPanel() {
  if (document.getElementById('gfx-report')) return
  const el = document.createElement('pre')
  el.id = 'gfx-report'
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:9999;margin:0;padding:10px;max-height:55vh;overflow:auto;background:rgba(0,0,0,.88);color:#f5e6c8;font:11px/1.35 monospace;white-space:pre-wrap;border:1px solid #c41e1e;border-radius:6px;pointer-events:none'
  document.body.appendChild(el)
  const draw = () => {
    const r = gfxReport()
    el.textContent = [
      `GPU      ${r.gpu}`,
      `WebGL    ${r.webgl}   max texture ${r.maxTexture}`,
      `ext      ${Object.entries(r.extensions).map(([k, v]) => `${k.replace(/^(EXT|OES)_/, '')}:${v ? 'yes' : 'NO'}`).join('  ')}`,
      `canvas   ${r.canvas}   buffer ${r.buffer}   dpr ${r.dpr}   screen ${r.screen}   view ${r.viewport}`,
      `frames   ${r.frames}   last frame: ${r.calls} draws, ${r.triangles} triangles`,
      `context  lost ${r.lost}x, restored ${r.restored}x${r.contextLostNow ? '   LOST NOW' : ''}`,
      `shaders  ${r.shaderErrors.length ? r.shaderErrors.join('\n         ') : 'all built'}`,
      `pixels   ${JSON.stringify(r.pixels || [])}`,
      `view     ${r.mode || 'normal'} ${r.reason || ''}${r.startShadows === false ? '   (no shadows: PowerVR)' : ''}`,
      `errors   ${r.errors.length ? r.errors.join('\n         ') : 'none'}`,
      `browser  ${r.ua}`,
    ].join('\n')
  }
  draw()
  setInterval(draw, 1000)
}

if (import.meta.env.DEV) window.__shelfGraphicsReport = gfxReport
