import { useEffect, useMemo, useState } from 'react'
import { PROJECTS } from './projects.js'
import { PICKS } from './picks.js'

const bySlug = new Map(PROJECTS.map((project) => [project.slug, project]))

export default function StaffPicks({ project, active, atEnd, watchManual, ctl, onChoose, compact = false, compactLabel = 'Staff picks · 2' }) {
  const [manualEnd, setManualEnd] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [project?.slug, active, atEnd])
  const picks = useMemo(
    () => (PICKS[project?.slug] || []).map((pick) => ({ ...pick, project: bySlug.get(pick.slug) })).filter((pick) => pick.project),
    [project?.slug],
  )

  useEffect(() => setManualEnd(false), [project?.slug, active])

  useEffect(() => {
    if (!active || !watchManual) return
    const check = () => {
      const c = ctl.current
      if (Number.isFinite(c.manualMax)) {
        const end = c.manualMax <= 2 || Math.max(c.manualPos || 0, c.manualTarget || 0) >= c.manualMax - 2
        setManualEnd((was) => (was === end ? was : end))
      }
    }
    // The manual only changes on scene frames. Do not poll it at 60 Hz while
    // someone is reading, or while the canvas is hidden.
    ctl.current.manualEndTick = check
    return () => { if (ctl.current.manualEndTick === check) ctl.current.manualEndTick = null }
  }, [active, watchManual, ctl, project?.slug])

  if (!active || !(atEnd || manualEnd) || picks.length !== 2) return null

  // Finishing a phone panel must not resize the reading surface. Recommendations are optional,
  // rather than stealing the last panel's space as soon as the reader reaches it.
  if (compact && !expanded) return <button className="staff-picks-tab tag" onClick={() => setExpanded(true)} aria-label="Staff picks" aria-expanded={false}>{compactLabel}</button>

  return (
    <aside className="staff-picks" aria-label={`Staff picks after ${project.title}`}>
      <p className="staff-picks-kicker">Staff picks</p>
      {compact && <button className="tag" onClick={() => setExpanded(false)} aria-expanded={true}>Back to the paper</button>}
      <p className="staff-picks-note">If that was your kind of thing:</p>
      <div className="staff-picks-list">
        {picks.map((pick) => (
          <button key={pick.slug} type="button" onClick={() => onChoose(pick.slug)}>
            <strong>{pick.project.title}</strong>
            <span>{pick.reason}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
