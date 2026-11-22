import { continueShelfMotion } from './motion-wake.js'
// The wall: one shelf per aisle, stacked top to bottom. On the active shelf the item in the
// middle slides halfway out; the open one floats in front of the camera and turns under your finger.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera, RoundedBox } from '@react-three/drei'
import StudioEnvironment from './StudioEnvironment.jsx'
import * as THREE from 'three'
import { createShadowTracker } from './shadow-updates.js'
import { syncDrawingBuffer } from './drawing-buffer.js'
import { kraftTexture } from './covers-8track.js'
import Booklet3D, { paperMat, tempo } from './Booklet3D.jsx'
import { spring } from './pace.js'
import Leaflet3D from './Leaflet3D.jsx'
import Sleeve3D, { TrackTape } from './Sleeve3D.jsx'
import Manual3D from './Manual3D.jsx'
import { BOX, CARD } from './covers-pcbox.js'
import { lidPose } from './manual-box.js'
import { LD } from './covers-laserdisc.js'
import Gatefold3D from './Gatefold3D.jsx'
import { FC } from './covers-filmcan.js'
import FilmStrip3D from './FilmStrip3D.jsx'
import { FL, SHUTTER } from './covers-floppy.js'
import Printout3D from './Printout3D.jsx'
import { CS, jcardPlan } from './covers-cassette.js'
import { PAGE } from './covers-booklet.js'
import { LP, DISC, PEEK } from './covers-vinyl.js'
import Record3D from './Record3D.jsx'
import { vhsBack, vhsFront, vhsSpine, signTexture, woodTexture, cartBack, cartFront, cartTop, tapeFace, trackBack, trackFront, trackLabel, pcFront, pcBack, pcSide, pcLidTop, ldFront, ldBack, canFront, canBack, canBand, floppyFront, floppyBack, cassetteFront, cassetteBack, cassetteSpine, tapeShell, jcardTextures, lpFront, lpBack, recordFace, recordSheen, setPrintFocus, setPrintRenderer, prefetchPrinted, updatePrintedMaterials, setPrintView, printedMemory } from './printed.js'

const FOV = 32
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
const damp = THREE.MathUtils.damp
// eye height of someone standing at the shelf, looking slightly down at it
const CAM_Y = 0.8
const LOOK_Y = -0.3
// every shelf's items stand on the same baseline; shelves stack ROW_H apart
const BASE = -1.025
export const ROW_H = 3.6

// VHS clamshell, in scene units (1 unit = 100 mm)
const T = 0.32
const H = 2.05
const D = 1.15
// the clamshell's front cover, which swings open on the spine like a book; the walls of the tray
const LID = 0.035
const WALL = 0.03
const TRAY = T - LID - WALL
// the tape lying in the tray, thin enough that the folded leaflet fits on top of it
const TAPE_T = 0.17
// cartridge (bigger than life so the label reads)
const CW = 1.05
const CH = 1.25
const CD = 0.2

// 8-track in its cardboard store sleeve (bigger than life too): the tape stands on its end inside
// and shows over the sleeve's open top
const SW = 1.0
const SH = 1.4
const ST = 0.24
const TW = 0.92
const TH = 1.2
const TAPE_Y = SH / 2 + 0.08 - TH / 2
const TAPE = { w: TW, h: TH, y: TAPE_Y }

// How each kind of media sits on the shelf, slides out, and faces you when open.
export const MEDIA = {
  vhs: { spacing: T + 0.05, span: 6.5, face: [D, H], openRy: -Math.PI / 2, height: H },
  cartridge: { spacing: CW + 0.26, span: 2.1, face: [CW, CH], openRy: 0, height: CH },
  '8track': { spacing: SW + 0.3, span: 2.1, face: [SW, SH], openRy: 0, height: SH + 0.08 },
  pcbox: { spacing: BOX.w + 0.32, span: 2.1, face: [BOX.w, BOX.h], openRy: 0, height: BOX.h },
  laserdisc: { spacing: LD.s + 0.3, span: 2.1, face: [LD.s, LD.s], openRy: 0, height: LD.s },
  filmcan: { spacing: FC.r * 2 + 0.3, span: 2.1, face: [FC.r * 2, FC.r * 2], openRy: 0, height: FC.r * 2 },
  floppy: { spacing: FL.w + 0.26, span: 2.1, face: [FL.w, FL.h], openRy: 0, height: FL.h },
  cassette: { spacing: CS.w + 0.28, span: 2.1, face: [CS.w, CS.h], openRy: 0, height: CS.h },
  // a little wider than the jacket when open, for the record peeking out of its side
  vinyl: { spacing: LP.s + 0.36, span: 2.1, face: [LP.s * 1.12, LP.s], openRy: 0, height: LP.s },
}

const MEDIA_DEPTH = { vhs: D, cartridge: CD, '8track': ST, pcbox: BOX.d, laserdisc: LD.t, filmcan: FC.t, floppy: FL.t, cassette: CS.t, vinyl: LP.t }

export function cameraZ(media, aspect) {
  const m = MEDIA[media]
  return Math.max(7.4, (m.spacing * m.span) / (2 * TAN * aspect))
}

// the case next to this one along the wall: along its shelf, then on to the first case of the shelf
// below (or back to the last of the shelf above); null past either end of the wall
export function neighbour(rows, o, d) {
  const i = o.index + d
  if (i >= 0 && i < rows[o.row].projects.length) return { row: o.row, index: i }
  const r = o.row + Math.sign(d)
  if (r < 0 || r >= rows.length) return null
  return { row: r, index: d > 0 ? 0 : rows[r].projects.length - 1 }
}
const easeOut = (u) => 1 - (1 - u) ** 3
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2)
// how far along a step to the next case is: 0 while the insert folds back, 1 at its end state
const stepAt = (c, st) => (st.skip || c.reduced ? 1 : st.swapped ? THREE.MathUtils.clamp((performance.now() - st.caseAt) / Math.max(1, st.dur), 0, 1) : 0)

function openDistance(media, aspect, spinY = 0) {
  const [w, h] = MEDIA[media].face
  const phoneLP = media === 'vinyl' && aspect < 0.75
  const frontWidth = phoneLP ? (w / 1.12) * 1.08 : w * 1.2
  const front = Math.max(h / (0.72 * 2 * TAN), frontWidth / ((phoneLP ? 0.92 : 0.84) * 2 * TAN * aspect))
  // On a portrait phone, bring the printed back close enough to read. Blend with its turn, not a
  // new animation clock; the front and every desktop pose keep their existing distance.
  const back = aspect < 0.75 ? THREE.MathUtils.smoothstep(-Math.cos(spinY), 0.2, 1) : 0
  const backWidth = media === 'vinyl' ? w / 1.12 : w // no space needed for the record's front-side peek
  const reading = Math.max(h / (0.68 * 2 * TAN), backWidth / (0.94 * 2 * TAN * aspect))
  return THREE.MathUtils.lerp(front, reading, back)
}

