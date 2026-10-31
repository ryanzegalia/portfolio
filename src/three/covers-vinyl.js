// Draws the "Original works" shelf's vinyl LPs: the 12-inch jacket (front and back), the record
// itself (grooves, a gap between each track, the center label) and the printed inner sleeve the
// record comes out in. The sleeve carries the liner notes, one side each, and you turn it over.
import { canvas, toTexture, fit, wrap, grain, barcode, ratingBox, hash, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { DIM, lines } from './covers-booklet.js'

// One unit is 100 mm, the same 12 inches as the LaserDisc jackets. The record is a share of the
// jacket's edge; PEEK is how far it shows out of the open side when you pull the jacket.
export const LP = { s: 2.05, t: 0.05 }
export const DISC = 0.47
export const PEEK = 0.24
const FACE = 1200
// the sleeve's sides are drawn smaller so their type reads at the size a phone shows them
const SIDE = 1000
const SLEEVE = '#f4efe3'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`
const accentOf = (p) => (p.palette && p.palette.accent) || '#8a62d1'
const bgOf = (p) => (p.palette && p.palette.bg) || '#1d1630'
const inkOf = (p) => (p.palette && p.palette.ink) || CREAM

function text(ctx, s, x, y, size, color = INK, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

const light = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}
// one ink the sleeve can be printed in: the accent, unless it's too pale to read on cream
const printInk = (p) => [accentOf(p), bgOf(p)].find((c) => light(c) < 0.55) || INK

// ---- the cover art -----------------------------------------------------------------------------

// Paint at n x n and blow it up with hard edges, for anything that should look like pixel art.
function pixels(ctx, x, y, size, n, paint) {
  const [c, g] = canvas(n, n)
  paint(g, n)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(c, x, y, size, size)
  ctx.restore()
}

// A ballfield from above in big pixels: mowed outfield, the dirt arc, chalk lines and the bases.
function diamond(ctx, p, x, y, size) {
  const grass = accentOf(p)
  pixels(ctx, x, y, size, 40, (g) => {
    const dot = (i, j, c) => {
      g.fillStyle = c
      g.fillRect(i, j, 1, 1)
    }
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        const dx = i - 19.5
        const dy = 35 - j
        const r = Math.hypot(dx, dy)
        if (dy < 0 || Math.abs(dx) > dy || r > 33) continue
        if (Math.abs(Math.abs(dx) - dy) < 0.8) dot(i, j, CREAM)
        else if (Math.abs(dx) + Math.abs(dy - 9) <= 6) dot(i, j, (i + j) % 4 < 2 ? grass : shade(grass, -0.12))
        else if (r < 16) dot(i, j, '#a8703f')
        else dot(i, j, Math.floor((i + 40 - j) / 3) % 2 ? grass : shade(grass, -0.14))
      }
    }
    g.fillStyle = '#a8703f'
    g.fillRect(18, 24, 3, 3)
    g.fillStyle = CREAM
    for (const [i, j] of [[19, 34], [28, 25], [19, 16], [10, 25]]) g.fillRect(i, j, 2, 2)
  })
}

// Layer lines stacking up into a shape, the way a print builds, with the top layer still going on.
function layers(ctx, p, x, y, size) {
  const accent = accentOf(p)
  const rows = 30
  const gap = size / rows
  const cx = x + size / 2
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1)
    const r = size * (0.2 + 0.1 * Math.sin(t * Math.PI * 1.6 + 0.4) + 0.06 * (1 - t))
    const ly = y + size - i * gap - gap / 2
    ctx.strokeStyle = i % 2 ? shade(accent, -0.18) : accent
    ctx.lineWidth = gap * 0.78
    ctx.lineCap = 'round'
    ctx.beginPath()
    if (i === rows - 1) {
      ctx.moveTo(cx - r, ly)
      ctx.lineTo(cx + r * 0.1, ly)
      ctx.stroke()
      // the nozzle, laying it down
      ctx.fillStyle = inkOf(p)
      ctx.beginPath()
      ctx.moveTo(cx + r * 0.1 - 26, ly - gap * 2.6)
      ctx.lineTo(cx + r * 0.1 + 26, ly - gap * 2.6)
      ctx.lineTo(cx + r * 0.1 + 6, ly - gap * 0.7)
      ctx.lineTo(cx + r * 0.1 - 6, ly - gap * 0.7)
      ctx.fill()
      ctx.fillRect(cx + r * 0.1 - 44, ly - gap * 4.4, 88, gap * 1.9)
    } else {
      ctx.moveTo(cx - r, ly)
      ctx.lineTo(cx + r, ly)
      ctx.stroke()
    }
  }
}

// A column of show dates on little tabs, tilted like they were stuck on by hand.
function datebook(ctx, p, x, y, size) {
  const accent = accentOf(p)
  const n = 6
  for (let i = 0; i < n; i++) {
    const r = (hash(`${p.slug}${i}`) % 9) - 4
    ctx.save()
    ctx.translate(x + size * (0.18 + (i % 2) * 0.12), y + size * 0.08 + i * (size * 0.15))
    ctx.rotate(r * 0.012)
    ctx.fillStyle = i % 3 === 2 ? inkOf(p) : accent
    ctx.beginPath()
    ctx.roundRect(0, 0, size * 0.62, size * 0.1, size * 0.05)
    ctx.fill()
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    for (let k = 0; k < 3; k++) ctx.fillRect(size * (0.1 + k * 0.16), size * 0.04, size * 0.1, size * 0.022)
    ctx.restore()
  }
  // a map pin or two
  for (const [px, py] of [[0.84, 0.2], [0.78, 0.62]]) {
    const cx = x + size * px
    const cy = y + size * py
    ctx.fillStyle = inkOf(p)
    ctx.beginPath()
    ctx.arc(cx, cy, size * 0.05, Math.PI, 0)
    ctx.lineTo(cx, cy + size * 0.11)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = bgOf(p)
    ctx.beginPath()
    ctx.arc(cx, cy, size * 0.02, 0, Math.PI * 2)
    ctx.fill()
  }
}

// An asanoha (hemp leaf) lattice in thin light lines, the kind cut into a printed vent panel, with
// one cell printed solid.
function lattice(ctx, p, x, y, size) {
  const accent = accentOf(p)
  const a = size / 4
  const hgt = (a * Math.sqrt(3)) / 2
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, size, size)
  ctx.clip()
  ctx.strokeStyle = accent
  ctx.lineWidth = 5
  ctx.lineJoin = 'round'
  const tri = (ax, ay, bx, by, cx, cy, fill) => {
    const gx = (ax + bx + cx) / 3
    const gy = (ay + by + cy) / 3
    if (fill) {
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.lineTo(cx, cy)
      ctx.fill()
    }
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.lineTo(cx, cy)
    ctx.closePath()
    for (const [vx, vy] of [[ax, ay], [bx, by], [cx, cy]]) {
      ctx.moveTo(vx, vy)
      ctx.lineTo(gx, gy)
    }
    ctx.stroke()
  }
  for (let r = -1; r < size / hgt + 1; r++) {
    const off = r % 2 ? a / 2 : 0
    for (let q = -2; q < 6; q++) {
      const lx = x + q * a + off
      const ty = y + r * hgt
      tri(lx, ty + hgt, lx + a, ty + hgt, lx + a / 2, ty, r === 2 && q === 1)
      tri(lx + a / 2, ty, lx + a * 1.5, ty, lx + a, ty + hgt, false)
    }
  }
  ctx.restore()
}

// Stacked blocks of colour, for a record with no picture of its own.
function blocks(ctx, p, x, y, size) {
  const accent = accentOf(p)
  ctx.fillStyle = accent
  ctx.fillRect(x, y + size * 0.1, size * 0.62, size * 0.5)
  ctx.fillStyle = inkOf(p)
  ctx.fillRect(x + size * 0.34, y + size * 0.42, size * 0.66, size * 0.12)
  ctx.globalAlpha = 0.85
  ctx.fillStyle = shade(accent, -0.3)
  ctx.beginPath()
  ctx.arc(x + size * 0.74, y + size * 0.3, size * 0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

const MOTIFS = { diamond, layers, lattice, datebook, blocks }

function shade(hex, by) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v + (by < 0 ? v * by : (255 - v) * by))))
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`
}

