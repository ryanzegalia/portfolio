// Draws the "How things ship" shelf's 35mm film cans: the printed label on the lid, the shipping
// label on the other lid, the tape round the rim, and the film strip that runs out of the can, one
// frame per stage of the pipeline, styled like a silent film's title cards held up to the light.
import { canvas, toTexture, fit, grain, barcode, ratingBox, hash, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { PAPER, DIM, lines } from './covers-booklet.js'

// One unit is 100 mm, a little bigger than life like the other media so the label reads.
export const FC = { r: 0.98, t: 0.16 }
// a film frame (the picture area is 4:3, like a projected frame) and the sprocket bands round it
export const FRAME = { w: 1100, h: 940, top: 80, pic: 780 }
const LIGHT = '#f6dcaa'
const BASE = '#15100b'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`
const accentOf = (p) => (p.palette && p.palette.accent) || '#e39b3a'
const bgOf = (p) => (p.palette && p.palette.bg) || '#1a120c'
// a pale accent ghosts on the paper label, so it prints in a darkened shade of itself instead
function readable(hex) {
  const v = parseInt(hex.slice(1), 16)
  const [r, g, b] = [v >> 16, (v >> 8) & 255, v & 255]
  if ((r * 0.299 + g * 0.587 + b * 0.114) / 255 <= 0.6) return hex
  const k = 0.42
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`
}

