// A shareware floppy's README, printed out. The disk's shutter slides open, the disk drops into the
// machine, and a dot-matrix printer feeds the README up out of its slot on green-bar tractor paper, the
// head striking each row as it comes. Only the first screenful prints, in about a third of a second; the rest
// of the sheet is already through the printer, so scrolling (wheel, drag, arrow keys, Page Down) pulls
// more paper up out of the slot. Putting it back runs the same way in reverse, faster. Like the other
// inserts it lives in the camera's own space; the disk itself is moved by its case (ctl.disk).
import { tempo } from './pace.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { printoutTextures } from './printed.js'

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp
const span = (t, [a, b]) => clamp((t - a) / (b - a), 0, 1)
const out = (t) => 1 - (1 - t) ** 3
const smooth = (t) => t * t * (3 - 2 * t)
// the intro, in seconds from the tap, all overlapping: the shutter slides open, the printer comes up
// into view, the disk goes in, and the first screenful feeds out, settling by about 0.35 s
const SHUT = [0.02, 0.1]
const RISE = [0.05, 0.16]
const DROP = [0.15, 0.23]
const FEED = [0.17, 0.35]
const NORMAL_FEED = [0.13, 0.29]
// putting it back: the paper feeds back in, the disk comes back up, the printer goes, the shutter shuts
const BACK = { feed: [0, 0.12], disk: [0.04, 0.16], sink: [0.08, 0.2], shut: [0.12, 0.22] }
// paper (px) above the row being struck, so it clears the bail bar
const LEAD = 22
// where the head parks and how far it travels, across the sheet (0 to 1)
const HOME = 0.09
const REACH = 0.94
const BEIGE = '#d9cfb6'
const noRay = () => null

// The head's reveal, in the paper's shader: rows above uCut (px down the sheet) are printed, the row
// under the head is printed as far across as uHead, and below that it's still blank paper.
const STRUCK = /* glsl */ `
  vec4 struck = texture2D( map, vMapUv );
  float down = uTop + ( 1.0 - vMapUv.y ) * uH;
  if (down < uVisibleTop || down > uVisibleBottom) discard;
  vec4 blank = texture2D( uPaper, vec2( vMapUv.x, 1.0 - down / uTile ) );
  float inked = down < uCut ? 1.0 : down < uCut + uRow ? 1.0 - smoothstep( uHead - 0.006, uHead, vMapUv.x ) : 0.0;
  vec4 sampledDiffuseColor = mix( blank, struck, inked );
  diffuseColor *= sampledDiffuseColor;
`

