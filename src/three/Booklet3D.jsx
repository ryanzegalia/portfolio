// The instruction booklet that comes out from behind an open cartridge. It lives in the camera's
// own space, so it always faces you square-on and sizes itself to the screen: a two-page spread on
// wide screens, one page at a time on a phone. Pages are leaves bent around the spine.
import * as pacing from './pace.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PAGE, bookletPlan } from './covers-booklet.js'
import { bookletTextures } from './printed.js'

// Fallbacks keep this isolated lane runnable before the shared pacing branch lands.
const { tempo, SHOWCASE = 1.25, NORMAL = 1.6 } = pacing

const damp = THREE.MathUtils.damp
const clamp = THREE.MathUtils.clamp
// one page in scene units, the same shape as the page canvases
const BH = 1
const BW = (BH * PAGE.w) / PAGE.h
const SEG = 24
// paper thickness between stacked leaves
const EPS = 0.0035
const noRay = () => null
// Own the complete journey rather than multiplying the shared insert tempo twice.
// One continuous pull from the sleeve, a forward settle, then the hinged cover.
const SHOW_OPEN = 1.072 * SHOWCASE
const NORMAL_OPEN = 0.3875 * NORMAL
const CLOSE = 0.35
export { tempo }
const beat = (p, a, b) => {
  const t = clamp((p - a) / (b - a), 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

// Bend one leaf: it turns around the spine (x = 0) by t * 180 degrees, the outer edge leading a
// little so the paper curls, then lies flat on the other side of the stack.
function bend(geo, t, z0, flex = 0) {
  const pos = geo.attributes.position.array
  const theta = t * Math.PI
  const curl = Math.sin(theta) * 0.65
  let x = 0
  let z = 0
  for (let i = 0; i <= SEG; i++) {
    if (i) {
      const u = (i - 0.5) / SEG
      const a = Math.min(Math.PI, theta + curl * u * u)
      x += (Math.cos(a) * BW) / SEG
      z += (Math.sin(a) * BW) / SEG
    }
    for (const r of [0, SEG + 1]) {
      pos[(r + i) * 3] = x
      pos[(r + i) * 3 + 2] = z + z0 + flex * (i / SEG) ** 2
    }
  }
  geo.attributes.position.needsUpdate = true
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
}

// keyed on the texture: a material first compiled without a map won't pick one up later
export const paperMat = (map, side) => (
  <meshStandardMaterial
    key={map ? map.uuid : 'blank'}
    map={map}
    side={side}
    roughness={0.86}
    metalness={0}
    color={map ? '#ffffff' : '#e9dfc7'}
    emissive="#ffffff"
    emissiveMap={map}
    emissiveIntensity={map ? 0.34 : 0}
  />
)

export default function Booklet3D({ project, shelf, ctl, mode, page, single, onTurn, onIntroDone }) {
  const { size, gl } = useThree()
  const plan = useMemo(() => bookletPlan(project), [project])
  // leaf 0 is the cover (inside cover = page 1), the last leaf carries the back cover
  const count = plan.length / 2 + 1
  const leaves = useMemo(
    () =>
      Array.from({ length: count }, () => {
        const front = new THREE.PlaneGeometry(BW, BH, SEG, 1)
        const back = front.clone()
        // the back is seen from behind: flip it so it doesn't read mirrored
        const uv = back.attributes.uv.array
        for (let i = 0; i < uv.length; i += 2) uv[i] = 1 - uv[i]
        return { front, back, t: -1 }
      }),
    [count],
  )
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    // draw the pages as soon as the cartridge is open, so the booklet is ready before you ask
    bookletTextures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const x of [t.cover, t.back, ...t.pages]) gl.initTexture(x)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const x of [made.cover, made.back, ...made.pages]) x.dispose()
    }
  }, [project, shelf, gl])
  useEffect(() => () => leaves.forEach((l) => (l.front.dispose(), l.back.dispose())), [leaves])

  const group = useRef()
  const st = useRef({ mode: null, t0: null, sent: false, p: 0, closeFrom: 0, duration: NORMAL_OPEN })

  useFrame((state, ft) => {
    const g = group.current
    if (!g) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    const top = single ? 58 : 76
    const bottom = single ? 150 : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    const across = single ? BW / 0.92 : (2 * BW) / 0.9
    const dist = Math.max(BH / (fillH * 2 * tan), across / (2 * tan * aspect))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = BW * unit
    const readY = (bottom - top) / 2 / unit
    const behind = (c.cartDist || 3) + 0.16

    if (mode !== s.mode) {
      if (mode === 'intro') {
        Object.assign(s, { t0: null, sent: false, p: 0, duration: c.show ? SHOW_OPEN : NORMAL_OPEN })
        leaves.forEach((l) => { l.t = -1 })
      } else if (!mode) {
        s.closeFrom = s.p
        s.t0 = now
        // Preserve the current spread, including a part-turned page, on early close.
        leaves.forEach((l) => { l.closeT = Math.max(0, l.t) })
        s.closeX = g.position.x
      }
      s.mode = mode
    }
    if (mode === 'intro' && s.t0 === null && tex) {
      s.t0 = now
      g.visible = true
    }
    const skip = c.bookSkip || (!mode && c.outroSkip)
    if (skip && g.visible) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
    }
    if (mode === 'intro' && s.t0 !== null) {
      s.p = c.reduced || skip ? 1 : clamp((now - s.t0) / s.duration, 0, 1)
      if (skip) s.t0 = now - s.duration
    } else if (mode === 'open') s.p = 1
    else if (!mode) s.p = c.reduced || skip ? 0 : s.closeFrom * (1 - clamp((now - s.t0) / CLOSE, 0, 1))
    if (!mode && s.p === 0) g.visible = false
    c.bookIntro = mode === 'intro' && (s.t0 === null || s.p < 1)
    c.bookOutro = !mode && g.visible
    if (!g.visible) return
    if (mode === 'intro' && s.p === 1 && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    const p = s.p
    const lift = beat(p, 0, 0.39)
    const forward = beat(p, 0.28, 0.64)
    const hinge = beat(p, 0.62, 1)
    const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
    const readX = single ? (page % 2 ? -BW / 2 : BW / 2) + drag * BW / 3 : 0
    // On desktop, register the spine before opening it. Phone framing follows the unfolding
    // page instead: moving to the reading offset early would send the closed cover offscreen.
    // There is no side waypoint; the bottom edge clears the cartridge before the forward move.
    const spineX = !mode ? s.closeX ?? readX : readX
    const framing = single ? (1 - Math.cos(Math.PI * hinge)) / 2 : beat(p, 0.30, 0.62)
    const closeHinge = beat(s.closeFrom, 0.62, 1)
    const closeFraming = single ? (1 - Math.cos(Math.PI * closeHinge)) / 2 : beat(s.closeFrom, 0.30, 0.62)
    const frame = !mode ? (closeFraming > 0 ? framing / closeFraming : 0) : framing
    const x = THREE.MathUtils.lerp(-BW / 2, spineX, frame)
    if (mode === 'open' && !c.reduced) g.position.x = damp(g.position.x, readX, 10, ft)
    else g.position.x = x
    g.position.y = THREE.MathUtils.lerp(1.34 * lift, readY, forward)
    g.position.z = THREE.MathUtils.lerp(-behind, -dist, forward)
    g.rotation.set(-0.10 * (1 - forward) * lift, -0.12 * (1 - forward) * lift, 0)

    const turned = Math.floor(page / 2) + 1
    const flex = 0.025 * Math.sin(Math.PI * lift) * (1 - forward)
    leaves.forEach((l, i) => {
      let target = i < turned ? 1 : 0
      if (!single && drag < 0 && i === turned && i < count - 1) target = clamp(-drag, 0, 1)
      if (!single && drag > 0 && i === turned - 1 && i > 0) target = 1 - clamp(drag, 0, 1)
      // The cover has a real hinge at x=0. The remaining leaves breathe a few degrees, not a flap.
      const fan = i > 0 ? 0.012 * (count - i) / count * Math.sin(Math.PI * hinge) : 0
      const t = mode === 'intro' ? (i === 0 ? hinge : fan)
        : !mode ? (closeHinge > 0 ? (l.closeT || 0) * hinge / closeHinge : 0)
        : c.reduced || l.t < 0 ? target : damp(l.t, target, drag ? 26 : 11, ft)
      if (Math.abs(t - l.t) < 1e-5 && Math.abs(flex - (l.flex || 0)) < 1e-5) return
      l.t = t
      l.flex = flex
      const z0 = THREE.MathUtils.lerp((count - i) * EPS, (i + 1) * EPS, t)
      bend(l.front, t, z0, flex)
      bend(l.back, t, z0, flex)
    })
  })

  // tap the outer edge of a page to turn it; on a phone, the left or right side of the page
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    const x = group.current.worldToLocal(e.point.clone()).x
    if (single) {
      const mid = page % 2 ? BW / 2 : -BW / 2
      if (x - mid > BW * 0.15) onTurn(1)
      else if (x - mid < -BW * 0.15) onTurn(-1)
    } else if (x > BW * 0.6) onTurn(1)
    else if (x < -BW * 0.6) onTurn(-1)
  }

  // a put-away booklet must not catch clicks meant for the backdrop
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay
  return (
    <group ref={group} visible={false}>
      {leaves.map((l, i) => {
        const front = i === 0 ? tex?.cover : tex?.pages[i * 2 - 1]
        const back = i === count - 1 ? tex?.back : tex?.pages[i * 2]
        return (
          <group key={i}>
            <mesh geometry={l.front} onClick={onClick} raycast={raycast}>
              {paperMat(front, THREE.FrontSide)}
            </mesh>
            <mesh geometry={l.back} onClick={onClick} raycast={raycast}>
              {paperMat(back, THREE.BackSide)}
            </mesh>
          </group>
        )
      })}
    </group>
  )
}
