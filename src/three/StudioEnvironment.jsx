// The store's three softboxes never move. Production loads their lossless, prefiltered
// half-float reflection map instead of compiling the cube capture/PMREM shaders on arrival.
// The bake and the live fallback render this same rig; no approximation of the lighting.
import { useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { manifest } from '../baked.js'

let baked = null
let expired = false
let deadline
export const environmentReady = import.meta.env.PROD ? Promise.race([
  manifest.then(async (m) => {
    if (expired || !m?.environment) return null
    const response = await fetch(`${import.meta.env.BASE_URL}baked/${m.environment}`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) throw new Error(`studio lighting: HTTP ${response.status}`)
    let bytes = await response.arrayBuffer()
    // Static hosts may serve .gz literally or set Content-Encoding and decompress it.
    if (new Uint8Array(bytes)[0] === 0x1f && new Uint8Array(bytes)[1] === 0x8b) {
      bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    }
    if (expired) return null
    const header = new Uint32Array(bytes, 0, 2)
    if (header[0] !== 768 || header[1] !== 1024 || bytes.byteLength !== 8 + header[0] * header[1] * 8) throw new Error('invalid studio lighting map')
    const texture = new THREE.DataTexture(new Uint16Array(bytes, 8), header[0], header[1], THREE.RGBAFormat, THREE.HalfFloatType)
    texture.mapping = THREE.CubeUVReflectionMapping
    texture.colorSpace = THREE.LinearSRGBColorSpace
    texture.minFilter = texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    return texture
  }).catch((error) => { console.warn('[studio] using live lighting', error); return null }),
  new Promise((resolve) => { deadline = setTimeout(() => { expired = true; resolve(null) }, 2800) }),
]).then((texture) => { baked = texture }).finally(() => clearTimeout(deadline)) : Promise.resolve()

function LiveStudio() {
  return <Environment resolution={256}>
    <Lightformer form="rect" intensity={2.2} color="#fff1dc" position={[0, 4, 5]} scale={[10, 3, 1]} />
    <Lightformer form="rect" intensity={1.2} color="#ffb070" position={[-6, 1, 3]} rotation-y={Math.PI / 3} scale={[4, 4, 1]} />
    <Lightformer form="rect" intensity={0.8} color="#bcd0ff" position={[6, 2, 2]} rotation-y={-Math.PI / 3} scale={[4, 3, 1]} />
  </Environment>
}

export default function StudioEnvironment() {
  return baked ? <Environment map={baked} /> : <LiveStudio />
}

// Called only by scripts/bake.mjs on its otherwise empty ?bake page.
export async function bakeEnvironment() {
  const host = document.createElement('div')
  host.style.cssText = 'width:256px;height:256px'
  document.body.appendChild(host)
  const root = createRoot(host)
  let deadline
  try {
    return await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('studio lighting bake timed out')), 15000)
      function Capture() {
        const { gl, scene } = useThree()
        useEffect(() => {
          const frame = requestAnimationFrame(async () => {
            const generator = new THREE.PMREMGenerator(gl)
            let target
            try {
              target = generator.fromCubemap(scene.environment)
              const pixels = new Uint16Array(target.width * target.height * 4)
              await gl.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, pixels)
              const bytes = new Uint8Array(8 + pixels.byteLength)
              new Uint32Array(bytes.buffer, 0, 2).set([target.width, target.height])
              bytes.set(new Uint8Array(pixels.buffer), 8)
              // Chunked conversion avoids the argument-count limit on large typed arrays.
              let text = ''
              for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
              resolve(btoa(text))
            } catch (error) { reject(error) }
            finally { target?.dispose(); generator.dispose() }
          })
          return () => cancelAnimationFrame(frame)
        }, [gl, scene])
        return <LiveStudio />
      }
      root.render(<Canvas><Capture /></Canvas>)
    })
  } finally { clearTimeout(deadline); root.unmount(); host.remove() }
}