// The faint ring a record wears into its jacket after a few years on the shelf.
function ringWear(ctx, w) {
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 34
  ctx.beginPath()
  ctx.arc(w / 2, w / 2, w * DISC - 30, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 14
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'
  ctx.beginPath()
  ctx.arc(w / 2, w / 2, w * DISC * 0.34, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// The round sticker on the shrink wrap.
function hype(ctx, shelf, x, y, r) {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.beginPath()
  ctx.arc(x + 5, y + 7, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#f2d64b'
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  const [a, b] = (shelf.sticker || '33 1/3 RPM').split(/ (?=\S+$)/)
  text(ctx, a, x, y + 6, r * 0.52, INK, 900, TITLE, 'center')
  text(ctx, b || '', x, y + r * 0.5, r * 0.26, INK, 700, TYPE, 'center')
  ctx.restore()
}

export async function lpFront(p, shelf) {
  const w = FACE
  const [c, ctx] = canvas(w, w)
  const img = await loadImage(p.photoUrl)
  const ink = inkOf(p)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, w, w)
  const art = { x: 150, y: 150, size: 640 }
  if (img) {
    // a real picture goes on as a tilted framed still, never cropped to the cover
    const s = Math.min((w - 200) / img.width, 600 / img.height)
    const iw = img.width * s
    const ih = img.height * s
    ctx.save()
    ctx.translate(w / 2, 150 + 300)
    ctx.rotate(-0.035)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(-iw / 2 - 14 + 8, -ih / 2 - 14 + 12, iw + 28, ih + 28)
    ctx.fillStyle = '#fff'
    ctx.fillRect(-iw / 2 - 14, -ih / 2 - 14, iw + 28, ih + 28)
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih)
    ctx.restore()
  } else (MOTIFS[p.art] || blocks)(ctx, p, art.x + 130, art.y, art.size)
  ringWear(ctx, w)
  // the artist across the top, the way a record says who made it
  ctx.font = `700 44px ${BODY}`
  ctx.fillStyle = ink
  ctx.letterSpacing = '6px'
  ctx.fillText('RYAN ZEGALIA', 70, 104)
  ctx.letterSpacing = '0px'
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.strokeRect(w - 70 - 150, 66, 150, 52)
  text(ctx, 'STEREO', w - 70 - 75, 102, 30, ink, 700, TYPE, 'center')
  // the title, big, low on the cover
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, w - 140, 190, 70)
  text(ctx, title, 70, 1000, ts, ink, 900, TITLE)
  text(ctx, (p.kicker || '').toUpperCase(), 72, 1062, 38, accentOf(p), 700, BODY)
  text(ctx, 'BUILT AND RUN BY RYAN ZEGALIA', 72, w - 48, 22, ink, 700, TYPE)
  text(ctx, `${catalog(p, shelf)}  ·  LONG PLAYING`, w - 70, w - 48, 22, ink, 700, TYPE, 'right')
  hype(ctx, shelf, w - 170, 300, 92)
  grain(ctx, w, w, 0.04)
  return toTexture(c)
}

// The back of the jacket: the track list up top, the blurb, what it was recorded with, the fine print.
function drawLpBack(ctx, p, shelf, k) {
  const w = FACE
  const px = (n) => Math.round(n * k)
  const m = 64
  ctx.fillStyle = CREAM
  ctx.fillRect(0, 0, w, w)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, w, 200)
  text(ctx, 'RYAN ZEGALIA', m, 70, 30, inkOf(p), 700, BODY)
  const title = p.title.toUpperCase()
  text(ctx, title, m, 160, fit(ctx, title, TITLE, 900, w - m * 2, 96, 50), inkOf(p), 900, TITLE)
  let y = 200 + px(78)
  const col = (w - m * 2) / 2
  let bottom = y
  ;['a', 'b'].forEach((side, ci) => {
    const x = m + ci * col
    let ty = y
    text(ctx, side === 'a' ? 'SIDE ONE' : 'SIDE TWO', x, ty, px(26), DIM, 700, TYPE)
    ty += px(52)
    ;(p.tracks?.[side] || []).forEach((t, i) => {
      text(ctx, `${side.toUpperCase()}${i + 1}`, x, ty, px(26), printInk(p), 700, TYPE)
      ctx.font = `600 ${px(36)}px ${BODY}`
      ctx.fillStyle = INK
      ty = wrap(ctx, t, x + px(64), ty, col - px(84), px(44)) + px(4)
    })
    bottom = Math.max(bottom, ty)
  })
  y = bottom + px(24)
  ctx.fillStyle = INK
  ctx.fillRect(m, y, w - m * 2, 3)
  y += px(56)
  // the pitch, in one line of big type (the liner notes inside the sleeve carry the full blurb)
  ctx.font = `700 ${px(54)}px ${BODY}`
  ctx.fillStyle = INK
  y = wrap(ctx, p.tagline || p.what || '', m, y + px(10), w - m * 2, px(62)) + px(10)
  ctx.font = `italic 600 ${px(30)}px ${BODY}`
  ctx.fillStyle = DIM
  ctx.fillText('Liner notes inside the sleeve.', m, y)
  y += px(50)
  for (const [label, value] of [
    ['RECORDED WITH', (p.requirements || []).join(' · ')],
    ['STATUS', p.status],
  ]) {
    if (!value) continue
    text(ctx, label, m, y, px(26), DIM, 700, TYPE)
    ctx.font = `600 ${px(38)}px ${BODY}`
    ctx.fillStyle = INK
    y = wrap(ctx, value, m, y + px(42), w - m * 2, px(46)) + px(16)
  }
  return y
}

