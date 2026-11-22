import { SHOWCASE } from './pace.js'
// A record's printed inner sleeve. The record runs on out of the jacket's open side, the sleeve
// slides out after it and comes to you, and the record settles behind it. The sleeve carries the
// liner notes, one on each side in two columns: drag across it, tap it or use the arrow keys to turn
// it over. A phone reads one printed column per stop, turning the paper over halfway. Like
// the other inserts it lives in the camera's own space and starts inside the case's own jacket, so
// the case can hide its record while this one is out.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { tempo } from './Booklet3D.jsx'
import { beat } from './pace.js'
import { ObjectButton, useObjectMove } from './ObjectMove.jsx'
import { DISC, PEEK } from './covers-vinyl.js'
import { sleeveSides, recordFace, recordSheen } from './printed.js'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp
const ease = (t) => THREE.MathUtils.smootherstep(t, 0, 1)
// the intro, in seconds: the sleeve slides out of the jacket, then comes to you
const SLIDE = 0.30
const DONE = 0.68
// The showcase (the first record of a visit) is its own sequence, in seconds: the record edges out
// of the jacket's open side as it's taken hold of, then runs on out with the sleeve after it, the
// two hang there a beat clear of the jacket, and then the sleeve comes to you and the record
// settles behind it
const SHOWR = { give: [0, 0.14], disc: [0.12, 0.52], sleeve: [0.18, 0.58], travel: [0.6, 1.04], done: 1.08 }
// how far out of the jacket's open side the sleeve has to go to clear it
const OUT = 1.04
const noRay = () => null

const sideMat = (map) => (
  <meshStandardMaterial key={map ? map.uuid : 'blank'} map={map} alphaTest={0.5} roughness={0.86} color={map ? '#ffffff' : '#f4efe3'} emissive="#ffffff" emissiveMap={map} emissiveIntensity={map ? 0.3 : 0} />
)

