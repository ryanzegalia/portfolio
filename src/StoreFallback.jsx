import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import Booklet from './Booklet.jsx'
import { coverStill } from './projects.js'
import { graphicsFailure, onGraphicsFailure, graphicsState, chooseList } from './gfx-report.js'
import './store-list.css'

class CanvasBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { graphicsFailure('context', error.message, this.props.generation) }
  render() { return this.state.failed ? null : this.props.children }
}
export function SafeCanvas({ renderMode, renderGeneration, ...props }) {
  const cleanup = useRef(null)
  useEffect(() => () => cleanup.current?.(), [])
  const safe = renderMode !== 'normal'
  return <CanvasBoundary generation={renderGeneration}><Canvas {...props}
    gl={safe ? { ...props.gl, antialias: false } : props.gl}
    dpr={renderMode === 'safe-retry' ? 1 : safe ? [1, 1.25] : props.dpr}
    shadows={renderMode === 'safe-retry' || !graphicsState().shadows ? false : props.shadows}
    onCreated={state => { cleanup.current = props.onCreated?.(state) }}
  /></CanvasBoundary>
}
export function useStoreMode() {
  const [state, setState] = useState(graphicsState)
  useEffect(() => onGraphicsFailure(setState), [])
  const browseList = useCallback(chooseList, [])
  return [state.mode === 'list' ? state.reason : '', browseList, state]
}

// The same project objects and reader as the 3D cases. No second set of copy to drift.
export function StoreList({ rows, reason }) {
  const [selected, select] = useState(null)
  return <>
    <main className="store-list" aria-label="Browse the shelves">
      <p className="list-note" role="status">{reason === 'chosen' ? 'Every aisle, every case.' : 'The 3D store couldn’t be drawn on this device. Browse the shelves here.'}</p>
      {rows.map(({ id, shelf, projects }, index) => <section id={`list-${id}`} key={id} className="list-aisle" aria-labelledby={`list-title-${id}`} style={{ '--shelf-color': shelf.color }}>
        <div className="list-heading"><span>Aisle {String(index + 1).padStart(2, '0')}</span><h2 id={`list-title-${id}`}>{shelf.name}</h2><p>{shelf.line}</p></div>
        <ul className="list-cases">{projects.map(p => {
          const photo = coverStill(p)
          return <li key={p.slug}><button className="list-case" onClick={() => select({ p, shelf })}>
            {photo && <img src={photo.src} alt="" loading="lazy" />}
            <span className="list-case-copy"><strong>{p.title}</strong><span>{p.tagline}</span><small>Read as text <span aria-hidden="true">↗</span></small></span>
          </button></li>
        })}</ul>
      </section>)}
    </main>
    {selected && <Booklet p={selected.p} shelf={selected.shelf} onClose={() => select(null)} />}
  </>
}
