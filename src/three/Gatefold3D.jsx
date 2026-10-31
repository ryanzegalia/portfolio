import { SHOWCASE } from './pace.js'
// A LaserDisc special edition's gatefold. The jacket comes to you shut, the front cover swings open
// like a book, and on a triple gatefold the extra flap folds out to the right; the disc rises out of
// its pocket behind. Opened, it lies flat: every panel across on a wide screen, one at a time on a
// phone. Like the other inserts it lives in the camera's own space and starts exactly where the case
// is, so the case hides its own jacket while this one is out.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { MAP, FACE } from './covers-laserdisc.js'
import { tempo } from './Booklet3D.jsx'
import { beat, settle } from './pace.js'
import { gatefoldTextures, discLabel, discSheen } from './printed.js'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
// the intro, in seconds: the jacket comes to you, then opens
const OUT = 0.16
const DONE = 0.45
// The showcase (the first gatefold of a visit) is its own sequence, in seconds: the jacket gives a
// little as it's taken hold of, comes to you shut so you see its cover, waits a beat, then the
// cover swings open like a heavy book (the flap after it on a triple), and only then does the disc
// rise out of its pocket, spinning
const SHOWG = { travel: [0.06, 0.48], open: [0.5, 0.95], disc: [0.72, 1.08], done: 1.1 }
// putting it back, in seconds: the disc drops into its pocket as the gatefold starts to fold, and
// the jacket heads back into the case while it shuts
const DROP = 0.1
const FOLD = [0.03, 0.18]
const BACK = [0.07, 0.21]
// fast, then settling
const easeOut = (t) => 1 - Math.pow(1 - THREE.MathUtils.clamp(t, 0, 1), 3)
const span = (t, [a, b]) => easeOut((t - a) / (b - a))
const EPS = 0.03
const noRay = () => null

const paper = (map, side, ref) => (
  <meshStandardMaterial ref={ref} key={map ? map.uuid : 'blank'} map={map} side={side} roughness={0.8} color={map ? '#ffffff' : '#e9dfc7'} emissive="#ffffff" emissiveMap={map} emissiveIntensity={map ? 0.3 : 0} />
)

