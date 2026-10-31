// The PC box's own way out for its getting started manual (Manual3D with `box`): the lid lifts off
// and tips back to lean behind the box, the box eases back a little to make room, the manual rises
// out of the box and comes to you, and the rest of its long sheet slides down from behind its first
// page. Closing runs it all in reverse, faster: the manual drops back in, then the lid comes down.
// One progress value drives the manual here and the lid and box in Scene.jsx (`lidPose`), shared
// through ctl.boxOut.
import { tempo } from './pace.js'
import * as THREE from 'three'

const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp
const damp = THREE.MathUtils.damp
const step = (p, a, b) => THREE.MathUtils.smoothstep(p, a, b)
// the whole way out and the whole way back, in seconds; the manual reads by about 0.37 s
const INTRO = 0.44
const CLOSE = 0.24
// how much room the lid and the rising manual need above the box (scene units)
const ROOM = 1.85
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// The lid and the box at progress p: the lid lifts straight off, then tips back and leans behind
// the box with its inside to you; the box eases back and down while it's open.
export function lidPose(p) {
  // Break the snug fit first; only tip once the lid has cleared the box rim.
  const up = 0.12 * step(p, 0, 0.08) + 0.88 * step(p, 0.11, 0.28)
  const tip = step(p, 0.25, 0.4)
  return { y: 0.34 * up, z: -0.3 * tip, rx: -1.2 * tip, stage: step(p, 0, 0.3) }
}

// called from Manual3D's frame instead of its own path; returns nothing
export function boxFrame({ g, c, s, mode, dt, tex, dist, readTop, top, size, tan, boxW, boxH, strips, mats, back, slug, onIntroDone }) {
  // a new way out or back: read its pace (the first of its kind this visit is the showcase)
  if (mode !== s.mode) {
    if (mode === 'intro' || !mode) s.pace = tempo(c, mode ? 2.6 : 2.1)
    if (mode === 'intro') {
      s.sent = false
      if (!s.p) c.manualTarget = c.manualPos = 0
    }
    if (reduced()) s.p = mode ? 1 : 0
    s.mode = mode
  }
  s.p = s.p || 0
  if (c.bookSkip || (!mode && c.outroSkip)) {
    c.bookSkip = false
    c.bookSkipAt = performance.now()
    if (mode === 'intro') s.p = 1
    if (!mode) { s.p = 0; c.outroSkip = false }
  }
  s.p = clamp(s.p + (mode ? dt / (INTRO * (s.pace || 1)) : -dt / (CLOSE * (s.pace || 1))), 0, 1)
  const p = s.p
  c.bookIntro = mode === 'intro' && p < 1
  c.bookOutro = !mode && p > 0
  if (mode === 'intro' && p >= 1 && !s.sent) {
    s.sent = true
    onIntroDone()
  }

  // The stage: from your eye the box is d0 away and fills most of the height, with no room above
  // it. It eases back (only as far as it must) and drops, so the lid and the manual stay in view.
  const d0 = c.cartDist || 4
  const h0 = tan * d0
  const fh = top / size.height
  const K = clamp((ROOM + boxH) / (h0 * (1.96 - 2 * fh)), 1, 1.3)
  const push = d0 * (K - 1)
  const drop = Math.max(0, ROOM + boxH / 2 - h0 * K * (1 - 2 * fh))
  c.boxOut = { slug, p, push, drop }

  g.visible = p > 0
  if (!g.visible) return
  // scrolling: the target is set by wheel, drag and keys; the sheet follows it softly
  c.manualTarget = clamp(c.manualTarget || 0, 0, c.manualMax)
  c.manualPos = damp(c.manualPos || 0, c.manualTarget, c.dragging ? 30 : 12, dt)

  const st = lidPose(p).stage
  const boxY = -drop * st
  const boxZ = -(d0 + push * st)
  // A leaf is 1.6 widths tall, not a square. Fit the WHOLE leaf inside the box,
  // upright: the old tilt put its foot through the front even before it rose.
  const leafH = tex.strips[0].h
  const foldedScale = Math.min(boxW * 0.8, (boxH - 0.26) / leafH)
  const rim = boxY + boxH / 2 - 0.123
  const rise = step(p, 0.40, 0.61)
  const forward = step(p, 0.61, 0.67)
  const trav = step(p, 0.67, 0.90)
  const unfold = step(p, 0.80, 1)
  // Clear the rim with the bottom edge, move forward, THEN lower/expand it.
  // Reversing this path puts it above the rim before it goes back inside.
  const y = lerp(rim - 0.04, rim + leafH * foldedScale + 0.06, rise)
  // The first 0.30 clears the carton, then lower it as it approaches the eye;
  // hauling a high leaf all the way forward first would crop it above the viewport.
  g.position.set(0, lerp(y, readTop + c.manualPos, trav), lerp(boxZ + 0.30 * forward, -dist, trav))
  g.rotation.set(0, 0, 0)
  g.scale.setScalar(lerp(foldedScale, 1, trav))

  // Only its first page comes out of the box; the rest of the sheet is folded up behind it and
  // slides down into place once it's in your hands (below the screen on a wide one).
  let at = 0
  tex.strips.forEach((t, i) => {
    const m = strips[i]
    const mat = mats[i]
    if (mat) {
      mat.opacity = 1
      // Folded continuation strips stay behind the first leaf, not hanging below the box.
      mat.visible = i === 0 || unfold > 0.001
    }
    if (m && i > 0) m.position.set(0, lerp(-t.h / 2, at - t.h / 2, unfold), -0.002 * i)
    at -= t.h
  })
  if (back) back.visible = unfold > 0.99
}
