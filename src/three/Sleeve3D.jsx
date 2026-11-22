// The cardboard store sleeve an 8-track came in. The tape slides up out of its open top and is set
// down standing beside it, then the sleeve comes to you and opens out flat like a folder: its inside
// is printed as the service log, both faces across with the folded side between them, one face at a
// time on a phone. Like the other inserts it lives in the camera's own space. It starts out exactly
// where the case's sleeve and tape are, so the case hides both while this one is out, and on the way
// back it ends exactly there again before the case shows its own.
import { tempo } from './pace.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { PAGE } from './covers-booklet.js'
import { kraftTexture } from './covers-8track.js'
import { paperMat } from './Booklet3D.jsx'
import { sleeveTextures, trackLabel } from './printed.js'
import { ObjectButton, useObjectMove } from './ObjectMove.jsx'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp
// a step of the way out, eased, over its own stretch of the whole (0 to 1)
const step = (p, a, b) => THREE.MathUtils.smoothstep(p, a, b)
// one face in scene units, the same shape as the page canvases
const BH = 1
const BW = (BH * PAGE.w) / PAGE.h
// the whole way out and the whole way back, in seconds; the log reads by about 0.4 s
const INTRO = 0.42
const CLOSE = 0.22
const noRay = () => null
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// The 8-track itself, standing on end: the case and the service log both draw it, so the tape that
// comes out of the sleeve is the one you saw in it.
export function TrackTape({ w, h, label }) {
  return (
    <>
      <RoundedBox args={[w, h, 0.19]} radius={0.03} smoothness={3} castShadow>
        <meshPhysicalMaterial color="#1f1c1a" roughness={0.5} clearcoat={0.3} clearcoatRoughness={0.4} />
      </RoundedBox>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, h / 2 - 0.035 - i * 0.03, 0.097]}>
          <boxGeometry args={[w * 0.8, 0.01, 0.01]} />
          <meshStandardMaterial color="#0f0e0d" roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[0, -0.12, 0.097]}>
        <planeGeometry args={[0.78, 0.92]} />
        <meshPhysicalMaterial key={label ? label.uuid : 'blank'} map={label} roughness={0.34} clearcoat={1} clearcoatRoughness={0.14} color={label ? '#ffffff' : '#222'} />
      </mesh>
    </>
  )
}