function text(ctx, s, x, y, size, color = INK, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

function para(ctx, s, x, y, width, size, lh, color, weight = 600, align = 'left') {
  ctx.font = `${weight} ${size}px ${BODY}`
  for (const l of lines(ctx, s || '', width)) {
    text(ctx, l, x, y, size, color, weight, BODY, align)
    y += lh
  }
  return y
}

// Pressed steel: a soft radial sheen and the rings stamped into the lid.
function steel(ctx, n) {
  const g = ctx.createRadialGradient(n * 0.38, n * 0.32, n * 0.05, n / 2, n / 2, n * 0.62)
  g.addColorStop(0, '#e9e7e2')
  g.addColorStop(0.55, '#a9a7a2')
  g.addColorStop(1, '#6d6b67')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, n, n)
  for (const [r, a] of [[0.485, 0.35], [0.47, 0.18], [0.43, 0.22]]) {
    ctx.strokeStyle = `rgba(30,28,25,${a})`
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(n / 2, n / 2, n * r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

// The label's little picture, one per can (its `art`), drawn like a poster: a sky going from the
// can's dark into its accent, flat black ground, and the thing itself in silhouette.
function poster(ctx, p, x, y, w, h) {
  const accent = accentOf(p)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  const sky = ctx.createLinearGradient(0, y, 0, y + h)
  sky.addColorStop(0, bgOf(p))
  sky.addColorStop(1, accent)
  ctx.fillStyle = sky
  ctx.fillRect(x, y, w, h)
  const hz = y + h * 0.66
  const art = ART[p.art] || ART.train
  art(ctx, p, x, y, w, h, hz, accent)
  ctx.restore()
}

const sun = (ctx, cx, cy, r) => {
  ctx.fillStyle = CREAM
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
}
const ground = (ctx, x, w, hz, h) => {
  ctx.fillStyle = INK
  ctx.fillRect(x, hz, w, h)
}
// rails running off to the horizon, sleepers closing up with distance
function rails(ctx, x, y, w, h, hz, color) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 5
  for (const d of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(x + w / 2 + d * 6, hz)
    ctx.lineTo(x + w / 2 + d * w * 0.38, y + h)
    ctx.stroke()
  }
  for (let i = 1; i < 6; i++) {
    const t = i / 6
    const yy = hz + (y + h - hz) * t * t
    const half = 6 + w * 0.38 * t * t
    ctx.fillRect(x + w / 2 - half, yy, half * 2, 4 + t * 6)
  }
}
const wheel = (ctx, cx, cy, r) => {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
}
// a person in silhouette, feet on the line
function figure(ctx, cx, feet, s) {
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(cx, feet - s * 0.86, s * 0.12, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.roundRect(cx - s * 0.15, feet - s * 0.72, s * 0.3, s * 0.42, s * 0.1)
  ctx.fill()
  ctx.fillRect(cx - s * 0.12, feet - s * 0.34, s * 0.1, s * 0.34)
  ctx.fillRect(cx + s * 0.02, feet - s * 0.34, s * 0.1, s * 0.34)
}

const ART = {
  // a freight train running along the horizon: the engine with its smoke, then the cars
  train(ctx, p, x, y, w, h, hz, accent) {
    sun(ctx, x + w * 0.66, y + h * 0.4, h * 0.17)
    ground(ctx, x, w, hz, h)
    rails(ctx, x, y, w, h, hz, accent)
    const unit = w * 0.13
    const rail = hz - 2
    ctx.fillStyle = INK
    // the engine, facing right: cab, boiler, chimney, cow-catcher
    const ex = x + w * 0.64
    ctx.fillRect(ex, rail - unit * 0.9, unit * 0.42, unit * 0.78)
    ctx.fillRect(ex - 6, rail - unit * 0.96, unit * 0.54, 10)
    ctx.fillRect(ex + unit * 0.42, rail - unit * 0.62, unit * 0.78, unit * 0.5)
    ctx.fillRect(ex + unit * 0.98, rail - unit * 0.86, unit * 0.12, unit * 0.26)
    ctx.beginPath()
    ctx.moveTo(ex + unit * 1.2, rail - unit * 0.26)
    ctx.lineTo(ex + unit * 1.38, rail - 4)
    ctx.lineTo(ex + unit * 1.2, rail - 4)
    ctx.fill()
    for (const k of [0.2, 0.62, 1.0]) wheel(ctx, ex + unit * k, rail - unit * 0.1, unit * 0.11)
    // three freight cars behind it, coupled
    for (let i = 1; i <= 3; i++) {
      const cx = ex - i * unit * 1.08
      ctx.fillStyle = INK
      ctx.fillRect(cx, rail - unit * 0.66, unit, unit * 0.52)
      ctx.fillRect(cx + unit, rail - unit * 0.24, unit * 0.08, 6)
      for (const k of [0.22, 0.78]) wheel(ctx, cx + unit * k, rail - unit * 0.1, unit * 0.1)
      // the sliding door, picked out in the accent
      ctx.fillStyle = accent
      ctx.fillRect(cx + unit * 0.36, rail - unit * 0.58, unit * 0.28, unit * 0.36)
    }
    // smoke drifting back over the cars
    ctx.fillStyle = CREAM
    for (const [dx, dy, r] of [[1.04, 1.06, 0.1], [0.84, 1.2, 0.13], [0.56, 1.3, 0.15], [0.24, 1.36, 0.12]]) wheel(ctx, ex + unit * dx, rail - unit * dy, unit * r)
  },
  // a level crossing: rails across the road, the crossbuck on its post, the striped arm down
  gate(ctx, p, x, y, w, h, hz, accent) {
    sun(ctx, x + w * 0.42, y + h * 0.4, h * 0.15)
    ground(ctx, x, w, hz, h)
    rails(ctx, x, y, w, h, hz, accent)
    const post = x + w * 0.27
    const top = hz - h * 0.46
    ctx.fillStyle = INK
    ctx.fillRect(post - 7, top, 14, hz - top + h * 0.1)
    // the crossbuck
    ctx.save()
    ctx.translate(post, top + 30)
    for (const a of [0.62, -0.62]) {
      ctx.save()
      ctx.rotate(a)
      ctx.fillStyle = CREAM
      ctx.fillRect(-70, -12, 140, 24)
      ctx.strokeStyle = INK
      ctx.lineWidth = 4
      ctx.strokeRect(-70, -12, 140, 24)
      ctx.restore()
    }
    ctx.restore()
    // the two lamps, the near one lit
    ctx.fillStyle = INK
    ctx.fillRect(post - 46, top + 92, 92, 36)
    ctx.fillStyle = '#ff5a3c'
    wheel(ctx, post - 24, top + 110, 13)
    ctx.fillStyle = '#4a2a22'
    wheel(ctx, post + 24, top + 110, 13)
    // the arm, lowered across the road, red and white
    const ay = hz - h * 0.12
    const len = w * 0.62
    ctx.fillStyle = INK
    ctx.fillRect(post - 20, ay - 20, 40, 40)
    const bands = 9
    for (let i = 0; i < bands; i++) {
      ctx.fillStyle = i % 2 ? '#d9483b' : CREAM
      ctx.fillRect(post + 20 + (i * len) / bands, ay - 11, len / bands + 1, 22)
    }
    ctx.strokeStyle = INK
    ctx.lineWidth = 3
    ctx.strokeRect(post + 20, ay - 11, len, 22)
  },
  // a lit doorway in a dark wall, and the people waiting to go through it one at a time
  doorway(ctx, p, x, y, w, h, hz, accent) {
    ground(ctx, x, w, hz, h)
    const wall = x + w * 0.66
    ctx.fillStyle = INK
    ctx.fillRect(wall, y + h * 0.14, w, hz - y)
    const dw = w * 0.1
    const dh = h * 0.36
    const dx = wall + w * 0.06
    ctx.fillStyle = CREAM
    ctx.fillRect(dx, hz - dh, dw, dh)
    // its light spilling out across the ground
    ctx.fillStyle = 'rgba(243,234,214,0.35)'
    ctx.beginPath()
    ctx.moveTo(dx, hz)
    ctx.lineTo(dx + dw, hz)
    ctx.lineTo(dx + dw * 0.4, y + h)
    ctx.lineTo(dx - w * 0.5, y + h)
    ctx.fill()
    // one going in, the rest in single file behind, each a little smaller with distance
    figure(ctx, dx + dw * 0.5, hz, h * 0.3)
    const s = h * 0.27
    for (let i = 0; i < 4; i++) figure(ctx, dx - w * 0.1 - i * w * 0.095, hz, s * (1 - i * 0.04))
    ctx.fillStyle = accent
    ctx.fillRect(dx - 8, hz - dh - 16, dw + 16, 10)
  },
  // a checklist on the desk, every box ticked, stamped across the corner
  stamp(ctx, p, x, y, w, h, hz, accent) {
    const cx = x + w / 2
    const cy = y + h * 0.56
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(-0.06)
    const pw = w * 0.4
    const ph = h * 0.86
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(-pw / 2 + 10, -ph / 2 + 12, pw, ph)
    ctx.fillStyle = CREAM
    ctx.fillRect(-pw / 2, -ph / 2, pw, ph)
    ctx.fillStyle = accent
    ctx.fillRect(-pw / 2, -ph / 2, pw, 22)
    for (let i = 0; i < 5; i++) {
      const ry = -ph / 2 + 64 + i * (ph - 90) / 5
      ctx.strokeStyle = INK
      ctx.lineWidth = 4
      ctx.strokeRect(-pw / 2 + 22, ry - 16, 30, 30)
      ctx.fillStyle = 'rgba(23,18,14,0.45)'
      ctx.fillRect(-pw / 2 + 68, ry - 4, pw * (0.62 - (i % 3) * 0.1), 7)
      if (i < 4) tickAt(ctx, -pw / 2 + 37, ry - 1, 20, INK)
    }
    ctx.restore()
    // the stamp, a ring with a tick, in red ink and not quite even
    ctx.save()
    ctx.translate(cx + w * 0.17, cy + h * 0.12)
    ctx.rotate(-0.3)
    ctx.globalAlpha = 0.85
    ctx.strokeStyle = '#b3302a'
    ctx.lineWidth = 12
    ctx.beginPath()
    ctx.arc(0, 0, h * 0.2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(0, 0, h * 0.2 - 16, 0, Math.PI * 2)
    ctx.stroke()
    tickAt(ctx, 0, 4, h * 0.2, '#b3302a')
    ctx.restore()
  },
  // shipping crates stacked on the dock, three, two, one
  crates(ctx, p, x, y, w, h, hz, accent) {
    sun(ctx, x + w * 0.3, y + h * 0.38, h * 0.14)
    ground(ctx, x, w, hz, h)
    const s = h * 0.2
    const cx = x + w / 2
    const box = (bx, by) => {
      ctx.fillStyle = '#9a6b3c'
      ctx.fillRect(bx, by, s, s)
      ctx.strokeStyle = INK
      ctx.lineWidth = 5
      ctx.strokeRect(bx, by, s, s)
      ctx.lineWidth = 3
      for (const k of [1 / 3, 2 / 3]) {
        ctx.beginPath()
        ctx.moveTo(bx, by + s * k)
        ctx.lineTo(bx + s, by + s * k)
        ctx.stroke()
      }
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(bx + 4, by + s - 4)
      ctx.lineTo(bx + s - 4, by + 4)
      ctx.stroke()
    }
    for (let r = 0; r < 3; r++) for (let i = 0; i < 3 - r; i++) box(cx - ((3 - r) * s) / 2 + i * s, hz - (r + 1) * s)
    // the top one is stencilled with the can's accent
    ctx.fillStyle = INK
    ctx.fillRect(cx - s * 0.3, hz - 3 * s + s * 0.38, s * 0.6, s * 0.24)
    ctx.fillStyle = accent
    ctx.fillRect(cx - s * 0.24, hz - 3 * s + s * 0.44, s * 0.48, s * 0.12)
  },
}

export function canFront(p, shelf) {
  const n = 1024
  const [c, ctx] = canvas(n, n)
  steel(ctx, n)
  // the printed label, a disc pressed onto the lid
  const r = n * 0.4
  ctx.save()
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, n, n)
  poster(ctx, p, n / 2 - r, n / 2 - r, r * 2, r * 1.05)
  const title = p.title.toUpperCase()
  let small = ''
  let main = title
  if (/^THE /.test(title)) {
    small = 'THE'
    main = title.slice(4)
  }
  let y = n / 2 + r * 0.05 + 70
  if (small) {
    text(ctx, small, n / 2, y - 6, 40, INK, 900, TITLE, 'center')
    y += 6
  }
  const ts = fit(ctx, main, TITLE, 900, r * 1.5, 110, 50)
  text(ctx, main, n / 2, y + ts * 0.8, ts, INK, 900, TITLE, 'center')
  y += ts * 0.8 + 46
  // the plain line says what it's for; it shrinks a little rather than run off the curve
  const kick = (p.kicker || '').toUpperCase()
  text(ctx, kick, n / 2, y, fit(ctx, kick, TITLE, 900, r * 1.5, 26, 18), readable(accentOf(p)), 900, TITLE, 'center')
  // the rim line sits well in from the curve, so its ends stay on the label at any angle
  const rim = `35MM  ·  REEL 1 OF 1  ·  ${catalog(p, shelf)}`
  const rimW = 2 * Math.sqrt(r * r - (r - 100) * (r - 100)) - 80
  text(ctx, rim, n / 2, n / 2 + r - 100, fit(ctx, rim, TYPE, 700, rimW, 22, 14), DIM, 700, TYPE, 'center')
  grain(ctx, n, n, 0.05)
  ctx.restore()
  ctx.strokeStyle = 'rgba(30,28,25,0.4)'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, r, 0, Math.PI * 2)
  ctx.stroke()
  return toTexture(c)
}

// The other lid: a film exchange's shipping label taped across it.
export function canBack(p, shelf, phone = false) {
  if (phone) {
    const n = 1024, x = 162, y = 162, w = 700
    const [c, ctx] = canvas(n, n)
    steel(ctx, n)
    ctx.fillStyle = PAPER
    ctx.fillRect(x, y, w, w)
    ctx.fillStyle = accentOf(p)
    ctx.fillRect(x, y, w, 62)
    text(ctx, 'FILM EXCHANGE', x + 28, y + 44, 34, INK, 700, TYPE)
    text(ctx, p.title.toUpperCase(), x + 28, y + 140, fit(ctx, p.title.toUpperCase(), TITLE, 900, w - 56, 70), INK, 900, TITLE)
    const yy = para(ctx, p.tagline || '', x + 28, y + 205, w - 56, 42, 50, INK, 600) + 38
    text(ctx, 'REEL CONTENTS', x + 28, yy, 34, DIM, 700, TYPE)
    let row = yy + 58
    for (const [i, frame] of (p.frames || []).entries()) {
      row = para(ctx, `${i + 1}  ${frame.name}`, x + 28, row, w - 56, 44, 52, INK, 700) + 12
    }
    text(ctx, 'BUILT BY RYAN ZEGALIA', x + 28, y + w - 28, 36, INK, 700, BODY)
    grain(ctx, n, n, 0.04)
    return toTexture(c)
  }
  const n = 1024
  const [c, ctx] = canvas(n, n)
  steel(ctx, n)
  const w = 640
  const h = 640
  const x = (n - w) / 2
  const y = (n - h) / 2
  ctx.save()
  ctx.translate(n / 2, n / 2)
  ctx.rotate(-0.03)
  ctx.translate(-n / 2, -n / 2)
  ctx.fillStyle = PAPER
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = accentOf(p)
  ctx.fillRect(x, y, w, 64)
  text(ctx, 'FILM EXCHANGE  ·  HANDLE WITH CARE', x + 24, y + 42, 22, INK, 700, TYPE)
  const ts = fit(ctx, p.title.toUpperCase(), TITLE, 900, w - 48, 64, 30)
  text(ctx, p.title.toUpperCase(), x + 24, y + 128, ts, INK, 900, TITLE)
  let yy = para(ctx, p.what, x + 24, y + 176, w - 48, 25, 31, INK, 600) + 10
  text(ctx, 'REEL CONTENTS', x + 24, yy, 18, DIM, 700, TYPE)
  yy += 32
  // the same six scenes the film runs, in its order
  const scenes = ['The problem', ...(p.frames || []).map((f) => f.name), 'What I built', 'What changed']
  scenes.forEach((name, i) => {
    text(ctx, `${i + 1}  ${name}`, x + 24 + Math.floor(i / 3) * (w / 2 - 12), yy + (i % 3) * 30, 23, INK, 700)
  })
  // both sit inside the label's bottom edge (the barcode's white plate runs 50 below its bars)
  ratingBox(ctx, x + 24, y + h - 174, p.rating || 'A', p.ratingWord || 'Approved', readable(accentOf(p)))
  barcode(ctx, x + w - 24 - 200, y + h - 140, 200, 70, hash(p.slug || p.title))
  grain(ctx, n, n, 0.04)
  ctx.restore()
  // a strip of tape over each end
  ctx.fillStyle = 'rgba(232,220,180,0.75)'
  for (const tx of [x + 40, x + w - 140]) ctx.fillRect(tx, y - 28, 100, 56)
  return toTexture(c)
}

// The rim: bare steel with a strip of masking tape and the title written on it.
export function canBand(p, shelf) {
  const [c, ctx] = canvas(2048, 64)
  const g = ctx.createLinearGradient(0, 0, 0, 64)
  g.addColorStop(0, '#77756f')
  g.addColorStop(0.5, '#d8d6d0')
  g.addColorStop(1, '#6a6863')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2048, 64)
  // two strips of tape on opposite sides, so one of them faces you however the can sits
  const label = `${p.title.toUpperCase()}  ${catalog(p, shelf)}`
  for (const x0 of [140, 1164]) {
    ctx.fillStyle = '#e6d9b4'
    ctx.fillRect(x0, 8, 760, 48)
    text(ctx, label, x0 + 20, 44, fit(ctx, label, TYPE, 700, 720, 30, 20), INK, 700, TYPE)
  }
  return toTexture(c)
}

// ---- the film ----------------------------------------------------------------------------------

// The frames on the strip: a title card with the everyday problem it solves, one card per stage,
// what I built, and last what changed (the payoff). Six on every can. App reads its length for paging.
export const filmPlan = (p) => ['title', ...(p.frames || []).map((_, i) => i), 'built', 'moment']

const GREEN = '#6fe07a'

// the stage's picture, drawn big in the middle of its card
const ICONS = {
  // a locomotive pulling a freight car along the rails
  train(ctx, x, y, s, a) {
    ctx.strokeStyle = CREAM
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo(x - s * 0.62, y + s * 0.36)
    ctx.lineTo(x + s * 0.62, y + s * 0.36)
    ctx.stroke()
    box(ctx, x - s * 0.6, y - s * 0.12, s * 0.48, s * 0.34, 6, a, CREAM, 5)
    box(ctx, x - s * 0.04, y - s * 0.06, s * 0.42, s * 0.28, 6, null, CREAM, 5)
    box(ctx, x + s * 0.22, y - s * 0.34, s * 0.32, s * 0.56, 6, null, CREAM, 5)
    box(ctx, x + s * 0.3, y - s * 0.26, s * 0.16, s * 0.14, 3, a)
    ctx.fillStyle = CREAM
    ctx.fillRect(x + s * 0.02, y - s * 0.28, s * 0.08, s * 0.22)
    ctx.fillRect(x - s * 0.12, y + s * 0.04, s * 0.08, 6)
    for (const wx of [-0.5, -0.24, 0.06, 0.3, 0.46]) {
      ctx.beginPath()
      ctx.arc(x + s * wx, y + s * 0.27, s * 0.07, 0, Math.PI * 2)
      ctx.fillStyle = BASE
      ctx.fill()
      ctx.stroke()
    }
  },
  // a level-crossing barrier, down
  gate(ctx, x, y, s, a) {
    box(ctx, x - s * 0.5, y - s * 0.3, s * 0.12, s * 0.8, 4, null, CREAM, 5)
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x - s * 0.38, y - s * 0.12, s * 0.98, s * 0.14, 6)
    ctx.clip()
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = i % 2 ? CREAM : a
      ctx.fillRect(x - s * 0.38 + i * s * 0.14, y - s * 0.12, s * 0.14, s * 0.14)
    }
    ctx.restore()
    ctx.fillStyle = a
    ctx.beginPath()
    ctx.arc(x - s * 0.44, y - s * 0.42, s * 0.08, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = CREAM
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(x - s * 0.62, y + s * 0.5)
    ctx.lineTo(x + s * 0.62, y + s * 0.5)
    ctx.stroke()
  },
  // a railway signal, the bottom lamp lit green
  signal(ctx, x, y, s) {
    ctx.fillStyle = CREAM
    ctx.fillRect(x - 4, y + s * 0.24, 8, s * 0.3)
    box(ctx, x - s * 0.18, y - s * 0.52, s * 0.36, s * 0.78, s * 0.16, '#0b0806', CREAM, 5)
    for (const [k, lit] of [[-0.34, false], [-0.12, false], [0.1, true]]) {
      ctx.beginPath()
      ctx.arc(x, y + s * k, s * 0.08, 0, Math.PI * 2)
      if (lit) {
        ctx.shadowColor = GREEN
        ctx.shadowBlur = 40
      }
      ctx.fillStyle = lit ? GREEN : 'rgba(243,234,214,0.18)'
      ctx.fill()
      ctx.shadowBlur = 0
    }
  },
  // a ticket with notched sides and a tear line
  ticket(ctx, x, y, s, a) {
    const w = s * 1.0
    const h = s * 0.52
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(-0.12)
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, 10)
    ctx.fillStyle = a
    ctx.fill()
    // the notches show the card behind
    ctx.fillStyle = '#1e1812'
    for (const sx of [-w / 2, w / 2]) {
      ctx.beginPath()
      ctx.arc(sx, 0, s * 0.08, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.strokeStyle = BASE
    ctx.lineWidth = 4
    ctx.setLineDash([10, 9])
    ctx.beginPath()
    ctx.moveTo(w * 0.22, -h / 2 + 10)
    ctx.lineTo(w * 0.22, h / 2 - 10)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = BASE
    ctx.fillRect(-w * 0.36, -h * 0.18, w * 0.44, 10)
    ctx.fillRect(-w * 0.36, h * 0.06, w * 0.3, 10)
    ctx.restore()
  },
  // a round arrow coming back to where it started
  handback(ctx, x, y, s, a) {
    ctx.strokeStyle = CREAM
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(x, y, s * 0.4, -Math.PI * 0.35, Math.PI * 1.25)
    ctx.stroke()
    head(ctx, x + Math.cos(-Math.PI * 0.35) * s * 0.4, y + Math.sin(-Math.PI * 0.35) * s * 0.4, Math.PI * 0.15, s * 0.14, CREAM)
    ICONS.ticket(ctx, x, y, s * 0.42, a)
  },
  // a sheet with a big tick over it
  review(ctx, x, y, s, a) {
    box(ctx, x - s * 0.34, y - s * 0.46, s * 0.62, s * 0.86, 10, null, CREAM, 5)
    ctx.fillStyle = 'rgba(243,234,214,0.55)'
    for (let i = 0; i < 4; i++) ctx.fillRect(x - s * 0.24, y - s * 0.3 + i * s * 0.14, s * (i === 3 ? 0.24 : 0.42), 6)
    tickAt(ctx, x + s * 0.2, y + s * 0.2, s * 0.5, a)
  },
  // a sheet with two arrows going round it: look again
  again(ctx, x, y, s, a) {
    box(ctx, x - s * 0.18, y - s * 0.24, s * 0.36, s * 0.48, 6, null, CREAM, 5)
    ctx.strokeStyle = a
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    for (const k of [0, Math.PI]) {
      ctx.beginPath()
      ctx.arc(x, y, s * 0.44, k - Math.PI * 0.85, k - Math.PI * 0.2)
      ctx.stroke()
      head(ctx, x + Math.cos(k - Math.PI * 0.2) * s * 0.44, y + Math.sin(k - Math.PI * 0.2) * s * 0.44, k + Math.PI * 0.3, s * 0.13, a)
    }
  },
  // crates stacked on each other, the newest on top
  stack(ctx, x, y, s, a) {
    const cw = s * 0.42
    const ch = s * 0.3
    for (const [dx, dy, fill] of [[-0.22, 0.2, null], [0.22, 0.2, null], [0, -0.12, a]]) {
      const bx = x + s * dx - cw / 2
      const by = y + s * dy - ch / 2
      box(ctx, bx, by, cw, ch, 4, fill, CREAM, 5)
      ctx.strokeStyle = fill ? BASE : CREAM
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(bx + 8, by + 8)
      ctx.lineTo(bx + cw - 8, by + ch - 8)
      ctx.stroke()
    }
  },
  // a parcel with an arrow heading out
  ship(ctx, x, y, s, a) {
    box(ctx, x - s * 0.5, y - s * 0.2, s * 0.56, s * 0.5, 6, a, CREAM, 5)
    ctx.fillStyle = BASE
    ctx.fillRect(x - s * 0.26, y - s * 0.2, s * 0.08, s * 0.5)
    arrowTo(ctx, x + s * 0.12, y + s * 0.05, x + s * 0.6, y + s * 0.05, CREAM)
    arrowTo(ctx, x + s * 0.12, y - s * 0.32, x + s * 0.48, y - s * 0.32, 'rgba(243,234,214,0.5)')
  },
  copy(ctx, x, y, s, a) {
    box(ctx, x - s * 0.5, y - s * 0.4, s * 0.62, s * 0.5, 8, null, CREAM, 5)
    box(ctx, x - s * 0.12, y - s * 0.12, s * 0.62, s * 0.5, 8, a, CREAM, 5)
  },
  walk(ctx, x, y, s, a) {
    box(ctx, x - s * 0.5, y - s * 0.4, s * 0.8, s * 0.6, 8, null, CREAM, 5)
    ctx.strokeStyle = a
    ctx.lineWidth = 9
    ctx.beginPath()
    ctx.arc(x + s * 0.18, y + s * 0.1, s * 0.2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + s * 0.32, y + s * 0.24)
    ctx.lineTo(x + s * 0.5, y + s * 0.42)
    ctx.stroke()
  },
  test(ctx, x, y, s, a) {
    box(ctx, x - s * 0.36, y - s * 0.46, s * 0.72, s * 0.92, 10, null, CREAM, 5)
    for (let i = 0; i < 3; i++) {
      tickAt(ctx, x - s * 0.18, y - s * 0.2 + i * s * 0.26, s * 0.16, a)
      ctx.fillStyle = CREAM
      ctx.fillRect(x - s * 0.02, y - s * 0.22 + i * s * 0.26, s * 0.26, 6)
    }
  },
  clock(ctx, x, y, s, a) {
    ctx.strokeStyle = CREAM
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(x, y, s * 0.46, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = a
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y - s * 0.3)
    ctx.moveTo(x, y)
    ctx.lineTo(x + s * 0.22, y + s * 0.08)
    ctx.stroke()
  },
}

function box(ctx, x, y, w, h, r, fill, stroke, lw = 2) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = lw
    ctx.stroke()
  }
}