export default function Printout3D({ project, shelf, ctl, mode, single, onIntroDone, diskH }) {
  const { size, gl } = useThree()
  const [tex, setTex] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    printoutTextures(project, shelf).then((t) => {
      made = t
      if (!live) return
      for (const s of t.strips) gl.initTexture(s.tex)
      gl.initTexture(t.paper)
      setTex(t)
    })
    return () => {
      live = false
      if (made) {
        for (const s of made.strips) s.tex.dispose()
        made.paper.dispose()
      }
    }
  }, [project, shelf, gl])
  useEffect(() => () => void (ctl.current.disk = null), [ctl])

  // shared by every strip of the sheet, so the head moves once for all of them
  const print = useMemo(() => ({ uCut: { value: 0 }, uRow: { value: 0 }, uHead: { value: 0 }, uPaper: { value: null }, uVisibleTop: { value: 0 }, uVisibleBottom: { value: 0 } }), [])
  const reveal = useMemo(
    () =>
      tex?.strips.map((s) => (shader) => {
        Object.assign(shader.uniforms, print, { uTop: { value: s.top }, uH: { value: s.h * tex.px }, uTile: { value: tex.tile } })
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', 'uniform sampler2D uPaper;\nuniform float uTop, uH, uTile, uCut, uRow, uHead, uVisibleTop, uVisibleBottom;\nvoid main() {')
          .replace('#include <map_fragment>', STRUCK)
          .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= sampledDiffuseColor.rgb;')
      }),
    [tex, print],
  )

  const group = useRef()
  const sheet = useRef()
  const machine = useRef()
  const head = useRef()
  const st = useRef({ mode: null, t0: 0, pace: 1, sent: false, closing: null, emerged: 0, shutter: 0, drop: 0, rise: 0, headU: HOME })

  useFrame((state, dt) => {
    const g = group.current
    if (!g || !tex) return
    // This auxiliary sampler bypasses the standard material map; follow its late ink upload too.
    print.uPaper.value = tex.paper.userData.print?.ink || tex.paper
    const c = ctl.current
    const s = st.current
    const now = state.clock.elapsedTime
    const tan = Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2))
    // keep clear of the header and the buttons (px), the same reading space as the manual
    const top = single ? 112 : 84
    const bottom = single ? 164 : 132
    const widthPx = single ? size.width * 0.94 : Math.min(size.width * 0.62, 760)
    const dist = size.height / (2 * tan * widthPx)
    const unit = size.height / (2 * tan * dist)
    const readTop = (size.height / 2 - top) / unit
    const px = tex.px
    const available = (size.height - top - bottom) / unit * px
    // Stop between complete lines: rows already include the descender space. The animation's
    // longer LEAD would reveal the next line's ascenders at rest, just above the bail bar.
    const restLead = single ? 24 : 8
    const lastRow = tex.rows.findLast((r) => r <= available - restLead) || 0
    const full = Math.min(available, lastRow + restLead)
    const readH = full / px
    const slot = readTop - readH
    const below = -size.height / 2 / unit - 0.12
    c.manualMax = Math.max(0, tex.height - readH + LEAD / px)
    c.manualPx = unit

    if (mode !== s.mode) {
      // Hold the open shutter before insertion, then give each line an even carriage pass; reduced
      // motion lands on the end state
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const pace = tempo(c, mode ? 2.7 : 2.3)
      if (mode === 'intro') {
        Object.assign(s, { t0: still ? now - 9 : now, pace, sent: false, closing: null })
        c.manualTarget = 0
        c.manualPos = 0
        g.visible = true
      } else if (!mode && g.visible) s.closing = { at: still ? now - 9 : now, pace, emerged: s.emerged, shutter: s.shutter, drop: s.drop, rise: s.rise }
      s.mode = mode
    }
    if (!g.visible) {
      c.bookIntro = mode === 'intro'
      return
    }
    // The printer starts feeding while the disk seats; keep the shutter and carriage beats.
    const feed = c.show ? FEED : NORMAL_FEED
    let e = mode ? (now - s.t0) / s.pace : 0
    // a tap skips to the whole sheet; so does reaching for the wheel while it prints
    if (mode === 'intro' && e < feed[1] && (c.manualTarget || 0) > 0) c.bookSkip = true
    if (c.bookSkip || (!mode && c.outroSkip)) {
      c.bookSkip = false
      c.bookSkipAt = performance.now()
      if (mode === 'intro' && e < feed[1]) {
        s.t0 = now - 9
        e = 9
      }
      // a tap while the paper feeds back in puts it all away at once (ctl.outroSkip), disk included
      if (!mode && s.closing) {
        s.closing.at = -1e9
        c.outroSkip = false
      }
    }
    c.bookIntro = mode === 'intro' && e < feed[1]
    c.bookOutro = !mode && !!s.closing
    if (mode === 'intro' && e >= feed[1] && !s.sent) {
      s.sent = true
      onIntroDone()
    }
    c.manualTarget = clamp(c.manualTarget || 0, 0, c.manualMax)
    if (mode && e >= feed[1]) c.manualPos = damp(c.manualPos || 0, c.manualTarget, c.dragging ? 30 : 12, dt)

    let { emerged, shutter, drop, rise, headU } = s
    let cut = 1e9
    let row = 0
    if (mode) {
      shutter = smooth(span(e, SHUT))
      rise = smooth(span(e, RISE))
      drop = smooth(span(e, DROP))
      if (e < feed[1]) {
        // the rows that fill the first screen, one line feed and one pass of the head each
        const rows = tex.rows
        let n = rows.findIndex((r, i) => (i ? rows[i - 1] : 0) >= full - LEAD)
        n = Math.max(1, n < 0 ? rows.length : n)
        const L = n * span(e, feed)
        const i = Math.min(n - 1, Math.floor(L))
        const f = Math.min(1, L - i)
        const from = i ? rows[i - 1] + LEAD : 0
        const to = i === n - 1 ? full : rows[i] + LEAD
        emerged = from + (to - from) * smooth(span(f, [0, 0.35]))
        cut = i ? rows[i - 1] : 0
        row = rows[i] - cut
        headU = lerp(HOME, REACH, span(f, [0.3, 1]))
      } else {
        emerged = full + c.manualPos * px
        headU = HOME
      }
    } else if (s.closing) {
      const C = s.closing
      const k = (now - C.at) / C.pace
      emerged = C.emerged * (1 - out(span(k, BACK.feed)))
      drop = C.drop * (1 - out(span(k, BACK.disk)))
      rise = C.rise * (1 - out(span(k, BACK.sink)))
      shutter = C.shutter * (1 - out(span(k, BACK.shut)))
      if (k > BACK.shut[1]) {
        Object.assign(s, { closing: null, emerged: 0, shutter: 0, drop: 0, rise: 0, headU: HOME })
        c.disk = { shutter: 0, drop: 0, gone: false }
        c.bookOutro = false
        g.visible = false
        return
      }
    }
    Object.assign(s, { emerged, shutter, drop, rise, headU })

    const slotNow = lerp(below, slot, rise)
    machine.current.position.set(0, slotNow, -dist)
    sheet.current.position.set(0, slotNow + emerged / px, -dist)
    head.current.position.x = headU - 0.5
    print.uVisibleTop.value = Math.max(0, emerged - full)
    print.uVisibleBottom.value = emerged
    print.uCut.value = cut
    print.uRow.value = row
    print.uHead.value = headU
    // far enough that the disk's top edge goes down behind the printer, wherever the slot sits
    const need = diskH / 2 + 0.2 - (slot / dist) * (c.cartDist || 4)
    // A small unseating lift precedes the slide into the drive, without a springy bounce.
    const lift = mode ? 0.06 * smooth(span(e, [0, 0.02])) * (1 - smooth(span(e, [0.1, 0.15]))) : 0
    c.disk = { shutter, drop: drop * need - lift, gone: drop > 0.999 }
  })

  // a tap while it's still printing finishes the intro
  const onClick = (e) => {
    if (!mode) return
    e.stopPropagation()
    const c = ctl.current
    if (c.bookIntro && !c.moved) c.bookSkip = true
  }
  const raycast = mode ? THREE.Mesh.prototype.raycast : noRay
  const steel = <meshStandardMaterial color="#b9bcc0" metalness={0.8} roughness={0.32} />
  const dark = <meshStandardMaterial color="#2b2826" roughness={0.55} metalness={0.2} />

  let y = 0
  return (
    <group ref={group} visible={false}>
      <group ref={sheet}>
        {tex?.strips.map((s, i) => {
          const cy = y - s.h / 2
          y -= s.h
          return (
            <mesh key={i} position={[0, cy, 0]} onClick={onClick} raycast={raycast}>
              <planeGeometry args={[1, s.h]} />
              <meshStandardMaterial map={s.tex} roughness={0.86} metalness={0} emissive="#ffffff" emissiveIntensity={0.34} onBeforeCompile={reveal[i]} />
            </mesh>
          )
        })}
      </group>
      {/* the printer, its top at the slot: a beige case with a disk drive in front, the paper slot with
          the bail bar across it, a tractor over each row of holes, and the head on its rail */}
      <group ref={machine}>
        <RoundedBox args={[1.24, single ? 0.22 : 0.9, 0.36]} radius={0.025} smoothness={3} position={[0, single ? -0.11 : -0.45, 0.05]} onClick={onClick} raycast={raycast}>
          <meshStandardMaterial color={BEIGE} roughness={0.62} emissive={BEIGE} emissiveIntensity={0.16} />
        </RoundedBox>
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRay}>
          <planeGeometry args={[1.04, 0.035]} />
          <meshBasicMaterial color="#120e0b" />
        </mesh>
        <mesh position={[-0.3, -0.075, 0.232]} raycast={noRay}>
          <planeGeometry args={[0.34, 0.022]} />
          <meshBasicMaterial color="#15110e" />
        </mesh>
        <mesh position={[0.5, 0.002, 0.17]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRay}>
          <circleGeometry args={[0.009, 16]} />
          <meshBasicMaterial color="#7dff8a" />
        </mesh>
        <mesh position={[0, 0.008, 0.03]} rotation={[0, 0, Math.PI / 2]} raycast={noRay}>
          <cylinderGeometry args={[0.006, 0.006, 1.06, 12]} />
          {steel}
        </mesh>
        {[-0.34, -0.12, 0.12, 0.34].map((x) => (
          <mesh key={x} position={[x, 0.008, 0.03]} rotation={[0, 0, Math.PI / 2]} raycast={noRay}>
            <cylinderGeometry args={[0.012, 0.012, 0.035, 16]} />
            <meshStandardMaterial color="#1d1b1a" roughness={0.8} />
          </mesh>
        ))}
        {[-0.47, 0.47].map((x) => (
          <RoundedBox key={x} args={[0.08, 0.05, 0.14]} radius={0.01} smoothness={2} position={[x, 0.025, 0]} raycast={noRay}>
            {dark}
          </RoundedBox>
        ))}
        <group ref={head} position={[HOME - 0.5, 0.012, 0.06]}>
          <mesh raycast={noRay}>
            <boxGeometry args={[0.06, 0.045, 0.05]} />
            {dark}
          </mesh>
        </group>
      </group>
    </group>
  )
}