// Shared motion: on the shelf, pulled halfway, or open in your hands.
function useCaseMotion(ref, { row, index, media, ctl, open, rest, pulled }) {
  const { size } = useThree()
  const putAt = useRef(0)
  const from = useRef(null)
  const invitation = useRef({ amount: 0, velocity: 0 })
  const supportMatrix = useRef(new THREE.Matrix4())
  const resting = useRef({ pose: new Float64Array(7), quiet: 0 })
  const travel = useRef({ open: false, move: null, swallow: false })
  useEffect(() => {
    const skip = (e) => {
      const a = travel.current
      if (e.type === 'pointerdown') a.swallow = false
      if (!a.move || ctl.current.step) return
      a.move.skip = true
      if (e.type === 'pointerdown') {
        // Let a drag take over immediately; consume only the resulting tap on the stage.
        a.swallow = e.target.tagName === 'CANVAS'
      } else if (!['n', 'p', 'f'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    const click = (e) => {
      if (!travel.current.swallow) return
      travel.current.swallow = false
      if (e.target.tagName === 'CANVAS' && !ctl.current.moved) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('pointerdown', skip, true)
    window.addEventListener('keydown', skip, true)
    window.addEventListener('click', click, true)
    return () => {
      window.removeEventListener('pointerdown', skip, true)
      window.removeEventListener('keydown', skip, true)
      window.removeEventListener('click', click, true)
    }
  }, [ctl])
  useFrame((state, dt) => {
    const g = ref.current
    if (!g) return
    const c = ctl.current
    const m = MEDIA[media]
    const rowY = -row * ROW_H
    // A new VHS waits in its slot while the previously focused neighbour squares up.
    // Two wide faces cannot occupy the same narrow spine spacing at the same depth.
    if (media === 'vhs') {
      c.vhsPoses ??= {}
      c.vhsPoses[row] ??= []
      c.vhsPoses[row][index] = g
    }
    const waitForNeighbour = media === 'vhs' && Math.abs(g.rotation.y) < 0.03 &&
      (Math.abs(c.vhsPoses[row][index - 1]?.rotation.y || 0) >= 0.03 || Math.abs(c.vhsPoses[row][index + 1]?.rotation.y || 0) >= 0.03)
    const isOpen = open && open.row === row && open.index === index
    // Keep both sides of a neighbour hand-off, and a returning case, outside the veil.
    // This is ownership, not a z threshold: every media kind has a different depth/tilt.
    c.heldCases ??= new Set()
    const steppingOut = c.step?.from.row === row && c.step?.from.index === index
    if (isOpen || travel.current.open || travel.current.move || steppingOut) c.heldCases.add(g)
    else c.heldCases.delete(g)
    // Far-away, settled cases need neither damping nor repeated support/collision
    // math. Any target/input change wakes the case; showcase travel and handoffs
    // always run. Compare accumulated poses, including tiny spring tails.
    const r = resting.current
    const active = !open && !c.shelfRest && Math.round(c.row) === row
    const offset = active ? c.rows[row].offset : 0
    const wantedNow = !open && !c.dragging && c.inviteRow === row && c.inviteIndex === index ? c.inviteAmount : 0
    const same = r.active === active && r.offset === offset && r.open === !!open && r.wanted === wantedNow && r.blocked === waitForNeighbour && r.reduced === c.reduced
    const pose = r.pose
    const still = Math.abs(pose[0] - g.position.x) < 1e-8 && Math.abs(pose[1] - g.position.y) < 1e-8 && Math.abs(pose[2] - g.position.z) < 1e-8 && Math.abs(pose[3] - g.rotation.x) < 1e-8 && Math.abs(pose[4] - g.rotation.y) < 1e-8 && Math.abs(pose[5] - g.rotation.z) < 1e-8 && Math.abs(pose[6] - g.scale.x) < 1e-8
    if (!still) {
      pose[0] = g.position.x; pose[1] = g.position.y; pose[2] = g.position.z
      pose[3] = g.rotation.x; pose[4] = g.rotation.y; pose[5] = g.rotation.z; pose[6] = g.scale.x
    }
    r.quiet = same && still ? r.quiet + 1 : 0
    r.active = active; r.offset = offset; r.open = !!open; r.wanted = wantedNow; r.blocked = waitForNeighbour; r.reduced = c.reduced
    if (!isOpen && !travel.current.move && !c.step && r.quiet >= 12 && Math.abs(invitation.current.velocity) < 1e-6 && Math.abs(invitation.current.amount - (wantedNow || 0)) < 1e-6) return
    let t = { x: index * m.spacing, y: rowY + rest.y, z: rest.z, rx: rest.rx, ry: 0, rz: 0, s: 1 }
    if (isOpen) {
      const aspect = size.width / size.height
      const openZ = c.camZ - openDistance(media, aspect, c.spinY)
      const camY = rowY + CAM_Y
      const openY = camY + (rowY + LOOK_Y - camY) * ((c.camZ - openZ) / c.camZ)
      t = { x: c.camX, y: openY, z: openZ, ry: m.openRy + c.spinY, rx: c.spinX - Math.atan2(camY - openY, c.camZ - openZ), rz: 0, s: 1 }
    } else if (active) {
      const d = Math.abs(index - c.rows[row].offset)
      const p = THREE.MathUtils.smoothstep(1 - d * 1.35, 0, 1)
      t = pulled(t, waitForNeighbour ? 0 : p, Math.sign(index - c.rows[row].offset), d)
    }
    // A small, bottom-edge invitation, separate from pulling a case into your hands. The spring
    // has weight without bouncing; one case gets attention and the previous one settles home.
    const invite = invitation.current
    const wanted = !open && !c.dragging && c.inviteRow === row && c.inviteIndex === index ? c.inviteAmount : 0
    if (c.reduced || open) {
      invite.amount = invite.velocity = 0
    } else {
      invite.amount = spring(invite, 'velocity', invite.amount, wanted || 0, 8, dt)
      if (Math.abs(invite.amount - (wanted || 0)) < 0.0001 && Math.abs(invite.velocity) < 0.001) {
        invite.amount = wanted || 0
        invite.velocity = 0
      }
    }
    const lean = invite.amount * 0.045 // 2.6 degrees; no sideways travel toward neighbouring cases
    const depth = MEDIA_DEPTH[media]
    // Rotate about the bottom FRONT edge, not the middle of the bottom. A deep VHS
    // needs the depth*sin(angle) lift: omitting it sweeps its front edge through the board.
    t.rx -= lean
    t.z += invite.amount * 0.035 + Math.sin(lean) * m.height * t.s / 2
    t.y += Math.sin(lean) * depth * t.s / 2 - (1 - Math.cos(lean)) * m.height * t.s / 2 + invite.amount * 0.025
    // a step to the neighbour: this case goes home, or comes out to you, on the step's own clock
    const st = c.step
    if (st && st.swapped && (isOpen ? st.to.row === row && st.to.index === index : st.from.row === row && st.from.index === index)) {
      // Steps own their clock and do not spend a kind's first deliberate pull/return.
      travel.current.open = !!isOpen
      travel.current.move = null
      const id = st.id + (isOpen ? 'in' : 'out')
      if (from.current?.id !== id) {
        const ry = isOpen ? g.rotation.y : t.ry + THREE.MathUtils.euclideanModulo(g.rotation.y - t.ry + Math.PI, Math.PI * 2) - Math.PI
        from.current = { id, x: g.position.x, y: g.position.y, z: g.position.z, rx: g.rotation.x, ry, rz: g.rotation.z, s: g.scale.x }
      }
      const f = from.current
      const u = stepAt(c, st)
      const v = isOpen ? easeOut(THREE.MathUtils.clamp((u - 0.1) / 0.9, 0, 1)) : easeInOut(THREE.MathUtils.clamp(u / 0.75, 0, 1))
      const L = THREE.MathUtils.lerp
      g.position.set(L(f.x, t.x, v), L(f.y, t.y, v), L(f.z, t.z, v))
      g.rotation.set(L(f.rx, t.rx, v), L(f.ry, t.ry, v), L(f.rz, t.rz, v))
      g.scale.setScalar(L(f.s, t.s, v))
      if (isOpen) putAt.current = state.clock.elapsedTime + 0.6
      return
    }
    const a = travel.current
    if (a.open !== !!isOpen) {
      a.open = !!isOpen
      // One registry per visit, independent of the inserts. The live Set remains authoritative
      // when storage is blocked; malformed or unavailable storage must never break a pull.
      if (!c.caseSeen) {
        c.caseSeen = new Set()
        try {
          const saved = JSON.parse(sessionStorage.getItem('shelf:cases-seen') || '[]')
          if (Array.isArray(saved)) c.caseSeen = new Set(saved.filter((v) => typeof v === 'string'))
        } catch { /* private browsing / blocked storage: keep the in-memory registry */ }
      }
      const key = `${media}:${isOpen ? 'pull' : 'return'}`
      const show = !c.caseSeen.has(key)
      c.caseSeen.add(key)
      try { sessionStorage.setItem('shelf:cases-seen', JSON.stringify([...c.caseSeen])) } catch { /* in-memory fallback */ }
      const ry = isOpen ? g.rotation.y : t.ry + THREE.MathUtils.euclideanModulo(g.rotation.y - t.ry + Math.PI, Math.PI * 2) - Math.PI
      a.move = { at: performance.now(), duration: isOpen ? (show ? 1300 : 620) : (show ? 625 : 350), show,
        f: { x: g.position.x, y: g.position.y, z: g.position.z, rx: g.rotation.x, ry, rz: g.rotation.z, s: g.scale.x } }
    }
    if (a.move) {
      const { f, at, duration, skip } = a.move
      const u = c.reduced || skip ? 1 : THREE.MathUtils.clamp((performance.now() - at) / duration, 0, 1)
      const beat = (start, end) => easeInOut(THREE.MathUtils.clamp((u - start) / (end - start), 0, 1))
      const L = THREE.MathUtils.lerp
      // Free the bottom edge, draw the weight forward, then present the face. The return
      // squares up first, slides into the slot, and sets down once: no spring or rebound.
      const slide = isOpen ? beat(0.09, 0.85) : beat(0.08, 0.92)
      const turn = isOpen ? beat(0.23, 0.94) : beat(0, 0.64)
      const lift = isOpen ? beat(0, 0.22) * (1 - beat(0.55, 1)) : beat(0, 0.18) * (1 - beat(0.78, 1))
      const tilt = isOpen ? beat(0, 0.2) * (1 - beat(0.32, 0.9)) : 0
      g.position.set(L(f.x, t.x, slide), L(f.y, t.y, slide) + lift * 0.065, L(f.z, t.z, slide))
      g.rotation.set(L(f.rx, t.rx, turn) - tilt * 0.055, L(f.ry, t.ry, turn), L(f.rz, t.rz, turn) + tilt * 0.018)
      g.scale.setScalar(L(f.s, t.s, slide))
      if (u === 1) a.move = null
      return
    }
    // just put back, it goes onto the shelf quicker than cases slide along it
    if (isOpen) putAt.current = state.clock.elapsedTime + 0.6
    const k = isOpen ? 7 : state.clock.elapsedTime < putAt.current ? 13 : 9
    // put back turned over (or turned right round), a case goes the short way to its front, and is
    // facing front before it lands
    if (!isOpen) g.rotation.y = t.ry + THREE.MathUtils.euclideanModulo(g.rotation.y - t.ry + Math.PI, Math.PI * 2) - Math.PI
    g.position.x = damp(g.position.x, t.x, k, dt)
    g.position.y = damp(g.position.y, t.y, k, dt)
    g.position.z = damp(g.position.z, t.z, k, dt)
    g.rotation.x = damp(g.rotation.x, t.rx, k, dt)
    const shelfYaw = media === 'vhs' && !open ? t.ry * THREE.MathUtils.smoothstep(g.position.z, 1.3, 1.36) : t.ry
    g.rotation.y = damp(g.rotation.y, shelfYaw, isOpen ? k : 18, dt)
    g.rotation.z = damp(g.rotation.z, t.rz, 8, dt)
    g.scale.setScalar(damp(g.scale.x, t.s, k, dt))
    if (!open && !a.move) {
      // Slide first, then turn; on return, straighten before entering the row.
      if (media === 'vhs') g.position.z = Math.max(g.position.z, 1.3 * THREE.MathUtils.smoothstep(Math.abs(g.rotation.y), 0.015, 0.03))
      // Keep the actual interpolated pose clear too. Scaling, the VHS yaw and its
      // neighbours' roll all change the bottom corner; checking only height/2 is wrong.
      const e = supportMatrix.current.makeRotationFromEuler(g.rotation).elements
      const hx = (media === 'vhs' ? T : media === 'vinyl' ? LP.s : m.face[0]) * g.scale.x / 2
      const hy = m.height * g.scale.x / 2
      const hz = depth * g.scale.x / 2
      const bottom = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz
      const reach = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz
      // The board's front trim is taller than its deck; rack media have a second low lip.
      // Ramp the lift BEFORE either lip, not abruptly when the corner reaches it.
      const front = g.position.z + reach
      const trim = THREE.MathUtils.smoothstep(front, 0.62, 0.78) * 0.12
      const rack = media !== 'vhs' && media !== 'pcbox' ? THREE.MathUtils.smoothstep(front, 0.28, 0.39) * 0.11 : 0
      g.position.y = Math.max(g.position.y, rowY + BASE + bottom + 0.012 + Math.max(trim, rack))
      g.position.z = Math.max(g.position.z, -0.8 + reach)
    }
  })
}

// Before the manifest arrives, neutral label/card stock, never a solid shelf-colour block.
// Once it arrives, printed.js supplies grain, faint rules and the per-media ink-in.
const Tint = createContext('#e2d8c0')
function CoverMat({ map }) {
  const tint = useContext(Tint)
  return <meshPhysicalMaterial map={map} roughness={map ? 0.34 : 0.78} clearcoat={map ? 1 : 0.1} clearcoatRoughness={0.14} color={map ? '#ffffff' : tint} />
}
// keyed on the texture: a material first compiled without a map won't pick one up later
const coverMat = (map) => <CoverMat key={map ? map.uuid : 'blank'} map={map} />

function useTextures(make, deps) {
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    // the printed surfaces come back as promises (src/three/printed.js): wait for every one
    make()
      .then(async (t) => Object.fromEntries(await Promise.all(Object.entries(t).map(async ([k, v]) => [k, await v]))))
      .then((t) => live && setTex(t))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return tex
}

function pickHandler(ctl, onPick, row, index) {
  return (e) => {
    e.stopPropagation()
    if (!ctl.current.moved) onPick(row, index)
  }
}

function VhsCase({ project, shelf, row, index, ctl, open, onPick, lid }) {
  const ref = useRef()
  const hinge = useRef()
  const shutAt = useRef(0)
  const swing = useRef({})
  const tex = useTextures(async () => {
    const [front, back] = await Promise.all([vhsFront(project, shelf), vhsBack(project, shelf)])
    return { front, back, spine: vhsSpine(project, shelf), tape: tapeFace(project, shelf) }
  }, [project, shelf])
  useCaseMotion(ref, {
    row, index, media: 'vhs', ctl, open,
    rest: { y: 0, z: 0, rx: 0 },
    pulled: (t, p) => ({
      ...t,
      // A spine-out VHS is 115 mm deep. Clear that depth before exposing its face;
      // the old 62 mm slide yawed the back corner through the next tape.
      z: p * 1.36,
      y: t.y + p * 0.03,
      ry: -p * 0.62,
      s: 1 + p * 0.05,
      // The 5 mm spine gaps cannot also accommodate a sideways roll.
      rz: 0,
    }),
  })
  // the lid opens while the leaflet is out, and snaps shut as it's tucked back in (at once, if a tap
  // put the leaflet away)
  useFrame((state, dt) => {
    const h = hinge.current
    if (!h) return
    const c = ctl.current
    const now = state.clock.elapsedTime
    if (lid) shutAt.current = now + 0.1 * tempo(c)
    if (c.outroSkip && !lid && open?.row === row && open?.index === index) {
      c.outroSkip = false
      shutAt.current = 0
      h.rotation.y = 0
    }
    // in the showcase the lid swings open with its weight: slow off the catch, laid back softly
    if (lid && c.show && !c.reduced) h.rotation.y = spring(swing.current, 'r', h.rotation.y, -2.45, 11, dt)
    else {
      swing.current.r = 0
      h.rotation.y = damp(h.rotation.y, lid || now < shutAt.current ? -2.45 : 0, (lid ? 30 : 48) / tempo(c), dt)
    }
  })
  const black = <meshPhysicalMaterial color="#0b0b0c" roughness={0.42} clearcoat={0.6} clearcoatRoughness={0.3} />
  const wallX = -T / 2 + WALL + TRAY / 2
  return (
    <group ref={ref} position={[index * MEDIA.vhs.spacing, -row * ROW_H, 0]} onClick={pickHandler(ctl, onPick, row, index)}>
      {/* the tray: back, four walls, and the tape lying in it */}
      <RoundedBox args={[WALL, H, D]} radius={0.012} smoothness={3} position={[-T / 2 + WALL / 2, 0, 0]} castShadow receiveShadow>
        {black}
      </RoundedBox>
      {[H / 2 - WALL / 2, -H / 2 + WALL / 2].map((y) => (
        <mesh key={y} position={[wallX, y, 0]}>
          <boxGeometry args={[TRAY, WALL, D]} />
          {black}
        </mesh>
      ))}
      {[D / 2 - WALL / 2, -D / 2 + WALL / 2].map((z) => (
        <mesh key={z} position={[wallX, 0, z]} castShadow>
          <boxGeometry args={[TRAY, H, WALL]} />
          {black}
        </mesh>
      ))}
      <RoundedBox args={[TAPE_T, 1.87, 1.03]} radius={0.015} smoothness={3} position={[-T / 2 + WALL + TAPE_T / 2, 0, 0]}>
        <meshStandardMaterial color="#141415" roughness={0.55} />
      </RoundedBox>
      <mesh position={[-T / 2 + WALL + TAPE_T + 0.002, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.0, 1.84]} />
        {coverMat(tex?.tape)}
      </mesh>
      <mesh position={[-T / 2 - 0.002, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[D - 0.05, H - 0.05]} />
        {coverMat(tex?.back)}
      </mesh>
      <mesh position={[0, 0, D / 2 + 0.002]}>
        <planeGeometry args={[T - 0.04, H - 0.05]} />
        {coverMat(tex?.spine)}
      </mesh>
      {/* the lid, hinged along the front edge of the spine */}
      <group ref={hinge} position={[T / 2, 0, D / 2]}>
        <RoundedBox args={[LID, H, D]} radius={0.012} smoothness={3} position={[-LID / 2, 0, -D / 2]} castShadow receiveShadow>
          {black}
        </RoundedBox>
        <mesh position={[0.002, 0, -D / 2]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[D - 0.05, H - 0.05]} />
          {coverMat(tex?.front)}
        </mesh>
      </group>
    </group>
  )
}

function Cartridge({ project, shelf, row, index, ctl, open, onPick }) {
  const ref = useRef()
  const shell = (project.palette && project.palette.shell) || '#2c2e33'
  const tex = useTextures(async () => {
    const [front, back] = await Promise.all([cartFront(project, shelf), cartBack(project, shelf)])
    return { front, back, top: cartTop(project, shelf) }
  }, [project, shelf])
  // standing in a rack, leaning back a little
  const restY = BASE + CH / 2 - 0.02
  useCaseMotion(ref, {
    row, index, media: 'cartridge', ctl, open,
    rest: { y: restY, z: 0.1, rx: -0.14 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.75, y: t.y + p * 0.22, rx: t.rx + p * 0.16, s: 1 + p * 0.06 }),
  })
  return (
    <group ref={ref} position={[index * MEDIA.cartridge.spacing, -row * ROW_H + restY, 0.1]} onClick={pickHandler(ctl, onPick, row, index)}>
      <RoundedBox args={[CW, CH, CD]} radius={0.05} smoothness={4} castShadow receiveShadow>
        <meshPhysicalMaterial color={shell} roughness={0.55} clearcoat={0.25} clearcoatRoughness={0.5} />
      </RoundedBox>
      {/* grip ridges across the top */}
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} position={[0, CH / 2 - 0.07 - i * 0.035, CD / 2 + 0.004]}>
          <boxGeometry args={[CW * 0.82, 0.012, 0.012]} />
          <meshStandardMaterial color="#1a1b1e" roughness={0.6} />
        </mesh>
      ))}
      {/* the label, set into a shallow recess */}
      <mesh position={[0, -0.12, CD / 2 + 0.003]}>
        <planeGeometry args={[0.86, 0.823]} />
        {coverMat(tex?.front)}
      </mesh>
      <mesh position={[0, -0.02, -CD / 2 - 0.003]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[0.86, 0.99]} />
        {coverMat(tex?.back)}
      </mesh>
      <mesh position={[0, CH / 2 + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CW * 0.86, CD * 0.7]} />
        {coverMat(tex?.top)}
      </mesh>
      {/* contacts peeking out the bottom */}
      <mesh position={[0, -CH / 2 + 0.03, 0]}>
        <boxGeometry args={[CW * 0.7, 0.05, CD * 0.55]} />
        <meshStandardMaterial color="#b58d3a" metalness={0.85} roughness={0.3} />
      </mesh>
    </group>
  )
}