function tickAt(ctx, x, y, s, color) {
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(5, s * 0.14)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x - s * 0.5, y)
  ctx.lineTo(x - s * 0.12, y + s * 0.38)
  ctx.lineTo(x + s * 0.55, y - s * 0.42)
  ctx.stroke()
}

// an arrowhead at (x, y) pointing along angle a
function head(ctx, x, y, a, s, color) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s)
  ctx.lineTo(x + Math.cos(a + 2.4) * s * 0.8, y + Math.sin(a + 2.4) * s * 0.8)
  ctx.lineTo(x + Math.cos(a - 2.4) * s * 0.8, y + Math.sin(a - 2.4) * s * 0.8)
  ctx.fill()
}

function arrowTo(ctx, x0, y0, x1, y1, color) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1 - 16, y1)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - 24, y1 - 15)
  ctx.lineTo(x1 - 24, y1 + 15)
  ctx.fill()
}

// The film itself round a frame: dark base, the sprocket holes glowing with the light behind, and
// the edge code printed along it, saying which scene this is.
function filmBase(ctx, p, shelf, i, n) {
  const { w, h, top, pic } = FRAME
  ctx.fillStyle = BASE
  ctx.fillRect(0, 0, w, h)
  for (const by of [14, h - 14 - 30]) {
    for (let k = 0; k < 8; k++) box(ctx, 40 + k * (w / 8), by, 58, 30, 7, LIGHT)
  }
  text(ctx, `${catalog(p, shelf)}  ·  SCENE ${i + 1} OF ${n}`, w / 2, top + pic + 27, 22, '#e3a64a', 700, TYPE, 'center')
}

