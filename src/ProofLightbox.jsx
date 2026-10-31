import { useEffect, useId, useRef } from 'react'

export default function ProofLightbox({ items, index, onIndex, onClose }) {
  const closeRef = useRef(null)
  const titleId = useId()
  const item = items[index]

  useEffect(() => {
    const prior = document.activeElement
    const focus = requestAnimationFrame(() => closeRef.current?.focus())
    const key = (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        onIndex(index - 1)
      } else if (event.key === 'ArrowRight' && index < items.length - 1) {
        event.preventDefault()
        onIndex(index + 1)
      } else if (event.key === 'Tab') {
        const dialog = closeRef.current?.closest('.proof-lightbox')
        const controls = [...(dialog?.querySelectorAll('button:not(:disabled)') || [])]
        if (!controls.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(focus)
      document.removeEventListener('keydown', key)
      requestAnimationFrame(() => prior?.focus?.())
    }
  }, [index, items.length, onClose, onIndex])

  if (!item) return null

  return (
    <div
      className="proof-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="proof-loupe">
        <div className="proof-loupe-heading">
          <div>
            <p>Proof on the light table</p>
            <h2 id={titleId}>Still {index + 1} of {items.length}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close proof viewer">×</button>
        </div>
        <figure className="proof-slide">
          <img src={item.src} alt={item.caption} />
          <figcaption>{item.caption}</figcaption>
        </figure>
        <div className="proof-loupe-controls">
          <button type="button" onClick={() => onIndex(index - 1)} disabled={index === 0}>Previous</button>
          <div className="proof-slide-tray" aria-label="Choose a proof still">
            {items.map((still, stillIndex) => (
              <button
                key={`${still.src}-${stillIndex}`}
                type="button"
                aria-label={`View proof ${stillIndex + 1}: ${still.caption}`}
                aria-current={stillIndex === index ? 'true' : undefined}
                onClick={() => onIndex(stillIndex)}
              >
                <img src={still.src} alt="" />
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onIndex(index + 1)} disabled={index === items.length - 1}>Next</button>
        </div>
      </div>
    </div>
  )
}
