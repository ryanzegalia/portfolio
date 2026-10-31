import { SHOWCASE } from './pace.js'
// The "Behind the scenes" leaflet tucked inside a rental tape's clamshell. It is a z-fold strip of
// panels: folded, it's one panel with the cover on top; it lifts out of the open case and opens
// like an accordion. Like the booklet it lives in the camera's own space, so the panels you're
// reading always face you square-on: three across on a wide screen, two on a narrower one, one on
// a phone. Panels you aren't reading relax back toward folded on either side.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PAGE } from './covers-booklet.js'
import { leafletPlan } from './covers-leaflet.js'
import { paperMat, tempo } from './Booklet3D.jsx'
import { spring } from './pace.js'
import { leafletTextures } from './printed.js'
import CassetteMove from './CassetteMove.jsx'

const damp = THREE.MathUtils.damp
const clamp = THREE.MathUtils.clamp
const lerp = THREE.MathUtils.lerp
// one panel in scene units, the same shape as the page canvases
const BH = 1
const BW = (BH * PAGE.w) / PAGE.h
// folded shut, paper keeps a little spring, so the panels never sit flush
const SHUT = Math.PI - 0.012
// opened, every crease keeps a slight bend, the way a folded leaflet never lies flat again
const OPEN = 0.1
// creases a panel or more away from what you're reading
const SIDE = 0.6
// lying in the case: bigger than in your hands (it's farther away), low and a little crooked on
// the tape, so the top reel still shows above it
const TUCK = 1.3
const TUCK_Y = -0.24
const TUCK_RZ = 0.03
// the intro, in seconds: the lid swings open, the leaflet lifts out, then unfolds
const LIFT = 0.16
const OUT = 0.4
const DONE = 0.95
// The rental leaflet's showcase (the first of a visit) is its own sequence, in seconds, every move
// on a spring: while the lid swings open it gives a little as it's taken hold of, lifts out still
// folded and held at an angle, comes round to the front, and then opens out crease by crease
const SHOWL = { give: 0.13, lift: 0.27, out: 0.56, unfold: 0.6, done: 1.18 }
const NORML = { give: 0, lift: LIFT, out: OUT, unfold: OUT, done: DONE }
// opening out, each crease starts a little after the one before it, from the cover on
const STAGGER = 0.4
const noRay = () => null
// A J-card comes out of a mixtape's lid instead (fromLid): one timeline, in seconds, run forward to
// open and backward to put away. The hinge gives, swings open and holds before the card clears its
// clips; the card then comes to you and its creases open one after another. The showcase uses this
// same choreography at a watchable pace rather than merely slowing one simultaneous move.
const J = { lid: [0, 0.12], slide: [0.14, 0.22], carry: [0.18, 0.31], unfold: [0.22, 0.42] }
const J_NORMAL = { lid: [0, 0.12], slide: [0.08, 0.16], carry: [0.11, 0.25], unfold: [0.14, 0.32] }
const J_DONE = 0.45
const J_NORMAL_DONE = 0.34
const J_LID = -2.3
// putting it away runs faster, keeping a first close near half a second and later closes near 0.2 s
const J_BACK = 2.2
// a J-card's creases at the edge of the view, past which the panels fold back out of the way
const EDGE = 1.25
const smooth = (t) => t * t * (3 - 2 * t)
const progress = (e, [a, b]) => clamp((e - a) / (b - a), 0, 1)
const phase = (e, range) => smooth(progress(e, range))
const M = new THREE.Matrix4()
const SLIDE = new THREE.Matrix4()
const P0 = new THREE.Vector3()
const Q0 = new THREE.Quaternion()
const S0 = new THREE.Vector3()
const P1 = new THREE.Vector3()
const Q1 = new THREE.Quaternion()

