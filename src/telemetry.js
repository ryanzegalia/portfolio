// First-party, per-tab telemetry. No cookies, frame callbacks, fingerprint or replay.
import { useEffect } from 'react'
import { gfxReport } from './gfx-report.js'
let active = false, id, queue = [], timer, tick, visibleAt = null, visibleMs = 0, seq = 0
let source = '', referrer = '', context = {}, utm = {}, gfxSent = {}
let gfxTimer
const VISIT_STORAGE_ID = 'shelf:visit'
const safe = (fn) => { try { return fn() } catch { return undefined } }
const stop = () => { active = false; queue = []; clearTimeout(timer); clearInterval(tick); clearTimeout(gfxTimer) }
const elapsed = () => Math.round(visibleMs + (visibleAt === null ? 0 : performance.now() - visibleAt))
function flush(final = false) {
  if (!active) return
  safe(() => {
    clearTimeout(timer); timer = null
    const body = JSON.stringify({ id, seq: ++seq, visible_ms: elapsed(), src: source, referrer, ...utm, screen: `${screen.width}x${screen.height}`, events: queue.splice(0, 40) })
    safe(() => sessionStorage.setItem(VISIT_STORAGE_ID, JSON.stringify({ id, seq, visibleMs: elapsed(), src: source, referrer, utm, gfxSent })))
    if (final) {
      if (!navigator.sendBeacon('/api/t', new Blob([body], { type: 'application/json' }))) stop()
    } else {
      fetch('/api/t', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'omit', keepalive: true, signal: AbortSignal.timeout(5000) }).then((r) => { if (!r.ok) stop() }).catch(stop)
    }
  })
}
export function track(event, data = {}) {
  if (!active) return
  safe(() => {
    if (queue.length < 40) queue.push({ event, ...data, at: elapsed() })
    if (!timer) timer = setTimeout(() => { timer = null; flush() }, 1000)
  })
}
safe(() => {
  if (import.meta.env.DEV || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || navigator.globalPrivacyControl || navigator.doNotTrack === '1') return
  const saved = safe(() => JSON.parse(sessionStorage.getItem(VISIT_STORAGE_ID)))
  id = saved?.id || crypto.randomUUID()
  gfxSent = saved?.gfxSent || {}
  seq = saved?.seq || 0; visibleMs = saved?.visibleMs || 0
  utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign'].map((key) => [key, (new URLSearchParams(location.search).get(key) || saved?.utm?.[key] || '').slice(0, 120)]))
  source = (new URLSearchParams(location.search).get('src') || saved?.src || '').slice(0, 120)
  // Only an origin, never search parameters or private paths from the referring page.
  referrer = saved?.referrer || safe(() => new URL(document.referrer).origin) || ''
  active = true
  visibleAt = document.visibilityState === 'visible' ? performance.now() : null
  track('landing')
  tick = setInterval(() => { if (document.visibilityState === 'visible') flush() }, 15000)
  document.addEventListener('visibilitychange', () => safe(() => {
    if (document.visibilityState === 'hidden') {
      if (visibleAt !== null) visibleMs += performance.now() - visibleAt
      visibleAt = null; flush(true)
    } else if (active) visibleAt = performance.now()
  }))
  window.addEventListener('pagehide', () => safe(() => {
    if (visibleAt !== null) visibleMs += performance.now() - visibleAt
    visibleAt = null; flush(true)
  }))
  window.addEventListener('pageshow', () => { if (active && document.visibilityState === 'visible' && visibleAt === null) visibleAt = performance.now() })
  // Delegated DOM clicks, not pointer/mouse movement; no URL or email addresses collected.
  document.addEventListener('click', (e) => safe(() => {
    const a = e.target.closest('a')
    if (a?.href.startsWith('mailto:')) track('email_clicked')
    else if (a && new URL(a.href).hostname.endsWith('github.com')) track('github_clicked')
    else if (a && new URL(a.href).hostname.endsWith('linkedin.com')) track('linkedin_clicked')
    if (e.target.closest('.staff-picks-tab')) track('staff_picks', context)
  }), { passive: true })
})
// State transitions also cover keyboard, touch and 3D raycast interactions. No useFrame.
export function useTelemetry({ aisle, project, book, page, pages, extras, contactOpen, directoryOpen }) {
  const slug = project?.slug
  useEffect(() => { track('shelf_viewed', { aisle }) }, [aisle])
  useEffect(() => { context = { slug }; if (slug) track('case_pulled', { slug }) }, [slug])
  useEffect(() => { if (slug && book === 'open') track('insert_opened', { slug, pages }) }, [slug, book])
  useEffect(() => { if (slug && book === 'open') track('page_viewed', { slug, page: page + 1, pages }) }, [slug, book, page])
  useEffect(() => { if (extras) track('read_as_text', { slug }) }, [extras])
  useEffect(() => { if (contactOpen) track('contact_opened') }, [contactOpen])
  useEffect(() => { if (directoryOpen) track('store_directory') }, [directoryOpen])
}

// Invoked after watchRenderer in Canvas.onCreated: about five seconds after the
// first store draw, or a zero-frame diagnostic if rendering never gets started.
// Three snapshots at most per tab visit. No polling or frame/render callbacks.
export function watchGraphics(gl) {
  if (!active) return
  safe(() => {
    const emit = (kind) => safe(() => {
      if (!active || gfxSent[kind]) return
      const report = JSON.parse(JSON.stringify(gfxReport()))
      gfxSent[kind] = true
      track('gfx', { gfx: report })
    })
    if (!gfxSent.baseline) gfxTimer = setTimeout(() => emit('baseline'), 5000)
    gl.domElement.addEventListener('webglcontextlost', () => emit('lost'), { once: true })
    const previous = gl.debug.onShaderError
    gl.debug.onShaderError = function (...args) {
      try { return previous?.apply(this, args) }
      finally { emit('shader') }
    }
  })
}
