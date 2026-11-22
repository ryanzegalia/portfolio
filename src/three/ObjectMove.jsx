// Optional controls live on the object; the same action is exposed in the reading hint.
import { useEffect } from 'react'
import { Html } from '@react-three/drei'

export function useObjectMove(ctl, mode, report, move) {
  useEffect(() => {
    if (mode !== 'open' || !move) return
    ctl.current.objectMove = move
    report(move)
    return () => {
      if (ctl.current.objectMove === move) {
        ctl.current.objectMove = null
        report(null)
      }
    }
  }, [ctl, mode, report, move])
}

export function ObjectButton({ move, position, children, kind = '' }) {
  return <Html position={position} center zIndexRange={[12, 1]}>
    <button type="button" className={`object-button ${kind}`} data-object-move={move.key}
      aria-label={move.label} aria-pressed={move.active} aria-keyshortcuts={move.key.toUpperCase()} title={`${move.label} (${move.key.toUpperCase()})`}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); move.activate() }}>
      {children}
    </button>
  </Html>
}
