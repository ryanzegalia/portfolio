import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createShadowTracker } from '../src/three/shadow-updates.js'

function fixture() {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
  caster.castShadow = true
  group.add(caster)
  scene.add(group)
  const changed = createShadowTracker()
  return { scene, group, caster, sample: () => { scene.updateMatrixWorld(); return changed(scene) } }
}

test('initial frame redraws; stationary wall and stationary held case do not', () => {
  const { group, sample } = fixture()
  assert.equal(sample(), true)
  assert.equal(sample(), false)
  group.position.z = 4
  assert.equal(sample(), true)
  assert.equal(sample(), false)
})
test('tracks every animated pose, spin, final put-back, and cumulative slow movement', () => {
  const { group, sample } = fixture()
  sample()
  for (const z of [0.5, 1, 2, 4, 2, 0.5, 0]) {
    group.position.z = z
    assert.equal(sample(), true)
  }
  group.rotation.y = 0.3
  assert.equal(sample(), true)
  assert.equal(sample(), false)
  group.position.z += 0.000006
  assert.equal(sample(), false)
  group.position.z += 0.000006
  assert.equal(sample(), true)
})
test('hidden parents, replacement casters, and removed casters invalidate', () => {
  const { scene, group, caster, sample } = fixture()
  sample()
  group.visible = false
  assert.equal(sample(), true)
  assert.equal(sample(), false)
  group.visible = true
  assert.equal(sample(), true)
  group.remove(caster)
  group.add(caster.clone())
  assert.equal(sample(), true)
  scene.remove(group)
  assert.equal(sample(), true)
})
test('camera and non-casting fill light movement do not redraw fixed-light shadows', () => {
  const { scene, sample } = fixture()
  const camera = new THREE.PerspectiveCamera()
  const light = new THREE.SpotLight()
  scene.add(camera, light)
  sample()
  camera.position.x = 5
  light.position.y = 6
  assert.equal(sample(), false)
})