// how far each crease is folded, for the panels u to u + w in view
function crease(i, u, w, tuck) {
  if (tuck === 'leaflet') {
    // Fold both edges away from the reader, irrespective of the accordion's parity. Keep
    // the selected panels at their original size; the remaining paper stacks behind them.
    const d = i <= u ? u - i : i >= u + w ? i - (u + w) : -Math.min(i - u, u + w - i)
    const sign = i % 2 ? 1 : -1
    const fold = (n) => n === 0 ? Math.PI - 0.18 : (n % 2 ? -Math.PI : Math.PI) + 0.004
    const edge = sign * fold(0)
    // Each hidden pair sits a paper-thickness farther back. Ordinary alternating SHUT
    // angles would bring every second panel forward again, covering the selected text.
    return d < 0 ? lerp(OPEN, edge, clamp(1 + d, 0, 1)) : sign * lerp(fold(Math.floor(d)), fold(Math.ceil(d)), d % 1)
  }
  if (tuck) {
    // a J-card's: flat in view, folded hard at the edges, the rest stacked shut behind
    const d = i <= u ? u - i : i >= u + w ? i - (u + w) : -Math.min(i - u, u + w - i)
    return d < 0 ? lerp(OPEN, EDGE, clamp(1 + d, 0, 1)) : lerp(EDGE, SHUT - 0.3, clamp(d, 0, 1))
  }
  const d = i < u ? u - i : i - (u + w)
  return lerp(OPEN, SIDE, clamp(d, 0, 1))
}

// Lay the strip out from the cover: each crease turns the next panel back the other way from the
// last one, which is what makes it a z-fold. f = 1 is folded shut.
function layout(L, u, w, f, tuck, stagger = 0) {
  let x = 0
  let z = 0
  let a = 0
  for (let i = 0; i < L.n; i++) {
    const fi = stagger ? 1 - clamp((1 - f - (stagger * (i - 1)) / Math.max(1, L.n - 2)) / (1 - stagger), 0, 1) : f
    if (i) a += (i % 2 ? 1 : -1) * lerp(crease(i, u, w, tuck), SHUT, fi)
    L.x[i] = x
    L.z[i] = z
    L.a[i] = a
    x += BW * Math.cos(a)
    z -= BW * Math.sin(a)
  }
}

// The J-card opens from its cover outward. Adjacent creases overlap enough to keep the accordion
// flowing, but each gets a distinct beat instead of every panel springing open at once.
function layoutJ(L, u, w, unfold, tuck) {
  let x = 0
  let z = 0
  let a = 0
  const creases = Math.max(1, L.n - 1)
  const stagger = 0.58
  const span = 1 + stagger * Math.max(0, creases - 1)
  for (let i = 0; i < L.n; i++) {
    if (i) {
      const local = smooth(clamp(unfold * span - stagger * (i - 1), 0, 1))
      a += (i % 2 ? 1 : -1) * lerp(SHUT, crease(i, u, w, tuck), local)
    }
    L.x[i] = x
    L.z[i] = z
    L.a[i] = a
    x += BW * Math.cos(a)
    z -= BW * Math.sin(a)
  }
}

// a point along the strip, s panels in from the cover's outer edge
function pointAt(L, s) {
  const i = clamp(Math.floor(s), 0, L.n - 1)
  const f = s - i
  return [L.x[i] + f * BW * Math.cos(L.a[i]), L.z[i] - f * BW * Math.sin(L.a[i])]
}

// How far back the camera must hold a J-card so the panels folded back past each edge stay on
// screen too. Solved over every screenful, so nothing zooms between them.
function tuckDist(L, per, xMax, yMax) {
  const last = Math.max(0, L.n - 1 - per)
  let need = 0
  for (let p = 0; ; p += per) {
    const u = 1 + Math.min(p, last)
    layout(L, u, per, 0, true)
    const [x0, z0] = pointAt(L, u)
    const [x1, z1] = pointAt(L, u + per)
    const ang = Math.atan2(-(z1 - z0), x1 - x0)
    const co = Math.cos(ang)
    const si = Math.sin(ang)
    const [px, pz] = pointAt(L, u + per / 2)
    for (let i = 0; i < L.n; i++) {
      for (const k of [0, 1]) {
        const x = L.x[i] + k * BW * Math.cos(L.a[i]) - px
        const z = L.z[i] - k * BW * Math.sin(L.a[i]) - pz
        const zc = x * si + z * co
        need = Math.max(need, zc + Math.abs(x * co - z * si) / xMax, zc + BH / 2 / yMax)
      }
    }
    if (p >= last) return need
  }
}

