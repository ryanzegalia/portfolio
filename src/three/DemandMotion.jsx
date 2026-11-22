import { useLayoutEffect, useRef } from 'react'
import { addEffect, useThree } from '@react-three/fiber'
import { createPoseTracker, onShelfWake, takeShelfMotion } from './motion-wake.js'

// Four unchanged samples, three rendered frames apart, cover spring reversals
// and chained callbacks. Animations still render at full refresh rate; only the
// settling check runs less often. No guessed duration drives a motion.
const SAMPLE_EVERY = 3
const SETTLED_SAMPLES = 4
export default function DemandMotion({ ctl, book }) {
  const { scene, camera, clock, gl, invalidate, get, setFrameloop, frameloop } = useThree()
  const syncVisibility = useRef(() => {})
  const mode = useRef(book)
  mode.current = book
  useLayoutEffect(() => {
    const changed = createPoseTracker()
    let quiet = 0, sampleFrame = 0, sleeping = true
    const wake = () => { quiet = 0; sampleFrame = 0; invalidate() }
    const before = addEffect(() => {
      // R3F computes dt before useFrame. Discard sleeping time BEFORE that
      // computation, including wakes caused by React rather than our listeners.
      // Otherwise the first damp/spring update jumps straight to its target.
      // Test the sleep state, never a frame-time threshold: a slow device must
      // still advance its animation, even when active frames are far apart.
      if (sleeping && get().internal.frames > 0) {
        clock.getDelta()
        quiet = sampleFrame = 0 // React/resize can wake us without an input event.
        sleeping = false
      }
    })
    const after = scene.onAfterRender
    scene.onAfterRender = function (...args) {
      after.apply(this, args)
      ctl.current.filmScrubTick?.()
      ctl.current.manualEndTick?.()
      const pending = takeShelfMotion() || mode.current === 'intro' || !!ctl.current.bookOutro || !!ctl.current.step
      // Explicit phases already keep the renderer awake; scanning their poses
      // adds CPU work without changing the sleep decision.
      if (pending) quiet = sampleFrame = 0
      else if (++sampleFrame >= SAMPLE_EVERY) {
        sampleFrame = 0
        quiet = changed(scene, camera) ? 0 : quiet + 1
      }
      sleeping = quiet >= SETTLED_SAMPLES
      if (!sleeping) invalidate()
    }
    const off = onShelfWake(wake)
    // Capture includes DOM controls, keyboard, touch, wheel and ref-only hover.
    const events = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'click']
    for (const event of events) window.addEventListener(event, wake, { capture: true, passive: true })
    gl.domElement.addEventListener('pointerleave', wake)
    let inView = true, suspended = false
    const visibility = () => {
      const hidden = document.hidden || !inView
      if (hidden === suspended && get().frameloop === (hidden ? 'never' : 'demand')) return
      suspended = hidden
      // setFrameloop resets R3F's clock; retain its elapsed timeline so an
      // insert does not restart or wait for an old timestamp on return.
      const elapsed = clock.elapsedTime
      setFrameloop(hidden ? 'never' : 'demand')
      clock.elapsedTime = elapsed
      sleeping = true
      if (!hidden) wake()
    }
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility() })
    syncVisibility.current = visibility
    observer.observe(gl.domElement)
    document.addEventListener('visibilitychange', visibility)
    visibility()
    wake()
    return () => {
      before(); off(); scene.onAfterRender = after
      for (const event of events) window.removeEventListener(event, wake, true)
      gl.domElement.removeEventListener('pointerleave', wake)
      syncVisibility.current = () => {}
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      if (suspended) {
        const elapsed = clock.elapsedTime
        setFrameloop('demand')
        clock.elapsedTime = elapsed
      }
    }
  }, [scene, camera, clock, gl, invalidate, get, setFrameloop, ctl])
  // A parent React update can reapply Canvas props while off screen.
  useLayoutEffect(() => syncVisibility.current(), [frameloop])
  return null
}
