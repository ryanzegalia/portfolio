import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { tapeShell } from './printed.js'
import { ObjectButton, useObjectMove } from './ObjectMove.jsx'

// The tray's tape is set beside the readable J-card. This is not another case:
// Scene hides its shell while this camera-space shell is in the reader's hand.
export default function CassetteMove({ project, shelf, ctl, mode, single, per, onSeek, onObjectMove }) {
  const { size, gl } = useThree()
  const root = useRef(), shell = useRef()
  const [sideB, setSideB] = useState(false)
  const [maps, setMaps] = useState(null)
  const move = useMemo(() => ({ key: 'b', active: sideB,
    label: sideB ? 'Flip to side A · who it is for' : 'Flip to side B · how it went',
    activate: () => { setSideB(!sideB); onSeek(sideB ? 0 : Math.min(3, 5 - per)) },
  }), [sideB, per, onSeek])
  useObjectMove(ctl, mode, onObjectMove, move)
  useEffect(() => {
    let live = true
    let made
    Promise.all(['A', 'B'].map((side) => tapeShell(project, shelf, side))).then((t) => {
      made = t
      if (live) { t.forEach((x) => gl.initTexture(x)); setMaps(t) }
      else t.forEach((x) => x.dispose())
    })
    return () => { live = false; made?.forEach((x) => x.dispose()) }
  }, [project, shelf, gl])
  useEffect(() => {
    if (mode !== 'open') setSideB(false)
    return () => { ctl.current.cassetteMoveOut = false; gl.domElement.style.cursor = '' }
  }, [ctl, mode, gl])
  useFrame((state, dt) => {
    if (!root.current || !shell.current) return
    const c = ctl.current
    const visible = mode === 'open' && !!maps
    root.current.visible = visible
    c.cassetteMoveOut = visible
    if (!visible) return
    // A small, reachable shell at the paper's upper right, clear of the first text.
    const unit = 2 * Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2)) / size.height
    const compact = single && size.height < 650
    root.current.position.set((size.width * (single ? (compact ? 0.9 : 0.5) : 0.78) - size.width / 2) * unit, (size.height / 2 - (single ? (compact ? 170 : 92) : 145)) * unit, -1)
    root.current.scale.setScalar((single ? (compact ? 70 : 100) : 132) * unit / 1.38)
    const target = sideB ? -Math.PI : 0
    shell.current.rotation.y = c.reduced ? target : THREE.MathUtils.damp(shell.current.rotation.y, target, 9, dt)
    const pose = single && !compact ? -Math.PI / 2 : 0
    shell.current.rotation.z = c.reduced ? pose : THREE.MathUtils.damp(shell.current.rotation.z, pose, 12, dt)
    shell.current.position.z = Math.abs(Math.sin(shell.current.rotation.y)) * 0.18
  })
  return <group ref={root} visible={false}>
    <group ref={shell} onClick={(e) => { e.stopPropagation(); if (!ctl.current.moved) move.activate() }} onPointerOver={() => { gl.domElement.style.cursor = 'pointer' }} onPointerOut={() => { gl.domElement.style.cursor = '' }}>
      <RoundedBox args={[0.88, 1.38, 0.11]} radius={0.02} smoothness={3}><meshPhysicalMaterial color="#242429" roughness={0.38} clearcoat={0.6} /></RoundedBox>
      {[0, 1].map((i) => <mesh key={i} position={[0, 0, i ? -0.056 : 0.056]} rotation={[0, i ? Math.PI : 0, 0]}>
        <planeGeometry args={[0.86, 1.36]} /><meshStandardMaterial map={maps?.[i]} color={maps ? '#ffffff' : '#28282b'} roughness={0.4} />
      </mesh>)}
    </group>
    {mode === 'open' && <ObjectButton move={move} kind="cassette" position={single && size.height >= 650 ? [0.38, 0, 0.09] : [0, -0.46, 0.09]}>{sideB ? 'B → A' : 'A → B'}</ObjectButton>}
  </group>
}
