import { useCallback, useEffect, useRef, useState } from 'react'
import { SafeCanvas as Canvas, StoreList, useStoreMode } from './StoreFallback.jsx'
import Scene, { MEDIA, neighbour } from './three/Scene.jsx'
import DemandMotion from './three/DemandMotion.jsx'
import { wakeShelf } from './three/motion-wake.js'
import { tempo } from './three/Booklet3D.jsx'
import Booklet from './Booklet.jsx'
import { manifest } from './baked.js'
import { environmentReady } from './three/StudioEnvironment.jsx'
import { SHELVES } from './shelves.js'
import { byShelf, coverStill } from './projects.js'
import { bookletPlan } from './three/covers-booklet.js'
import { leafletPlan } from './three/covers-leaflet.js'
import { sleevePlan } from './three/covers-8track.js'
import { manualPlan } from './three/covers-pcbox.js'
import { gatefoldPlan } from './three/covers-laserdisc.js'
import { filmPlan } from './three/covers-filmcan.js'
import FilmScrub from './FilmScrub.jsx'
import { printPlan } from './three/covers-floppy.js'
import { jcardPlan } from './three/covers-cassette.js'
import { vinylPlan } from './three/covers-vinyl.js'
import StaffPicks from './StaffPicks.jsx'
import { CONTACT } from './contact.js'
import ProofLightbox from './ProofLightbox.jsx'
import { track, useTelemetry, watchGraphics } from './telemetry.js'
import { watchRenderer } from './gfx-report.js'

// the wall, top to bottom: every shelf that has something on it
const AISLES = Object.keys(SHELVES)
// shelves whose media isn't built yet stay off the wall until it is
const ROWS = AISLES.filter((id) => byShelf(id).length && MEDIA[SHELVES[id].media]).map((id) => ({ id, shelf: SHELVES[id], projects: byShelf(id) }))
const CONTACT_LINKS = CONTACT.links.filter((link) => link.href)
const FONTS = ['900 100px "Big Shoulders Display"', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"', '400 40px "Barlow Condensed"', '700 30px "Courier Prime"', '400 30px "Courier Prime"']
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
// dark type on a light shelf color (the golds and oranges), cream on a dark one
const inkOn = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55 ? 'var(--ink)' : 'var(--cream)'
}
// a tap (or Enter, or putting the case back) while an insert goes back in puts it away at once
const skipOutro = (c) => Object.assign(c, { bookSkip: true, outroSkip: true })
// which kinds of media have had an insert opened this visit: the first of each kind plays as the
// showcase (ctl.show, pace.js), every later one at the normal pace. Kept in sessionStorage, and in
// memory when storage is off or throws
const SEEN_STORAGE_ID = 'shelf:inserts-seen'
const seen = new Set()
function firstOf(kind) {
  try {
    const was = JSON.parse(sessionStorage.getItem(SEEN_STORAGE_ID) || '[]')
    if (Array.isArray(was)) was.forEach((k) => seen.add(k))
  } catch {}
  if (!kind || seen.has(kind)) return false
  seen.add(kind)
  try {
    sessionStorage.setItem(SEEN_STORAGE_ID, JSON.stringify([...seen]))
  } catch {}
  return true
}
const kindAt = (o) => (o ? ROWS[o.row]?.shelf.media : null)
// Next and Previous from inside a case, in seconds, always at the normal pace (a showcase never slows a step): the insert folds
// back, then the case goes home while the camera glides and the neighbour comes out; its insert starts
// opening a little before the neighbour has arrived
const STEP_FOLD = 0.36
const STEP_CASE = 0.72
const STEP_INSERT = 0.45
const stepKey = (e) => !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'n' || e.key === 'N' ? 1 : e.key === 'p' || e.key === 'P' ? -1 : 0)
const keyBelongsToControl = (target) => !!target?.closest?.('button, a, input, textarea, select, [contenteditable="true"], [role="dialog"], .counter-card, .aisle-directory, .staff-picks')

// what each kind of media comes with, as a modeled object you take out of the case
const INSERTS = { cartridge: bookletPlan, vhs: leafletPlan, '8track': sleevePlan, pcbox: manualPlan, laserdisc: gatefoldPlan, filmcan: filmPlan, floppy: printPlan, cassette: jcardPlan, vinyl: vinylPlan }

// a phone held upright gets one booklet page (or leaflet panel) at a time
const isSingle = () => window.innerWidth < 700 && window.innerHeight > window.innerWidth * 1.1
// an opened leaflet shows three panels across on a wide screen, two on a narrower one
const perView = () => (isSingle() ? 1 : window.innerWidth / window.innerHeight >= 1.45 ? 3 : 2)

// "Page 3 of 6", "Pages 3-4 of 6", "Panels 1-3 of 6"
function pageCount(word, at, step, total) {
  const end = Math.min(total, at + step)
  return end - at > 1 ? `${word}s ${at + 1}-${end} of ${total}` : `${word} ${at + 1} of ${total}`
}

function seenWelcome() {
  try {
    return localStorage.getItem('shelf:welcomed') === '1'
  } catch {
    return false
  }
}