function TrackCase({ project, shelf, row, index, ctl, open, onPick }) {
  const ref = useRef()
  const held = useRef()
  const tex = useTextures(async () => {
    const [front, back] = await Promise.all([trackFront(project, shelf), trackBack(project, shelf)])
    return { front, back, label: await trackLabel(project, shelf) }
  }, [project, shelf])
  const restY = BASE + SH / 2 - 0.02
  useCaseMotion(ref, {
    row, index, media: '8track', ctl, open,
    rest: { y: restY, z: 0.1, rx: -0.12 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.75, y: t.y + p * 0.2, rx: t.rx + p * 0.14, s: 1 + p * 0.06 }),
  })
  // While the service log is out, its own sleeve and tape stand exactly where these were and do the
  // moving, so the case hides both; they're back in place before it shows them again.
  useFrame(() => {
    const isOpen = open && open.row === row && open.index === index
    if (held.current) held.current.visible = !(isOpen && ctl.current.sleeveOut)
  })
  const board = <meshStandardMaterial map={kraftTexture()} roughness={0.95} />
  return (
    <group ref={ref} position={[index * MEDIA['8track'].spacing, -row * ROW_H + restY, 0.1]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={held}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[SW, SH, ST]} />
          {board}
        </mesh>
        <mesh position={[0, 0, ST / 2 + 0.002]}>
          <planeGeometry args={[SW, SH]} />
          <meshStandardMaterial key={tex?.front ? tex.front.uuid : 'blank'} map={tex?.front} roughness={0.8} color={tex?.front ? '#ffffff' : '#c7a476'} />
        </mesh>
        <mesh position={[0, 0, -ST / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[SW, SH]} />
          <meshStandardMaterial key={tex?.back ? tex.back.uuid : 'blank'} map={tex?.back} roughness={0.8} color={tex?.back ? '#ffffff' : '#c7a476'} />
        </mesh>
        {/* the open top, dark inside */}
        <mesh position={[0, SH / 2 + 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[SW - 0.05, ST - 0.05]} />
          <meshBasicMaterial color="#1a120b" />
        </mesh>
        <group position={[0, TAPE_Y, 0]}>
          <TrackTape w={TW} h={TH} label={tex?.label} />
        </group>
      </group>
    </group>
  )
}

// A 90s PC software box standing on the shelf. The band across the top is the lid: it lifts off and
// tips back while the getting started manual is out, and the box eases back to make room; the manual
// drives both (manual-box.js), and the lid comes down only once the manual is back in.
function PcBox({ project, shelf, row, index, ctl, open, onPick }) {
  const ref = useRef()
  const top = useRef()
  const stage = useRef()
  const out = useRef({ p: 0, push: 0, drop: 0 })
  const tex = useTextures(async () => {
    const front = await pcFront(project, shelf)
    return { ...front, back: pcBack(project, shelf), side: pcSide(project, shelf), top: pcLidTop(project, shelf) }
  }, [project, shelf])
  const bodyH = BOX.h - BOX.lid
  const lidY = BOX.h / 2 - BOX.lid / 2
  const restY = BASE + BOX.h / 2
  useCaseMotion(ref, {
    row, index, media: 'pcbox', ctl, open,
    rest: { y: restY, z: 0.05, rx: 0 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.8, y: t.y + p * 0.12, rx: t.rx + p * 0.06, s: 1 + p * 0.05 }),
  })
  useFrame((state, dt) => {
    const l = top.current
    if (!l || !stage.current) return
    const o = out.current
    const b = ctl.current.boxOut
    const isOpen = open && open.row === row && open.index === index
    // follow the manual while it's this box's; put away early, settle shut on its own
    if (isOpen && b && b.slug === project.slug) Object.assign(o, b)
    else o.p = o.p > 0.001 ? damp(o.p, 0, 14, dt) : 0
    const k = lidPose(o.p)
    stage.current.position.set(0, -o.drop * k.stage, -o.push * k.stage)
    l.position.set(0, lidY + k.y, k.z)
    l.rotation.x = k.rx
  })
  const card = <meshPhysicalMaterial color={CARD} roughness={0.7} clearcoat={0.15} clearcoatRoughness={0.6} />
  const LW = BOX.w + 0.014
  const LD = BOX.d + 0.014
  return (
    <group ref={ref} position={[index * MEDIA.pcbox.spacing, -row * ROW_H + restY, 0.05]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={stage}>
        <group position={[0, -BOX.lid / 2, 0]}>
          {/* An open carton, not a solid block with a dark cap: the manual exits through air. */}
          {[-1, 1].map((side) => (
            <group key={side}>
              <mesh position={[0, 0, side * (BOX.d / 2 - 0.012)]} castShadow receiveShadow>
                <boxGeometry args={[BOX.w, bodyH, 0.024]} />
                {card}
              </mesh>
              <mesh position={[side * (BOX.w / 2 - 0.012), 0, 0]} castShadow receiveShadow>
                <boxGeometry args={[0.024, bodyH, BOX.d - 0.048]} />
                {card}
              </mesh>
            </group>
          ))}
          <mesh position={[0, -bodyH / 2 + 0.012, 0]} receiveShadow>
            <boxGeometry args={[BOX.w, 0.024, BOX.d]} />
            <meshStandardMaterial color="#30271d" roughness={1} />
          </mesh>
          <mesh position={[0, 0, BOX.d / 2 + 0.002]}>
            <planeGeometry args={[BOX.w, bodyH]} />
            {coverMat(tex?.body)}
          </mesh>
          <mesh position={[0, 0, -BOX.d / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[BOX.w, bodyH]} />
            {coverMat(tex?.back)}
          </mesh>
          {[1, -1].map((sx) => (
            <mesh key={sx} position={[(sx * BOX.w) / 2 + sx * 0.002, 0, 0]} rotation={[0, (sx * Math.PI) / 2, 0]}>
              <planeGeometry args={[BOX.d, bodyH]} />
              {coverMat(tex?.side)}
            </mesh>
          ))}
          {/* The bottom and inner walls above supply the dark interior without a false top. */}
        </group>
        <group ref={top} position={[0, lidY, 0]}>
          <mesh castShadow>
            <boxGeometry args={[LW, BOX.lid, LD]} />
            <meshPhysicalMaterial color={CARD} roughness={0.7} clearcoat={0.15} clearcoatRoughness={0.6} />
          </mesh>
          <mesh position={[0, 0, LD / 2 + 0.002]}>
            <planeGeometry args={[LW, BOX.lid]} />
            {coverMat(tex?.band)}
          </mesh>
          <mesh position={[0, BOX.lid / 2 + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[LW, LD]} />
            {coverMat(tex?.top)}
          </mesh>
        </group>
      </group>
    </group>
  )
}

// A 12-inch LaserDisc special edition, standing face-out in a low rack and leaning back a little.
// While its gatefold is out, the jacket here hides: the gatefold sits exactly where it was.
function LdJacket({ project, shelf, row, index, ctl, open, onPick }) {
  const phone = useThree((state) => state.size.width < 700 && state.size.height > state.size.width * 1.1)
  const ref = useRef()
  const body = useRef()
  const tex = useTextures(async () => ({ front: await ldFront(project, shelf), back: phone ? ldBack(project, shelf, true) : ldBack(project, shelf) }), [project, shelf, phone])
  const restY = BASE + LD.s / 2 + 0.02
  useCaseMotion(ref, {
    row, index, media: 'laserdisc', ctl, open,
    rest: { y: restY, z: 0.12, rx: -0.1 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.85, y: t.y + p * 0.16, rx: t.rx + p * 0.1, s: 1 + p * 0.04 }),
  })
  useFrame(() => {
    const isOpen = open && open.row === row && open.index === index
    if (body.current) body.current.visible = !(isOpen && ctl.current.jacketOut)
  })
  return (
    <group ref={ref} position={[index * MEDIA.laserdisc.spacing, -row * ROW_H + restY, 0.12]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={body}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[LD.s, LD.s, LD.t]} />
          <meshStandardMaterial color="#0d0f11" roughness={0.55} />
        </mesh>
        <mesh position={[0, 0, LD.t / 2 + 0.002]}>
          <planeGeometry args={[LD.s, LD.s]} />
          {coverMat(tex?.front)}
        </mesh>
        <mesh position={[0, 0, -LD.t / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[LD.s, LD.s]} />
          {coverMat(tex?.back)}
        </mesh>
      </group>
    </group>
  )
}

// A 35mm film can from the projection booth, standing on its edge face-out in the rack and leaning
// back a little: steel, a printed label on the lid, a shipping label on the other, tape round the rim.
function FilmCan({ project, shelf, row, index, ctl, open, onPick }) {
  const phone = useThree((state) => state.size.width < 700 && state.size.height > state.size.width * 1.1)
  const ref = useRef()
  const tex = useTextures(async () => ({ front: canFront(project, shelf), back: phone ? canBack(project, shelf, true) : canBack(project, shelf), band: canBand(project, shelf) }), [project, shelf, phone])
  const restY = BASE + FC.r + 0.02
  useCaseMotion(ref, {
    row, index, media: 'filmcan', ctl, open,
    rest: { y: restY, z: 0.12, rx: -0.1 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.85, y: t.y + p * 0.16, rx: t.rx + p * 0.1, s: 1 + p * 0.04 }),
  })
  const body = useRef()
  const frontLid = useRef()
  // FilmStrip3D drives both pieces: the loose lid lifts and clears the rim first, then the can drops
  // away while the reel pours out. Wind-back runs that order in reverse.
  useFrame(() => {
    const isOpen = open && open.row === row && open.index === index
    const aside = isOpen ? ctl.current.canAside || 0 : 0
    const lift = isOpen ? ctl.current.canLid || 0 : 0
    if (body.current) {
      body.current.position.y = -aside * FC.r * 3.2
      body.current.visible = aside < 0.98
    }
    if (frontLid.current) {
      frontLid.current.visible = aside < 0.98
      frontLid.current.position.set(lift * FC.r * 1.05, lift * FC.r * 0.42 - aside * FC.r * 3.2, FC.t / 2 + lift * 0.24)
      frontLid.current.rotation.set(-lift * 0.18, lift * 0.3, -lift * 0.16)
    }
  })
  const lid = (map) => <meshStandardMaterial key={map ? map.uuid : 'blank'} map={map} color={map ? '#ffffff' : '#9a9893'} metalness={0.45} roughness={0.42} />
  return (
    <group ref={ref} position={[index * MEDIA.filmcan.spacing, -row * ROW_H + restY, 0.12]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={body}>
        <mesh rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[FC.r, FC.r, FC.t, 96, 1, true]} />
          <meshStandardMaterial key={tex?.band ? tex.band.uuid : 'blank'} map={tex?.band} metalness={0.7} roughness={0.35} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 0, -FC.t / 2]} rotation={[0, Math.PI, 0]} castShadow>
          <circleGeometry args={[FC.r, 96]} />
          {lid(tex?.back)}
        </mesh>
        <mesh position={[0, 0, -FC.t / 2]}>
          <torusGeometry args={[FC.r, 0.022, 14, 120]} />
          <meshStandardMaterial color="#b9b7b1" metalness={0.8} roughness={0.28} />
        </mesh>
      </group>
      {/* the front lid is a separate stamped-steel piece so it can actually come off the can */}
      <group ref={frontLid} position={[0, 0, FC.t / 2]}>
        <mesh castShadow>
          <circleGeometry args={[FC.r, 96]} />
          {lid(tex?.front)}
        </mesh>
        <mesh>
          <torusGeometry args={[FC.r, 0.022, 14, 120]} />
          <meshStandardMaterial color="#b9b7b1" metalness={0.8} roughness={0.28} />
        </mesh>
      </group>
    </group>
  )
}