// height and thick are the case's sleeve in scene units, so this one can sit exactly on it; tape is
// the tape in it ({ w, h, y }: its size and how high it stands)
export default function Sleeve3D({ project, shelf, ctl, mode, page, single, onTurn, onSeek, onObjectMove, onIntroDone, height, thick, tape }) {
  const { size, gl, scene, camera } = useThree()
  const [programFocus, setProgramFocus] = useState(false)
  const press = useRef(0)
  const button = useRef()
  const backPanel = useRef()
  const spineBoard = useRef()
  const move = useMemo(() => ({ key: 'g', active: page === 1,
    label: page ? 'Program 1 · service log' : 'Program 2 · on the bench',
    activate: () => { press.current = performance.now(); setProgramFocus(true); onSeek(page ? 0 : 1) },
  }), [page, onSeek])
  useObjectMove(ctl, mode, onObjectMove, move)
  useEffect(() => { if (mode !== 'open') setProgramFocus(false) }, [mode])
  // the folded side, as wide as the sleeve is thick
  const SP = thick / height
  const geo = useMemo(() => {
    const back = new THREE.PlaneGeometry(BW, BH).translate(BW / 2, 0, 0)
    const spine = new THREE.PlaneGeometry(SP, BH).translate(-SP / 2, 0, 0)
    const front = new THREE.PlaneGeometry(BW, BH).translate(-BW / 2, 0, 0)
    // the front's outside is seen from behind: flip it so it doesn't read mirrored
    const outside = front.clone()
    const uv = outside.attributes.uv.array
    for (let i = 0; i < uv.length; i += 2) uv[i] = 1 - uv[i]
    return { back, spine, front, outside }
  }, [SP])
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo])
  const kraft = kraftTexture()
  const [label, setLabel] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    Promise.resolve(trackLabel(project, shelf)).then((t) => {
      made = t
      if (live) setLabel(t)
    })
    return () => {
      live = false
      if (made) made.dispose()
    }
  }, [project, shelf])
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    // draw the log as soon as the case is open, so it's ready before you ask
    sleeveTextures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const x of [t.cover, ...t.pages]) gl.initTexture(x)
      setTex(t)
    })
    return () => {
      live = false
      if (made) for (const x of [made.cover, ...made.pages]) x.dispose()
    }
  }, [project, shelf, gl])

  // build its shaders while the case is only out, so the tap doesn't wait on them
  useEffect(() => {
    if (!tex || !group.current || !cart.current) return
    const shown = [group.current, cart.current].map((o) => [o, o.visible])
    for (const [o] of shown) o.visible = true
    gl.compile(group.current.parent, camera, scene)
    for (const [o, v] of shown) o.visible = v
  }, [tex, gl, scene, camera])

  // put away with the case still out: give the case its own sleeve and tape back
  useEffect(() => () => void (ctl.current.sleeveOut = false), [ctl])

  const group = useRef()
  const strip = useRef()
  const spine = useRef()
  const front = useRef()
  const cart = useRef()
  const st = useRef({ fold: 0, turn: 0, buttonTravel: 0, mode: null, p: 0, sent: false, f: 1, ox: 0, pace: 1, out: false })

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !strip.current || !cart.current) return
    const c = ctl.current
    const s = st.current
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    const aspect = size.width / size.height
    // keep clear of the header and the buttons (px)
    const top = single ? 58 : 76
    const bottom = single ? 150 : 140
    const fillH = Math.max(0.4, (size.height - top - bottom) / size.height)
    const across = single ? BW / 0.92 : (2 * BW + SP) / 0.9
    const dist = Math.max(BH / (fillH * 2 * tan), across / (2 * tan * aspect))
    const unit = size.height / (2 * tan * dist)
    c.bookPagePx = BW * unit
    const readY = (bottom - top) / 2 / unit

    // a new way out or back: read its pace (the first of its kind this visit is the showcase)
    if (mode !== s.mode) {
      s.returnTape = !mode ? [...cart.current.position.toArray(), cart.current.scale.x] : null
      if (mode === 'intro' || !mode) s.pace = tempo(c, mode ? 2.65 : 2.3)
      if (mode === 'intro') s.sent = false
      if (reduced()) s.p = mode ? 1 : 0
      s.mode = mode
    }
    // the way out waits for the log to be drawn (it usually is by now)
    if (mode && !tex) {
      c.bookIntro = mode === 'intro'
      return
    }
    let snap = false
    if (c.bookSkip || (!mode && c.outroSkip)) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (!mode) { s.p = 0; c.outroSkip = false }
      if (mode === 'intro' && s.p < 1) {
        s.p = 1
        snap = true
      }
    }
    s.p = clamp(s.p + (mode ? dt / (INTRO * s.pace) : -dt / (CLOSE * s.pace)), 0, 1)
    const p = s.p
    c.bookIntro = mode === 'intro' && p < 1
    c.bookOutro = !mode && p > 0
    if (mode === 'intro' && p >= 1 && !s.sent) {
      s.sent = true
      onIntroDone()
    }
    // all the way back in: the case shows its own sleeve and tape on the next frame, and this one
    // hides then, so there's never a frame with neither
    if (!mode && p <= 0) {
      if (c.sleeveOut) c.sleeveOut = false
      else g.visible = cart.current.visible = false
      return
    }
    g.visible = cart.current.visible = true
    c.sleeveOut = true

    // The stage: the case, from your eye, eases back just enough that the tape can clear the
    // sleeve's top and then stand beside it, all in view (a phone needs the room across, a wide
    // screen the room up and down). Only its distance changes, so the whole stage just gets a little
    // smaller.
    const d0 = c.cartDist || 4
    const halfH = tan * d0
    const W = BW * height
    const clearY = height / 2 + 0.03 + tape.h / 2
    const K = clamp(Math.max((height + tape.h + 0.03) / (0.88 * 2 * halfH), (W + tape.w) / (0.94 * 2 * halfH * aspect)), 1, 1.5)
    // the pair, centred: the sleeve drops so the tape has room above it, then both share the width
    const drop = (clearY + tape.h / 2 - height / 2) / 2
    const sideS = -(tape.w * 0.92) / 2
    const sideT = W / 2 + tape.w / 2 - tape.w * 0.08 + sideS

    // Ease the grip free, lift clear, carry sideways, then place it down. The pause between
    // placement (.57) and the sleeve's approach (.65) lets the tape have its own moment.
    const a = step(p, 0, 0.3)
    const rise = 0.055 * step(p, 0, 0.07) + 0.945 * step(p, 0.1, 0.31)
    const over = step(p, 0.36, 0.49)
    const down = step(p, 0.46, 0.57)
    // Start the paper's approach as the tape is being set down, not after an empty wait.
    const trav = step(p, c.show ? 0.51 : 0.40, c.show ? 0.84 : 0.70)
    const open = step(p, c.show ? 0.57 : 0.46, c.show ? 0.88 : 0.76)
    const k = lerp(1, K, a)
    // and once the sleeve is on its way to you, the pair left behind settles back to the middle, so
    // the tape stands behind the open log rather than peeking out under it
    const sy = -drop * (a - step(p, 0.66, 0.95))
    const sx = sideS * over

    // the tape: straight up out of the open top, then a little toward you (so it clears the
    // sleeve's face), over and down to stand beside it, bottoms level
    const ty = sy + lerp(lerp(tape.y, clearY, rise), tape.h / 2 - height / 2, down)
    cart.current.position.set(lerp(0, sideT, over), ty, -k * d0 + 0.3 * over)
    cart.current.rotation.set(0, -0.12 * over, 0)
    // Once the card reads, bring the cartridge's selector into reach above it.
    const ready = mode === 'open'
    const settleTape = ready ? step(p, 0.95, 1) : 0
    const px = 2 * tan / size.height
    if (!settleTape) {
      s.tx = cart.current.position.x; s.ty = cart.current.position.y; s.tz = cart.current.position.z; s.ts = 1
      if (!mode && s.returnTape) {
        // Rejoin the existing return path from the selector's actual pose, never teleport.
        const back = c.reduced ? 1 : step(1 - p, 0, 1)
        const [x, y, z, scale] = s.returnTape
        cart.current.position.set(lerp(x, s.tx, back), lerp(y, s.ty, back), lerp(z, s.tz, back))
        s.ts = lerp(scale, 1, back)
      }
    } else {
      const x = (size.width * (single ? (page ? 0.9 : 0.52) : 0.88) - size.width / 2) * px
      const y = (size.height / 2 - (single ? (page ? 160 : 88) : 126)) * px
      const scale = (single ? 70 : 136) * px / tape.h
      const k = c.reduced ? 1e4 : 12
      s.tx = damp(s.tx ?? x, x, k, dt); s.ty = damp(s.ty ?? y, y, k, dt)
      s.tz = damp(s.tz ?? -1, -1, k, dt); s.ts = damp(s.ts ?? scale, scale, k, dt)
      cart.current.position.set(s.tx, s.ty, s.tz)
      cart.current.rotation.y = -0.1
    }
    cart.current.scale.setScalar(s.ts)
    if (button.current) {
      const elapsed = (performance.now() - press.current) / 1000
      const travel = c.reduced || elapsed > 0.24 ? 0 : elapsed < 0.06 ? elapsed / 0.06 : 1 - step(elapsed, 0.06, 0.24)
      button.current.position.z = 0.112 - travel * 0.024
    }

    // the sleeve: where it stands on the stage, shut, then on its way to you and opening out
    const fromY = sy
    const fromZ = -k * d0 - thick / 2
    // centred on both faces, or on the one you're reading on a phone; a drag pulls it along
    const drag = mode === 'open' && c.bookDrag != null ? c.bookDrag / Math.max(1, c.bookPagePx) : 0
    s.fold = c.reduced ? (programFocus ? 1 : 0) : damp(s.fold, programFocus ? 1 : 0, 10, dt)
    const ox = (single ? (page ? BW / 2 : -SP - BW / 2) : -SP / 2) - drag * BW * 0.4
    if (snap || p < 1) s.ox = ox
    else s.ox = c.reduced ? ox : damp(s.ox, ox, drag ? 26 : 10, dt)
    g.position.set(lerp(sx, 0, trav), lerp(fromY, readY, trav), lerp(fromZ, -dist, trav))
    const targetTurn = programFocus ? -page * Math.PI : 0
    s.turn = c.reduced ? targetTurn : damp(s.turn, targetTurn, 9, dt)
    g.rotation.set(0, Math.sin(Math.PI * trav) * 0.2 + s.turn, 0)
    g.scale.setScalar(lerp(height, 1, trav))
    s.f = 1 - open

    // shut, the front lies over the back with the folded side between them; open, all flat
    spine.current.rotation.y = (s.f * Math.PI) / 2
    front.current.rotation.y = (s.f * Math.PI) / 2
    strip.current.position.x = lerp(-lerp(s.ox, BW / 2, s.f), SP + BW / 2, s.fold)
    // Fold the second face behind the first, then turn the whole service card. Both
    // printed faces remain the original service log, with no duplicate content path.
    if (spineBoard.current) spineBoard.current.visible = s.fold < 0.98
    if (backPanel.current) {
      backPanel.current.rotation.y = Math.PI * s.fold
      backPanel.current.position.set(-SP * s.fold, 0, -0.006 * s.fold)
    }
  })

  // on a phone, tap the right or left side of the face to go to the other one
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.moved) return
    if (c.bookIntro) {
      c.bookSkip = true
      return
    }
    if (!single) return
    const x = strip.current.worldToLocal(e.point.clone()).x
    const mid = programFocus ? -SP - BW / 2 : page ? BW / 2 : -SP - BW / 2
    // The folded card's back is mirrored in local space, not in the reader's hands.
    const fromMid = (x - mid) * (programFocus && page ? -1 : 1)
    if (fromMid > BW * 0.15) onTurn(1)
    else if (fromMid < -BW * 0.15) onTurn(-1)
  }

  // a put-away sleeve must not catch clicks meant for the backdrop
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay
  const board = <meshStandardMaterial map={kraft} roughness={0.95} side={THREE.DoubleSide} />
  return (
    <>
      <group ref={cart} visible={false}>
        <TrackTape w={tape.w} h={tape.h} label={label} />
        {mode === 'open' && <group ref={button} position={[0, tape.h / 2 - 0.27, 0.112]}>
          <mesh><boxGeometry args={[0.55, 0.19, 0.025]} /><meshStandardMaterial color="#82765c" metalness={0.65} roughness={0.26} /></mesh>
          <ObjectButton move={move} position={[0, 0, 0.025]} kind="program"><i className="program-light" />PROGRAM {page + 1}</ObjectButton>
        </group>}
      </group>
      <group ref={group} visible={false}>
        <group ref={strip}>
          <group ref={backPanel}>
          <mesh geometry={geo.back} onClick={onClick} raycast={raycast}>
            {paperMat(tex?.pages[1], THREE.FrontSide)}
          </mesh>
          <mesh geometry={geo.back} raycast={noRay}>
            <meshStandardMaterial map={kraft} roughness={0.95} side={THREE.BackSide} />
          </mesh>
          </group>
          <group ref={spine}>
            <mesh ref={spineBoard} geometry={geo.spine} onClick={onClick} raycast={raycast}>
              {board}
            </mesh>
            <group ref={front} position={[-SP, 0, 0]}>
              <mesh geometry={geo.front} onClick={onClick} raycast={raycast}>
                {paperMat(tex?.pages[0], THREE.FrontSide)}
              </mesh>
              {/* the outside matches the case's own sleeve, so swapping one for the other doesn't show */}
              <mesh geometry={geo.outside} raycast={noRay}>
                <meshStandardMaterial key={tex?.cover ? tex.cover.uuid : 'blank'} map={tex?.cover} roughness={0.8} side={THREE.BackSide} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </>
  )
}
