// The film that runs out of a 35mm can. The reel lifts out of the can and rolls along, laying the
// strip down behind it: each frame swings flat as the reel passes, one frame per stage. Like the
// other inserts it lives in the camera's own space and starts where the can is. Three frames across
// on a wide screen, two on a narrower one, one on a phone; swipe, tap a side or use the arrows to
// run it along.
import { tempo } from './pace.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FRAME } from './covers-filmcan.js'
import { canvas, toTexture } from './covers.js'
import { filmTextures } from './printed.js'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp
// one frame in scene units, the same shape as the frame canvases
const FH = 1
const FW = (FH * FRAME.w) / FRAME.h
// the reel's size, in the same units
const REEL = 0.62
// The lid lifts first, the reel follows with weight, then the strip pours off it and each frame
// settles flat. These are normal-speed seconds; the first film this visit runs the same sequence at
// showcase pace so the reel unwinding is something you can actually watch.
const LID = [0, 0.11]
const TRAVEL = [0.05, 0.25]
const ROLL = [0.1, 0.4]
const DROP = [0.08, 0.28]
const DONE = 0.4
// The wind-back is deliberately the reverse mechanical order. App's close wait matches 0.24 s.
const WIND = 0.24
const ease = (t) => 1 - Math.pow(1 - t, 3)
const smooth = (t) => t * t * (3 - 2 * t)
const phase = (e, [a, b]) => smooth(clamp((e - a) / (b - a), 0, 1))
const noRay = () => null
// A short unprinted tail moves the reel's LEFT rim beyond the final frame. Grow it
// with the pour so the reel still starts in the can; use the same path in reverse.
const reelX = (len, total) => len + REEL * 0.5 + (REEL * 0.5 + 0.08) * smooth(clamp(len / Math.max(0.001, total), 0, 1))

// A projector reel: pressed steel with three cut-outs you can see through, and the hub.
function reelTexture() {
  const n = 512
  const [c, ctx] = canvas(n, n)
  const g = ctx.createRadialGradient(n * 0.4, n * 0.35, 10, n / 2, n / 2, n / 2)
  g.addColorStop(0, '#f0eee9')
  g.addColorStop(1, '#8d8b86')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(n / 2, n / 2, n * 0.4, a + 0.25, a + 1.75)
    ctx.arc(n / 2, n / 2, n * 0.16, a + 1.6, a + 0.4, true)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#5a5853'
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n * 0.07, 0, Math.PI * 2)
  ctx.fill()
  return toTexture(c)
}

