// The getting started manual from a 90s PC box. The lid comes up, the manual lifts out of the box,
// comes to you and lies there as one long sheet you scroll through: wheel, drag, arrow keys. No page
// turning. Like the other inserts it lives in the camera's own space, and it starts out inside the box.
// A shareware floppy's README printout is the same long sheet, so it rides here too (textures, paper).
import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { manualTextures } from './printed.js'
import { boxFrame } from './manual-box.js'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
// the intro, in seconds: the manual rises out of the box, comes to you, settles
const LIFT = 0.22
const OUT = 0.5
const DONE = 0.85
const noRay = () => null

// boxW and boxH are the box in scene units, so the manual starts out sized to sit inside it
export default function Manual3D({ project, shelf, ctl, mode, single, onIntroDone, boxW, boxH, textures = manualTextures, paper = '#e9dfc7', box = false }) {
  const { size, gl } = useThree()
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    textures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const s of t.strips) gl.initTexture(s.tex)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const s of made.strips) s.tex.dispose()
    }
  }, [project, shelf, gl, textures])

  const group = useRef()
  const strips = useRef([])
  const mats = useRef([])
  const back = useRef()
  const st = useRef({ mode: null, t0: null, sent: false, hideAt: 0 })

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !tex) return
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    // keep clear of the header and the buttons (px)
    const top = single ? 112 : 84
    const bottom = single ? 150 : 132
    // a comfortable reading width: most of a phone, a column on a wide screen
    // Show a useful stretch of the long sheet above the HUD fade, not a chapter heading cut
    // through its middle. Keep the phone column wide; on desktop fit at least 1.45 sheet widths.
    const widthPx = single ? size.width * 0.94 : Math.min(size.width * 0.62, 760, (size.height - top - bottom - 32) / 1.45)
    const dist = size.height / (2 * tan * widthPx)
    const unit = size.height / (2 * tan * dist)
    const readTop = (size.height / 2 - top) / unit
    const readH = (size.height - top - bottom) / unit
    c.manualMax = Math.max(0, tex.height - readH)
    c.manualPx = unit
    // where the box is: the manual starts inside it, just under the lid
    const inBox = -(c.cartDist || 4)
    const startScale = boxW * 0.8
    const startY = boxH / 2 - 0.12
    // the PC box has its own way out, lid first (manual-box.js)
    if (box) return boxFrame({ g, c, s, mode, dt, tex, dist, readTop, top, size, tan, boxW, boxH, strips: strips.current, mats: mats.current, back: back.current, slug: project.slug, onIntroDone })

    if (mode !== s.mode) {
      if (mode === 'intro') Object.assign(s, { t0: null, sent: false })
      if (!mode) s.hideAt = now + 0.34
      s.mode = mode
    }
    if (mode === 'intro' && s.t0 === null) {
      s.t0 = now
      c.manualTarget = 0
      c.manualPos = 0
      g.position.set(0, startY - 0.4, inBox)
      g.rotation.set(-0.25, 0, 0)
      g.scale.setScalar(startScale)
      g.visible = true
    }
    if (!mode && now > s.hideAt) g.visible = false
    if (!g.visible) {
      c.bookIntro = mode === 'intro'
      return
    }
    let e = mode === 'intro' ? now - s.t0 : 9
    let snap = false
    if (c.bookSkip) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < DONE) {
        e = 9
        s.t0 = now - 9
        snap = true
      }
    }
    c.bookIntro = mode === 'intro' && e < DONE
    if (mode === 'intro' && e >= DONE && !s.sent) {
      s.sent = true
      onIntroDone()
    }

    // scrolling: the target is set by wheel, drag and keys; the sheet follows it softly
    c.manualTarget = THREE.MathUtils.clamp(c.manualTarget || 0, 0, c.manualMax)
    c.manualPos = damp(c.manualPos || 0, c.manualTarget, c.dragging ? 30 : 12, dt)

    // The way out is one smooth eased path, not a chain of targets: up out of the box, then over
    // to you, growing to reading size. The rest of the sheet fades in under the top as it comes.
    const ease = (t) => THREE.MathUtils.smootherstep(t, 0, 1)
    const riseY = startY + boxH * 0.5
    let fade = 1
    if (mode && e < DONE) {
      const a = ease(Math.min(1, e / LIFT))
      const b = ease(Math.max(0, (e - LIFT) / (DONE - LIFT)))
      g.position.set(0, lerp(lerp(startY - 0.35, riseY, a), readTop + c.manualPos, b), lerp(inBox, -dist, b))
      g.rotation.set(lerp(lerp(-0.22, -0.1, a), 0, b), 0, 0)
      g.scale.setScalar(lerp(startScale, 1, b))
      // the rest of the sheet shows once it's mostly in front of the box, not over its art
      fade = ease(Math.max(0, (b - 0.4) / 0.6))
    } else if (mode) {
      // in your hands: it sits where it should, and scrolling moves it
      g.position.x = damp(g.position.x, 0, 14, dt)
      g.position.y = damp(g.position.y, readTop + c.manualPos, snap ? 1e3 : 22, dt)
      g.position.z = damp(g.position.z, -dist, 14, dt)
      g.rotation.x = damp(g.rotation.x, 0, 14, dt)
      g.scale.setScalar(damp(g.scale.x, 1, 14, dt))
    } else {
      // put back: into the box, top first
      g.position.x = damp(g.position.x, 0, 13, dt)
      g.position.y = damp(g.position.y, startY - 0.35, 13, dt)
      g.position.z = damp(g.position.z, inBox, 13, dt)
      g.rotation.x = damp(g.rotation.x, -0.22, 13, dt)
      g.scale.setScalar(damp(g.scale.x, startScale, 13, dt))
      s.fade = damp(s.fade ?? 1, 0, 18, dt)
      fade = s.fade
    }
    if (mode) s.fade = fade
    mats.current.forEach((m, i) => {
      if (!m || i === 0) return
      m.opacity = fade
      m.visible = fade > 0.01
    })
    if (back.current) back.current.visible = fade > 0.99
  })

  // a tap while it's still coming out finishes the intro
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.bookIntro && !c.moved) c.bookSkip = true
  }
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay

  let y = 0
  return (
    <group ref={group} visible={false}>
      {tex?.strips.map((s, i) => {
        const cy = y - s.h / 2
        y -= s.h
        return (
          <mesh key={i} ref={(m) => (strips.current[i] = m)} position={[0, cy, 0]} onClick={onClick} raycast={raycast}>
            <planeGeometry args={[1, s.h]} />
            <meshStandardMaterial
              ref={(m) => (mats.current[i] = m)}
              map={s.tex}
              roughness={0.86}
              metalness={0}
              emissive="#ffffff"
              emissiveMap={s.tex}
              emissiveIntensity={0.34}
              transparent={i > 0}
            />
          </mesh>
        )
      })}
      {/* the back of the sheet, so a glimpse from behind isn't empty */}
      {tex && (
        <mesh ref={back} position={[0, -tex.height / 2, -0.002]} raycast={noRay}>
          <planeGeometry args={[1, tex.height]} />
          <meshStandardMaterial color={paper} roughness={0.9} side={THREE.BackSide} />
        </mesh>
      )}
    </group>
  )
}