// size is the jacket's edge in scene units, so the sleeve can start out exactly inside it
export default function Record3D({ project, shelf, ctl, mode, page, single, onTurn, onSeek, onObjectMove, onIntroDone, size: S }) {
  const { size, gl } = useThree()
  const [playing, setPlaying] = useState(false)
  const arm = useRef()
  const speed = useRef(0)
  const move = useMemo(() => ({ key: 'd', active: playing,
    label: playing ? 'Lift the needle · stop the record' : 'Drop the needle · what I built',
    activate: () => { setPlaying(!playing); if (!playing) onSeek(single ? 2 : 1) },
  }), [playing, single, onSeek])
  useObjectMove(ctl, mode, onObjectMove, move)
  useEffect(() => { if (mode !== 'open') setPlaying(false) }, [mode])
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    // draw both sides as soon as the jacket is out, so they're ready before you ask
    sleeveSides(project, shelf).then(async (sides) => {
      made = { sides, disc: await recordFace(project, shelf), sheen: await recordSheen() }
      if (!live) return
      for (const x of sides) gl.initTexture(x)
      setTex(made)
    })
    return () => {
      live = false
      if (made) for (const x of [made.disc, made.sheen, ...made.sides]) x.dispose()
    }
  }, [project, shelf, gl])
  // Crop the geometry's UVs, not the texture: baked print textures carry a live stock/ink
  // handle which Texture.clone would JSON-copy, losing its Color and deferred ink update.
  const readingGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(single ? 0.485 : 0.97, 0.97)
    if (single) {
      const uv = geo.attributes.uv
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + (page % 2) * 0.5)
    }
    return geo
  }, [single, page % 2])
  useEffect(() => () => readingGeo.dispose(), [readingGeo])
  // put away with the jacket still out: give the case its own record back
  useEffect(() => () => void (ctl.current.recordOut = false), [ctl])

  const group = useRef()
  const sheet = useRef()
  const disc = useRef()
  const spin = useRef()
  const peek = single ? 0.08 : PEEK
  const st = useRef({ mode: null, t0: null, sent: false, closeAt: 0, hideAt: 0, sx: 0, dx: peek, dy: 0, dz: 0, turn: 0 })

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !sheet.current || !tex) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    // keep clear of the header (and its shelf buttons on a phone) and the buttons below (px)
    const top = single ? 100 : 76
    const bottom = single ? 230 : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    // Frame one column on a phone, including its own printed header and paper gutters.
    // A desktop also leaves room for the record beside it.
    const across = single ? 0.5 / 0.92 : 1.75 / 0.94
    const dist = Math.max(1 / (fillH * 2 * tan), across / (2 * tan * aspect))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = unit
    const readY = (bottom - top) / 2 / unit
    const inCase = -(c.cartDist || 4)
    const side = single ? Math.floor(page / 2) : page
    const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
    // Center the whole sleeve on a phone; on desktop offset it to reveal the record on its right.
    const homeX = single ? drag * 0.3 : -0.19
    const restX = homeX + (single ? 0.13 : 0.62)
    const restY = single ? 0.32 : 0

    if (mode !== s.mode) {
      // the normal pace runs the way out in half these seconds; the first of its kind this visit is
      // the showcase, 2.2 times as long (and its close too)
      const q = 0.5 * tempo(c, 2.2)
      // the showcase's way out runs on its own clock (SHOWR); its way back is the normal one, slower
      const show = mode === 'intro' && !!c.show && !c.reduced
      if (mode === 'intro') Object.assign(s, { t0: null, sent: false, oq: show ? SHOWCASE : q, show })
      if (!mode) Object.assign(s, { closeAt: now, cq: q, hideAt: now + 0.47 * q })
      s.mode = mode
    }
    if (mode === 'intro' && s.t0 === null) {
      Object.assign(s, { t0: now, sx: 0, dx: peek, dy: 0, dz: 0, turn: 0 })
      g.position.set(0, 0, inCase)
      g.scale.setScalar(S)
      g.visible = true
    }
    if (!mode && now > s.hideAt) g.visible = false
    // while this one is out, the case's jacket is empty
    // a tap while it goes back in puts it away at once
    if (!mode && c.bookSkip && g.visible) {
      Object.assign(c, { bookSkip: false, bookSkipAt: performance.now() })
      g.visible = false
    }
    c.bookOutro = !mode && g.visible
    c.recordOut = g.visible
    if (!g.visible) {
      c.bookIntro = mode === 'intro'
      return
    }
    let e = mode === 'intro' ? (now - s.t0) / s.oq : 9
    const done = s.show ? SHOWR.done : DONE
    let snap = false
    if (c.bookSkip) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < done) {
        e = 9
        s.t0 = now - 9
        snap = true
      }
    }
    c.bookIntro = mode === 'intro' && e < done
    if (mode === 'intro' && e >= done && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    if (mode === 'intro' && e < done && !snap && s.show) {
      const R = SHOWR
      const run = beat(e, ...R.disc)
      const slide = beat(e, ...R.sleeve)
      const travel = beat(e, ...R.travel)
      g.position.set(0, lerp(0, readY, travel), lerp(inCase, -dist, travel))
      g.scale.setScalar(lerp(S, 1, travel))
      s.sx = lerp(slide * OUT, homeX, travel)
      s.dx = lerp(lerp(peek + 0.06 * beat(e, ...R.give), OUT + 0.3, run), restX, travel)
      s.dy = lerp(0, restY, travel)
      s.dz = lerp(0, -0.04, travel)
    } else if (mode === 'intro' && e < done && !snap) {
      // the record runs on ahead out of the open side, the sleeve after it; then the sleeve comes to
      // you and the record tucks in behind it
      const slide = ease(Math.min(1, e / SLIDE))
      const travel = ease(clamp((e - SLIDE * 0.75) / (DONE - SLIDE * 0.75), 0, 1))
      g.position.set(0, lerp(0, readY, travel), lerp(inCase, -dist, travel))
      g.scale.setScalar(lerp(S, 1, travel))
      s.sx = lerp(slide * OUT, homeX, travel)
      s.dx = lerp(lerp(peek, OUT + 0.3, slide), restX, travel)
      s.dy = lerp(0, restY, travel)
      s.dz = lerp(0, -0.04, travel)
    } else if (mode) {
      const k = snap || c.reduced ? 1e4 : 12
      g.position.x = damp(g.position.x, 0, k, dt)
      g.position.y = damp(g.position.y, readY, k, dt)
      g.position.z = damp(g.position.z, -dist, k, dt)
      g.scale.setScalar(damp(g.scale.x, 1, k, dt))
      s.sx = damp(s.sx, homeX, k, dt)
      s.dx = damp(s.dx, restX, k, dt)
      s.dy = damp(s.dy, restY, k, dt)
      s.dz = damp(s.dz, -0.04, k, dt)
    } else {
      // put back: it goes back to the jacket's open side, then slides in
      // on the close's own clock: about a quarter second, half a second after a showcase
      const back = (now - s.closeAt) / s.cq
      const kd = dt / s.cq
      g.position.x = damp(g.position.x, 0, 16, kd)
      g.position.y = damp(g.position.y, 0, 16, kd)
      g.position.z = damp(g.position.z, inCase, 16, kd)
      g.scale.setScalar(damp(g.scale.x, S, 16, kd))
      s.sx = damp(s.sx, back < 0.22 ? OUT : 0, 16, kd)
      s.dx = damp(s.dx, back < 0.22 ? OUT + 0.3 : peek, 15, kd)
      s.dy = damp(s.dy, 0, 16, kd)
      s.dz = damp(s.dz, 0, 16, kd)
    }

    // turning it over: side 1 faces you, side 2 is round the back. On a wide screen a drag turns it
    // under your finger and lets go to whichever side the pager lands on
    const lean = single ? 0 : clamp(drag * 2.4, side ? 0 : -1.5, side ? 1.5 : 0)
    const want = mode === 'open' ? -side * Math.PI + lean : 0
    s.turn = c.reduced ? want : damp(s.turn, want, drag ? 30 : mode ? 9 : 14, dt)
    // lifted toward you while it turns, so its edges swing clear of the record behind it
    sheet.current.position.set(s.sx, 0, 0.004 + Math.abs(Math.sin(s.turn)) * 0.5)
    sheet.current.rotation.y = s.turn
    if (disc.current) {
      disc.current.position.set(s.dx, s.dy, s.dz - 0.006)
      // On a phone the record becomes a small tab, not a second full-width reading surface.
      disc.current.scale.setScalar(damp(disc.current.scale.x, single && mode ? 0.32 : 1, 10, dt))
    }
    speed.current = c.reduced ? 0 : damp(speed.current, playing && mode === 'open' ? 1.3 : 0, 8, dt)
    if (spin.current) spin.current.rotation.y += dt * speed.current
    if (arm.current) {
      arm.current.rotation.z = c.reduced ? (playing ? -0.56 : 0) : damp(arm.current.rotation.z, playing ? -0.56 : 0, 10, dt)
      arm.current.position.z = c.reduced ? (playing ? 0.015 : 0.04) : damp(arm.current.position.z, playing ? 0.015 : 0.04, 14, dt)
    }
  })

  // a tap turns the sleeve over to its other side; on a phone, a tap on the right or left goes along
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    if (!single) onTurn(page ? -1 : 1)
    else if (e.pointer.x > 0.2) onTurn(1)
    else if (e.pointer.x < -0.2) onTurn(-1)
  }
  // a put-away sleeve must not catch clicks meant for the backdrop
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay

  return (
    <group ref={group} visible={false}>
      <group ref={disc} position={[peek, 0, -0.006]}>
        <mesh ref={spin} rotation={[Math.PI / 2, 0, 0]} onClick={onClick} raycast={raycast}>
          <cylinderGeometry args={[DISC, DISC, 0.006, 96]} />
          <meshPhysicalMaterial key={tex?.disc ? tex.disc.uuid : 'blank'} map={tex?.disc} color={tex?.disc ? '#ffffff' : '#0b0b0c'} roughness={0.32} metalness={0.1} clearcoat={1} clearcoatRoughness={0.08} emissive="#ffffff" emissiveMap={tex?.disc} emissiveIntensity={tex?.disc ? 0.18 : 0} />
        </mesh>
        {mode === 'open' && !single && <group position={[0.23, 0.29, 0.045]}>
          <mesh><cylinderGeometry args={[0.035, 0.035, 0.025, 24]} /><meshStandardMaterial color="#b5a27b" metalness={0.8} roughness={0.25} /></mesh>
          <group ref={arm} scale={single ? 0.6 : 1} onClick={(e) => { e.stopPropagation(); if (!ctl.current.moved) move.activate() }} onPointerOver={() => { gl.domElement.style.cursor = 'pointer' }} onPointerOut={() => { gl.domElement.style.cursor = '' }}>
            <mesh position={[0, -0.16, 0]}><boxGeometry args={[0.014, 0.32, 0.014]} /><meshStandardMaterial color="#c7b997" metalness={0.85} roughness={0.22} /></mesh>
            <mesh position={[-0.012, -0.32, 0]}><boxGeometry args={[0.044, 0.063, 0.025]} /><meshStandardMaterial color="#302b26" metalness={0.5} roughness={0.3} /></mesh>
            <ObjectButton move={move} position={[-0.012, -0.32, 0.025]} kind="needle">{playing ? 'Ⅱ' : '↓'}</ObjectButton>
          </group>
        </group>}
        {/* the light's two streaks stay put while the record turns under them */}
        <mesh position={[0, 0, 0.0035]} raycast={noRay}>
          <circleGeometry args={[DISC, 96]} />
          <meshBasicMaterial key={tex?.sheen ? tex.sheen.uuid : 'blank'} map={tex?.sheen} transparent opacity={tex?.sheen ? 0.32 : 0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <group ref={sheet}>
        <mesh geometry={readingGeo} position={[0, 0, 0.0008]} onClick={onClick} raycast={raycast}>
          {sideMat(tex?.sides[0])}
        </mesh>
        <mesh geometry={readingGeo} position={[0, 0, -0.0008]} rotation={[0, Math.PI, 0]} onClick={onClick} raycast={raycast}>
          {sideMat(tex?.sides[1])}
        </mesh>
      </group>
    </group>
  )
}
