// The insert that comes out of the case: what it is, how it works, what broke, proof, credits.
// Every media type has one; only its name changes (behind the scenes, manual, liner notes...).
import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtDay, fmtMonth, numbers } from './projects.js'
import ProofLightbox from './ProofLightbox.jsx'

function Numbers({ p }) {
  const { items, note } = numbers(p)
  return (
    <dl className="numbers">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {note && <p className="fine">{note}</p>}
    </dl>
  )
}

// The On the clock shelf: the job, the problems solved and the tools, in the manual's order.
function Job({ p }) {
  return (
    <>
      {p.sticker && <p className="fine">{p.sticker}</p>}
      <section>
        <h3>The job</h3>
        <p>{p.what}</p>
      </section>
      <section>
        <h3>What I do</h3>
        <ul className="built">
          {p.does?.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Problems I solved</h3>
        <div className="broke">
          {p.solved?.map((s) => (
            <div key={s.problem} className="card">
              <h4>{s.problem}</h4>
              <p>{s.did}</p>
              <p>{s.ended}</p>
            </div>
          ))}
        </div>
      </section>
      {p.tools?.length > 0 && (
        <section>
          <h3>{p.tools.length > 1 ? 'Tools I built for it' : 'A tool I built for it'}</h3>
          <ul className="built">
            {p.tools.map((t) => (
              <li key={t.name}>
                <b>{t.name}:</b> {t.line}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>The story</h3>
        {p.story?.map((para) => (
          <p key={para.slice(0, 40)}>{para}</p>
        ))}
      </section>
      <section className="credits">
        <h3>Works with</h3>
        <p>{p.worksWith}</p>
        <p className="tech">Done on the clock by Ryan Zegalia.</p>
      </section>
    </>
  )
}

// The text reader uses the same selected records as the printed maintenance card.
function ServiceRecord({ p }) {
  const record = p.making.serviceRecord
  const started = p.started || p.history?.started || p.stats?.started || p.stats?.first
  return (
    <>
      <section>
        <h3>Service log</h3>
        <p>{record.purpose}</p>
        {started && <p>Started <time dateTime={started}>{fmtMonth(started)}</time>.</p>}
        <h4>Selected entries</h4>
        <ol className="log">
          {record.entries.map((entry) => (
            <li key={`${entry.date}${entry.text}`}>
              <time dateTime={entry.date}>{fmtDay(entry.date)}</time>
              <p>{entry.text} <small>RZ</small></p>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3>On the bench</h3>
        <p>Observed <time dateTime={record.receipt.date}>{fmtDay(record.receipt.date)}</time></p>
        <h4>{record.receipt.title}</h4>
        <p>{record.receipt.text}</p>
      </section>
      <section>
        <h3>How the parts connect</h3>
        <ol className="how">{record.route.map((part) => <li key={part}>{part}</li>)}</ol>
        <h4>Keep in service</h4>
        <p>{record.care}</p>
      </section>
      <section className="credits">
        <h3>Parts and labor</h3>
        {p.making.credits.map((credit) => <p key={credit}>{credit}</p>)}
      </section>
    </>
  )
}

export default function Booklet({ p, shelf, onClose }) {
  const mk = p.making || {}
  const job = !!p.does
  const [proofIndex, setProofIndex] = useState(null)
  const closeProof = useCallback(() => setProofIndex(null), [])
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const prior = document.activeElement
    const store = dialog.closest('.store')
    const background = [...(store?.children || [])].filter((node) => node !== dialog && !node.hasAttribute('inert'))
    background.forEach((node) => node.setAttribute('inert', ''))
    const focus = requestAnimationFrame(() => closeButtonRef.current?.focus())
    const containFocus = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null)
      if (!controls.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', containFocus, true)
    return () => {
      cancelAnimationFrame(focus)
      document.removeEventListener('keydown', containFocus, true)
      background.forEach((node) => node.removeAttribute('inert'))
      requestAnimationFrame(() => {
        if (prior && prior !== document.body && document.contains(prior)) prior.focus()
      })
    }
  }, [onClose])

  const proofStills = (mk.proof || [])
    .filter((item) => item.type === 'image')
    .map((item) => ({ ...item, src: p.img(item.src), source: item }))
    .filter((item) => item.src)
  return (
    <div ref={dialogRef} className="booklet-wrap" role="dialog" aria-modal="true" aria-label={`${p.title}: ${shelf.extras}`} onClick={onClose}>
      <article className="booklet" onClick={(e) => e.stopPropagation()}>
        <button ref={closeButtonRef} className="booklet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <header>
          <span className="stamp" style={{ color: shelf.color, borderColor: shelf.color }}>
            {shelf.extras}
          </span>
          <h2>{p.title}</h2>
          <p className="tagline">{p.tagline}</p>
          <p className="byline">A Ryan Zegalia production · {p.credit}</p>
        </header>

        {job ? <Job p={p} /> : mk.serviceRecord ? <ServiceRecord p={p} /> : null}

        {!job && !mk.serviceRecord && (
          <>
        <section>
          <h3>What it is</h3>
          <p>{p.what}</p>
          {mk.problem && (
            <>
              <h4>Why it needed to exist</h4>
              <p>{mk.problem}</p>
            </>
          )}
        </section>

        <section>
          <h3>What I built</h3>
          <ul className="built">
            {p.built?.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>

        {p.moment && (
          <section>
            <h3>How it went</h3>
            <p>
              {p.moment.when && <b>{p.moment.when}. </b>}
              {p.moment.what}
            </p>
          </section>
        )}

        {p.journey && (
          <section>
            <h3>One request, start to finish</h3>
            <ol className="how">
              {p.journey.map((st) => (
                <li key={st.name}>
                  <b>{st.name}.</b> {st.adds} <i>In this example:</i> {st.example}
                </li>
              ))}
            </ol>
          </section>
        )}

        {(p.steps || p.frames) && (
          <section>
            <h3>{p.frames ? 'Scene by scene' : 'How it works'}</h3>
            {/* the film opens on its title card, so its stages are scenes 2 onward */}
            <ol className="how" style={p.frames ? { counterReset: 'step 1' } : undefined}>
              {(p.steps || p.frames).map((st) => (
                <li key={st.name}>
                  <b>{st.name}.</b> {st.says}
                </li>
              ))}
            </ol>
          </section>
        )}

        {p.tracks && (
          <section>
            <h3>Track list</h3>
            <div className="tracks">
              {['a', 'b'].map((side) =>
                p.tracks[side]?.length ? (
                  <div key={side}>
                    <h4>Side {side.toUpperCase()}</h4>
                    <ol>
                      {p.tracks[side].map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ol>
                  </div>
                ) : null,
              )}
            </div>
          </section>
        )}

        {mk.how && (
          <section>
            <h3>How it works</h3>
            <ol className="how">
              {mk.how.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
        )}

        {mk.log && (
          <section>
            <h3>Service log</h3>
            <ol className="log">
              {mk.log.map((x) => (
                <li key={`${x.date}${x.text}`}>
                  <time dateTime={x.date}>{fmtDay(x.date)}</time>
                  <p>{x.text}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {mk.broke?.length > 0 && (
          <section>
            <h3>The hard parts</h3>
            <div className="broke">
              {mk.broke.map((b) => (
                <div key={b.title} className="card">
                  <h4>{b.title}</h4>
                  <p>{b.body}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {mk.proof && (
          <section>
            <h3>{shelf.proof}</h3>
            <div className="proof">
              {mk.proof.map((x, i) =>
                x.type === 'image' ? (
                  <figure key={i}>
                    <button
                      className="proof-still"
                      type="button"
                      aria-label={`View large: ${x.caption}`}
                      onClick={() => {
                        const index = proofStills.findIndex((still) => still.source === x)
                        if (index >= 0) setProofIndex(index)
                      }}
                    >
                      <img src={p.img(x.src)} alt={x.caption} loading="lazy" />
                      <span aria-hidden="true">View large</span>
                    </button>
                    <figcaption>{x.caption}</figcaption>
                  </figure>
                ) : (
                  <figure key={i} className="quote">
                    <div className="screen">{x.text}</div>
                    <figcaption>{x.caption}</figcaption>
                  </figure>
                ),
              )}
            </div>
          </section>
        )}

        {!mk.serviceRecord && numbers(p).items.length > 0 && <section>
          <h3>Project record</h3>
          <Numbers p={p} />
        </section>}

        <section className="credits">
          <h3>Credits</h3>
          {(mk.credits || [`Built by Ryan Zegalia`]).map((c) => (
            <p key={c}>{c}</p>
          ))}
          <p className="tech">Made with {(p.requirements || []).join(' · ')}</p>
        </section>
          </>
        )}
      </article>
      {proofIndex !== null && <ProofLightbox items={proofStills} index={proofIndex} onIndex={setProofIndex} onClose={closeProof} />}
    </div>
  )
}