// size is the can's radius in scene units, so the reel starts the size of the can it came from
export default function FilmStrip3D({ project, shelf, ctl, mode, page, per, single, onTurn, onIntroDone, size: S }) {
  const { size, gl } = useThree()
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    filmTextures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const x of t.frames) gl.initTexture(x)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const x of made.frames) x.dispose()
    }
  }, [project, shelf, gl])
  // App's close() waits out a wind-back that is still running before the can goes on the shelf
  useEffect(() => {
    const c = ctl.current
    return () => Object.assign(c, { canAside: 0, canLid: 0, windUntil: 0, filmOpen: false })
  }, [ctl])
  const reelMap = useMemo(() => reelTexture(), [])
  useEffect(() => {
    // Like the frame textures, upload the reel before its first moving frame.
    gl.initTexture(reelMap)
    return () => reelMap.dispose()
  }, [gl, reelMap])
  // each frame swings on its left edge, so its geometry starts there
  const geo = useMemo(() => new THREE.PlaneGeometry(FW, FH).translate(FW / 2, 0, 0), [])
  useEffect(() => () => geo.dispose(), [geo])

  const n = tex ? tex.frames.length : 0
  const view = single ? 1 : per
  const group = useRef()
  const strip = useRef()
  const reel = useRef()
  const wound = useRef()
  const frames = useRef([])
  const st = useRef({ sheet: 0, mode: null, t0: null, tc: null, q: 1, sent: false, len: 0, cx: 0, from: null })

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !strip.current || !tex) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    const top = single ? 64 : 84
    const bottom = single ? 150 : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    const across = (view * FW) / (single ? 0.92 : 0.94)
    const dist = Math.max(FH / (fillH * 2 * tan), across / (2 * tan * aspect))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = unit * FW
    const readY = (bottom - top) / 2 / unit
    const inCase = -(c.cartDist || 4)
    const total = n * FW

    if (mode !== s.mode) {
      // Opening needs room for the lid, reel and frame beats. Closing keeps the established 0.24 s
      // normal / 0.41 s showcase wind-back so the can is whole before App shelves it.
      const q = c.reduced ? 0 : mode === 'intro' ? tempo(c, 2.8) : tempo(c, 1.7)
      if (mode === 'intro') Object.assign(s, { t0: null, sent: false, q })
      if (!mode && s.mode && g.visible) {
        Object.assign(s, { tc: now, q, from: { sheet: s.sheet, len: s.len, y: g.position.y, z: g.position.z, sc: g.scale.x, cx: s.cx } })
        c.windUntil = performance.now() + WIND * q * 1000
      }
      s.mode = mode
    }
    c.filmOpen = !!mode
    if (mode === 'intro' && s.t0 === null) {
      Object.assign(s, { t0: now, len: 0, cx: (view * FW) / 2 })
      Object.assign(c, { filmTarget: 0, canAside: 0, canLid: 0 })
      g.position.set(0, 0, inCase)
      g.scale.setScalar((S * 0.9) / REEL)
      g.visible = true
    }
    let k = !mode && s.tc != null ? (s.q ? clamp((now - s.tc) / (WIND * s.q), 0, 1) : 1) : 1
    let e = mode === 'intro' ? (s.q ? (now - s.t0) / s.q : 9) : 9
    if (c.bookSkip) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < DONE) {
        e = 9
        s.t0 = now - 9
      } else if (!mode && s.tc != null) {
        // A second tap during the wind-back must land on a closed can immediately.
        k = 1
        c.windUntil = 0
        c.outroSkip = false
      }
    }
    if (!mode && k >= 1) {
      g.visible = false
      s.tc = null
    }
    // Expose the wind-back to the common tap/keyboard skip route as the other inserts do.
    c.bookOutro = !mode && g.visible
    if (!g.visible) {
      Object.assign(c, { canAside: 0, canLid: 0, bookIntro: mode === 'intro' })
      return
    }
    c.bookIntro = mode === 'intro' && e < DONE
    if (mode === 'intro' && e >= DONE && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    // where it should be: in the can, on its way, then laid out in front of you
    // App runs the film along through filmTarget (in frames); this is where the view should sit
    c.filmMax = Math.max(0, n - view)
    const home = clamp(c.filmTarget ?? page, 0, c.filmMax) * FW + (view * FW) / 2
    const lenBefore = s.len
    const small = (S * 0.9) / REEL
    if (!mode) {
      // The frames wind onto the reel first. The can rises around it, then the loose lid settles last.
      const u = smooth(k)
      const f = s.from
      s.len = f.len * (1 - u)
      s.cx = lerp(f.cx, (view * FW) / 2, u)
      g.position.set(0, lerp(f.y, 0, u), lerp(f.z, inCase, u))
      g.scale.setScalar(lerp(f.sc, small, u))
      c.canAside = 1 - u
      c.canLid = 1 - smooth(clamp((k - 0.58) / 0.42, 0, 1))
    } else if (mode === 'intro' && e < DONE) {
      const travel = phase(e, TRAVEL)
      const rollEnd = c.show ? ROLL[1] : 0.30
      const roll = clamp((e - ROLL[0]) / (rollEnd - ROLL[0]), 0, 1)
      g.position.set(0, lerp(0, readY, travel), lerp(inCase, -dist, travel))
      g.scale.setScalar(lerp(small, 1, travel))
      // Start AND finish at rest. An ease-out alone starts at maximum speed,
      // throwing the first frame across the window in two or three refreshes.
      s.len = total * smooth(roll)
      s.cx = home
      c.canLid = phase(e, LID)
      c.canAside = phase(e, DROP)
    } else {
      // Laid out on frame one: it follows the window if it resizes, then runs when dragged/scrubbed.
      g.position.y = damp(g.position.y, readY, 14, dt)
      g.position.z = damp(g.position.z, -dist, 14, dt)
      g.scale.setScalar(damp(g.scale.x, 1, 14, dt))
      s.len = total
      s.cx = damp(s.cx, home, c.dragging ? 30 : 12, dt)
      Object.assign(c, { canAside: 1, canLid: 1 })
    }

    // the reel stays where the can was while the film pours out of it, then rolls off to the
    // right, laying the rest of the film down behind it
    // Ease the hand-off from following the reel to holding the reading window.
    // min(cx, len) had a velocity corner exactly when the first frames landed.
    const blend = Math.max(0.001, s.cx * 0.25)
    const handoff = clamp((s.len - s.cx + blend) / (2 * blend), 0, 1)
    // Integral of 1 - smoothstep: following speed falls from 1 to 0, never
    // exceeds the reel's speed (which would make the reel briefly roll backwards).
    const off = s.len < s.cx - blend ? s.len : s.cx - blend + 2 * blend * (handoff - handoff ** 3 + handoff ** 4 / 2)
    strip.current.position.x = -off
    c.filmView = Math.max(0, off / FW - view / 2)
    // "see all frames": every frame slides from its place on the strip into a contact sheet that
    // fits the screen (three across on a wide screen, two on a phone), and back again
    if (mode) s.sheet = damp(s.sheet, c.filmSheet ? 1 : 0, 14, dt)
    else s.sheet = (s.from ? s.from.sheet : 0) * (1 - ease(k))
    const b = ease(clamp(s.sheet, 0, 1))
    const cols = single ? 2 : 3
    const rowsN = Math.ceil(n / cols)
    const availW = (size.width * 0.92) / unit
    const availH = (size.height - top - bottom) / unit
    const gap = 1.06
    const sc = Math.min(availW / (cols * FW * gap), availH / (rowsN * FH * gap))
    frames.current.forEach((m, i) => {
      if (!m) return
      const k = smooth(clamp((s.len - i * FW) / FW, 0, 1))
      m.visible = k > 0
      m.rotation.y = (1 - k) * -Math.PI / 2 * (1 - b)
      const gx = ((i % cols) - (cols - 1) / 2) * FW * sc * gap - (FW * sc) / 2 + off
      const gy = ((rowsN - 1) / 2 - Math.floor(i / cols)) * FH * sc * gap
      m.position.set(lerp(i * FW, gx, b), lerp(0, gy, b), b * 0.02)
      m.scale.setScalar(lerp(1, sc, b))
    })
    if (reel.current) {
      reel.current.visible = b < 0.5
      reel.current.position.x = reelX(s.len, total)
      reel.current.rotation.z -= (reelX(s.len, total) - reelX(lenBefore, total)) / REEL
      const left = 1 - s.len / Math.max(0.001, total)
      if (wound.current) wound.current.scale.setScalar(0.32 + 0.6 * left)
    }
  })

  // tap the right or left side to run the film along
  const onClick = (e, i) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    // on the contact sheet, a frame takes you back to the film at that frame
    if (c.filmSheet) return c.filmPick?.(i)
    const x = strip.current.worldToLocal(e.point.clone()).x - Math.min(st.current.cx, st.current.len)
    if (x > FW * 0.2 * view) onTurn(1)
    else if (x < -FW * 0.2 * view) onTurn(-1)
  }
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay

  return (
    <group ref={group} visible={false}>
      <group ref={strip}>
        {tex &&
          tex.frames.map((t, i) => (
            <mesh key={t.uuid} ref={(m) => (frames.current[i] = m)} geometry={geo} position={[i * FW, 0, 0]} onClick={(e) => onClick(e, i)} raycast={raycast}>
              <meshStandardMaterial key={t.uuid} map={t} roughness={0.7} emissive="#ffffff" emissiveMap={t} emissiveIntensity={0.42} side={THREE.DoubleSide} />
            </mesh>
          ))}
        <group ref={reel} position={[REEL, 0, 0.02]}>
          {/* the film still wound on it */}
          <mesh ref={wound} raycast={noRay}>
            <circleGeometry args={[REEL * 0.86, 64]} />
            <meshStandardMaterial color="#1a130c" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.01]} raycast={noRay}>
            <circleGeometry args={[REEL, 64]} />
            <meshStandardMaterial map={reelMap} metalness={0.6} roughness={0.3} transparent alphaTest={0.5} />
          </mesh>
        </group>
      </group>
    </group>
  )
}
