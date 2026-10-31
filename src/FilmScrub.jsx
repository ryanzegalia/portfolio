// The thin bar under the film's frame count: one cell per frame and a thumb as wide as the frames
// on screen. Click a cell to jump there, or drag the thumb along; it follows the film as it runs.
import { useEffect, useRef } from 'react'

export default function FilmScrub({ ctl, n, view, onSeek }) {
  const bar = useRef()
  const thumb = useRef()
  useEffect(() => {
    let last
    const tick = () => {
      const at = ctl.current.filmView || 0
      if (thumb.current && at !== last) {
        thumb.current.style.transform = `translateX(${(at / n) * 100 * (n / view)}%)`
        last = at
      }
    }
    // Follow the film's rendered pose, without a second RAF loop that keeps
    // running while the visitor reads (or while the canvas is off screen).
    ctl.current.filmScrubTick = tick
    tick()
    return () => { if (ctl.current.filmScrubTick === tick) ctl.current.filmScrubTick = null }
  }, [ctl, n, view])
  // where along the film a pointer is, in frames, with the window centred on it
  const at = (e) => {
    const r = bar.current.getBoundingClientRect()
    return ((e.clientX - r.left) / r.width) * n - view / 2
  }
  const down = (e) => {
    e.stopPropagation()
    bar.current.setPointerCapture(e.pointerId)
    onSeek(at(e), false)
  }
  const move = (e) => bar.current.hasPointerCapture(e.pointerId) && onSeek(at(e), false)
  const up = (e) => {
    if (!bar.current.hasPointerCapture(e.pointerId)) return
    bar.current.releasePointerCapture(e.pointerId)
    onSeek(at(e), true)
  }
  return (
    <div className="scrub" ref={bar} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} role="presentation">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
      <b ref={thumb} style={{ width: `${(view / n) * 100}%` }} />
    </div>
  )
}