export function lpBack(p, shelf, phone = false) {
  if (phone) {
    const [c, ctx] = canvas(FACE, FACE)
    const m = 64, width = FACE - m * 2
    ctx.fillStyle = CREAM
    ctx.fillRect(0, 0, FACE, FACE)
    ctx.fillStyle = bgOf(p)
    ctx.fillRect(0, 0, FACE, 200)
    text(ctx, 'RYAN ZEGALIA', m, 64, 36, inkOf(p), 700, BODY)
    text(ctx, p.title.toUpperCase(), m, 156, fit(ctx, p.title.toUpperCase(), TITLE, 900, width, 88), inkOf(p), 900, TITLE)
    let bottom = 0
    ;['a', 'b'].forEach((side, col) => {
      const x = m + col * width / 2
      text(ctx, side === 'a' ? 'SIDE ONE · SELECTIONS' : 'SIDE TWO · SELECTIONS', x, 274, 28, DIM, 700, TYPE)
      let y = 340
      for (const [i, track] of (p.tracks?.[side] || []).slice(0, 3).entries()) {
        ctx.font = `600 46px ${BODY}`
        ctx.fillStyle = INK
        y = wrap(ctx, `${side.toUpperCase()}${i + 1}  ${track}`, x, y, width / 2 - 32, 56) + 18
      }
      bottom = Math.max(bottom, y)
    })
    ctx.fillStyle = INK
    ctx.fillRect(m, bottom + 8, width, 3)
    ctx.font = `700 52px ${BODY}`
    wrap(ctx, p.tagline || '', m, bottom + 80, width, 62)
    ctx.font = `600 44px ${BODY}`
    wrap(ctx, p.credit || '', m, 1070, width, 52)
    grain(ctx, FACE, FACE, 0.035)
    return toTexture(c)
  }
  const w = FACE
  const [c, ctx] = canvas(w, w)
  const limit = w - 240
  let k = 1.15
  for (; k >= 0.6; k -= 0.05) if (drawLpBack(ctx, p, shelf, k) <= limit) break
  if (k < 0.72) console.warn(`[shelf] back of "${p.title}" had to shrink to ${Math.round(k * 100)}%: cut some words`)
  const m = 64
  const by = w - 210
  ratingBox(ctx, m, by, p.rating || 'O', p.ratingWord || 'Original', INK)
  text(ctx, p.credit || '', m + 180, by + 50, 30, INK, 700, BODY)
  text(ctx, 'A RYAN ZEGALIA PRODUCTION  ·  33 1/3 RPM', m + 180, by + 92, 22, DIM, 700, TYPE)
  text(ctx, catalog(p, shelf), m + 180, by + 128, 22, DIM, 700, TYPE)
  barcode(ctx, w - m - 260, by + 24, 260, 84, hash(p.slug || p.title))
  grain(ctx, w, w, 0.035)
  return toTexture(c)
}

