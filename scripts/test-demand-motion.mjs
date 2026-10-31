import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createPoseTracker, onShelfWake, wakeShelf, continueShelfMotion, takeShelfMotion } from '../src/three/motion-wake.js'

const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera()
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
const light = new THREE.PointLight()
scene.add(mesh, light)
const changed = createPoseTracker()
assert.equal(changed(scene, camera), true)
assert.equal(changed(scene, camera), false)
mesh.position.x = 0.0000006
assert.equal(changed(scene, camera), false)
mesh.position.x = 0.0000012
assert.equal(changed(scene, camera), true, 'sub-epsilon movements must accumulate')
assert.equal(changed(scene, camera), false)
mesh.material.opacity = 0.5
assert.equal(changed(scene, camera), true, 'store dimming')
light.intensity = 0.5
assert.equal(changed(scene, camera), true, 'lighting')
camera.position.z = 2
assert.equal(changed(scene, camera), true, 'camera outside scene graph')
mesh.visible = false
assert.equal(changed(scene, camera), true, 'hidden geometry')
scene.remove(mesh)
assert.equal(changed(scene, camera), true, 'removed geometry')
assert.equal(changed(scene, camera), false)
let wakes = 0
const off = onShelfWake(() => wakes++)
wakeShelf(); assert.equal(wakes, 1)
off(); wakeShelf(); assert.equal(wakes, 1, 'unmount removes wake listener')
continueShelfMotion(); assert.equal(takeShelfMotion(), true)
assert.equal(takeShelfMotion(), false, 'pending fade/hold is consumed per frame')
console.log('Demand motion: 15 assertions passed')