// size is the jacket's edge in scene units, so the gatefold can sit exactly on the case
export default function Gatefold3D({ project, shelf, ctl, mode, page, single, onTurn, onIntroDone, size: S }) {
  const { size, gl, camera, scene } = useThree()
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    gatefoldTextures(project, shelf).then(async (t) => {
      t.disc = await discLabel(project, shelf)
      t.sheen = await discSheen()
      made = t
      if (!live) return
      for (const x of [t.cover, t.back, t.disc, t.sheen, ...t.faces]) gl.initTexture(x)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const x of [made.cover, made.back, made.disc, made.sheen, ...made.faces]) x.dispose()
    }
  }, [project, shelf, gl])
  useEffect(() => () => void (ctl.current.jacketOut = false), [ctl])
  // build its shaders (the disc's rainbow one is heavy) while it waits in the case, so the first
  // frame of the intro doesn't stall on them
  useEffect(() => {
    if (tex && group.current) gl.compileAsync(group.current, camera, scene).catch(() => {})
  }, [tex, gl, camera, scene])
  const n = tex ? tex.faces.length : 2

  // the front cover's outside is seen from behind once it's folded over: flip it so it reads
  const geo = useMemo(() => {
    const left = new THREE.PlaneGeometry(1, 1).translate(-0.5, 0, 0)
    const right = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0)
    const outside = left.clone()
    const uv = outside.attributes.uv.array
    for (let i = 0; i < uv.length; i += 2) uv[i] = 1 - uv[i]
    return { left, right, outside }
  }, [])
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo])

  // On a phone the held chapter has clean paper edges. Clip the neighbouring print in the
  // strip's own coordinates once it is open, without flattening the unfolding showcase.
  const readingEdges = useMemo(() => [new THREE.Plane(), new THREE.Plane()], [])
  useEffect(() => {
    const previous = gl.localClippingEnabled
    gl.localClippingEnabled = true
    return () => { gl.localClippingEnabled = previous }
  }, [gl])

  const group = useRef()
  const strip = useRef()
  const cover = useRef()
  const flap = useRef()
  const disc = useRef()
  const spin = useRef()
  const line = useRef([])
  const rings = useRef([])
  const journey = project.journey?.length || 0
  // the line map's stops: a journey's chapters, or a case's steps
  const stops = (project.journey || project.steps)?.length || 0
  // on a phone a journey reads one stop (one chapter) at a time, so its words are big enough
  const halves = single && journey > 0
  const st = useRef({ mode: null, t0: null, sent: false, c0: 0, q: 1, from: null, gone: false, f: 1, cx: 0.5, d: 0, lineAt: null, z: 1, vx: 0, vy: 0 })

  // Held like the real thing: zoom in with the wheel or a pinch, then drag to look around. view is
  // where the look is headed (zoom 1 is the whole thing laid out, x and y how far it's been moved,
  // in panel units); m keeps this frame's numbers for the math
  const view = useRef({ zoom: 1, x: 0, y: 0 })
  const m = useRef(null)
  useEffect(() => {
    // never lose the gatefold: the look stops at its edges
    const keep = (v) => {
      const k = m.current
      const d = k.dist / v.zoom
      const hw = d * k.tan * k.aspect
      const lo = Math.min(k.cx, k.left + hw * 0.9)
      const hi = Math.max(k.cx, k.right - hw * 0.9)
      v.x = THREE.MathUtils.clamp(k.cx + v.x, lo, hi) - k.cx
      const yr = Math.max(0, 0.5 - d * k.tan * 0.7)
      v.y = THREE.MathUtils.clamp(v.y, -yr, yr)
    }
    ctl.current.gate = {
      zoomed: () => view.current.zoom > 1.02,
      // the spot under the pointer stays under it while the zoom changes
      zoomBy(f, px, py) {
        const k = m.current
        const v = view.current
        if (!k) return
        const z = THREE.MathUtils.clamp(v.zoom * f, 1, 4)
        const nx = (px / k.w) * 2 - 1
        const ny = 1 - (py / k.h) * 2
        const lx = (nx * k.dist * k.tan * k.aspect) / v.zoom + k.cx + v.x
        const ly = (ny * k.dist * k.tan - k.readY) / v.zoom + v.y
        v.x = lx - (nx * k.dist * k.tan * k.aspect) / z - k.cx
        v.y = ly - (ny * k.dist * k.tan - k.readY) / z
        v.zoom = z
        if (z === 1) Object.assign(v, { x: 0, y: 0 })
        keep(v)
      },
      panBy(dx, dy) {
        const k = m.current
        const v = view.current
        if (!k) return
        const per = (2 * k.dist * k.tan) / v.zoom / k.h
        v.x -= dx * per
        v.y += dy * per
        keep(v)
      },
      reset: () => Object.assign(view.current, { zoom: 1, x: 0, y: 0 }),
    }
    return () => void delete ctl.current.gate
  }, [ctl, n])
  // turning to another chapter, or putting it back, lays it out whole again
  useEffect(() => void Object.assign(view.current, { zoom: 1, x: 0, y: 0 }), [page, mode])

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !strip.current || !tex) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    // a chapter on a phone stands clear of the header and its buttons
    const top = single ? 112 : 84
    const bottom = single ? 180 : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    // Leave a visible gutter beyond the active panel, including its fold edge. The adjacent
    // panel can still peek in (this is a continuous gatefold), but no active-panel text is cut.
    const across = halves ? 3 / journey / 0.86 : single ? 1 / 0.84 : n / 0.94
    const dist = Math.max(1 / (fillH * 2 * tan), across / (2 * tan * aspect))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = unit * s.z
    const readY = (bottom - top) / 2 / unit
    const inCase = -(c.cartDist || 4)

    if (mode !== s.mode) {
      s.q = tempo(c, 2.2)
      // the showcase's way out runs on its own clock (SHOWG); its way back is the normal one, slower
      if (mode === 'intro') Object.assign(s, { t0: null, sent: false, show: !!c.show && !c.reduced })
      if (mode === 'intro' && s.show) s.q = SHOWCASE
      // going back starts from wherever it got to, even part way out
      if (!mode && g.visible) {
        const p = s.lineAt === null ? 0 : Math.min(stops, (now - s.lineAt) / 0.13)
        Object.assign(s, { c0: now, from: { y: g.position.y, z: g.position.z, s: g.scale.x, f: s.f, cx: s.cx, d: s.d, p } })
      }
      s.mode = mode
    }
    if (mode === 'intro' && s.t0 === null) {
      Object.assign(s, { t0: now, f: 1, cx: 0.5, lineAt: null, gone: false })
      g.position.set(0, 0, inCase)
      g.rotation.set(0, 0, 0)
      g.scale.setScalar(S)
      g.visible = true
    }
    // back in the case, it stays one more frame, so the case's own jacket is showing before it goes
    if (s.gone) {
      s.gone = false
      g.visible = false
    }
    c.jacketOut = g.visible
    if (!g.visible) {
      c.bookIntro = mode === 'intro'
      c.bookOutro = false
      return
    }
    let e = mode === 'intro' ? (now - s.t0) / s.q : 9
    let back = mode ? 0 : (now - s.c0) / s.q
    const show = s.show && mode === 'intro'
    const done = s.show ? SHOWG.done : DONE
    let snap = false
    if (c.bookSkip) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < done) {
        e = 9
        s.t0 = now - 9
        snap = true
        s.lineAt = now - 9
      }
      // a tap while it goes back in puts it away at once
      if (!mode) back = 9
    }
    c.bookIntro = mode === 'intro' && e < done
    c.bookOutro = !mode
    if (mode === 'intro' && e >= done && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    // where it should be: shut in the case, shut on its way, then open in front of you
    const ease = (t) => THREE.MathUtils.smootherstep(t, 0, 1)
    const travel = !mode ? 0 : show ? beat(e, ...SHOWG.travel) : ease(Math.min(1, e / OUT))
    // it swings open fast and lays itself down flat softly, without going past; in the showcase it
    // starts slowly too, the weight of the board
    const open = !mode ? 0 : show ? beat(e, ...SHOWG.open) : settle(e, OUT * 0.35, 0.32)
    // taken hold of in the showcase: it lifts a hair and tips its top toward you, then levels on the way
    const give = show ? Math.sin(Math.PI * Math.min(1, e / 0.3)) * (1 - travel) : 0
    const tip = show ? -0.07 * beat(e, 0, 0.12) * (1 - beat(e, 0.18, 0.46)) : 0
    const tf = 1 - open
    // centered on every panel, or on the one you're reading on a phone; a drag pulls it along
    const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
    const home = halves ? -1 + ((page + 0.5) * 3) / journey : single ? page - 0.5 : (n - 2) / 2
    const openCx = home - drag * 0.4
    const panelWidth = halves ? 3 / journey : 1
    m.current = { dist, tan, aspect, readY, cx: home, left: single ? home - panelWidth / 2 : -1, right: single ? home + panelWidth / 2 : n - 1, w: size.width, h: size.height }
    const vt = mode === 'open' ? view.current : { zoom: 1, x: 0, y: 0 }
    s.z = damp(s.z, vt.zoom, mode ? 16 : 30, dt)
    s.vx = damp(s.vx, vt.x, mode ? 18 : 30, dt)
    s.vy = damp(s.vy, vt.y, mode ? 18 : 30, dt)
    if (!mode) {
      // going back: it folds as the disc drops in, then heads into the case as it shuts
      const was = s.from
      const fold = span(back, FOLD)
      const stay = 1 - span(back, BACK)
      g.position.set(0, lerp(0, was.y, stay), lerp(inCase, was.z, stay))
      g.scale.setScalar(lerp(S, was.s, stay))
      s.f = lerp(was.f, 1, fold)
      s.cx = lerp(was.cx, 0.5, fold)
      s.d = was.d * (1 - easeOut(back / DROP))
      // in the case: from the next frame the case's own jacket shows instead
      if (back >= BACK[1]) {
        s.gone = true
        c.jacketOut = false
        c.bookOutro = false
      }
    } else if (snap || (mode === 'intro' && e < done)) {
      g.position.set(0, lerp(0, readY, travel) + 0.05 * S * give, lerp(inCase, -dist, travel))
      g.rotation.set(tip, 0, 0)
      g.scale.setScalar(lerp(S, 1, travel))
      s.f = tf
      s.cx = lerp(0.5, openCx, open)
    } else {
      g.position.x = damp(g.position.x, 0, 12, dt)
      g.position.y = damp(g.position.y, readY, 12, dt)
      g.position.z = damp(g.position.z, -dist, 12, dt)
      g.scale.setScalar(damp(g.scale.x, 1, 12, dt))
      s.f = damp(s.f, 0, 10, dt)
      s.cx = damp(s.cx, openCx, drag ? 26 : 10, dt)
    }

    // fold: the cover swings open first, then the flap tucked under it follows and flops flat.
    // Shut, the flap rides a hair above the middle panel and the cover above both, so neither
    // pokes through the other
    const o = 1 - s.f
    const oc = flap.current ? THREE.MathUtils.smootherstep(o, 0, 0.6) : o
    const of = Math.max(0, (o - 0.35) / 0.65)
    cover.current.rotation.y = (1 - oc) * (Math.PI - EPS)
    cover.current.position.z = flap.current ? 0.02 * (1 - oc) : 0
    if (flap.current) {
      flap.current.rotation.y = -(1 - of) * (Math.PI - 0.012)
      flap.current.position.z = 0.003 * (1 - of)
    }
    // zoomed in, the whole sheet grows around where you're looking
    strip.current.scale.setScalar(s.z)
    strip.current.position.set(-(s.cx + s.vx) * s.z, -s.vy * s.z, 0)
    const cropped = single && mode === 'open'
    if (cropped) {
      const width = panelWidth
      strip.current.updateWorldMatrix(true, false)
      readingEdges[0].set(new THREE.Vector3(1, 0, 0), -(home - width / 2)).applyMatrix4(strip.current.matrixWorld)
      readingEdges[1].set(new THREE.Vector3(-1, 0, 0), home + width / 2).applyMatrix4(strip.current.matrixWorld)
    }
    if (s.cropped !== cropped) {
      strip.current.traverse((object) => {
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          if (!material) continue
          material.clippingPlanes = cropped ? readingEdges : null
          material.needsUpdate = true
        }
      })
      s.cropped = cropped
    }
    // the disc rises out of its pocket behind the middle panel, spinning, catching the light; going
    // back, it drops in first
    if (disc.current) {
      // in the showcase it waits until the cover is open, then rises on its own beat
      const out = mode ? Math.min(THREE.MathUtils.clamp(1 - s.f, 0, 1), show && !snap ? beat(e, ...SHOWG.disc) : 1) : s.d
      s.d = out
      // on a phone it only peeks over the top, so it stays out from under the header
      disc.current.position.y = lerp(0, single ? 0 : 0.4, out)
      disc.current.visible = mode ? s.f < 0.98 : out > 0.002
      if (spin.current) spin.current.rotation.y += dt * (0.6 + (show ? 3 * out : 0) + 4 * Math.max(0, 1 - (now - (s.lineAt ?? now)) / 1.5))
    }
    // the map's line draws itself stop to stop once the gatefold is flat, each stop pinging; going
    // back, it runs back to the start before the gatefold folds
    if (stops) {
      if (mode && s.lineAt === null && s.f < 0.05) s.lineAt = now
      if (!mode) s.lineAt = null
      const p = mode ? (s.lineAt === null ? 0 : (now - s.lineAt) / 0.13) : s.from.p * Math.max(0, 1 - back / FOLD[0])
      line.current.forEach((m, j) => {
        if (!m) return
        const k = THREE.MathUtils.clamp(p - j, 0, 1)
        m.visible = k > 0.001 && s.f < 0.05
        m.scale.x = Math.max(0.0001, k * SEG)
        m.position.x = X(j) + GAP + (k * SEG) / 2
      })
      rings.current.forEach((m, i) => {
        if (!m) return
        const age = p - i
        m.visible = !!mode && s.f < 0.05 && age >= 0 && age < 3
        const t = THREE.MathUtils.clamp(age / 3, 0, 1)
        m.scale.setScalar(1 + t * 1.6)
        m.material.opacity = 0.9 * (1 - t)
      })
    }
  })

  // on a phone, tap the right or left side of the panel to go along
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved || c.gate?.zoomed()) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    if (!single) return
    const x = strip.current.worldToLocal(e.point.clone()).x
    const mid = halves ? -1 + ((page + 0.5) * 3) / journey : page - 0.5
    const edge = halves ? 0.08 : 0.15
    if (x - mid > edge) onTurn(1)
    else if (x - mid < -edge) onTurn(-1)
  }
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay
  const board = <meshStandardMaterial color="#0d0f11" roughness={0.6} side={THREE.BackSide} />
  // the map line's stops, in the strip's units (panels are one unit square, the cover's panel
  // runs from -1 to 0)
  const mapY = 0.5 - MAP.y / FACE
  const X = (i) => -1 + ((i + 0.5) / Math.max(1, stops)) * 3
  const GAP = (MAP.r + 6) / FACE
  const SEG = stops ? 3 / stops - GAP * 2 : 0
  const gold = new THREE.Color(project.palette?.accent || '#e0b04a')

  return (
    <group ref={group} visible={false}>
      <group ref={strip}>
        {/* the disc in its pocket, behind the middle panel */}
        <group ref={disc} position={[0.5, 0, -0.014]}>
          <mesh ref={spin} rotation={[Math.PI / 2, 0, 0]} raycast={noRay}>
            <cylinderGeometry args={[0.47, 0.47, 0.008, 96]} />
            <meshPhysicalMaterial key={tex?.disc ? tex.disc.uuid : 'blank'} map={tex?.disc} color="#ffffff" emissive="#ffffff" emissiveMap={tex?.disc} emissiveIntensity={0.32} metalness={0.7} roughness={0.12} iridescence={1} iridescenceIOR={1.7} iridescenceThicknessRange={[180, 620]} clearcoat={1} clearcoatRoughness={0.05} />
          </mesh>
          {/* the rainbow stays with the light while the disc turns under it */}
          <mesh position={[0, 0, 0.0045]} raycast={noRay}>
            <circleGeometry args={[0.47, 96]} />
            <meshBasicMaterial key={tex?.sheen ? tex.sheen.uuid : 'blank'} map={tex?.sheen} transparent opacity={tex?.sheen ? 0.55 : 0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
        {/* the map line, drawn live over the open gatefold */}
        {stops > 0 &&
          Array.from({ length: stops - 1 }, (_, j) => (
            <mesh key={`l${j}`} ref={(m) => (line.current[j] = m)} position={[X(j), mapY, 0.003]} visible={false} raycast={noRay}>
              <planeGeometry args={[1, MAP.thick / FACE]} />
              <meshBasicMaterial color={gold} toneMapped={false} />
            </mesh>
          ))}
        {stops > 0 &&
          Array.from({ length: stops }, (_, i) => (
            <mesh key={`r${i}`} ref={(m) => (rings.current[i] = m)} position={[X(i), mapY, 0.004]} visible={false} raycast={noRay}>
              <ringGeometry args={[MAP.r / FACE, (MAP.r + 10) / FACE, 48]} />
              <meshBasicMaterial color={gold} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          ))}
        {/* the middle panel: inside of the back cover */}
        <mesh geometry={geo.right} onClick={onClick} raycast={raycast}>
          {paper(tex?.faces[1], THREE.FrontSide)}
        </mesh>
        <mesh geometry={geo.right} raycast={noRay}>
          <meshStandardMaterial key={tex?.back ? tex.back.uuid : 'blank'} map={tex?.back} roughness={0.6} side={THREE.BackSide} />
        </mesh>
        {/* the front cover, hinged on the middle panel's left edge */}
        <group ref={cover}>
          <mesh geometry={geo.left} onClick={onClick} raycast={raycast}>
            {paper(tex?.faces[0], THREE.FrontSide)}
          </mesh>
          <mesh geometry={geo.outside} raycast={noRay}>
            <meshStandardMaterial key={tex?.cover ? tex.cover.uuid : 'blank'} map={tex?.cover} roughness={0.4} side={THREE.BackSide} emissive="#ffffff" emissiveMap={tex?.cover} emissiveIntensity={tex?.cover ? 0.28 : 0} />
          </mesh>
        </group>
        {/* a triple gatefold's extra flap, hinged on the middle panel's right edge */}
        {n > 2 && (
          <group ref={flap} position={[1, 0, 0]}>
            <mesh geometry={geo.right} onClick={onClick} raycast={raycast}>
              {paper(tex?.faces[2], THREE.FrontSide)}
            </mesh>
            <mesh geometry={geo.right} raycast={noRay}>
              {board}
            </mesh>
          </group>
        )}
      </group>
    </group>
  )
}