// ---- the record ---------------------------------------------------------------------------------

// Black vinyl seen from above: fine grooves, a smooth gap between each track on side A, and the
// paper label in the middle with the title, the side and the speed.
export function recordFace(p, shelf) {
  const n = 1024
  const c0 = n / 2
  const [c, ctx] = canvas(n, n)
  ctx.fillStyle = '#0b0b0c'
  ctx.fillRect(0, 0, n, n)
  const label = n * 0.17
  const inner = label + 34
  const outer = n / 2 - 14
  for (let r = inner; r < outer; r += 3) {
    ctx.strokeStyle = r % 2 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(c0, c0, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  // the gaps between tracks, outermost first like the record plays
  const count = Math.max(1, p.tracks?.a?.length || 4)
  for (let i = 1; i < count; i++) {
    const r = outer - ((outer - inner) * i) / count
    ctx.strokeStyle = '#050505'
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.arc(c0, c0, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(c0, c0, r + 4, 0, Math.PI * 2)
    ctx.stroke()
  }
  // the smooth run-out round the label
  ctx.fillStyle = '#0e0e10'
  ctx.beginPath()
  ctx.arc(c0, c0, inner - 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = accentOf(p)
  ctx.beginPath()
  ctx.arc(c0, c0, label, 0, Math.PI * 2)
  ctx.fill()
  const lk = light(accentOf(p)) > 0.55 ? INK : CREAM
  text(ctx, 'RYAN ZEGALIA', c0, c0 - label * 0.62, 24, lk, 700, BODY, 'center')
  const title = p.title.toUpperCase()
  text(ctx, title, c0, c0 - label * 0.2, fit(ctx, title, TITLE, 900, label * 1.5, 52, 22), lk, 900, TITLE, 'center')
  text(ctx, 'SIDE A', c0 - label * 0.55, c0 + 12, 22, lk, 700, TYPE, 'center')
  text(ctx, '33 1/3', c0 + label * 0.55, c0 + 12, 22, lk, 700, TYPE, 'center')
  text(ctx, catalog(p, shelf), c0, c0 + label * 0.62, 20, lk, 700, TYPE, 'center')
  ctx.fillStyle = '#121214'
  ctx.beginPath()
  ctx.arc(c0, c0, n * 0.012, 0, Math.PI * 2)
  ctx.fill()
  return toTexture(c)
}

// The two soft streaks of light a record throws back: they stay with the lamp while it turns, so
// they're drawn on their own and laid over the spinning record.
export function recordSheen() {
  const n = 512
  const [c, ctx] = canvas(n, n)
  const g = ctx.createConicGradient(-0.9, n / 2, n / 2)
  for (const at of [0, 0.5]) {
    g.addColorStop(at, 'rgba(255,255,255,0)')
    g.addColorStop(at + 0.06, 'rgba(255,240,220,0.5)')
    g.addColorStop(at + 0.12, 'rgba(255,255,255,0)')
  }
  g.addColorStop(0.99, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n / 2 - 4, 0, Math.PI * 2)
  ctx.arc(n / 2, n / 2, n * 0.21, 0, Math.PI * 2, true)
  ctx.fill()
  return toTexture(c)
}

// ---- the inner sleeve ---------------------------------------------------------------------------

// The sleeve's two sides, in order; App reads the length for paging. Each side is printed in two
// columns: a wide screen reads a whole side at once, a phone one column at a time.
export const vinylPlan = (p, single) => (single ? ['notes', 'notes', 'made', 'made'] : ['notes', 'made'])
// how far each column's middle sits from the sleeve's middle, in sleeve units
export const COLUMN = 0.223
// and how far from a column's middle the other column's type starts (260 of the side's 1000 px)
export const NEXT = 0.252
const COLS = [{ x: 70, w: 400 }, { x: 530, w: 400 }]
const TOP = 160
const BOTTOM = SIDE - 54

// What a side says, in reading order: it runs down the left column and on into the right one.
function sideItems(p, kind) {
  const mk = p.making || {}
  if (kind === 'notes') {
    const items = [{ t: 'title', s: 'LINER NOTES' }, { t: 'p', s: p.what }]
    if (mk.problem) items.push({ t: 'h', s: 'WHY I MADE IT' }, { t: 'p', s: mk.problem })
    if (p.moment?.what) items.push({ t: 'h', s: p.moment.when ? `HOW IT WENT · ${p.moment.when.toUpperCase()}` : 'HOW IT WENT' }, { t: 'p', s: p.moment.what })
    if (mk.credits?.length) items.push({ t: 'h', s: 'WITH THANKS TO' }, ...mk.credits.map((s) => ({ t: 'fine', s })))
    return items
  }
  const items = [{ t: 'title', s: 'HOW IT WAS MADE' }]
  ;(mk.how || []).forEach((s, i) => items.push({ t: 'step', mark: String(i + 1), s }))
  items.push({ t: 'h', s: 'WHAT I BUILT' }, ...(p.built || []).map((s) => ({ t: 'step', mark: '●', s })))
  if (p.requirements?.length) items.push({ t: 'h', s: 'RECORDED WITH' }, { t: 'fine', s: p.requirements.join(', ') })
  return items
}

// Lay the items out at scale k. Returns false if they run out of room before the end.
function flow(ctx, p, items, k) {
  const px = (n) => Math.round(n * k)
  const type = {
    p: { font: `500 ${px(31)}px ${BODY}`, lh: px(39), gap: px(18), color: INK },
    step: { font: `500 ${px(31)}px ${BODY}`, lh: px(39), gap: px(10), color: INK },
    fine: { font: `600 ${px(27)}px ${BODY}`, lh: px(33), gap: px(8), color: DIM },
  }
  let col = 0
  let y = TOP
  const next = () => {
    col++
    y = TOP
    return col < COLS.length
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const { x, w } = COLS[col] || COLS[0]
    if (it.t === 'title') {
      const size = fit(ctx, it.s, TITLE, 900, w, px(80), 40)
      if (y + size > BOTTOM && !next()) return false
      text(ctx, it.s, COLS[col].x, y + size * 0.8, size, INK, 900, TITLE)
      y += size * 0.8 + px(30)
    } else if (it.t === 'h') {
      // a heading never sits alone at the foot of a column
      const after = type[items[i + 1]?.t] || type.p
      if (y > TOP && y + px(40) + after.lh * 2 > BOTTOM && !next()) return false
      text(ctx, it.s, COLS[col].x, y + px(24), px(24), printInk(p), 700, TYPE)
      y += px(52)
    } else {
      const ty = type[it.t]
      const indent = it.t === 'step' ? px(44) : 0
      ctx.font = ty.font
      // a column breaks between sentences, never inside one: as many whole sentences as fit go here,
      // the rest start the next column
      let rest = (it.s || '').split(/(?<=[.!?]["')]?)\s+(?=["'(A-Z0-9])/).filter(Boolean)
      let first = true
      while (rest.length) {
        const cx = COLS[col].x
        let n = rest.length
        let ls = []
        for (; n > 0; n--) {
          ls = lines(ctx, rest.slice(0, n).join(' '), COLS[col].w - indent)
          if (y + ls.length * ty.lh <= BOTTOM + px(10)) break
        }
        if (!n) {
          if (!next()) return false
          continue
        }
        ls.forEach((l, j) => {
          if (j === 0 && first && it.mark) text(ctx, it.mark, cx, y + ty.lh * 0.72, px(31), printInk(p), 900, TITLE)
          ctx.font = ty.font
          ctx.fillStyle = ty.color
          ctx.fillText(l, cx + indent, y + ty.lh * 0.72)
          y += ty.lh
        })
        first = false
        rest = rest.slice(n)
        if (rest.length && !next()) return false
      }
      y += ty.gap
    }
  }
  return true
}

function sideTexture(p, shelf, kind) {
  const [c, ctx] = canvas(SIDE, SIDE)
  const items = sideItems(p, kind)
  const paper = () => {
    ctx.clearRect(0, 0, SIDE, SIDE)
    ctx.fillStyle = SLEEVE
    ctx.fillRect(0, 0, SIDE, SIDE)
    // the printed band along the top: whose record, which side
    ctx.fillStyle = bgOf(p)
    ctx.fillRect(0, 0, SIDE, 92)
    for (const col of COLS) {
      const title = p.title.toUpperCase()
      text(ctx, `RYAN ZEGALIA · ${kind === 'notes' ? 'SIDE 1' : 'SIDE 2'}`, col.x, 30, 21, inkOf(p), 700, TYPE)
      text(ctx, title, col.x, 66, fit(ctx, title, TYPE, 700, col.w, 26, 16), inkOf(p), 700, TYPE)
    }
  }
  let k = 1
  for (; k >= 0.64; k -= 0.04) {
    paper()
    if (flow(ctx, p, items, k)) break
  }
  if (k < 0.72) console.warn(`[shelf] the sleeve of "${p.title}" (${kind}) had to shrink to ${Math.round(k * 100)}%: cut some words`)
  grain(ctx, SIDE, SIDE, 0.03)
  // the thumb cut in the open edge: the right side of side 1 is the left side of side 2
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(kind === 'notes' ? SIDE : 0, SIDE / 2, 60, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  return toTexture(c)
}

export async function sleeveSides(p, shelf) {
  const sides = []
  for (const kind of vinylPlan(p, false)) {
    sides.push(sideTexture(p, shelf, kind))
    await new Promise((r) => setTimeout(r))
  }
  return sides
}