// The 3.5" disk's metal shutter: a thin plate over each face with a window in it, joined over the top
// edge. It slides sideways until its window lines up with the disk's own.
const SHUT_W = FL.w * SHUTTER.w
const SHUT_H = FL.h * SHUTTER.h
const SHUT_SLIDE = SHUT_W * ((SHUTTER.win[0] + SHUTTER.win[1]) / 2 - 0.5)
const shutterPlate = (() => {
  const s = new THREE.Shape()
  s.moveTo(-SHUT_W / 2, 0)
  s.lineTo(-SHUT_W / 2, -SHUT_H)
  s.lineTo(SHUT_W / 2, -SHUT_H)
  s.lineTo(SHUT_W / 2, 0)
  s.closePath()
  const [x0, x1] = SHUTTER.win.map((f) => -SHUT_W / 2 + SHUT_W * f)
  const [y0, y1] = SHUTTER.winY.map((f) => -SHUT_H * f)
  const hole = new THREE.Path()
  hole.moveTo(x0, y0)
  hole.lineTo(x1, y0)
  hole.lineTo(x1, y1)
  hole.lineTo(x0, y1)
  hole.closePath()
  s.holes.push(hole)
  return new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: false })
})()

// A 3.5" shareware floppy, standing face-out in the rack and leaning back a little: coloured
// plastic, the metal shutter, a printed label on the front and the hub on the back. While its README
// prints, the shutter slides open and the disk drops into the printer; the printout drives both
// (ctl.disk), so they run back the same way and a skip lands them together.
function Floppy({ project, shelf, row, index, ctl, open, onPick }) {
  const ref = useRef()
  const body = useRef()
  const slider = useRef()
  const tex = useTextures(async () => ({ front: floppyFront(project, shelf), back: floppyBack(project, shelf) }), [project, shelf])
  const restY = BASE + FL.h / 2 + 0.02
  useCaseMotion(ref, {
    row, index, media: 'floppy', ctl, open,
    rest: { y: restY, z: 0.12, rx: -0.12 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.85, y: t.y + p * 0.16, rx: t.rx + p * 0.12, s: 1 + p * 0.04 }),
  })
  useFrame((state, dt) => {
    const b = body.current
    const sl = slider.current
    if (!b || !sl) return
    const d = open && open.row === row && open.index === index ? ctl.current.disk : null
    if (d) {
      sl.position.x = -d.shutter * SHUT_SLIDE
      b.position.y = -d.drop
      b.visible = !d.gone
    } else {
      sl.position.x = damp(sl.position.x, 0, 14, dt)
      b.position.y = damp(b.position.y, 0, 14, dt)
      b.visible = true
    }
  })
  const steel = <meshStandardMaterial color="#c4c8cd" metalness={0.85} roughness={0.3} />
  return (
    <group ref={ref} position={[index * MEDIA.floppy.spacing, -row * ROW_H + restY, 0.12]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={body}>
        <RoundedBox args={[FL.w, FL.h, FL.t]} radius={0.012} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color={project.palette?.accent || '#2bb3a8'} roughness={0.45} />
        </RoundedBox>
        <mesh position={[0, 0, FL.t / 2 + 0.002]}>
          <planeGeometry args={[FL.w, FL.h]} />
          {coverMat(tex?.front)}
        </mesh>
        <mesh position={[0, 0, -FL.t / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[FL.w, FL.h]} />
          {coverMat(tex?.back)}
        </mesh>
        <group ref={slider} position={[0, FL.h / 2, 0]}>
          <mesh geometry={shutterPlate} position={[0, 0, FL.t / 2 + 0.003]} castShadow>
            {steel}
          </mesh>
          <mesh geometry={shutterPlate} position={[0, 0, -FL.t / 2 - 0.007]}>
            {steel}
          </mesh>
          <mesh position={[0, 0.003, 0]}>
            <boxGeometry args={[SHUT_W, 0.006, FL.t + 0.014]} />
            {steel}
          </mesh>
        </group>
      </group>
    </group>
  )
}

// A mixtape in its clear case, standing on its short edge face-out. The tray holds the tape, side A
// out the back; the lid, hinged down the spine side, holds the J-card under two clips, its cover
// out the front and its spine down the hinge. Opening the J-card swings the lid open (Leaflet3D
// drives it, through c.lidCase) and lifts the card out; the card here hides while that one is out.
const PANE = 0.012
const JC_H = 1.33
const JC_W = (JC_H * PAGE.w) / PAGE.h
// Cheap clear plastic: the environment gives it a real glossy reflection without the frame cost of
// transmission. Broad panes stay nearly invisible; the thicker walls catch more light so the case
// still has a readable silhouette in the dark aisle.
const clearMat = (opacity = 0.12, edge = false) => (
  <meshPhysicalMaterial
    color={edge ? '#c5d9dc' : '#d7e7e9'}
    transparent
    opacity={edge ? Math.max(opacity, 0.28) : opacity}
    roughness={edge ? 0.12 : 0.07}
    metalness={0}
    ior={1.47}
    reflectivity={0.9}
    envMapIntensity={edge ? 2.1 : 1.65}
    clearcoat={1}
    clearcoatRoughness={edge ? 0.1 : 0.045}
    depthWrite={false}
    side={THREE.DoubleSide}
  />
)

function Cassette({ project, shelf, row, index, ctl, open, onPick }) {
  const ref = useRef()
  const tape = useRef()
  useFrame(() => { if (tape.current) tape.current.visible = !(mine && ctl.current.cassetteMoveOut) })
  const lid = useRef()
  const card = useRef()
  const anchor = useRef()
  const tex = useTextures(
    async () => ({ front: cassetteFront(project, shelf), back: cassetteBack(project, shelf), a: tapeShell(project, shelf, 'A'), b: tapeShell(project, shelf, 'B'), spine: cassetteSpine(project, shelf) }),
    [project, shelf],
  )
  const restY = BASE + CS.h / 2 + 0.02
  const c = ctl.current
  const mine = !!open && open.row === row && open.index === index
  useEffect(() => {
    if (mine) ctl.current.lidCase = { lid: lid.current, card: card.current, anchor: anchor.current, row, index }
  }, [mine, ctl, row, index])
  // put back in a hurry, the case stays in your hands until its J-card is in and the lid is shut
  const held = !open && c.lidCase && c.lidCase.row === row && c.lidCase.index === index && c.jcardE > 0
  useCaseMotion(ref, {
    row, index, media: 'cassette', ctl, open: held ? { row, index } : open,
    rest: { y: restY, z: 0.12, rx: -0.1 },
    pulled: (t, p) => ({ ...t, z: t.z + p * 0.85, y: t.y + p * 0.16, rx: t.rx + p * 0.1, s: 1 + p * 0.04 }),
  })
  const shellFace = (map, z, ry) => (
    <mesh position={[0, 0, z]} rotation={[0, ry, 0]}>
      <planeGeometry args={[0.86, 1.36]} />
      <meshStandardMaterial key={map ? map.uuid : 'blank'} map={map} color={map ? '#ffffff' : '#2a2a2e'} roughness={0.5} />
    </mesh>
  )
  const back = -CS.t / 2
  return (
    <group ref={ref} position={[index * MEDIA.cassette.spacing, -row * ROW_H + restY, 0.12]} onClick={pickHandler(ctl, onPick, row, index)}>
      {/* the tray: its back, three low walls, and the tape lying in it */}
      <mesh position={[0, 0, back + PANE / 2]} castShadow>
        <boxGeometry args={[CS.w, CS.h, PANE]} />
        {clearMat()}
      </mesh>
      {/* The J-card's folded rear flap sits just inside the clear tray, as on a real tape case. */}
      <mesh position={[0, 0, back + PANE + 0.0005]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[JC_W, JC_H]} />
        {paperMat(tex?.back, THREE.FrontSide)}
      </mesh>
      <mesh position={[CS.w / 2 - PANE / 2, 0, back + 0.04]}>
        <boxGeometry args={[PANE, CS.h, 0.08]} />
        {clearMat(0.28, true)}
      </mesh>
      {[1, -1].map((k) => (
        <mesh key={k} position={[0, k * (CS.h / 2 - PANE / 2), back + 0.04]}>
          <boxGeometry args={[CS.w, PANE, 0.08]} />
          {clearMat(0.28, true)}
        </mesh>
      ))}
      <group ref={tape}>
      <RoundedBox args={[0.88, 1.38, 0.11]} radius={0.02} smoothness={3} position={[0, 0, back + PANE + 0.057]}>
        <meshStandardMaterial color="#232326" roughness={0.5} />
      </RoundedBox>
      {shellFace(tex?.b, back + PANE + 0.113, 0)}
      {shellFace(tex?.a, back + PANE + 0.001, Math.PI)}
      </group>
      {/* the lid, hinged at the back of the spine side */}
      <group ref={lid} position={[-CS.w / 2, 0, back]}>
        <mesh position={[CS.w / 2, 0, CS.t - PANE / 2]} castShadow renderOrder={2}>
          <boxGeometry args={[CS.w, CS.h, PANE]} />
          {clearMat()}
        </mesh>
        <mesh position={[PANE / 2, 0, CS.t / 2]} renderOrder={2}>
          <boxGeometry args={[PANE, CS.h, CS.t]} />
          {clearMat(0.3, true)}
        </mesh>
        <mesh position={[CS.w - PANE / 2, 0, CS.t - 0.025]} renderOrder={2}>
          <boxGeometry args={[PANE, CS.h, 0.05]} />
          {clearMat(0.3, true)}
        </mesh>
        {[1, -1].map((k) => (
          <group key={k}>
            <mesh position={[CS.w / 2, k * (CS.h / 2 - PANE / 2), CS.t * 0.75]} renderOrder={2}>
              <boxGeometry args={[CS.w, PANE, CS.t / 2]} />
              {clearMat(0.3, true)}
            </mesh>
            {/* the clips the J-card sits under */}
            <mesh position={[CS.w * 0.55, k * (JC_H / 2 - 0.006), CS.t - PANE - 0.019]} renderOrder={2}>
              <boxGeometry args={[0.3, 0.05, 0.016]} />
              {clearMat(0.42, true)}
            </mesh>
          </group>
        ))}
        <group ref={card}>
          <mesh position={[CS.w / 2, 0, CS.t - PANE - 0.003]}>
            <planeGeometry args={[JC_W, JC_H]} />
            {paperMat(tex?.front, THREE.FrontSide)}
          </mesh>
          <mesh position={[CS.w / 2, 0, CS.t - PANE - 0.007]}>
            {/* The stock fills the clear lid, including the margins around the printed face. */}
            <boxGeometry args={[CS.w - PANE * 2, CS.h - PANE * 2, 0.006]} />
            <meshStandardMaterial color="#e9dfc7" roughness={0.86} />
          </mesh>
          <mesh position={[PANE + 0.002, 0, CS.t / 2]} rotation={[0, -Math.PI / 2, 0]}>
            <planeGeometry args={[CS.t * 0.86, JC_H]} />
            {paperMat(tex?.spine, THREE.FrontSide)}
          </mesh>
        </group>
        {/* where Leaflet3D takes the card from: the cover's centre, one unit to the card's height */}
        <group ref={anchor} position={[CS.w / 2, 0, CS.t - PANE - 0.003]} scale={JC_H} />
      </group>
    </group>
  )
}

// A 12-inch LP standing face-out in the rack and leaning back a little. Pull it and the record
// slides partway out of the jacket's open side; while the sleeve is out you hold the jacket off to
// the left, and the record here hides (the sleeve's own record is exactly where it was).
function Vinyl({ project, shelf, row, index, ctl, open, onPick, lid }) {
  const phone = useThree((state) => state.size.width < 700 && state.size.height > state.size.width * 1.1)
  const ref = useRef()
  const jacket = useRef()
  const record = useRef()
  const pull = useRef(0)
  const tex = useTextures(async () => ({ front: await lpFront(project, shelf), back: phone ? lpBack(project, shelf, true) : lpBack(project, shelf), disc: recordFace(project, shelf), sheen: recordSheen() }), [project, shelf, phone])
  const restY = BASE + LP.s / 2 + 0.02
  useCaseMotion(ref, {
    row, index, media: 'vinyl', ctl, open,
    rest: { y: restY, z: 0.12, rx: -0.1 },
    pulled: (t, p) => {
      pull.current = p
      return { ...t, z: t.z + p * 0.85, y: t.y + p * 0.16, rx: t.rx + p * 0.1, s: 1 + p * 0.04 }
    },
  })
  useFrame((state, dt) => {
    const c = ctl.current
    const isOpen = open && open.row === row && open.index === index
    const out = isOpen ? 1 : !open && Math.round(c.row) === row ? pull.current : 0
    if (record.current) {
      record.current.visible = !(isOpen && c.recordOut)
      record.current.position.x = damp(record.current.position.x, (phone && isOpen ? 0.08 : PEEK) * LP.s * out, 8, dt)
    }
    if (jacket.current) {
      jacket.current.visible = !(phone && isOpen && c.recordOut)
      jacket.current.position.x = damp(jacket.current.position.x, lid ? -0.32 * LP.s : 0, lid ? 12 : 10, dt)
    }
  })
  const card = <meshStandardMaterial color="#d9cfbd" roughness={0.85} />
  return (
    <group ref={ref} position={[index * MEDIA.vinyl.spacing, -row * ROW_H + restY, 0.12]} onClick={pickHandler(ctl, onPick, row, index)}>
      <group ref={record} position={[0, 0, -0.006 * LP.s]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[DISC * LP.s, DISC * LP.s, 0.006 * LP.s, 96]} />
          <meshPhysicalMaterial key={tex?.disc ? tex.disc.uuid : 'blank'} map={tex?.disc} color={tex?.disc ? '#ffffff' : '#0b0b0c'} roughness={0.32} metalness={0.1} clearcoat={1} clearcoatRoughness={0.08} />
        </mesh>
        <mesh position={[0, 0, 0.0035 * LP.s]}>
          <circleGeometry args={[DISC * LP.s, 96]} />
          <meshBasicMaterial key={tex?.sheen ? tex.sheen.uuid : 'blank'} map={tex?.sheen} transparent opacity={tex?.sheen ? 0.32 : 0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <group ref={jacket}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[LP.s, LP.s, LP.t]} />
          {card}
        </mesh>
        <mesh position={[0, 0, LP.t / 2 + 0.002]}>
          <planeGeometry args={[LP.s, LP.s]} />
          {coverMat(tex?.front)}
        </mesh>
        <mesh position={[0, 0, -LP.t / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[LP.s, LP.s]} />
          {coverMat(tex?.back)}
        </mesh>
      </group>
    </group>
  )
}

const CASES = { vhs: VhsCase, cartridge: Cartridge, '8track': TrackCase, pcbox: PcBox, laserdisc: LdJacket, filmcan: FilmCan, floppy: Floppy, cassette: Cassette, vinyl: Vinyl }

function Shelf({ row, count, shelf, top, ctl, open }) {
  const shade = useRef()
  const plate = useRef()
  const { size } = useThree()
  // shelves you're not standing at sink back into the dark
  useFrame((state, dt) => {
    if (!shade.current) return
    const mat = shade.current.material
    mat.opacity = damp(mat.opacity, Math.round(ctl.current.row) === row ? 0 : 0.82, 6, dt)
    shade.current.visible = mat.opacity > 0.01
    if (!plate.current) return
    // a phone's view is narrower than the walk from the sign to the cases further along, so there the
    // sign slides along to stay in view, and comes down while something is open in front of it
    const c = ctl.current
    const narrow = size.width < size.height
    const room = Math.max(0, ((c.camZ ?? 7.4) + 0.79) * TAN * (size.width / size.height) - 1)
    plate.current.position.x = narrow ? THREE.MathUtils.clamp(signX, c.camX - room, c.camX + room) : signX
    plate.current.visible = !(narrow && open)
  })
  const tex = useTextures(async () => ({ wood: woodTexture([96, 60, 34], 5 + row), back: woodTexture([38, 24, 16], 9 + row), sign: signTexture(shelf) }), [row, shelf])
  const { wood, back, sign } = tex || {}
  const m = MEDIA[shelf.media]
  const len = count * m.spacing + 10
  const cx = ((count - 1) * m.spacing) / 2
  const y0 = -row * ROW_H
  wood?.repeat.set(len / 4, 1)
  back?.repeat.set(len / 6, 3)
  const board = (y) => (
    <>
      <mesh position={[cx, y, 0]} receiveShadow castShadow>
        <boxGeometry args={[len, 0.12, 1.6]} />
        <meshStandardMaterial key={wood ? wood.uuid : 'blank'} map={wood} color={wood ? '#ffffff' : '#5a3a22'} roughness={0.7} />
      </mesh>
      <mesh position={[cx, y + 0.01, 0.81]}>
        <boxGeometry args={[len, 0.2, 0.04]} />
        <meshStandardMaterial color="#3d2615" roughness={0.6} />
      </mesh>
    </>
  )
  const signX = m.spacing * (shelf.media === 'vhs' ? 1.6 : 0.6)
  const signY = y0 + BASE + m.height + 0.5
  return (
    <group>
      {board(y0 + BASE - 0.06)}
      {top && board(y0 + BASE + ROW_H - 0.06)}
      <mesh position={[cx, y0 + 0.6, -0.82]} receiveShadow>
        <planeGeometry args={[len, ROW_H + 0.2]} />
        <meshStandardMaterial key={back ? back.uuid : 'blank'} map={back} color={back ? '#ffffff' : '#241710'} roughness={0.85} />
      </mesh>
      <mesh ref={plate} position={[signX, signY, -0.79]}>
        <planeGeometry args={[1.9, 0.41]} />
        <meshStandardMaterial key={sign ? sign.uuid : 'blank'} map={sign} color={sign ? '#ffffff' : '#1a1512'} roughness={0.5} metalness={0.1} />
      </mesh>
      {/* cartridges and 8-tracks get a lip in front so they have something to lean on */}
      {(shelf.media === 'cartridge' || shelf.media === '8track' || shelf.media === 'laserdisc' || shelf.media === 'filmcan' || shelf.media === 'floppy' || shelf.media === 'cassette' || shelf.media === 'vinyl') && (
        <mesh position={[cx, y0 + BASE + 0.05, 0.42]}>
          <boxGeometry args={[len, 0.1, 0.05]} />
          <meshStandardMaterial color="#2a1a0e" roughness={0.6} />
        </mesh>
      )}
      <mesh ref={shade} position={[cx, y0 + 0.6, 0.98]} raycast={() => null}>
        <planeGeometry args={[len, ROW_H]} />
        <meshBasicMaterial color="#0b0706" transparent opacity={0.82} depthWrite={false} />
      </mesh>
      {shelf.media === 'vhs' &&
        [-0.42, (count - 1) * m.spacing + 0.42].map((x) => (
          <mesh key={x} position={[x, y0 + BASE + 0.45, -0.1]} castShadow>
            <boxGeometry args={[0.05, 0.9, 1.0]} />
            <meshStandardMaterial color="#1c1c1e" metalness={0.6} roughness={0.35} />
          </mesh>
        ))}
    </group>
  )
}

export default function Scene({ rows, ctl, open, onPick, onFocus, onClose, book, page, per, single, onTurn, onSeek, onObjectMove, onIntroDone }) {
  const cam = useRef()
  const dim = useRef()
  const spot = useRef()
  const { size, gl, scene, camera } = useThree()
  const drawableViewport = useMemo(() => new THREE.Vector4(), [])
  useFrame(({ gl, scene, camera }) => {
    const held = ctl.current.heldCases
    // A graphics-context remount can retain the controls but detach the old case roots.
    for (const root of held || []) if (!root.parent) held.delete(root)
    if (!held?.size && !dim.current?.visible) return gl.render(scene, camera)
    // Draw the store and its unchanged veil first, then the held case and inserts.
    // Keep held meshes in the first shadow pass: excluding them by layer here would
    // erase their cast/self shadows. Suppress only their colour/depth writes, per draw
    // (materials can be shared with a case that is still on the shelf).
    const foreground = new Map()
    const writes = new Map()
    const masks = new Map()
    const restoreWrite = (material) => {
      const saved = writes.get(material)
      if (saved) {
        material.colorWrite = saved[0]
        material.depthWrite = saved[1]
        writes.delete(material)
      }
    }
    const mark = (object) => {
      if (!object.isMesh || foreground.has(object)) return
      const before = object.onBeforeRender, after = object.onAfterRender
      foreground.set(object, [before, after])
      masks.set(object, object.layers.mask)
      object.onBeforeRender = function (...args) {
        before.apply(this, args)
        const material = args[4]
        writes.set(material, [material.colorWrite, material.depthWrite])
        material.colorWrite = material.depthWrite = false
      }
      object.onAfterRender = function (...args) {
        restoreWrite(args[4])
        after.apply(this, args)
      }
    }
    for (const root of held || []) root.traverse(mark)
    for (const root of camera.children) root.traverse(mark)
    scene.traverse((object) => {
      if (!object.isLight) return
      masks.set(object, object.layers.mask)
      object.layers.enable(31)
    })
    const mask = camera.layers.mask
    const autoClear = gl.autoClear
    const background = scene.background
    try {
      camera.layers.set(0)
      gl.render(scene, camera)
      for (const [object, [before, after]] of foreground) {
        object.onBeforeRender = before
        object.onAfterRender = after
        object.layers.set(31)
      }
      // Retain the store's depth: shelf lips still occlude a case as it goes home.
      // The veil never writes depth, so it cannot cover any part of the held objects.
      gl.autoClear = false
      scene.background = null
      camera.layers.set(31)
      gl.render(scene, camera)
    } finally {
      camera.layers.mask = mask
      gl.autoClear = autoClear
      scene.background = background
      for (const material of writes.keys()) restoreWrite(material)
      for (const [object, [before, after]] of foreground) {
        object.onBeforeRender = before
        object.onAfterRender = after
      }
      for (const [object, saved] of masks) object.layers.mask = saved
    }
  }, 1)
  // Build the visible aisle and its neighbour first. Far-away cases used to make
  // the first frame pay for every kind of geometry, material and printed surface.
  // Keep mounted aisles alive; this is startup scheduling, not scroll recycling.
  const [mountedRows, setMountedRows] = useState(() => new Set([0, 1]))
  const mounted = useRef(mountedRows)
  mounted.current = mountedRows
  useEffect(() => {
    let timer, frame, cancelled = false
    const next = () => {
      if (cancelled) return
      const row = rows.findIndex((_, i) => !mounted.current.has(i))
      if (row < 0) return
      setMountedRows((was) => new Set([...was, row]))
      timer = setTimeout(() => { frame = requestAnimationFrame(next) }, 50)
    }
    // Leave the first painted frame and its printing uploads clear, then spread
    // the rest over separate turns rather than one all-wall React commit.
    frame = requestAnimationFrame(() => { timer = setTimeout(next, 500) })
    return () => { cancelled = true; clearTimeout(timer); cancelAnimationFrame(frame) }
  }, [rows])
  useFrame(() => {
    syncDrawingBuffer(gl, camera, drawableViewport)
    const c = ctl.current
    const needed = [Math.floor(c.row) - 1, Math.floor(c.row), Math.ceil(c.row), Math.ceil(c.row) + 1, Math.round(c.rowTarget), open?.row]
      .filter((row) => row >= 0 && row < rows.length && !mounted.current.has(row))
    if (needed.length) setMountedRows((was) => new Set([...was, ...needed]))
  }, -100)
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('rendererProbe')) return
    window.__shelfProbe = () => {
      const ctx = gl.getContext()
      const textures = new Set()
      scene.traverse((object) => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (!material) continue
          for (const value of Object.values(material)) if (value?.isTexture) {
            textures.add(value)
            for (const ink of [value.userData.print?.ink, value.userData.print?.wall]) if (ink) textures.add(ink)
          }
        }
      })
      const textureBytes = [...textures].filter((t) => gl.properties.get(t).__webglTexture).reduce((n, t) => n + (t.image?.width || 0) * (t.image?.height || 0) * 4 * (t.generateMipmaps ? 4 / 3 : 1), 0)
      const debug = ctx.getExtension('WEBGL_debug_renderer_info')
      return { render: { ...gl.info.render }, shadowAutoUpdate: gl.shadowMap.autoUpdate, window: [innerWidth, innerHeight], client: [gl.domElement.clientWidth, gl.domElement.clientHeight], size: gl.getSize(new THREE.Vector2()).toArray(), buffer: gl.getDrawingBufferSize(new THREE.Vector2()).toArray(), actual: [ctx.drawingBufferWidth, ctx.drawingBufferHeight], viewport: [...ctx.getParameter(ctx.VIEWPORT)], scissor: [...ctx.getParameter(ctx.SCISSOR_BOX)], scissorTest: ctx.isEnabled(ctx.SCISSOR_TEST), aspect: camera.aspect, fov: camera.fov, r3f: [size.width, size.height], memory: { ...gl.info.memory, estimatedTextureBytes: Math.round(textureBytes), ...printedMemory() }, renderer: debug ? ctx.getParameter(debug.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER) }
    }
    return () => { delete window.__shelfProbe }
  }, [size, gl, camera])
  const last = useRef('')
  const attention = useRef({ row: -1, arrived: -1, x: 0, y: 0, z: 0, tx: 0, ty: 0, ready: false })
  useEffect(() => {
    const mq = window.matchMedia('(hover: none), (pointer: coarse)')
    const touch = () => { ctl.current.shelfTouch = mq.matches; ctl.current.shelfHover = null }
    const clear = () => { ctl.current.shelfHover = null }
    const key = (e) => { if (e.key.startsWith('Arrow') || e.key === 'Tab' || e.key === 'Escape') clear() }
    touch()
    mq.addEventListener('change', touch)
    window.addEventListener('keydown', key, true)
    gl.domElement.addEventListener('pointerleave', clear)
    return () => {
      mq.removeEventListener('change', touch)
      window.removeEventListener('keydown', key, true)
      gl.domElement.removeEventListener('pointerleave', clear)
      clear()
    }
  }, [ctl, gl])
  useEffect(() => setPrintRenderer(gl), [gl])
  useEffect(() => {
    const changed = createShadowTracker()
    const before = scene.onBeforeRender
    const autoUpdate = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
    scene.onBeforeRender = function (...args) {
      before.apply(this, args)
      // All case/insert animation callbacks and world-matrix updates have finished now.
      // This also catches hiding a can, replacing a case, and the final put-back pose.
      if (changed(scene)) gl.shadowMap.needsUpdate = true
    }
    return () => {
      scene.onBeforeRender = before
      gl.shadowMap.autoUpdate = autoUpdate
      gl.shadowMap.needsUpdate = true
    }
  }, [gl, scene])
  // a case out of the shelf: fetch its insert's pages now, so opening it doesn't wait on them
  const openSlug = open ? rows[open.row].projects[open.index]?.slug : null
  useEffect(() => void (openSlug && prefetchPrinted(openSlug)), [openSlug])
  // and, a little later, its neighbours', so Next and Previous don't wait on theirs
  const oRow = open?.row
  const oIndex = open?.index
  useEffect(() => {
    if (oRow == null) return
    const id = setTimeout(() => [-1, 1].forEach((d) => {
      const n = neighbour(rows, { row: oRow, index: oIndex }, d)
      if (n) prefetchPrinted(rows[n.row].projects[n.index].slug, false)
    }), 500)
    return () => clearTimeout(id)
  }, [oRow, oIndex, rows])
  // and build its insert's shaders while it's in your hands (again as its pages arrive), so the first
  // open doesn't stall on them
  useEffect(() => {
    if (!openSlug) return
    const ids = [300, 900, 1800].map((ms) => setTimeout(() => gl.compileAsync(scene, camera).catch(() => {}), ms))
    return () => ids.forEach(clearTimeout)
  }, [openSlug, gl, scene, camera])

  useFrame((state, dt) => {
    const c = ctl.current
    const adjacent = open ? [-1, 1].map((d) => neighbour(rows, open, d)).filter(Boolean).map((n) => rows[n.row].projects[n.index].slug) : []
    setPrintView(openSlug, adjacent, Math.cos(c.spinYTarget || 0) < 0, size.width <= 640 && size.width < size.height)
    updatePrintedMaterials(scene)
    const aspect = size.width / size.height
    // a step to the next case drives the camera on its own clock: it holds while the insert folds back,
    // then glides (down or up a row too, at a shelf's end) as the case goes home and the next comes out
    const st = c.step
    let su = -1
    if (st) {
      su = stepAt(c, st)
      if (!st.cam) st.cam = { x: c.camX ?? 0, row: c.row, z: c.camZ }
      if (su >= 1) st.done = true
      if (st.done && (st.after = (st.after || 0) + 1) > 2) c.step = null
    }
    const se = su >= 0 ? easeInOut(su) : 0
    if (su >= 0) c.row = THREE.MathUtils.lerp(st.cam.row, st.to.row, se)
    else if (!open && (!c.dragging || c.axis !== 'y')) c.row = damp(c.row, c.rowTarget, 7, dt)
    const active = THREE.MathUtils.clamp(Math.round(c.row), 0, rows.length - 1)
    setPrintFocus(active)
    const media = rows[active].shelf.media
    const m = MEDIA[media]
    // stepping up or down to another shelf keeps you at the same spot along the aisle: that shelf
    // picks the case in front of you rather than swinging the view back to where you left it
    if (c.lastActive !== active) {
      if (c.lastActive != null && !open && c.camX != null) {
        const s = c.rows[active]
        s.offset = s.target = THREE.MathUtils.clamp(Math.round(c.camX / m.spacing), 0, rows[active].projects.length - 1)
      }
      c.lastActive = active
    }
    const toMedia = su >= 0 ? rows[st.to.row].shelf.media : media
    if (su >= 0) c.camZ = THREE.MathUtils.lerp(st.cam.z ?? cameraZ(toMedia, aspect), cameraZ(toMedia, aspect), se)
    else if (!open) c.camZ = damp(c.camZ ?? cameraZ(media, aspect), cameraZ(media, aspect), 6, dt)
    // how far the open item sits from your eye, so the booklet can start out tucked behind it
    if (open) c.cartDist = openDistance(rows[open.row].shelf.media, aspect, c.spinY) / Math.cos(Math.atan2(CAM_Y - LOOK_Y, c.camZ))
    rows.forEach((r, i) => {
      const s = c.rows[i]
      if (!open && !(c.dragging && c.axis === 'x' && i === active)) s.offset = damp(s.offset, s.target, 9, dt)
      s.offset = THREE.MathUtils.clamp(s.offset, -0.4, r.projects.length - 0.6)
    })
    c.pxPerCase = (m.spacing / (2 * c.camZ * TAN * aspect)) * size.width
    c.pxPerRow = (ROW_H / (2 * c.camZ * TAN)) * size.height
    c.spinY = damp(c.spinY, c.spinYTarget, c.dragging ? 18 : 8, dt)
    c.spinX = damp(c.spinX, c.dragging ? c.spinXTarget : 0, 8, dt)
    if (su >= 0) {
      const s = c.rows[st.to.row]
      s.offset = s.target = st.to.index
      c.camX = THREE.MathUtils.lerp(st.cam.x, st.to.index * MEDIA[toMedia].spacing, se)
    } else if (!open) c.camX = damp(c.camX ?? 0, c.rows[active].offset * m.spacing, 8, dt)
    const camY = -c.row * ROW_H + CAM_Y
    if (cam.current) {
      cam.current.position.set(c.camX, camY, c.camZ)
      cam.current.lookAt(c.camX, -c.row * ROW_H + LOOK_Y, 0)
    }
    const f = THREE.MathUtils.clamp(Math.round(c.rows[active].offset), 0, rows[active].projects.length - 1)
    const key = `${active}:${f}:${!!c.shelfRest}`
    if (key !== last.current) {
      last.current = key
      onFocus(active, f, !!c.shelfRest)
    }
    const a = attention.current
    if (a.row !== active || (a.resting && !c.shelfRest)) {
      if (a.row !== active) c.shelfHover = null
      a.row = active
      a.arrived = -1
    }
    a.resting = !!c.shelfRest
    if (a.arrived < 0 && !open && !c.dragging && Math.abs(c.row - active) < 0.06) a.arrived = state.clock.elapsedTime
    const hover = !c.shelfTouch && !c.reduced && !c.dragging && !open && c.shelfHover?.row === active ? c.shelfHover : null
    const focus = hover ? hover.index : f
    c.inviteRow = active
    c.inviteIndex = focus
    // Phones get one quiet invitation on arrival, not a hover or a repeating idle animation.
    const age = a.arrived < 0 ? -1 : state.clock.elapsedTime - a.arrived
    // The touch invitation has an intentional still beat before it begins.
    if (c.shelfTouch && !c.reduced && !open && age >= 0 && age < 1.4) continueShelfMotion()
    c.inviteAmount = c.shelfRest || c.reduced || open ? 0 : c.shelfTouch ? (age >= 0.25 && age < 1.4 ? 0.65 : 0) : 1
    if (spot.current) {
      // Attention follows a CASE, never pointer coordinates. Reuse the existing non-shadow light;
      // the fixed directional light and the caster-driven shadow invalidation stay untouched.
      const x = open ? c.camX : focus * m.spacing
      const y = -active * ROW_H
      const lx = x - 0.9
      const ly = y + 3.5
      const ty = y + BASE + m.height * 0.55
      const light = spot.current
      const snap = c.reduced || !a.ready
      light.position.x = snap ? lx : spring(a, 'x', light.position.x, lx, 4, dt)
      light.position.y = snap ? ly : spring(a, 'y', light.position.y, ly, 5, dt)
      light.position.z = snap ? 3.2 : spring(a, 'z', light.position.z, 3.2, 4, dt)
      light.target.position.x = snap ? x : spring(a, 'tx', light.target.position.x, x, 4, dt)
      light.target.position.y = snap ? ty : spring(a, 'ty', light.target.position.y, ty, 5, dt)
      light.target.position.z = 0
      if (snap) a.x = a.y = a.z = a.tx = a.ty = 0
      a.ready = true
      light.target.updateMatrixWorld()
    }
    if (dim.current) {
      const mat = dim.current.material
      mat.opacity = damp(mat.opacity, open ? 0.72 : 0, 8, dt)
      dim.current.visible = mat.opacity > 0.01
      dim.current.position.set(c.camX, camY, 1.15)
    }
  })

  const widest = Math.max(...rows.map((r) => r.projects.length * MEDIA[r.shelf.media].spacing))
  // the insert that came with the open item rides along with the camera: a cartridge's booklet,
  // a tape's leaflet
  const openMedia = open && rows[open.row].shelf.media
  const openItem = open && rows[open.row].projects[open.index]
  const bookFor = openMedia === 'cartridge' ? openItem : null
  const leafFor = openMedia === 'vhs' ? openItem : null
  const jcardFor = openMedia === 'cassette' ? openItem : null
  const sleeveFor = openMedia === '8track' ? openItem : null
  const manualFor = openMedia === 'pcbox' ? openItem : null
  const gateFor = openMedia === 'laserdisc' ? openItem : null
  const filmFor = openMedia === 'filmcan' ? openItem : null
  const printFor = openMedia === 'floppy' ? openItem : null
  // the printout stays mounted after its disk goes back, so a quick put back still feeds the paper in
  const lastPrint = useRef(null)
  if (printFor) lastPrint.current = { item: printFor, shelf: rows[open.row].shelf }
  else if (open) lastPrint.current = null
  const printed = lastPrint.current
  const recordFor = openMedia === 'vinyl' ? openItem : null
  // a J-card put away in a hurry finishes going back into its case before it goes
  const jcardLast = useRef(null)
  const [, setJcardBack] = useState(0)
  if (jcardFor) jcardLast.current = { item: jcardFor, shelf: rows[open.row].shelf }
  const jcard = jcardFor ? jcardLast.current : !open && ctl.current.jcardE > 0 ? jcardLast.current : null
  return (
    <>
      <PerspectiveCamera ref={cam} makeDefault fov={FOV} near={0.1} far={80} position={[0, CAM_Y, 8]}>
        {bookFor && (
          <Booklet3D key={bookFor.slug} project={bookFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} single={single} onTurn={onTurn} onIntroDone={onIntroDone} />
        )}
        {sleeveFor && (
          <Sleeve3D onSeek={onSeek} onObjectMove={onObjectMove} key={sleeveFor.slug} project={sleeveFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} single={single} onTurn={onTurn} onIntroDone={onIntroDone} height={SH} thick={ST} tape={TAPE} />
        )}
        {gateFor && (
          <Gatefold3D key={gateFor.slug} project={gateFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} single={single} onTurn={onTurn} onIntroDone={onIntroDone} size={LD.s} />
        )}
        {filmFor && (
          <FilmStrip3D key={filmFor.slug} project={filmFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} per={per} single={single} onTurn={onTurn} onIntroDone={onIntroDone} size={FC.r} />
        )}
        {recordFor && (
          <Record3D onSeek={onSeek} onObjectMove={onObjectMove} key={recordFor.slug} project={recordFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} single={single} onTurn={onTurn} onIntroDone={onIntroDone} size={LP.s} />
        )}
        {printed && (
          <Printout3D key={printed.item.slug} project={printed.item} shelf={printed.shelf} ctl={ctl} mode={printFor ? book : null} single={single} onIntroDone={onIntroDone} diskH={FL.h} />
        )}
        {manualFor && (
          <Manual3D key={manualFor.slug} project={manualFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} single={single} onIntroDone={onIntroDone} boxW={BOX.w} boxH={BOX.h} box />
        )}
        {jcard && (
          <Leaflet3D
            key={jcard.item.slug}
            project={jcard.item}
            shelf={jcard.shelf}
            ctl={ctl}
            mode={jcardFor ? book : null}
            page={page}
            per={per}
            single={single}
            onTurn={onTurn}
            onIntroDone={onIntroDone}
            plan={jcardPlan}
            textures={jcardTextures}
            fromLid
            onSeek={onSeek}
            onObjectMove={onObjectMove}
            onPutAway={() => setJcardBack((n) => n + 1)}
          />
        )}
        {leafFor && (
          <Leaflet3D key={leafFor.slug} project={leafFor} shelf={rows[open.row].shelf} ctl={ctl} mode={book} page={page} per={per} single={single} onTurn={onTurn} onIntroDone={onIntroDone} pace={0.45} />
        )}
      </PerspectiveCamera>
      <color attach="background" args={['#120d0a']} />
      <fog attach="fog" args={['#120d0a', 9, 26]} />
      <ambientLight intensity={0.28} color="#ffd9b0" />
      <directionalLight
        position={[3, 6, 7]}
        intensity={1.6}
        color="#ffe2bf"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-6}
        shadow-camera-right={widest + 6}
        shadow-camera-top={4}
        shadow-camera-bottom={-rows.length * ROW_H - 2}
        // Tight depth range: the old 500-unit default made the bias detach shadows by ~0.2 units.
        shadow-camera-near={0.1}
        shadow-camera-far={60}
        shadow-bias={-0.00001}
        shadow-normalBias={0.01}
        shadow-radius={3}
      />
      <spotLight ref={spot} angle={0.42} penumbra={0.85} intensity={9} decay={1} color="#ffd7a3" />
      <StudioEnvironment />

      {rows.map((r, row) => {
        const Case = CASES[r.shelf.media]
        return (
          <group key={r.id}>
            <Shelf row={row} count={r.projects.length} shelf={r.shelf} top={row === 0} ctl={ctl} open={!!open} />
            <Tint.Provider value={r.shelf.media === 'pcbox' || r.shelf.media === '8track' ? '#c7aa82' : '#e2d8c0'}>
              {mountedRows.has(row) && r.projects.map((p, i) => (
                <group key={p.slug}
                  onPointerOver={(e) => {
                    if (open || ctl.current.dragging || ctl.current.shelfTouch || e.pointerType === 'touch') return
                    e.stopPropagation()
                    if (Math.round(ctl.current.row) === row) {
                      ctl.current.shelfRest = false
                      ctl.current.shelfHover = { row, index: i }
                    }
                  }}
                  onPointerOut={() => {
                    const h = ctl.current.shelfHover
                    if (h?.row === row && h.index === i) ctl.current.shelfHover = null
                  }}
                >
                  <Case project={p} shelf={r.shelf} row={row} index={i} ctl={ctl} open={open} onPick={onPick} lid={!!book && open?.row === row && open?.index === i} />
                </group>
              ))}
            </Tint.Provider>
          </group>
        )
      })}

      <mesh
        ref={dim}
        // three.js picks hidden meshes too, so the backdrop only catches clicks while it's showing
        raycast={function (rc, hits) {
          if (this.visible) THREE.Mesh.prototype.raycast.call(this, rc, hits)
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (!ctl.current.moved) onClose()
        }}
      >
        <planeGeometry args={[60, 30]} />
        <meshBasicMaterial color="#070504" transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  )
}