// A mixtape's J-card folds the same way, so it rides here too (plan, textures). Under 1, pace runs
// the way out and back quicker (the rental tape's leaflet)
export default function Leaflet3D({ project, shelf, ctl, mode, page, per, single, onTurn, onSeek, onObjectMove, onIntroDone, plan = leafletPlan, textures = leafletTextures, pace = 1, fromLid = false, onPutAway }) {
  const { size, gl } = useThree()
  // the cover, every inside panel, then the store's back panel
  const count = useMemo(() => plan(project).length + 2, [project, plan])
  const geo = useMemo(() => new THREE.PlaneGeometry(BW, BH).translate(BW / 2, 0, 0), [])
  useEffect(() => () => geo.dispose(), [geo])
  const L = useMemo(() => ({ n: count, x: new Float32Array(count), z: new Float32Array(count), a: new Float32Array(count) }), [count])
  const flat = useMemo(() => ({ n: count, x: new Float32Array(count), z: new Float32Array(count), a: new Float32Array(count) }), [count])
  const fit = useMemo(() => ({ n: count, x: new Float32Array(count), z: new Float32Array(count), a: new Float32Array(count) }), [count])
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    // draw the panels as soon as the case is open, so the leaflet is ready before you ask
    textures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const x of [t.cover, t.back, ...t.pages]) gl.initTexture(x)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const x of [made.cover, made.back, ...made.pages]) x.dispose()
    }
  }, [project, shelf, gl, textures])

  const group = useRef()
  const strip = useRef()
  const panels = useRef([])
  const st = useRef({ mode: null, t0: null, sent: false, hideAt: 0, q: 1, f: 1, u: 1, w: 1, e: 0, rate: 1, jump: false, lc: null, T: NORML, show: false, v: {} })
  // let go of the case's lid whole and shut, however this ends
  useEffect(
    () => () => {
      const lc = st.current.lc
      if (lc) {
        lc.lid.rotation.y = 0
        lc.card.visible = true
      }
      ctl.current.jcardE = 0
    },
    [ctl],
  )

  useFrame((state, ft) => {
    // pace changes the way out and back, never the reading; a J-card from a lid keeps its own clock
    const dt = mode === 'open' || fromLid ? ft : ft / (pace * st.current.q)
    const g = group.current
    if (!g || !strip.current) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    // keep clear of the header and the buttons (px)
    const top = single ? (fromLid ? 154 : 58) : 76
    const bottom = single ? (fromLid ? 250 : 150) : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    const across = (per * BW) / (single ? 0.92 : 0.9)
    const tuck = per > 1 ? (fromLid ? true : 'leaflet') : false
    let dist = Math.max(BH / (fillH * 2 * tan), across / (2 * tan * aspect))
    if (fromLid && tuck) dist = Math.max(dist, tuckDist(fit, per, 0.97 * tan * aspect, fillH * 1.08 * tan))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = BW * unit
    const readY = (bottom - top) / 2 / unit
    // Fit in screen space first, then bring the entire folded strip in front of the tape. Merely
    // fitting its width can put it behind the case on a narrower desktop. Scale depth and size
    // together so the reading size stays identical; the strip's full length bounds its rear edge.
    const readScale = fromLid || !single ? Math.min(1, Math.max(0.5, (c.cartDist || 5) - 0.35) / (dist + count * BW)) : 1
    // lying on the tape, just inside where the lid closes
    const inCase = -((c.cartDist || 5) - 0.11)

    if (fromLid) {
      if (mode !== s.mode) {
        // The first cassette this visit gives the hinge and each crease room to read; later ones run
        // the identical sequence at the normal pace. Reduced motion goes straight to the end.
        s.rate = 1 / tempo(c, 2.65)
        s.jump = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        if (mode === 'intro') s.sent = false
        if (mode && !s.lc) s.lc = c.lidCase
        s.mode = mode
      }
      const lc = s.lc
      // the intro waits for the panels to be drawn (they usually are by now)
      if (!lc || !tex) {
        c.bookIntro = mode === 'intro'
        return
      }
      const beats = c.show ? J : J_NORMAL
      const done = c.show ? J_DONE : J_NORMAL_DONE
      let skip = false
      let skipClose = false
      if (c.bookSkip) {
        c.bookSkip = false
        c.bookSkipAt = performance.now()
        skip = mode === 'intro' && s.e < done
        skipClose = !mode && s.e > 0
      }
      if (mode) s.e = skip || s.jump ? done : Math.min(done, s.e + dt * s.rate)
      else s.e = skipClose || s.jump ? 0 : Math.max(0, s.e - dt * s.rate * (c.show ? J_BACK : J_NORMAL_DONE / 0.21))
      const e = s.e
      c.jcardE = e
      c.bookIntro = mode === 'intro' && e < done
      c.bookOutro = !mode && e > 0
      if (mode === 'intro' && e >= done && !s.sent) {
        s.sent = true
        onIntroDone()
      }
      const hinge = progress(e, beats.lid)
      // A tiny give against the latch supplies anticipation; then the weighted swing settles without
      // bouncing. The short gap before beats.slide is the held open-lid beat.
      lc.lid.rotation.y = hinge < 0.18 ? 0.045 * smooth(hinge / 0.18) : lerp(0.045, J_LID, smooth((hinge - 0.18) / 0.82))
      // the card in the lid and this one are the same card: only ever one of them shows
      const out = e > 0
      lc.card.visible = !out
      if (g.visible && !out && onPutAway) onPutAway()
      g.visible = out
      const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
      const tu = clamp(1 + page - drag, 0.6, Math.max(1, count - per) + 0.4)
      if (!out) {
        Object.assign(s, { f: 1, u: tu, w: per })
        return
      }
      // from where it lies in the lid, lifted off its clips, to where you read it
      lc.anchor.updateWorldMatrix(true, false)
      g.parent.updateWorldMatrix(true, false)
      const sl = phase(e, beats.slide)
      M.copy(g.parent.matrixWorld).invert().multiply(lc.anchor.matrixWorld).multiply(SLIDE.makeTranslation(0.06 * sl, 0, -0.14 * sl))
      M.decompose(P0, Q0, S0)
      const cr = phase(e, beats.carry)
      g.position.lerpVectors(P0, P1.set(0, readY * readScale, -dist * readScale), cr)
      // it comes up toward you as it turns over, clear of the tape in the tray
      g.position.z += 0.7 * Math.sin(Math.PI * cr)
      g.quaternion.slerpQuaternions(Q0, Q1, cr)
      g.scale.setScalar(lerp(S0.x, readScale, cr))
      s.f = 1 - phase(e, beats.unfold)
      s.u = c.reduced ? tu : damp(s.u, tu, drag ? 26 : 10, dt)
      s.w = damp(s.w, per, 10, dt)
      placeStrip()
      return
    }
    if (mode !== s.mode) {
      s.q = tempo(c, 2.2)
      // the showcase's way out runs on its own clock (SHOWL), in seconds; its way back is the normal
      // one, slower
      s.show = mode === 'intro' && !!c.show && !c.reduced
      if (mode === 'intro') Object.assign(s, { t0: null, sent: false, T: s.show ? SHOWL : NORML, v: {} })
      if (mode === 'intro' && s.show) s.q = SHOWCASE / pace
      if (!mode) s.hideAt = now + 0.42 * pace * s.q
      s.mode = mode
    }
    // the intro waits for the panels to be drawn (they usually are by now)
    if (mode === 'intro' && s.t0 === null && tex) {
      Object.assign(s, { t0: now, f: 1, u: 1 + page, w: per })
      g.position.set(0, TUCK_Y, inCase)
      g.rotation.set(0, 0, TUCK_RZ)
      g.scale.setScalar(TUCK)
      g.visible = true
    }
    if (!mode && now > s.hideAt) g.visible = false
    if (!g.visible) {
      c.bookIntro = mode === 'intro'
      c.bookOutro = false
      return
    }
    let e = mode === 'intro' ? (now - s.t0) / (pace * s.q) : 9
    const T = s.T
    let snap = false
    if (c.bookSkip) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < T.done) {
        e = 9
        s.t0 = now - 9
        snap = true
      }
      // a tap while it goes back in puts it away at once
      if (!mode) {
        g.visible = false
        c.bookOutro = false
        return
      }
    }
    c.bookIntro = mode === 'intro' && e < T.done
    c.bookOutro = !mode
    if (mode === 'intro' && e >= T.done && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    // where it should be right now
    let tx = 0
    let ty = readY * readScale
    let tz = -dist * readScale
    let ry = 0
    let rz = 0
    let sc = readScale
    let tf = 0
    if (!mode || e < T.lift) {
      ty = TUCK_Y
      tz = inCase
      rz = TUCK_RZ
      sc = TUCK
      tf = 1
      // taken hold of: it lifts a hair off the tape and straightens
      if (mode && e >= T.give) {
        ty += 0.05
        tz += 0.03
        rz = 0
      }
    } else if (e < T.out) {
      // up out of the case, still folded, held at a slight angle
      tx = 0.12
      ty = 0.12
      tz = lerp(inCase, -dist * readScale, 0.55)
      ry = -0.3
      rz = -0.06
      sc = lerp(TUCK, readScale, 0.5)
      tf = 1
    } else if (e < T.unfold) tf = 1
    const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
    const tu = clamp(1 + page - drag, 0.6, Math.max(1, count - per) + 0.4)
    if (snap) {
      g.position.set(tx, ty, tz)
      g.rotation.set(0, 0, 0)
      g.scale.setScalar(sc)
      Object.assign(s, { f: tf, u: tu, w: per, v: {} })
    } else if (s.show && mode === 'intro') {
      // the showcase: the same poses, each move eased in and settled
      const v = s.v
      const k = e < T.lift ? 15 : e < T.out ? 10.5 : 10
      g.position.x = spring(v, 'x', g.position.x, tx, k, dt)
      g.position.y = spring(v, 'y', g.position.y, ty, k, dt)
      g.position.z = spring(v, 'z', g.position.z, tz, k, dt)
      g.rotation.y = spring(v, 'ry', g.rotation.y, ry, 10, dt)
      g.rotation.z = spring(v, 'rz', g.rotation.z, rz, 10, dt)
      g.scale.setScalar(spring(v, 's', g.scale.x, sc, k, dt))
      s.f = clamp(spring(v, 'f', s.f, tf, 8.5, dt), 0, 1)
      s.u = damp(s.u, tu, 10, dt)
      s.w = damp(s.w, per, 10, dt)
    } else {
      const k = !mode ? 12 : e < T.out ? 16 : 10
      g.position.x = damp(g.position.x, tx, k, dt)
      g.position.y = damp(g.position.y, ty, k, dt)
      g.position.z = damp(g.position.z, tz, !mode ? 12 : 16, dt)
      g.rotation.y = damp(g.rotation.y, ry, 14, dt)
      g.rotation.z = damp(g.rotation.z, rz, 14, dt)
      g.scale.setScalar(damp(g.scale.x, sc, k, dt))
      s.f = damp(s.f, tf, tf ? 16 : 9, dt)
      s.u = c.reduced ? tu : damp(s.u, tu, drag ? 26 : 10, dt)
      s.w = damp(s.w, per, 10, dt)
    }

    placeStrip()
  })

  // Opened out, the panels in view should face you, so the strip turns to level them. Folded,
  // it's held by the cover. In between it hands over from one to the other.
  function placeStrip() {
    const s = st.current
    const tuck = per > 1 ? (fromLid ? true : 'leaflet') : false
    layout(flat, s.u, s.w, 0, tuck)
    const [x0, z0] = pointAt(flat, s.u)
    const [x1, z1] = pointAt(flat, s.u + s.w)
    const ang = Math.atan2(-(z1 - z0), x1 - x0) * (1 - s.f)
    if (fromLid) layoutJ(L, s.u, s.w, 1 - s.f, tuck)
    else layout(L, s.u, s.w, s.f, tuck, STAGGER)
    const [px, pz] = pointAt(L, lerp(s.u + s.w / 2, 0.5, s.f))
    const co = Math.cos(ang)
    const si = Math.sin(ang)
    strip.current.rotation.y = -ang
    strip.current.position.set(-(px * co - pz * si), 0, -(px * si + pz * co))
    for (let i = 0; i < count; i++) {
      const p = panels.current[i]
      if (!p) continue
      p.position.set(L.x[i], 0, L.z[i])
      p.rotation.y = L.a[i]
    }
  }

  // tap a panel toward the right to move along, toward the left to go back
  const onClick = (i) => (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    const { u, w } = st.current
    const at = i + clamp(panels.current[i].worldToLocal(e.point.clone()).x / BW, 0, 1)
    const edge = per === 1 ? 0.35 : 0.4
    if (at > u + w - edge) onTurn(1)
    else if (at < u + edge) onTurn(-1)
  }

  // a put-away leaflet must not catch clicks meant for the backdrop
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay
  return (
    <>
    {fromLid && <CassetteMove project={project} shelf={shelf} ctl={ctl} mode={mode} single={single} per={per} onSeek={onSeek} onObjectMove={onObjectMove} />}
    <group ref={group} visible={false}>
      <group ref={strip}>
        {Array.from({ length: count }, (_, i) => {
          const front = i === 0 ? tex?.cover : i === count - 1 ? tex?.back : tex?.pages[i - 1]
          return (
            <group key={i} ref={(el) => (panels.current[i] = el)}>
              <mesh geometry={geo} onClick={onClick(i)} raycast={raycast}>
                {paperMat(front, THREE.FrontSide)}
              </mesh>
              <mesh geometry={geo} onClick={onClick(i)} raycast={raycast}>
                {paperMat(null, THREE.BackSide)}
              </mesh>
            </group>
          )
        })}
      </group>
    </group>
    </>
  )
}