export default function App() {
  const [listReason, browseList, graphics] = useStoreMode()
  const ctl = useRef({ row: 0, rowTarget: 0, rows: ROWS.map(() => ({ offset: 0, target: 0 })), axis: null, dragging: false, moved: false, spinY: 0, spinYTarget: 0, spinX: 0, spinXTarget: 0, camX: 0, pxPerCase: 60, pxPerRow: 300 })
  const [{ row, index: focus, resting }, setFocusState] = useState({ row: 0, index: 0 })
  const shelf = ROWS[row].shelf
  const projects = ROWS[row].projects
  const n = projects.length
  const rowRef = useRef(0)
  rowRef.current = row
  const [open, setOpen] = useState(null)
  const [extras, setExtras] = useState(false)
  const closeExtras = useCallback(() => setExtras(false), [])
  const [proofIndex, setProofIndex] = useState(null)
  const closeProof = useCallback(() => setProofIndex(null), [])
  const [welcome, setWelcome] = useState(() => !seenWelcome())
  const [ready, setReady] = useState(false)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const directoryButtonRef = useRef(null)
  const contactButtonRef = useRef(null)
  const storeRef = useRef(null)
  const welcomeDialogRef = useRef(null)
  const welcomeButtonRef = useRef(null)
  const browseButtonRef = useRef(null)
  const openRef = useRef(null)
  openRef.current = open
  // the insert (a cartridge's booklet, a tape's leaflet): null (in the case), 'intro' (coming out)
  // or 'open' (in your hands)
  const [book, setBook] = useState(null)
  // the film's contact sheet: every frame at once
  const [filmSheet, setFilmSheetState] = useState(false)
  const setFilmSheet = useCallback((on) => {
    ctl.current.filmSheet = on
    setFilmSheetState(on)
  }, [])
  const [page, setPage] = useState(0)
  const [objectMove, setObjectMove] = useState(null)
  const [single, setSingle] = useState(isSingle)
  const [per, setPer] = useState(perView)
  const bookRef = useRef(null)
  bookRef.current = book
  const media = open !== null ? ROWS[open.row].shelf.media : null
  const plan = INSERTS[media]
  // a mixtape's J-card folds out the same way as a rental tape's leaflet
  const isLeaf = media === 'vhs' || media === 'cassette'
  // a PC box's manual, or a floppy's printout, is one long sheet you scroll, not pages you turn
  const isManual = media === 'pcbox' || media === 'floppy'
  const manualRef = useRef(false)
  manualRef.current = isManual
  // a leaflet or J-card reads on to its back panel too
  const pages = plan ? plan(ROWS[open.row].projects[open.index], single).length + (media === 'vhs' || media === 'cassette' ? 1 : 0) : 0
  // how far one turn moves: a page or a spread of the booklet, a screenful of the leaflet
  // a LaserDisc's gatefold lies fully open on a wide screen, one panel at a time on a phone
  const isGate = media === 'laserdisc'
  // a film can's strip runs along like the leaflet: a screenful of frames at a time
  const isFilm = media === 'filmcan'
  const filmRef = useRef(false)
  filmRef.current = isFilm
  // a record's inner sleeve is one sheet: you read a side, then turn it over
  const isVinyl = media === 'vinyl'
  const step = isLeaf ? per : isFilm ? (single ? 1 : per) : isGate ? (single ? 1 : Math.max(1, pages)) : single || isVinyl || media === '8track' ? 1 : 2
  const shown = isLeaf || isFilm || isVinyl || media === '8track' || single ? page : page - (page % 2)
  useTelemetry({ aisle: shelf.name, project: open ? ROWS[open.row].projects[open.index] : null, book, page: shown, pages, extras, contactOpen, directoryOpen })
  const pageRef = useRef(0)
  pageRef.current = shown
  const stepRef = useRef(step)
  stepRef.current = step
  const pagesRef = useRef(0)
  pagesRef.current = pages

  useEffect(() => {
    const resize = () => {
      setSingle(isSingle())
      setPer(perView())
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    // the fonts are only needed to draw the printing; when the build baked it, the wall starts at once
    Promise.all([manifest, environmentReady]).then(([m]) => m && setReady(true))
    Promise.all([...FONTS.map((f) => document.fonts.load(f)), environmentReady]).then(() => setReady(true))
  }, [])

  const dismissWelcome = useCallback(() => {
    setWelcome(false)
    try {
      localStorage.setItem('shelf:welcomed', '1')
    } catch {
      /* private window: show it again next time */
    }
  }, [])

  useEffect(() => {
    if (!welcome || !ready || listReason) return
    const store = storeRef.current
    const prior = document.activeElement
    store?.setAttribute('inert', '')
    const focus = requestAnimationFrame(() => welcomeButtonRef.current?.focus())
    const containFocus = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismissWelcome()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [...(welcomeDialogRef.current?.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])') || [])].filter((node) => !node.disabled)
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
    document.addEventListener('keydown', containFocus, true)
    return () => {
      cancelAnimationFrame(focus)
      store?.removeAttribute('inert')
      document.removeEventListener('keydown', containFocus, true)
      requestAnimationFrame(() => {
        if (prior && prior !== document.body && document.contains(prior)) prior.focus()
        else browseButtonRef.current?.focus()
      })
    }
  }, [welcome, ready, dismissWelcome, listReason])

  const onFocus = useCallback((r, i, resting = false) => setFocusState({ row: r, index: i, resting }), [])
  const openCase = useCallback((r, i) => {
    setDirectoryOpen(false)
    setContactOpen(false)
    setProofIndex(null)
    const c = ctl.current
    Object.assign(c, { shelfRest: false, spinY: 0, spinYTarget: 0, spinX: 0, spinXTarget: 0, bookSkip: false, bookOutro: false })
    c.rows[r].target = i
    clearTimeout(c.closeTimer)
    setOpen({ row: r, index: i })
  }, [])
  const close = useCallback((now) => {
    setProofIndex(null)
    const c = ctl.current
    // the insert goes all the way back in first (at once), so the case is whole when it goes back on
    // the shelf
    if ((bookRef.current || c.bookOutro) && now !== true) {
      skipOutro(c)
      setExtras(false)
      setFilmSheet(false)
      setBook(null)
      return void requestAnimationFrame(() => requestAnimationFrame(() => close(true)))
    }
    c.bookOutro = false
    setExtras(false)
    setFilmSheet(false)
    setBook(null)
    // a film still winding back finishes first, so the can is whole before it goes on the shelf
    const wait = c.filmOpen ? (c.reduced ? 0 : 240 * tempo(c, 1.7)) : (c.windUntil || 0) - performance.now()
    clearTimeout(c.closeTimer)
    if (wait > 0) c.closeTimer = setTimeout(() => setOpen(null), wait)
    else setOpen(null)
  }, [])
  const skipIntro = () => (ctl.current.bookSkip = true)
  const openBook = () => {
    if (bookRef.current) return skipIntro()
    const c = ctl.current
    // face the cartridge forward so the booklet comes out from behind it
    c.spinYTarget = Math.round(c.spinYTarget / (Math.PI * 2)) * Math.PI * 2
    c.bookIntro = true
    c.bookSkip = false
    c.outroSkip = false
    c.show = firstOf(kindAt(openRef.current))
    setPage(0)
    setBook('intro')
  }
  const closeBook = useCallback(() => {
    setExtras(false)
    setProofIndex(null)
    setFilmSheet(false)
    setBook(null)
  }, [setFilmSheet])
  // the insert of the case now in your hands starts coming out (snap: already at its end)
  const beginInsert = useCallback((snap) => {
    const c = ctl.current
    c.spinYTarget = Math.round(c.spinYTarget / (Math.PI * 2)) * Math.PI * 2
    // landing on a kind not yet opened this visit, it plays the showcase (unless the step was skipped)
    Object.assign(c, { bookIntro: true, bookSkip: !!snap, outroSkip: false, show: !snap && firstOf(kindAt(openRef.current)) })
    bookRef.current = 'intro'
    setPage(0)
    setBook('intro')
  }, [])
  // a step's middle: the case goes home and the neighbour comes out (Scene runs both, and the camera,
  // off c.step); reading, the neighbour's insert follows before it has quite arrived
  const swapStep = useCallback(
    (st) => {
      const c = ctl.current
      if (st.swapped) return
      Object.assign(st, { swapped: true, caseAt: performance.now() })
      c.rows[st.to.row].target = st.to.index
      c.rowTarget = st.to.row
      openRef.current = st.to
      setOpen(st.to)
      if (st.reading && !st.skip) c.stepTimer = setTimeout(() => ((st.opened = true), beginInsert(false)), st.dur * STEP_INSERT)
    },
    [beginInsert],
  )
  // a tap, click or key during a step: straight to its end state
  const finishStep = useCallback(() => {
    const c = ctl.current
    const st = c.step
    if (!st || st.skip || st.done) return
    clearTimeout(c.stepTimer)
    st.skip = true
    if (!st.swapped) {
      skipOutro(c)
      swapStep(st)
    }
    if (st.reading) {
      if (!st.opened) (st.opened = true), beginInsert(true)
      else c.bookSkip = true
    }
    c.bookSkipAt = performance.now()
  }, [beginInsert, swapStep])
  // The same physical handoff powers Next/Previous, staff picks: the insert folds,
  // the case goes home, the camera crosses the store, and the chosen case comes out.
  const stepToCase = useCallback(
    (target) => {
      const c = ctl.current
      finishStep()
      const from = openRef.current
      const to = typeof target === 'function' ? target(from) : target
      if (!from || !to || (from.row === to.row && from.index === to.index)) return
      clearTimeout(c.closeTimer)
      const q = c.reduced ? 0 : 1
      const reading = !!bookRef.current
      c.spinYTarget = Math.round(c.spinYTarget / Math.PI) * Math.PI
      Object.assign(c, { spinXTarget: 0 })
      const st = { id: (c.stepId = (c.stepId || 0) + 1), from, to, reading, dur: STEP_CASE * q * 1000, skip: false, swapped: false, opened: false, done: false, caseAt: 0 }
      c.step = st
      setExtras(false)
      setFilmSheet(false)
      if (reading) {
        // the insert folds back at the normal pace, even after a showcase
        c.show = false
        bookRef.current = null
        setBook(null)
      }
      if (q === 0) return finishStep()
      if (reading) c.stepTimer = setTimeout(() => swapStep(st), STEP_FOLD * q * 1000)
      else swapStep(st)
    },
    [finishStep, swapStep, setFilmSheet],
  )
  const stepCase = useCallback((d) => { track(d > 0 ? 'next' : 'previous'); stepToCase((from) => from && neighbour(ROWS, from, d)) }, [stepToCase])
  const jumpCase = useCallback(
    (slug) => {
      let to = null
      ROWS.some((r, rowIndex) => {
        const index = r.projects.findIndex((project) => project.slug === slug)
        if (index < 0) return false
        to = { row: rowIndex, index }
        return true
      })
      if (!to) return
      if (openRef.current) return stepToCase(to)
      const c = ctl.current
      c.row = c.rowTarget = to.row
      c.rows[to.row].offset = c.rows[to.row].target = to.index
      openCase(to.row, to.index)
    },
    [openCase, stepToCase],
  )
  const stepping = () => {
    const st = ctl.current.step
    return !!st && !st.skip && !st.done
  }
  // the film runs along by any amount (the wheel, a drag, the scrubber) and settles on a whole frame
  const filmTo = useCallback((t, snap) => {
    const c = ctl.current
    c.filmTarget = clamp(snap ? Math.round(t) : t, 0, c.filmMax || 0)
    wakeShelf()
    if (snap) setPage(c.filmTarget)
  }, [])
  // a frame tapped on the contact sheet: back to the film with that frame in the middle
  useEffect(() => {
    ctl.current.filmPick = (i) => {
      filmTo(i - (stepRef.current - 1) / 2, true)
      setFilmSheet(false)
    }
  }, [filmTo, setFilmSheet])
  // the insert is all the way out: from here it reads (its pace was set as it started out, firstOf)
  const onIntroDone = useCallback(() => {
    setBook((b) => (b === 'intro' ? 'open' : b))
  }, [])
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const set = () => {
      ctl.current.reduced = !!mq?.matches
    }
    set()
    mq?.addEventListener?.('change', set)
    return () => mq?.removeEventListener?.('change', set)
  }, [])
  // one page on a phone, a whole spread otherwise; going back lands on the screenful you came from
  const turn = useCallback((d) => {
    if (bookRef.current !== 'open') return void (ctl.current.bookSkip = true)
    const step = stepRef.current
    if (filmRef.current) return filmTo(Math.round(ctl.current.filmTarget || 0) + d * step, true)
    const at = pageRef.current
    const last = pagesRef.current - step
    const to = d > 0 ? at + step : at % step ? at - (at % step) : at - step
    setPage(clamp(to, 0, Math.max(0, last)))
  }, [])
  // a tap on the dark around it: finish the intro, then put the booklet back, then the cartridge
  const backdrop = useCallback(() => {
    const c = ctl.current
    if (c.moved) return
    if (openRef.current === null) {
      c.shelfRest = true
      c.shelfHover = null
      setFocusState((current) => ({ ...current, resting: true }))
      wakeShelf()
      return
    }
    if (c.bookIntro) return void (c.bookSkip = true)
    // a tap while the insert goes back in puts it away at once
    if (c.bookOutro) return void skipOutro(c)
    if (performance.now() - (c.bookSkipAt || 0) < 400) return
    if (c.filmSheet) setFilmSheet(false)
    else if (bookRef.current) closeBook()
    else close()
  }, [close, closeBook, setFilmSheet])
  const flip = () => {
    track('case_turned', { slug: ROWS[open.row].projects[open.index].slug })
    const c = ctl.current
    if (c.bookOutro) skipOutro(c)
    c.spinYTarget = Math.round(c.spinYTarget / Math.PI) * Math.PI + Math.PI
  }
  const go = useCallback((d) => {
    track(d > 0 ? 'next' : 'previous')
    if (openRef.current !== null) return
    ctl.current.shelfRest = false
    const s = ctl.current.rows[rowRef.current]
    s.target = clamp(Math.round(s.target) + d, 0, ROWS[rowRef.current].projects.length - 1)
  }, [])
  const goRow = useCallback((d) => {
    if (openRef.current !== null) return
    setDirectoryOpen(false)
    setContactOpen(false)
    const c = ctl.current
    c.shelfRest = false
    c.rowTarget = clamp(Math.round(c.rowTarget) + d, 0, ROWS.length - 1)
  }, [])
  const goToShelf = useCallback(
    (to) => {
      if (openRef.current !== null) return
      setDirectoryOpen(false)
      setContactOpen(false)
      if (openRef.current !== null) close(true)
      ctl.current.shelfRest = false
      ctl.current.rowTarget = clamp(to, 0, ROWS.length - 1)
    },
    [close],
  )

  const onPick = useCallback(
    (r, i) => {
      const c = ctl.current
      // the case in your hands goes back on the shelf with a click (a drag turns it instead)
      if (openRef.current !== null) {
        if (openRef.current.row === r && openRef.current.index === i && !bookRef.current) {
          // a click while its insert goes back in puts that away at once; the next puts the case back
          if (c.bookOutro) skipOutro(c)
          else if (performance.now() - (c.bookSkipAt || 0) > 400) close()
        }
        return
      }
      // a case on another shelf brings you to that shelf; one on this shelf comes straight out
      if (r !== Math.round(c.row)) c.rowTarget = r
      else openCase(r, i)
    },
    [openCase],
  )

  // Drag starts on the stage; move/up are watched on window so the 3D clicks still land.
  const onPointerDown = (e) => {
    if (stepping()) finishStep()
    const c = ctl.current
    // a second finger down on an open gatefold starts a pinch
    c.ptrs = c.ptrs || new Map()
    c.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (c.ptrs.size === 2 && c.gate && bookRef.current === 'open') {
      const [a, b] = [...c.ptrs.values()]
      c.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      c.pinched = true
      c.moved = true
    }
    if (c.ptrs.size > 1) return
    c.pinched = false
    Object.assign(c, { dragging: true, moved: false, axis: null, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: performance.now(), vel: 0 })
    const move = (ev) => {
      if (c.ptrs.has(ev.pointerId)) c.ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      if (c.pinch) {
        if (c.ptrs.size < 2) return
        const [a, b] = [...c.ptrs.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const x = (a.x + b.x) / 2
        const y = (a.y + b.y) / 2
        c.gate.panBy(x - c.pinch.x, y - c.pinch.y)
        c.gate.zoomBy(d / Math.max(1, c.pinch.d), x, y)
        c.pinch = { d, x, y }
        return
      }
      if (ev.pointerId !== e.pointerId || c.pinched) return
      const dx = ev.clientX - c.lx
      const dy = ev.clientY - c.ly
      const now = performance.now()
      const tx = ev.clientX - c.sx
      const ty = ev.clientY - c.sy
      if (Math.abs(tx) + Math.abs(ty) > 6) c.moved = true
      // a drag picks its direction once: along the shelf, or up and down the wall
      if (!c.axis && Math.abs(tx) + Math.abs(ty) > 8) c.axis = Math.abs(tx) >= Math.abs(ty) ? 'x' : 'y'
      if (openRef.current === null) {
        if (c.axis) c.shelfRest = false
        const s = c.rows[Math.round(c.row)]
        if (c.axis === 'x') {
          s.offset -= dx / c.pxPerCase
          s.target = s.offset
          c.vel = c.vel * 0.6 + (-dx / c.pxPerCase / Math.max(1, now - c.lt)) * 0.4
        } else if (c.axis === 'y') {
          c.row = clamp(c.row - dy / c.pxPerRow, -0.3, ROWS.length - 0.7)
          c.rowTarget = c.row
          c.vel = c.vel * 0.6 + (-dy / c.pxPerRow / Math.max(1, now - c.lt)) * 0.4
        }
      } else if (bookRef.current) {
        if (c.gate?.zoomed()) c.gate.panBy(dx, dy)
        // zoomed in, a drag looks around the gatefold
        else if (manualRef.current) {
          // drag the manual up to read on
          if (c.axis === 'y') {
            const px = c.manualPx || 100
            c.manualTarget = (c.manualTarget || 0) - dy / px
            c.vel = c.vel * 0.6 + (-dy / px / Math.max(1, now - c.lt)) * 0.4
          }
        } else if (filmRef.current && c.axis === 'x') {
          // the film sticks to your finger
          const px = c.bookPagePx || 300
          if (c.filmFrom == null) c.filmFrom = c.filmTarget || 0
          filmTo(c.filmFrom - tx / px, false)
          c.vel = c.vel * 0.6 + (-dx / px / Math.max(1, now - c.lt)) * 0.4
        } else if (c.axis === 'x') c.bookDrag = tx
        // drag a page across to turn it
      } else {
        c.spinYTarget += dx * 0.012
        c.spinXTarget = clamp(c.spinXTarget + dy * 0.004, -0.45, 0.45)
      }
      c.lx = ev.clientX
      c.ly = ev.clientY
      c.lt = now
    }
    const up = (ev) => {
      c.ptrs.delete(ev.pointerId)
      if (c.ptrs.size < 2) c.pinch = null
      if (c.ptrs.size) return
      c.dragging = false
      if (c.pinched || c.gate?.zoomed()) c.bookDrag = null
      else if (bookRef.current) {
        const tx = ev.clientX - c.sx
        // A still tap skips the opening even for a scrolling manual or printout.
        if (!c.moved && c.bookIntro) skipIntro()
        else if (manualRef.current) {
          // a flick keeps it going a little
          if (c.axis === 'y') c.manualTarget = (c.manualTarget || 0) + c.vel * 220
        } else if (filmRef.current && c.axis === 'x') {
          // a flick carries on a little, then it settles on a frame
          filmTo((c.filmTarget || 0) + c.vel * 200, true)
          c.filmFrom = null
        } else if (c.axis === 'x' && Math.abs(tx) > 40) turn(tx < 0 ? 1 : -1)
        c.bookDrag = null
      } else if (openRef.current === null && c.axis === 'x') {
        const r = Math.round(c.row)
        const s = c.rows[r]
        s.target = clamp(Math.round(s.offset + c.vel * 260), 0, ROWS[r].projects.length - 1)
      } else if (openRef.current === null && c.axis === 'y') c.rowTarget = clamp(Math.round(c.row + c.vel * 150), 0, ROWS.length - 1)
      else if (openRef.current !== null) c.spinYTarget = Math.round(c.spinYTarget / Math.PI) * Math.PI
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setTimeout(() => (c.moved = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // a double click on an open gatefold leans in on that spot, or steps back out
  const onDoubleClick = (e) => {
    const g = ctl.current.gate
    if (!g || bookRef.current !== 'open' || single) return
    if (g.zoomed()) g.reset()
    else g.zoomBy(2.5, e.clientX, e.clientY)
  }

  const onWheel = (e) => {
    const c = ctl.current
    if (openRef.current !== null) {
      // the wheel zooms into an open gatefold, toward the pointer
      if (bookRef.current === 'open' && c.gate) return c.gate.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 32 : 1) * 0.0016), e.clientX, e.clientY)
      // the wheel reads down the manual
      if (bookRef.current && manualRef.current) c.manualTarget = (c.manualTarget || 0) + (e.deltaY * (e.deltaMode === 1 ? 32 : 1)) / (c.manualPx || 100)
      // and runs the film along, even while it is still pouring out
      else if (bookRef.current && isFilm) {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 32 : 1)
        filmTo((c.filmTarget || 0) + d / (c.bookPagePx || 300), false)
        clearTimeout(c.filmSnap)
        c.filmSnap = setTimeout(() => filmTo(c.filmTarget, true), 150)
      }
      // and turns everything else along: a page, a panel, a screenful of film, the other side
      else if (bookRef.current === 'open') {
        const now = performance.now()
        c.wheelAcc = (c.wheelAcc || 0) + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 32 : 1)
        if (Math.abs(c.wheelAcc) >= 60 && now - (c.lastTurn || 0) > 300) {
          turn(Math.sign(c.wheelAcc))
          c.lastTurn = now
          c.wheelAcc = 0
        }
        clearTimeout(c.wheelTimer)
        c.wheelTimer = setTimeout(() => (c.wheelAcc = 0), 220)
      }
      return
    }
    c.shelfRest = false
    clearTimeout(c.wheelTimer)
    const k = e.deltaMode === 1 ? 32 : 1
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      // sideways: along the shelf
      const r = Math.round(c.rowTarget)
      const s = c.rows[r]
      const last = ROWS[r].projects.length - 1
      s.target = clamp(s.target + ((e.deltaX || e.deltaY) * k) / Math.max(40, c.pxPerCase), 0, last)
      c.wheelTimer = setTimeout(() => { s.target = clamp(Math.round(s.target), 0, last); wakeShelf() }, 140)
    } else {
      // up and down: one wheel notch (or a short trackpad swipe) is one shelf
      const now = performance.now()
      c.wheelAcc = (c.wheelAcc || 0) + e.deltaY * k
      if (Math.abs(c.wheelAcc) >= 60 && now - (c.lastRowStep || 0) > 380) {
        c.rowTarget = clamp(Math.round(c.rowTarget) + Math.sign(c.wheelAcc), 0, ROWS.length - 1)
        c.lastRowStep = now
        c.wheelAcc = 0
      }
      c.wheelTimer = setTimeout(() => (c.wheelAcc = 0), 220)
    }
  }

  useEffect(() => {
    const key = (e) => {
      if ((directoryOpen || contactOpen) && e.key === 'Escape') {
        const trigger = contactOpen ? contactButtonRef : directoryButtonRef
        setDirectoryOpen(false)
        setContactOpen(false)
        trigger.current?.focus()
        return
      }
      if (keyBelongsToControl(e.target)) return
      if (directoryOpen || contactOpen || listReason) return
      // a key during a step lands it; N or P then takes the next step from there
      if (stepping()) {
        finishStep()
        if (stepKey(e)) stepCase(stepKey(e))
        return
      }
      if (stepKey(e) && openRef.current !== null && !extras) return void stepCase(stepKey(e))
      if (e.key === 'Escape') return extras ? setExtras(false) : ctl.current.filmSheet ? setFilmSheet(false) : bookRef.current ? closeBook() : close()
      if (extras) return
      if (bookRef.current && manualRef.current) {
        const c = ctl.current
        const px = c.manualPx || 100
        const page = (window.innerHeight * 0.75) / px
        const by = { ArrowDown: 70 / px, ArrowUp: -70 / px, PageDown: page, PageUp: -page, ' ': page, Home: -1e6, End: 1e6 }[e.key]
        if (by !== undefined) {
          e.preventDefault()
          if (c.bookIntro) skipIntro()
          else c.manualTarget = (c.manualTarget || 0) + by
        } else if (e.key === 'Enter') skipIntro()
        return
      }
      if (bookRef.current && ctl.current.gate && ['+', '=', '-', '0'].includes(e.key)) {
        const g = ctl.current.gate
        if (e.key === '0') g.reset()
        else g.zoomBy(e.key === '-' ? 1 / 1.5 : 1.5, window.innerWidth / 2, window.innerHeight / 2)
        return
      }
      if (bookRef.current) {
        const move = ctl.current.objectMove
        if (move && !e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === move.key && !e.target.closest?.('input, textarea, select, [contenteditable=true]')) {
          e.preventDefault()
          move.activate()
          return
        }
        if (e.key === 'ArrowRight') turn(1)
        else if (e.key === 'ArrowLeft') turn(-1)
        else if (e.key === 'Enter' || e.key === ' ') skipIntro()
        return
      }
      // Enter or Space while the insert goes back in puts it away at once
      if (ctl.current.bookOutro && (e.key === 'Enter' || e.key === ' ')) return void skipOutro(ctl.current)
      if (e.key === 'ArrowLeft' && openRef.current === null) go(-1)
      else if (e.key === 'ArrowRight' && openRef.current === null) go(1)
      else if (e.key === 'ArrowUp' && openRef.current === null) goRow(-1)
      else if (e.key === 'ArrowDown' && openRef.current === null) goRow(1)
      else if ((e.key === 'Enter' || e.key === ' ') && openRef.current === null) openCase(rowRef.current, Math.round(ctl.current.rows[rowRef.current].target))
      else if (e.key.toLowerCase() === 'f' && openRef.current !== null) flip()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [go, goRow, openCase, close, closeBook, turn, extras, directoryOpen, contactOpen, listReason, setFilmSheet, finishStep, stepCase])

  const p = open ? ROWS[open.row].projects[open.index] : projects[focus]
  const proofStills = (p?.making?.proof || [])
    .filter((item) => item.type === 'image')
    .map((item) => ({ src: p.img(item.src), caption: item.caption }))
    .filter((item) => item.src)
  const coverProof = coverStill(p)
  if (coverProof) {
    const existing = proofStills.findIndex((still) => still.src === coverProof.src)
    if (existing >= 0) proofStills[existing] = coverProof
    else proofStills.push(coverProof)
  }
  const aisle = AISLES.indexOf(ROWS[row].id) + 1
  const code = `${shelf.code}-${String(p?.order ?? 0).padStart(2, '0')}`
  const atInsertEnd = book === 'open' && !isManual && pages > 0 && shown >= Math.max(0, pages - step)
  // A 2x phone at the usual 1.5 cap stretches the page picture. Spend the extra pixels
  // only while a case is in your hands; it switches as the case flies out or home, so the
  // change is never seen on a still page. Graphics safe mode still wins (SafeCanvas).
  const readingDpr = open !== null && single ? 2 : 1.5

  return (
    <>
      <div className={`store ${listReason ? 'is-list' : ''}`} ref={storeRef} onClick={(e) => {
        // Canvas misses are handled below; DOM labels/background are empty space too.
        if (!e.target.closest('canvas, button, a, input, select, textarea, [role="dialog"], [role="button"]')) backdrop()
      }}>
      {!listReason && <div className="stage" onPointerDown={onPointerDown} onWheel={onWheel} onDoubleClick={onDoubleClick}>
        {ready && (
          <Canvas onPointerMissed={(e) => e.type === 'click' && backdrop()} frameloop="demand" key={graphics.generation} renderMode={graphics.mode} renderGeneration={graphics.generation} onCreated={({ gl, invalidate }) => { gl.domElement.setAttribute('aria-hidden', 'true'); const stop = watchRenderer(gl, invalidate); watchGraphics(gl); return stop }} shadows dpr={[1, readingDpr]} gl={{ antialias: true }}>
            <Scene rows={ROWS} ctl={ctl} open={open} onPick={onPick} onFocus={onFocus} onClose={backdrop} book={book} page={shown} per={per} single={single} onTurn={turn} onSeek={setPage} onObjectMove={setObjectMove} onIntroDone={onIntroDone} />
            <DemandMotion ctl={ctl} book={book} />
          </Canvas>
        )}
      </div>}

      <header className={`top ${!listReason && open !== null ? 'is-case' : ''} ${!listReason && book ? 'is-book' : ''} ${!listReason && book && isManual ? 'is-manual' : ''}`}>
        <div className="who">
          <h1>Ryan Zegalia</h1>
          <p>Everything on these shelves is something I built. Most of it is running right now.</p>
          <button
            ref={contactButtonRef}
            className="counter-tag"
            type="button"
            aria-expanded={contactOpen}
            aria-controls="counter-card"
            onClick={() => {
              setDirectoryOpen(false)
              setContactOpen((value) => !value)
            }}
          >
            At the counter
          </button>
          {contactOpen && (
            <section className="counter-card" id="counter-card" aria-label="About and contact">
              <p className="counter-kicker">Clerk on duty</p>
              <h2>{CONTACT.name}</h2>
              <p>{CONTACT.line}</p>
              <p className="counter-work">{CONTACT.work}</p>
              <div className="counter-links">
                {CONTACT_LINKS.map((link) => (
                  <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
                    <span>{link.label}</span>
                    <b aria-hidden="true">↗</b>
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="aisle">
          <button
            ref={directoryButtonRef}
            className="aisle-current"
            type="button"
            disabled={!listReason && open !== null}
            aria-expanded={directoryOpen}
            aria-controls="aisle-directory"
            onClick={() => {
              setContactOpen(false)
              setDirectoryOpen((value) => !value)
            }}
          >
            <span>Aisle {aisle} of {AISLES.length}</span>
            <b>{shelf.name}</b>
          </button>
          <span className="aisle-nav">
            <button onClick={() => goRow(-1)} disabled={open !== null || row === 0} aria-label="Shelf above">▲</button>
            <button onClick={() => goRow(1)} disabled={open !== null || row === ROWS.length - 1} aria-label="Shelf below">▼</button>
          </span>
          {directoryOpen && (
            <section className="aisle-directory" id="aisle-directory" aria-label="Store directory">
              <p className="directory-kicker">After hours video</p>
              <h2>Store directory</h2>
              <p className="directory-note">Nine aisles. Pick the kind of problem you want to see.</p>
              <ol>
                {ROWS.map((r, index) => (
                  <li key={r.id}>
                    <button type="button" aria-current={index === row ? 'true' : undefined} style={{ '--shelf-color': r.shelf.color }} onClick={() => { if (listReason) { setDirectoryOpen(false); setFocusState({ row: index, index: 0 }); document.getElementById(`list-${r.id}`)?.scrollIntoView() } else goToShelf(index) }}>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <strong>{r.shelf.name}</strong>
                      <small>{r.shelf.line}</small>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </header>

      {!listReason && <div data-media={media} className={`hud ${open === null ? '' : 'is-open'} ${book && isManual ? 'is-manual' : ''}`} onPointerDownCapture={(e) => stepping() && !e.target.closest?.('.casestep') && finishStep()}>
        {open === null ? (
          <div className="now">
            <button className="arrow" onClick={() => go(-1)} aria-label="Previous" disabled={focus === 0}>
              ‹
            </button>
            <div className="label">
              {resting ? <h2>{shelf.name}</h2> : <>
              <span className="code" style={{ background: shelf.color, color: inkOn(shelf.color) }}>{code}</span>
              <h2>{p?.title}</h2>
              <p>{p?.tagline}</p>
              <p className="credit">{p?.credit}</p>
              <button ref={browseButtonRef} className="tag" onClick={() => openCase(row, focus)}>
                Pull it out
              </button>
              </>}
            </div>
            <button className="arrow" onClick={() => go(1)} aria-label="Next" disabled={focus === n - 1}>
              ›
            </button>
          </div>
        ) : book === 'open' ? (
          <div className="bookbar">
            <div className="pager" hidden={pages <= step}>
              <button className="arrow" onClick={() => turn(-1)} disabled={shown === 0} aria-label="Previous page">
                ‹
              </button>
              <span className="pagecount">{isVinyl ? (single ? `Side ${Math.floor(shown / 2) + 1} · column ${shown % 2 + 1} of 2` : `Side ${shown + 1} of ${pages}`) : pageCount(isFilm ? 'Frame' : isGate && single && pages > 3 ? 'Chapter' : isLeaf || isGate ? 'Panel' : 'Page', shown, step, pages)}</span>
              <button className="arrow" onClick={() => turn(1)} disabled={shown >= pages - step} aria-label="Next page">
                ›
              </button>
            </div>
            {isFilm && pages > step && <FilmScrub ctl={ctl} n={pages} view={step} onSeek={filmTo} />}
            {proofStills.length > 0 && (
              <div className="proof-dock" aria-label="Proof stills. Tap one to view it large.">
                <span>Proof</span>
                {proofStills.map((still, index) => (
                  <button key={`${still.src}-${index}`} type="button" onClick={() => setProofIndex(index)} aria-label={`View proof ${index + 1}: ${still.caption}`}>
                    <img src={still.src} alt="" />
                  </button>
                ))}
              </div>
            )}
            <div className="openbar">
              {isFilm && (
                <button className="tag small" onClick={() => setFilmSheet(!filmSheet)}>
                  {filmSheet ? 'Back to the film' : 'See all frames'}
                </button>
              )}
              <button className="tag small" onClick={() => setExtras(true)}>
                Read as text
              </button>
              <button className="tag ghost small" onClick={closeBook}>
                Put it back
              </button>
              <StaffPicks compact project={p} active={!extras} atEnd={atInsertEnd} watchManual={isManual} ctl={ctl} onChoose={jumpCase} />
            </div>
          </div>
        ) : (
          <div className="openbar case-actions">
            <button className="tag" onClick={flip} disabled={!!book} aria-label="Turn it over">
              {single ? 'Turn over' : 'Turn it over'}
            </button>
            <button className="tag hot" onClick={plan ? openBook : () => setExtras(true)}>
              {single ? ({ cartridge: 'Manual', vhs: 'The story', '8track': 'Service log', pcbox: 'Manual', laserdisc: 'Gatefold', filmcan: 'The film', floppy: 'README', cassette: 'J-card', vinyl: 'Liner notes' }[media] || shelf.extras) : shelf.extras}
            </button>
            <button className="tag ghost" onClick={close}>
              {single ? 'Put back' : 'Put it back'}
            </button>
          </div>
        )}
        <div className="hintrow">
          {open !== null && (
            <button className="arrow casestep" onClick={() => stepCase(-1)} disabled={!neighbour(ROWS, open, -1)} aria-label="Previous case" title="Previous case (P)">
              «
            </button>
          )}
        <p className="hint">
          {book === 'open' && objectMove ? <button className="move-hint" onClick={objectMove.activate} aria-pressed={objectMove.active}>{objectMove.label}{!single && ` · ${objectMove.key.toUpperCase()}`}</button> : <>{single && open !== null
            ? book ? (isManual ? 'Swipe up to read' : isGate ? 'Swipe · pinch to zoom' : 'Swipe to read on') : 'Drag to turn · tap to read'
            : open === null
            ? 'Swipe along a shelf · up and down for more shelves · tap one to pull it out'
            : book
              ? isFilm
                ? filmSheet
                  ? 'Tap a frame to read it · Escape goes back to the film'
                  : single
                  ? 'Swipe along the film · tap a side works too'
                  : 'Drag, click a side or use the arrow keys to run the film along'
                : isGate
                ? single
                  ? 'Swipe along the gatefold · pinch to look closer'
                  : 'Scroll or double click to look closer · drag to move around'
                : isVinyl
                ? single
                  ? 'Swipe to read on, then it turns over · tap a side works too'
                  : 'Drag across, click or use the arrow keys to turn the sleeve over'
                : isManual
                ? single
                  ? 'Swipe up to read on · read as text for a plain version'
                  : 'Scroll, drag or use the arrow keys to read on · read as text for a plain version'
                : media === '8track'
                ? single
                  ? 'Swipe for the other side · tap a side works too'
                  : 'Both sides of the sleeve, opened out · read as text for the whole story'
                : isLeaf
                ? single
                  ? `Swipe along the ${media === 'cassette' ? 'J-card' : 'leaflet'} · tap a side works too`
                  : `Drag the ${media === 'cassette' ? 'J-card' : 'leaflet'} along or tap the panel at either end · arrow keys work too`
                : single
                  ? 'Swipe to turn the page · tap the edge works too'
                  : 'Drag a page across or tap its edge to turn · arrow keys work too'
              : `Drag to turn it in your hands · ${shelf.extras.toLowerCase()} has the full story`}
          {open !== null && !single && !filmSheet && ' · N for the next case, P for the one before'}</>}
        </p>
          {open !== null && (
            <button className="arrow casestep" onClick={() => stepCase(1)} disabled={!neighbour(ROWS, open, 1)} aria-label="Next case" title="Next case (N)">
              »
            </button>
          )}
        </div>
      </div>}

      {listReason ? <StoreList rows={ROWS} reason={listReason} /> : <button className={`browse-list ${book ? 'is-reading' : ''}`} onClick={browseList}>Browse as a list</button>}

      {open !== null && extras && p && !listReason && <Booklet p={p} shelf={ROWS[open.row].shelf} onClose={closeExtras} />}
      {proofIndex !== null && <ProofLightbox items={proofStills} index={proofIndex} onIndex={setProofIndex} onClose={closeProof} />}
      </div>

      {welcome && ready && !listReason && (
        <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" ref={welcomeDialogRef}>
          <div className="card">
            <p className="kicker">Members only · No late fees</p>
            <h2 id="welcome-title">Welcome in.</h2>
            <p>This is my after-hours video store. Every case on these shelves is a real project I built, rebuilt, or keep running.</p>
            <p>Pull one out, turn it over, and open what is inside. You can see what it does, how I made it, and the proof that it works. Each aisle holds a different kind of problem I solved.</p>
            <button ref={welcomeButtonRef} className="tag" onClick={dismissWelcome}>
              Start browsing
            </button>
          </div>
        </div>
      )}

      <section className="sr-only">
        {ROWS.map((r) => (
          <div key={r.id}>
            <h2>{r.shelf.name}</h2>
            <ul>
              {r.projects.map((x) => (
                <li key={x.slug}>
                  <h3>{x.title}</h3>
                  <p>{x.tagline}</p>
                  <p>{x.what}</p>
                  <p>{x.credit}</p>
                  <ul>
                    {(x.built || x.does)?.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {!ready && <div className="loading">Rewinding…</div>}
    </>
  )
}