// The picture inside a frame: rounded corners like a projector gate, lit in the middle and
// falling off to dark at the edges.
function picture(ctx, lightTone, darkTone) {
  const { w, top, pic } = FRAME
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(18, top, w - 36, pic, 34)
  ctx.clip()
  const g = ctx.createRadialGradient(w / 2, top + pic * 0.45, pic * 0.15, w / 2, top + pic / 2, w * 0.68)
  g.addColorStop(0, lightTone)
  g.addColorStop(1, darkTone)
  ctx.fillStyle = g
  ctx.fillRect(0, top, w, pic)
}

function frameTexture(p, shelf, kind, i, n) {
  const { w, top, pic } = FRAME
  const [c, ctx] = canvas(FRAME.w, FRAME.h)
  filmBase(ctx, p, shelf, i, n)
  const accent = accentOf(p)
  const mid = w / 2
  if (kind === 'title') {
    // the opening title card, on the pale leader with the countdown mark up top
    picture(ctx, '#dcd5c4', '#9c968a')
    const cy = top + 112
    ctx.strokeStyle = 'rgba(23,18,14,0.35)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(mid, cy, 62, 0, Math.PI * 2)
    ctx.moveTo(mid - 84, cy)
    ctx.lineTo(mid + 84, cy)
    ctx.moveTo(mid, cy - 84)
    ctx.lineTo(mid, cy + 84)
    ctx.stroke()
    ctx.fillStyle = 'rgba(23,18,14,0.16)'
    ctx.beginPath()
    ctx.moveTo(mid, cy)
    ctx.arc(mid, cy, 62, -Math.PI / 2, Math.PI * 0.35)
    ctx.fill()
    const title = p.title.toUpperCase()
    const ts = fit(ctx, title, TITLE, 900, w - 160, 116, 50)
    text(ctx, title, mid, top + 290, ts, INK, 900, TITLE, 'center')
    const kick = (p.kicker || '').toUpperCase()
    text(ctx, kick, mid, top + 360, fit(ctx, kick, BODY, 800, w - 160, 40, 28), '#4a3f33', 800, BODY, 'center')
    ctx.fillStyle = 'rgba(23,18,14,0.4)'
    ctx.fillRect(mid - 90, top + 400, 180, 4)
    // the one-beat setup: the everyday problem this solves
    text(ctx, 'THE PROBLEM', mid, top + 456, 26, '#4a3f33', 700, TYPE, 'center')
    para(ctx, (p.making && p.making.problem) || p.tagline, mid, top + 512, w - 220, 42, 54, INK, 600, 'center')
    text(ctx, `A FILM IN ${n} SCENES`, mid, top + pic - 50, 28, '#4a3f33', 700, TYPE, 'center')
  } else if (typeof kind === 'number') {
    const f = p.frames[kind]
    picture(ctx, '#2c231a', '#0b0806')
    text(ctx, `SCENE ${i + 1}`, mid, top + 78, 30, accent, 700, TYPE, 'center')
    const draw = ICONS[f.icon] || ICONS.review
    draw(ctx, mid, top + 250, 250, accent)
    const name = f.name.toUpperCase()
    const ns = fit(ctx, name, TITLE, 900, w - 160, 100, 50)
    text(ctx, name, mid, top + 500, ns, CREAM, 900, TITLE, 'center')
    para(ctx, f.says, mid, top + 576, w - 180, 48, 60, 'rgba(243,234,214,0.92)', 600, 'center')
  } else if (kind === 'moment') {
    picture(ctx, '#2c231a', '#0b0806')
    // the last scene is the payoff; work systems carry no dates (DESIGN.md, work rules)
    text(ctx, 'WHAT CHANGED', mid, top + 140, 56, accent, 900, TITLE, 'center')
    const mo = p.moment || {}
    ctx.font = `600 50px ${BODY}`
    const rows = lines(ctx, mo.what || '', w - 200).length
    para(ctx, mo.what, mid, top + 240 + Math.max(0, (6 - rows) * 30), w - 200, 50, 62, CREAM, 600, 'center')
    text(ctx, 'THE END', mid, top + pic - 46, 46, 'rgba(243,234,214,0.8)', 900, TITLE, 'center')
  } else {
    picture(ctx, '#2c231a', '#0b0806')
    text(ctx, 'WHAT I BUILT', mid, top + 110, 52, accent, 900, TITLE, 'center')
    let y = top + 190
    for (const b of p.built || []) {
      text(ctx, '✦', 96, y, 32, accent, 700)
      y = para(ctx, b, 140, y, w - 230, 38, 46, CREAM, 600) + 14
    }
  }
  ctx.restore()
  grain(ctx, FRAME.w, FRAME.h, 0.05)
  return toTexture(c)
}

export async function filmTextures(p, shelf) {
  const frames = []
  const plan = filmPlan(p)
  for (const [i, kind] of plan.entries()) {
    frames.push(frameTexture(p, shelf, kind, i, plan.length))
    await new Promise((r) => setTimeout(r))
  }
  return { frames }
}
