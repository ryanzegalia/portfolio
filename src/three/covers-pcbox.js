// Draws the On the clock shelf's 90s PC software boxes (front, back, sides, lid) and the getting
// started manual that lifts out of them. One product line: worn cream card, navy type, a navy spine,
// and on the front a program window of that part of the job, a different program on every box. The
// windows are drawn here in code with made-up entries, never the real screens.
import { canvas, toTexture, fit, wrap, grain, barcode, hash, TITLE, BODY, TYPE, INK } from './covers.js'
import { PAPER, DIM, lines } from './covers-booklet.js'

// One unit is 100 mm. The lid is the band across the top of the box.
export const BOX = { w: 1.5, h: 1.95, d: 0.42, lid: 0.123 }
const PX = 1024 / BOX.w
export const FACE = { w: 1024, h: Math.round(BOX.h * PX) }
const BAND = Math.round(BOX.lid * PX)
export const SIDE = { w: Math.round(BOX.d * PX), h: FACE.h - BAND }
export const MANUAL_W = 1000

export const CARD = '#ebe2cd'
const NAVY = '#1e3763'
const NAVY_LT = '#35588f'
const FIELD = '#fbf8f0'
const SOFT = '#5d6576'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`

function bar(ctx, x, y, w, h, color) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

function text(ctx, s, x, y, size, color = NAVY, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

// Old card stock: a little uneven, darker toward the edges, a few scuffs.
function cardStock(ctx, w, h, seed, base = CARD) {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)
  const v = ctx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75)
  v.addColorStop(0, 'rgba(120,96,60,0)')
  v.addColorStop(1, 'rgba(120,96,60,0.28)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
  let r = seed
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 2
  for (let i = 0; i < 14; i++) {
    r = (r * 9301 + 49297) % 233280
    const x = (r / 233280) * w
    r = (r * 9301 + 49297) % 233280
    const y = (r / 233280) * h
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + 20 + (r % 60), y + (r % 7) - 3)
    ctx.stroke()
  }
}

// ---- the program windows -------------------------------------------------------------------
// Each box's stand-in screen is its own made-up program, drawn the way a 90s box printed a
// screenshot: a window with a menu bar, the part of the job it does inside, generic entries only.

const PANEL = '#e9e5da'
const GREEN = '#2f7d4f'
const RED = '#b5412e'
const LINE = 'rgba(30,55,99,0.28)'

// a raised (or sunk) bevel, the way 90s windows drew a button or a field
function bevel(ctx, x, y, w, h, fill, sunk = false) {
  bar(ctx, x, y, w, h, fill)
  ctx.lineWidth = 2
  ctx.strokeStyle = sunk ? '#7d8594' : '#ffffff'
  ctx.beginPath()
  ctx.moveTo(x + 1, y + h - 1)
  ctx.lineTo(x + 1, y + 1)
  ctx.lineTo(x + w - 1, y + 1)
  ctx.stroke()
  ctx.strokeStyle = sunk ? '#ffffff' : '#7d8594'
  ctx.beginPath()
  ctx.moveTo(x + w - 1, y + 1)
  ctx.lineTo(x + w - 1, y + h - 1)
  ctx.lineTo(x + 1, y + h - 1)
  ctx.stroke()
}

function btn(ctx, x, y, w, h, label, size, dark = false) {
  if (dark) {
    bar(ctx, x, y, w, h, NAVY)
    ctx.strokeStyle = '#0d1a33'
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
  } else bevel(ctx, x, y, w, h, PANEL)
  text(ctx, label, x + w / 2, y + h / 2 + size * 0.36, size, dark ? '#fff' : NAVY, 700, BODY, 'center')
}

// grey bars standing in for a line of writing
function writing(ctx, x, y, widths, thick, gap, color = '#c9ced8') {
  widths.forEach((ww, i) => bar(ctx, x, y + i * gap, ww, thick, color))
}

function chip(ctx, x, y, label, size, color) {
  ctx.font = `700 ${size}px ${BODY}`
  const cw = ctx.measureText(label).width + size
  bar(ctx, x, y, cw, size * 1.35, color)
  text(ctx, label, x + size / 2, y + size * 1.02, size, '#fff', 700)
  return cw
}

function tick(ctx, x, y, s, color = GREEN, lw = 4) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.5)
  ctx.lineTo(x + s * 0.35, y + s * 0.85)
  ctx.lineTo(x + s, y)
  ctx.stroke()
}

// Storefronts: a browser on a product page, the price read from one source, a stock flag, a store map
function webScreen(ctx, x, y, w, h, k) {
  bevel(ctx, x + 12, y + 10, w - 24, 34 * k, '#fff', true)
  text(ctx, 'http://www.example.com/shop/starter-kit', x + 24, y + 10 + 24 * k, 19 * k, SOFT, 400, TYPE)
  const top = y + 20 + 34 * k
  bar(ctx, x + 12, top, w - 24, y + h - 12 - top, '#ffffff')
  bar(ctx, x + 12, top, w - 24, 34 * k, NAVY_LT)
  text(ctx, 'SHOP     GUIDES     SUPPORT     FIND A STORE', x + 28, top + 24 * k, 19 * k, '#fff', 700)
  const py = top + 34 * k + 16
  const ph = y + h - 26 - py
  const pw = Math.min(ph * 1.05, (w - 24) * 0.42)
  const g = ctx.createLinearGradient(0, py, 0, py + ph)
  g.addColorStop(0, '#eef1f5')
  g.addColorStop(1, '#bfc7d3')
  ctx.fillStyle = g
  ctx.fillRect(x + 26, py, pw, ph)
  // the product: a carry case with a handle, drawn plainly
  const cx = x + 26 + pw / 2
  const cy = py + ph * 0.58
  ctx.fillStyle = '#26324a'
  ctx.fillRect(cx - pw * 0.34, cy - ph * 0.2, pw * 0.68, ph * 0.42)
  ctx.strokeStyle = '#26324a'
  ctx.lineWidth = 9 * k
  ctx.strokeRect(cx - pw * 0.1, cy - ph * 0.3, pw * 0.2, ph * 0.1)
  bar(ctx, cx - pw * 0.34, cy - ph * 0.04, pw * 0.68, 5 * k, '#8b96aa')
  const rx = x + 26 + pw + 26
  const rw = x + w - 26 - rx
  text(ctx, 'Starter Kit', rx, py + 40 * k, 40 * k, INK, 700, TITLE)
  text(ctx, '$129.00', rx, py + 86 * k, 36 * k, NAVY, 700, TYPE)
  chip(ctx, rx, py + 102 * k, 'IN STOCK', 20 * k, GREEN)
  bevel(ctx, rx, py + 146 * k, rw, 34 * k, '#fff', true)
  text(ctx, 'Size: Standard', rx + 10, py + 170 * k, 21 * k, INK, 400, TYPE)
  bar(ctx, rx + rw - 34 * k, py + 146 * k, 34 * k, 34 * k, '#dfe5ef')
  btn(ctx, rx, py + 194 * k, Math.min(rw, 230 * k), 44 * k, 'Add to Cart', 24 * k, true)
  // the store map, if there's room under the button
  const my = py + 254 * k
  if (y + h - 26 - my > 60 * k) {
    const mh = y + h - 26 - my
    bar(ctx, rx, my, rw, mh, '#e4ecd9')
    ctx.strokeStyle = '#c4d2ae'
    ctx.lineWidth = 6 * k
    ctx.beginPath()
    ctx.moveTo(rx, my + mh * 0.7)
    ctx.lineTo(rx + rw, my + mh * 0.35)
    ctx.moveTo(rx + rw * 0.3, my)
    ctx.lineTo(rx + rw * 0.45, my + mh)
    ctx.stroke()
    ;[[0.2, 0.4], [0.6, 0.62], [0.78, 0.3]].forEach(([a, b]) => {
      ctx.fillStyle = RED
      ctx.beginPath()
      ctx.arc(rx + rw * a, my + mh * b, 8 * k, 0, Math.PI * 2)
      ctx.fill()
    })
    text(ctx, 'Find a store near you', rx + 10, my + 26 * k, 19 * k, NAVY, 700)
  }
}

// The Mailroom: the send calendar, a few weeks of it, every send marked approved or still a draft
function mailScreen(ctx, x, y, w, h, k) {
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI']
  const gx = x + 14
  const gw = w - 28
  const cw = gw / 5
  bar(ctx, gx, y + 10, gw, 32 * k, '#dfe5ef')
  days.forEach((d, i) => text(ctx, d, gx + i * cw + cw / 2, y + 10 + 23 * k, 20 * k, NAVY, 700, TYPE, 'center'))
  const top = y + 10 + 32 * k
  const status = 30 * k
  const rows = 3
  const rh = (y + h - 10 - status - top) / rows
  const sends = { 0: ['News', 1], 2: ['Sale', 1], 4: ['Update', 1], 6: ['Guide', 1], 8: ['Sale', 1], 10: ['Event', 1], 12: ['Survey', 0], 14: ['News', 0] }
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 5; i++) {
      const cx = gx + i * cw
      const cy = top + r * rh
      bar(ctx, cx, cy, cw, rh, '#ffffff')
      ctx.strokeStyle = LINE
      ctx.lineWidth = 2
      ctx.strokeRect(cx, cy, cw, rh)
      const sd = sends[r * 5 + i]
      if (!sd) continue
      // an envelope, and the send's kind under it
      const ew = Math.min(cw * 0.5, rh * 0.6)
      const eh = ew * 0.62
      const ex = cx + 12
      const ey = cy + 12
      bar(ctx, ex, ey, ew, eh, sd[1] ? NAVY : '#9aa4b5')
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 3 * k
      ctx.beginPath()
      ctx.moveTo(ex + 3, ey + 3)
      ctx.lineTo(ex + ew / 2, ey + eh * 0.6)
      ctx.lineTo(ex + ew - 3, ey + 3)
      ctx.stroke()
      if (sd[1]) tick(ctx, ex + ew + 8, ey + 4, 22 * k, GREEN, 4 * k)
      text(ctx, sd[0], cx + 12, Math.min(cy + rh - 10, ey + eh + 28 * k), 22 * k, sd[1] ? INK : SOFT, 700)
    }
  }
  bevel(ctx, x + 14, y + h - 6 - status, w - 28, status - 2, PANEL, true)
  text(ctx, 'Pre-send check: no draft notes left in the next send', x + 26, y + h - 6 - status * 0.3, 19 * k, INK, 400, TYPE)
}

// Sale Day: the price changer, the old price and the new one on every line, and the sale switch
function saleScreen(ctx, x, y, w, h, k) {
  const tx = x + 14
  const tw = w * 0.64
  const cols = [0, 0.4, 0.62, 0.83].map((f) => tx + tw * f)
  const head = ['ITEM', 'WAS', 'NOW', '']
  // the rows fill the window's height, up to a comfortable size
  const rh = Math.max(36 * k, Math.min(62 * k, (h - 30) / 7))
  bar(ctx, tx, y + 12, tw, rh, '#dfe5ef')
  head.forEach((s, i) => text(ctx, s, cols[i] + 10, y + 12 + rh * 0.68, 19 * k, NAVY, 700, TYPE))
  const items = [['Kit A', '129.00', '109.00'], ['Kit B', '189.00', '159.00'], ['Case', '49.00', '41.00'], ['Cable set', '24.00', '20.00'], ['Bundle', '299.00', '249.00'], ['Spare part', '12.00', '10.00']]
  const n = Math.max(2, Math.min(items.length, Math.floor((h - 30 - rh) / rh)))
  items.slice(0, n).forEach(([a, b, c2], r) => {
    const ry = y + 12 + rh * (r + 1)
    bar(ctx, tx, ry, tw, rh, r % 2 ? '#f6f8fb' : '#ffffff')
    ctx.strokeStyle = LINE
    ctx.lineWidth = 1
    ctx.strokeRect(tx, ry, tw, rh)
    text(ctx, a, cols[0] + 10, ry + rh * 0.68, 22 * k, INK, 700)
    text(ctx, b, cols[1] + 10, ry + rh * 0.68, 21 * k, SOFT, 400, TYPE)
    bar(ctx, cols[1] + 8, ry + rh * 0.5, 80 * k, 2, SOFT)
    text(ctx, c2, cols[2] + 10, ry + rh * 0.68, 21 * k, RED, 700, TYPE)
    tick(ctx, cols[3] + 14, ry + rh * 0.28, 18 * k, GREEN, 3 * k)
  })
  // the switch: a big lit button, a timer under it, undo beside the table
  const sx = tx + tw + 22
  const sw = x + w - 14 - sx
  bevel(ctx, sx, y + 12, sw, h - 24, PANEL)
  text(ctx, 'SALE', sx + sw / 2, y + 12 + 44 * k, 30 * k, NAVY, 900, TITLE, 'center')
  const bx = sx + sw * 0.18
  const bw = sw * 0.64
  bar(ctx, bx, y + 12 + 60 * k, bw, 60 * k, '#1d1d1d')
  bar(ctx, bx + bw / 2, y + 12 + 64 * k, bw / 2 - 4, 52 * k, GREEN)
  text(ctx, 'ON', bx + bw * 0.75, y + 12 + 100 * k, 26 * k, '#fff', 900, TITLE, 'center')
  text(ctx, 'OFF', bx + bw * 0.25, y + 12 + 100 * k, 22 * k, '#7a7a7a', 700, TITLE, 'center')
  text(ctx, 'TIMER', sx + sw / 2, y + 12 + 160 * k, 18 * k, SOFT, 700, TYPE, 'center')
  bevel(ctx, sx + 14, y + 12 + 172 * k, sw - 28, 44 * k, '#10181f', true)
  text(ctx, '48:00:00', sx + sw / 2, y + 12 + 204 * k, 28 * k, '#7df0a0', 700, TYPE, 'center')
  if (h > 300 * k) btn(ctx, sx + 14, y + h - 24 - 50 * k, sw - 28, 42 * k, 'Undo', 22 * k)
}

// Show Season: the show's packing page, numbered totes with what goes in each, and the label
function showScreen(ctx, x, y, w, h, k) {
  const totes = [['Signs', 1], ['Badges', 1], ['Shirts', 1], ['Banner', 1], ['Swag', 0], ['Booth kit', 0]]
  const lw = w * 0.3
  const gx = x + 14
  const gw = w - 28 - lw - 18
  const cols = 3
  const tw = gw / cols
  const th = (h - 24) / 2
  totes.forEach(([name, packed], i) => {
    const tx = gx + (i % cols) * tw + 6
    const ty = y + 12 + Math.floor(i / cols) * th + 6
    const bw = tw - 12
    const bh = th - 12
    // a tote, front on: lid strip, handle hole, number stencilled on
    bar(ctx, tx, ty + bh * 0.18, bw, bh * 0.82, packed ? '#3b5f93' : '#8e9bb0')
    bar(ctx, tx - 4, ty + bh * 0.1, bw + 8, bh * 0.12, packed ? NAVY : '#6f7c92')
    bar(ctx, tx + bw * 0.38, ty + bh * 0.3, bw * 0.24, bh * 0.07, 'rgba(0,0,0,0.35)')
    text(ctx, String(i + 1), tx + bw / 2, ty + bh * 0.72, Math.min(bh * 0.38, 70 * k), '#fff', 900, TITLE, 'center')
    text(ctx, name, tx + bw / 2, ty + bh * 0.95, 20 * k, '#fff', 700, BODY, 'center')
    if (packed) tick(ctx, tx + bw - 30 * k, ty + bh * 0.3, 22 * k, '#9ff0b8', 4 * k)
  })
  // the shipping label for the lot
  const lx = x + w - 14 - lw
  bar(ctx, lx, y + 12, lw, h - 24, '#ffffff')
  ctx.strokeStyle = INK
  ctx.lineWidth = 3
  ctx.strokeRect(lx + 2, y + 14, lw - 4, h - 28)
  text(ctx, 'SHIP TO', lx + 14, y + 12 + 32 * k, 18 * k, SOFT, 700, TYPE)
  writing(ctx, lx + 14, y + 12 + 46 * k, [lw * 0.7, lw * 0.55, lw * 0.62], 10 * k, 22 * k)
  text(ctx, 'TOTES 1 TO 6', lx + 14, y + 12 + 140 * k, 22 * k, INK, 700, TYPE)
  barcode(ctx, lx + 14, y + 12 + 156 * k, lw - 28, Math.max(30, Math.min(90 * k, h - 24 - 176 * k)), 7)
}

// Launch Day: the day-of checklist, how far along it is, and the label for the box going out
function launchScreen(ctx, x, y, w, h, k) {
  const steps = [['Stock is in', 1], ['Product page live', 1], ['Test order placed', 1], ['Guide published', 0], ['Email out', 0]]
  const cw = w * 0.58
  const done = steps.filter((s) => s[1]).length
  bevel(ctx, x + 14, y + 12, cw, 30 * k, '#fff', true)
  bar(ctx, x + 16, y + 14, (cw - 4) * (done / steps.length), 30 * k - 4, GREEN)
  text(ctx, `${done} of ${steps.length} done`, x + 14 + cw / 2, y + 12 + 22 * k, 19 * k, '#fff', 700, TYPE, 'center')
  const rh = Math.min(62 * k, (h - 40 - 30 * k) / steps.length)
  steps.forEach(([t, d], i) => {
    const ry = y + 26 + 30 * k + i * rh
    bevel(ctx, x + 18, ry + rh * 0.2, rh * 0.56, rh * 0.56, '#fff', true)
    if (d) tick(ctx, x + 18 + rh * 0.1, ry + rh * 0.28, rh * 0.38, NAVY, 4 * k)
    text(ctx, t, x + 18 + rh * 0.8, ry + rh * 0.62, Math.min(30 * k, rh * 0.5), d ? SOFT : INK, d ? 500 : 700, TYPE)
  })
  // the label preview: a warning sticker and a serial label, the way they print
  const lx = x + 14 + cw + 22
  const lw = x + w - 14 - lx
  bevel(ctx, lx, y + 12, lw, h - 24, PANEL, true)
  text(ctx, 'LABEL PREVIEW', lx + 12, y + 12 + 26 * k, 17 * k, SOFT, 700, TYPE)
  const sy = y + 12 + 40 * k
  const sh = (h - 24 - 52 * k) * 0.55
  bar(ctx, lx + 12, sy, lw - 24, sh, '#f2c230')
  ctx.strokeStyle = INK
  ctx.lineWidth = 3
  ctx.strokeRect(lx + 14, sy + 2, lw - 28, sh - 4)
  const tr = Math.min(sh * 0.34, lw * 0.18)
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.moveTo(lx + 12 + tr * 1.3, sy + sh * 0.18)
  ctx.lineTo(lx + 12 + tr * 0.3, sy + sh * 0.18 + tr * 1.7)
  ctx.lineTo(lx + 12 + tr * 2.3, sy + sh * 0.18 + tr * 1.7)
  ctx.fill()
  text(ctx, '!', lx + 12 + tr * 1.3, sy + sh * 0.18 + tr * 1.5, tr * 1.1, '#f2c230', 900, TITLE, 'center')
  writing(ctx, lx + 24 + tr * 2.4, sy + sh * 0.25, [lw * 0.32, lw * 0.26, lw * 0.3], 8 * k, 18 * k, 'rgba(0,0,0,0.55)')
  const ly = sy + sh + 12
  const lh = y + h - 24 - ly
  bar(ctx, lx + 12, ly, lw - 24, lh, '#ffffff')
  text(ctx, 'SN 000123', lx + 22, ly + 26 * k, 19 * k, INK, 700, TYPE)
  if (lh > 50 * k) barcode(ctx, lx + 22, ly + 36 * k, lw - 44, lh - 46 * k, 11)
}

// Art Department: a paint program with a banner layout on the canvas, the 3D model in review on it,
// the tools down the side and the colours along the bottom
function artScreen(ctx, x, y, w, h, k) {
  const tb = 74 * k
  const pal = 34 * k
  bevel(ctx, x + 8, y + 8, tb, h - 16 - pal - 8, PANEL)
  const icons = ['pencil', 'brush', 'line', 'rect', 'oval', 'text', 'fill', 'pick']
  const is = tb / 2 - 6
  icons.forEach((ic, i) => {
    const ix = x + 12 + (i % 2) * (is + 4)
    const iy = y + 14 + Math.floor(i / 2) * (is + 4)
    if (iy + is > y + h - pal - 18) return
    bevel(ctx, ix, iy, is, is, i === 3 ? '#cfd6e3' : PANEL, i === 3)
    ctx.strokeStyle = INK
    ctx.fillStyle = INK
    ctx.lineWidth = 3 * k
    const c = [ix + is / 2, iy + is / 2]
    const r = is * 0.28
    ctx.beginPath()
    if (ic === 'pencil' || ic === 'line') {
      ctx.moveTo(c[0] - r, c[1] + r)
      ctx.lineTo(c[0] + r, c[1] - r)
      ctx.stroke()
    } else if (ic === 'rect') ctx.strokeRect(c[0] - r, c[1] - r * 0.7, r * 2, r * 1.4)
    else if (ic === 'oval') {
      ctx.ellipse(c[0], c[1], r, r * 0.7, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (ic === 'text') text(ctx, 'A', c[0], c[1] + r * 0.9, r * 2.4, INK, 900, TITLE, 'center')
    else if (ic === 'brush') {
      ctx.arc(c[0], c[1] + r * 0.4, r * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(c[0] - 2, c[1] - r, 4, r)
    } else if (ic === 'fill') {
      ctx.moveTo(c[0] - r, c[1])
      ctx.lineTo(c[0], c[1] - r)
      ctx.lineTo(c[0] + r, c[1])
      ctx.lineTo(c[0], c[1] + r)
      ctx.fill()
    } else {
      ctx.arc(c[0], c[1], r * 0.6, 0, Math.PI * 2)
      ctx.stroke()
    }
  })
  // the colours
  const colours = ['#000000', '#7f7f7f', '#7f0000', '#7f7f00', '#007f00', '#007f7f', '#00007f', '#7f007f', '#ffffff', '#c3c3c3', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff']
  const pw = (w - 16 - tb - 10) / colours.length
  colours.forEach((c, i) => {
    bevel(ctx, x + 8 + tb + 10 + i * pw, y + h - 8 - pal, pw - 3, pal, c, true)
  })
  bevel(ctx, x + 8, y + h - 8 - pal, tb, pal, PANEL, true)
  bar(ctx, x + 16, y + h - pal, tb * 0.4, pal - 16, NAVY)
  bar(ctx, x + 16 + tb * 0.3, y + h - pal + 6, tb * 0.4, pal - 16, RED)
  // the canvas: a banner being laid out, the model in review on it
  const cx = x + 8 + tb + 10
  const cy = y + 8
  const cw = x + w - 8 - cx
  const ch = h - 16 - pal - 8
  bevel(ctx, cx, cy, cw, ch, '#ffffff', true)
  const bx = cx + 18
  const by = cy + 16
  const bw = cw - 36
  const bh = ch - 32
  bar(ctx, bx, by, bw, bh, '#14264f')
  bar(ctx, bx, by + bh * 0.72, bw, bh * 0.28, RED)
  text(ctx, 'SHOW BANNER', bx + 18, by + bh * 0.2 + 18 * k, Math.min(48 * k, bh * 0.16), '#fff', 900, TITLE)
  writing(ctx, bx + 18, by + bh * 0.32, [bw * 0.4, bw * 0.3], 10 * k, 20 * k, '#9fb3d6')
  // a wireframe box, the 3D model, with its selection handles
  const s = Math.min(bw * 0.2, bh * 0.36)
  const ox = bx + bw * 0.7
  const oy = by + bh * 0.2
  const d = s * 0.45
  ctx.strokeStyle = '#ffd34a'
  ctx.lineWidth = 3 * k
  ctx.strokeRect(ox, oy + d, s, s)
  ctx.strokeRect(ox + d, oy, s, s)
  ctx.beginPath()
  ;[[0, 0], [s, 0], [0, s], [s, s]].forEach(([a, b]) => {
    ctx.moveTo(ox + a, oy + d + b)
    ctx.lineTo(ox + d + a, oy + b)
  })
  ctx.stroke()
  ctx.setLineDash([8 * k, 6 * k])
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.strokeRect(ox - 10, oy - 10, s + d + 20, s + d + 20)
  ctx.setLineDash([])
  text(ctx, 'ROUND 2 OF 3', bx + 18, by + bh * 0.9, Math.min(26 * k, bh * 0.1), '#fff', 700, TYPE)
}

// Behind the Counter: the order screen, the line items and the shipping prices up front
function orderScreen(ctx, x, y, w, h, k) {
  text(ctx, 'Customer', x + 18, y + 12 + 26 * k, 22 * k, NAVY, 700)
  bevel(ctx, x + 18 + 100 * k, y + 12, 170 * k, 36 * k, '#fff', true)
  text(ctx, '1042', x + 28 + 100 * k, y + 12 + 26 * k, 21 * k, INK, 700, TYPE)
  text(ctx, 'Quote', x + 18 + 300 * k, y + 12 + 26 * k, 22 * k, NAVY, 700)
  bevel(ctx, x + 18 + 370 * k, y + 12, 120 * k, 36 * k, '#fff', true)
  text(ctx, 'Q-0017', x + 28 + 370 * k, y + 12 + 26 * k, 21 * k, INK, 700, TYPE)
  // the line items
  const tx = x + 14
  const tw = w * 0.56
  const ty = y + 12 + 50 * k
  const rh = 38 * k
  const cols = [0, 0.14, 0.72].map((f) => tx + tw * f)
  bar(ctx, tx, ty, tw, rh, '#dfe5ef')
  ;['QTY', 'ITEM', 'PRICE'].forEach((s, i) => text(ctx, s, cols[i] + 8, ty + rh * 0.68, 18 * k, NAVY, 700, TYPE))
  const lines2 = [['2', 'Kit A', '258.00'], ['1', 'Case', '49.00'], ['4', 'Cable set', '96.00'], ['1', 'Spare part', '12.00']]
  const n = Math.max(2, Math.min(lines2.length, Math.floor((y + h - 70 * k - ty) / rh) - 1))
  lines2.slice(0, n).forEach((l, r) => {
    const ry = ty + rh * (r + 1)
    bar(ctx, tx, ry, tw, rh, r % 2 ? '#f6f8fb' : '#fff')
    ctx.strokeStyle = LINE
    ctx.lineWidth = 1
    ctx.strokeRect(tx, ry, tw, rh)
    l.forEach((s, i) => text(ctx, s, cols[i] + 8, ry + rh * 0.68, 21 * k, INK, i === 1 ? 700 : 400, i === 1 ? BODY : TYPE))
  })
  // shipping, priced before the order goes in
  const sx = tx + tw + 20
  const sw = x + w - 14 - sx
  bevel(ctx, sx, ty, sw, y + h - 12 - ty, PANEL)
  text(ctx, 'SHIPPING', sx + 14, ty + 30 * k, 20 * k, NAVY, 700, TYPE)
  const opts = [['Ground', '14.20'], ['2-Day', '28.90'], ['Overnight', '46.50']]
  opts.forEach(([a, b], i) => {
    const oy = ty + 52 * k + i * 44 * k
    if (oy + 30 * k > y + h - 70 * k) return
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = INK
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(sx + 26, oy + 14 * k, 11 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    if (i === 0) {
      ctx.fillStyle = INK
      ctx.beginPath()
      ctx.arc(sx + 26, oy + 14 * k, 5 * k, 0, Math.PI * 2)
      ctx.fill()
    }
    text(ctx, a, sx + 46, oy + 22 * k, 22 * k, INK, 700)
    text(ctx, b, sx + sw - 14, oy + 22 * k, 20 * k, INK, 400, TYPE, 'right')
  })
  btn(ctx, sx + 14, y + h - 24 - 44 * k, sw - 28, 42 * k, 'Send Quote', 22 * k, true)
}

// The AI Desk: the change gate, what's there now beside what the AI wants, and a person's yes or no
function aiScreen(ctx, x, y, w, h, k) {
  const pw = (w - 42) / 2
  const ph = h - 24
  ;[['NOW', 0], ['THE AI WANTS', 1]].forEach(([label, side]) => {
    const px = x + 14 + side * (pw + 14)
    bevel(ctx, px, y + 12, pw, ph, '#ffffff', true)
    text(ctx, label, px + 14, y + 12 + 28 * k, 19 * k, SOFT, 700, TYPE)
    const rows = [['Kit A', 0], ['Price 199.00', side ? 2 : 1], ['In stock', 0], ['Ships next day', 0]]
    rows.forEach(([s, mark], i) => {
      const ry = y + 12 + 44 * k + i * 40 * k
      if (ry + 34 * k > y + ph) return
      if (mark) bar(ctx, px + 6, ry, pw - 12, 34 * k, mark === 2 ? '#d7f0dc' : '#f6d9d3')
      text(ctx, mark === 2 ? 'Price 189.00' : s, px + 16, ry + 24 * k, 22 * k, mark === 1 ? RED : mark === 2 ? GREEN : INK, mark ? 700 : 400, TYPE)
      if (mark === 1) bar(ctx, px + 16, ry + 16 * k, 150 * k, 2, RED)
    })
  })
  // the question, in a dialog over both
  const dw = Math.min(w * 0.62, 520 * k)
  const dh = Math.min(h * 0.5, 170 * k)
  const dx = x + (w - dw) / 2
  const dy = y + h - 20 - dh
  ctx.fillStyle = 'rgba(20,20,30,0.3)'
  ctx.fillRect(dx + 8, dy + 8, dw, dh)
  bevel(ctx, dx, dy, dw, dh, PANEL)
  bar(ctx, dx + 3, dy + 3, dw - 6, 30 * k, NAVY)
  text(ctx, 'Change gate', dx + 14, dy + 3 + 22 * k, 19 * k, '#fff', 700)
  const r = Math.min(26 * k, dh * 0.18)
  ctx.fillStyle = NAVY_LT
  ctx.beginPath()
  ctx.arc(dx + 24 + r, dy + 36 * k + r + 10, r, 0, Math.PI * 2)
  ctx.fill()
  text(ctx, '?', dx + 24 + r, dy + 36 * k + r * 1.7 + 10, r * 1.6, '#fff', 900, TITLE, 'center')
  text(ctx, 'Make this 1 change?', dx + 40 + r * 2, dy + 36 * k + r + 18, 26 * k, INK, 700)
  const bw = 110 * k
  btn(ctx, dx + dw - 28 - bw * 2, dy + dh - 14 - 38 * k, bw, 38 * k, 'Yes', 21 * k, true)
  btn(ctx, dx + dw - 14 - bw, dy + dh - 14 - 38 * k, bw, 38 * k, 'No', 21 * k)
}

const SCREENS = {
  'screen-web': ['Storefront Editor', webScreen, 'File  Edit  View  Go  Help'],
  'screen-mail': ['Send Calendar', mailScreen, 'File  Edit  View  Send  Help'],
  'screen-sale': ['Price Changer', saleScreen, 'File  Edit  Prices  Sale  Help'],
  'screen-show': ['Show Packing', showScreen, 'File  Edit  Totes  Ship  Help'],
  'screen-launch': ['Launch Day', launchScreen, 'File  Edit  Checklist  Labels  Help'],
  'screen-art': ['Paint', artScreen, 'File  Edit  View  Image  Colors  Help'],
  'screen-order': ['New Order', orderScreen, 'File  Edit  Order  Ship  Help'],
  'screen-ai': ['Change Preview', aiScreen, 'File  Edit  Review  Help'],
}

// A program window the way a 90s box printed one: navy title bar, a menu bar, the screen inside.
export function standIn(ctx, kind, x, y, w, h) {
  const [title, draw, menu] = SCREENS[kind] || SCREENS['screen-web']
  ctx.save()
  ctx.fillStyle = 'rgba(40,30,15,0.18)'
  ctx.fillRect(x + 8, y + 10, w, h)
  bar(ctx, x, y, w, h, '#f3efe4')
  ctx.strokeStyle = NAVY
  ctx.lineWidth = 4
  ctx.strokeRect(x + 2, y + 2, w - 4, h - 4)
  bar(ctx, x, y, w, 52, NAVY)
  text(ctx, title, x + 22, y + 36, 28, '#fff', 700)
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 2
  for (let i = 0; i < 2; i++) ctx.strokeRect(x + w - 44 - i * 34, y + 14, 24, 24)
  bar(ctx, x + 4, y + 52, w - 8, 34, PANEL)
  text(ctx, menu, x + 18, y + 77, 22, INK, 500)
  bar(ctx, x + 4, y + 86, w - 8, 2, '#b9b4a6')
  ctx.beginPath()
  ctx.rect(x + 4, y + 88, w - 8, h - 92)
  ctx.clip()
  const k = Math.max(0.6, Math.min(1.25, w / 880, (h - 88) / 400))
  draw(ctx, x + 4, y + 88, w - 8, h - 92, k)
  ctx.restore()
}

// ---- the box -----------------------------------------------------------------------------------

// "The Mailroom" sets THE small over MAILROOM; a long name breaks onto two lines.
function titleBlock(ctx, title, x, y, width) {
  let small = ''
  let main = title.toUpperCase()
  if (/^THE /.test(main)) {
    small = 'THE'
    main = main.slice(4)
  }
  if (small) {
    text(ctx, small, x, y + 54, 62, NAVY, 900, TITLE)
    y += 60
  }
  let rows = [main]
  let size = fit(ctx, main, TITLE, 900, width, 196, 60)
  if (size < 150 && main.includes(' ')) {
    const words = main.split(' ')
    let best = null
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ')
      const b = words.slice(i).join(' ')
      const s = Math.min(fit(ctx, a, TITLE, 900, width, 180, 60), fit(ctx, b, TITLE, 900, width, 180, 60))
      if (!best || s > best.s) best = { s, rows: [a, b] }
    }
    rows = best.rows
    size = best.s
  }
  ctx.font = `900 ${size}px ${TITLE}`
  ctx.fillStyle = NAVY
  rows.forEach((r, i) => ctx.fillText(r, x, y + size * 0.84 + i * size * 0.9))
  return y + size * 0.84 + (rows.length - 1) * size * 0.9
}

// Breaks a seal's words into at most n rows, each no wider than the circle (radius R) at its height;
// null if they don't fit.
function sealRows(ctx, words, n, size, R) {
  const room = (i) => {
    const edge = Math.abs(i - (n - 1) / 2) * size * 1.02 + size * 0.4
    return edge < R ? 2 * Math.sqrt(R * R - edge * edge) : 0
  }
  const rows = ['']
  for (const word of words) {
    const i = rows.length - 1
    const t = rows[i] ? `${rows[i]} ${word}` : word
    if (rows[i] && ctx.measureText(t).width > room(i)) rows.push(word)
    else rows[i] = t
  }
  return rows.length <= n && rows.every((l, i) => ctx.measureText(l).width <= room(i)) ? rows : null
}

// The one checked number, as a round seal stuck on the box.
function seal(ctx, x, y, r, s, angle) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = 'rgba(40,30,15,0.25)'
  ctx.beginPath()
  ctx.arc(4, 6, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#c8452f'
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,240,220,0.85)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, r - 12, 0, Math.PI * 2)
  ctx.stroke()
  // the words fill the ring the way a round label's do: each row as wide as the circle is at its
  // height, so the middle rows run longer than the top and bottom ones
  const words = s.toUpperCase().split(' ')
  let size = 44
  let rows = null
  for (;;) {
    ctx.font = `900 ${size}px ${TITLE}`
    for (let n = 1; n <= 6 && !rows; n++) rows = sealRows(ctx, words, n, size, r - 18)
    if (rows || size <= 20) break
    size -= 2
  }
  rows = rows || words
  ctx.fillStyle = '#fff6e8'
  ctx.textAlign = 'center'
  rows.forEach((l, i) => ctx.fillText(l, 0, (i - (rows.length - 1) / 2) * size * 1.02 + size * 0.36))
  ctx.restore()
}

// A 3.5 inch floppy, drawn small.
function floppy(ctx, x, y, s, color = NAVY) {
  bar(ctx, x, y, s, s, color)
  bar(ctx, x + s * 0.22, y, s * 0.56, s * 0.34, '#c4cad3')
  bar(ctx, x + s * 0.52, y + s * 0.05, s * 0.12, s * 0.24, color)
  bar(ctx, x + s * 0.14, y + s * 0.52, s * 0.72, s * 0.44, FIELD)
}

// The front, drawn whole; the top band becomes the lid and the rest goes on the box itself.
function drawFront(p, shelf) {
  const { w, h } = FACE
  const [c, ctx] = canvas(w, h)
  cardStock(ctx, w, h, hash(p.slug))
  const m = 64
  // the lid's band: the publisher line
  text(ctx, 'RYAN ZEGALIA PRESENTS', m, BAND / 2 + 10, 28, NAVY, 700)
  text(ctx, shelf.name.toUpperCase(), w - m, BAND / 2 + 10, 28, NAVY, 700, BODY, 'right')
  bar(ctx, 0, BAND - 5, w, 5, NAVY)

  const ty = titleBlock(ctx, p.title, m - 4, BAND + 34, w - m * 2)
  bar(ctx, m, ty + 22, w * 0.62, 12, NAVY_LT)

  // the plain line: what part of the job this box is, clear of the seal on the right
  const r = p.sticker ? Math.round(Math.min(120, 96 + p.sticker.length * 0.45)) : 0
  const kick = (p.kicker || '').toUpperCase()
  if (kick) text(ctx, kick, m, ty + 84, fit(ctx, kick, BODY, 700, w - m - r * 2 - 60, 46, 24), NAVY, 700)

  // the program window; a box with a seal drops it down to make room above, so the seal covers the
  // window's title bar and nothing in the window, and a longer line gets a bigger seal
  const sy = p.sticker ? ty + r * 2 - 54 : ty + 70
  const sh = h - sy - 215
  standIn(ctx, p.screen, m + 6, sy, w - m * 2 - 12, sh)
  // over the window's corner: clear of the title above, its bottom edge just over the first field
  if (p.sticker) seal(ctx, w - r - 22, sy + 70 - r, r, p.sticker, 0.14)

  // the line along the bottom, like the slogan on a box
  ctx.font = `700 40px ${BODY}`
  const rows = lines(ctx, p.tagline || '', w - m * 2)
  const by = h - 112 - (rows.length - 1) * 48
  rows.forEach((r, i) => text(ctx, r, w / 2, by + i * 48, 40, NAVY, 700, BODY, 'center'))
  text(ctx, catalog(p, shelf), m, h - 34, 24, SOFT, 700, TYPE)
  const n = (p.tools || []).length
  if (n) {
    floppy(ctx, w - m - 210, h - 62, 34)
    text(ctx, `${n} DISK${n > 1 ? 'S' : ''} INSIDE`, w - m, h - 34, 24, SOFT, 700, TYPE, 'right')
  }
  grain(ctx, w, h, 0.04)
  return c
}

function slice(src, y, h) {
  const [c, ctx] = canvas(src.width, h)
  ctx.drawImage(src, 0, y, src.width, h, 0, 0, src.width, h)
  return c
}

export async function pcFront(p, shelf) {
  const full = drawFront(p, shelf)
  return { band: toTexture(slice(full, 0, BAND)), body: toTexture(slice(full, BAND, FACE.h - BAND)) }
}

export function pcBack(p, shelf) {
  const w = FACE.w
  const h = FACE.h - BAND
  const [c, ctx] = canvas(w, h)
  const limit = h - 200
  let shown = Math.min(4, (p.does || []).length)
  let k = 1.3
  // shrink the type first, then show fewer lines (the manual has them all)
  for (;;) {
    if (drawBack(ctx, p, shelf, k, shown, w, h) <= limit) break
    if (k > 0.8) k -= 0.04
    else if (shown > 3) shown -= 1
    else break
  }
  const m = 60
  const by = h - 170
  barcode(ctx, w - m - 260, by + 20, 260, 80, hash(p.slug))
  text(ctx, 'A RYAN ZEGALIA PRODUCTION', m, by + 52, 26, NAVY, 700)
  text(ctx, 'Done on the clock.', m, by + 90, 24, SOFT, 400, TYPE)
  grain(ctx, w, h, 0.035)
  return toTexture(c)
}

function drawBack(ctx, p, shelf, k, shown, w, h) {
  const px = (n) => Math.round(n * k)
  cardStock(ctx, w, h, hash(p.slug) + 3)
  bar(ctx, 0, 0, w, 10, NAVY)
  const m = 60
  let y = 34 + px(78)
  ctx.font = `900 ${fit(ctx, p.title.toUpperCase(), TITLE, 900, w - m * 2, px(96))}px ${TITLE}`
  ctx.fillStyle = NAVY
  ctx.fillText(p.title.toUpperCase(), m, y)
  y += px(50)
  ctx.font = `600 ${px(42)}px ${BODY}`
  ctx.fillStyle = INK
  y = wrap(ctx, p.tagline || '', m, y, w - m * 2, px(48)) + px(14)
  // the tagline is the pitch; the manual opens with the longer blurb, so the box does not repeat it
  y += px(24)

  const heading = (s) => {
    bar(ctx, m, y - px(34), w - m * 2, px(46), NAVY)
    text(ctx, s, m + 16, y, px(34), '#fff', 900, TITLE)
    y += px(48)
  }
  heading("WHAT'S IN THE BOX")
  ctx.font = `600 ${px(30)}px ${BODY}`
  // a short cut, picked across the whole list so it shows the spread of the job (the manual has
  // every line, in order)
  const all = p.does || []
  const does = shown >= all.length ? all : Array.from({ length: shown }, (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, shown - 1))])
  for (const d of does) {
    bar(ctx, m + 4, y - px(18), px(11), px(11), NAVY)
    ctx.fillStyle = INK
    y = wrap(ctx, d, m + px(26), y, w - m * 2 - px(28), px(35)) + px(3)
  }
  const more = (p.does || []).length - does.length
  if (more > 0) {
    ctx.font = `italic 600 ${px(27)}px ${BODY}`
    ctx.fillStyle = DIM
    ctx.fillText(`...and ${more} more in the manual.`, m + px(26), y)
    y += px(34)
  }
  y += px(18)

  const tools = p.tools || []
  if (tools.length) {
    heading(tools.length > 1 ? 'TOOLS I BUILT, ON DISK' : 'A TOOL I BUILT, ON DISK')
    const cw = (w - m * 2) / 2
    tools.forEach((t, i) => {
      const cx = m + (i % 2) * cw
      const cy = y + Math.floor(i / 2) * px(46)
      floppy(ctx, cx, cy - px(28), px(32))
      text(ctx, t.name, cx + px(44), cy, px(28), INK, 700)
    })
    y += Math.ceil(tools.length / 2) * px(46) + px(10)
  }

  // system requirements: who the work is done with
  ctx.strokeStyle = NAVY
  ctx.lineWidth = 3
  const top = y
  y += px(36)
  text(ctx, 'SYSTEM REQUIREMENTS', m + 18, y, px(24), NAVY, 700)
  y += px(32)
  ctx.font = `600 ${px(28)}px ${BODY}`
  ctx.fillStyle = INK
  // the content starts with a capital ("Leadership, ...", "A contract designer"); mid-sentence a plain
  // first word reads lower case, and an acronym like "CEO" keeps its capitals
  const withWho = (p.worksWith || '').replace(/^[A-Z](?=[a-z]|\s)/, (c) => c.toLowerCase())
  y = wrap(ctx, `Works with ${withWho}`, m + 18, y, w - m * 2 - 36, px(33)) + px(6)
  ctx.strokeRect(m, top, w - m * 2, y - top)
  return y
}

// The spine: navy, the title running up it like the boxes in the store.
export function pcSide(p, shelf) {
  const { w, h } = SIDE
  const [c, ctx] = canvas(w, h)
  cardStock(ctx, w, h, hash(p.slug) + 7, NAVY)
  bar(ctx, 0, 0, w, 110, CARD)
  text(ctx, shelf.code, w / 2, 58, 48, NAVY, 900, TITLE, 'center')
  text(ctx, String(p.order ?? 0).padStart(2, '0'), w / 2, 96, 34, NAVY, 700, BODY, 'center')
  ctx.save()
  ctx.translate(w / 2, h - 150)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, h - 320, 140, 40)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillStyle = CARD
  ctx.fillText(title, 0, 4)
  ctx.restore()
  text(ctx, 'RZ', w / 2, h - 50, 30, CARD, 700, BODY, 'center')
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

export function pcLidTop(p, shelf) {
  const [c, ctx] = canvas(FACE.w, SIDE.w)
  cardStock(ctx, FACE.w, SIDE.w, hash(p.slug) + 11)
  ctx.font = `900 ${fit(ctx, p.title.toUpperCase(), TITLE, 900, FACE.w - 160, 110)}px ${TITLE}`
  ctx.fillStyle = NAVY
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(p.title.toUpperCase(), FACE.w / 2, SIDE.w / 2 + 4)
  grain(ctx, FACE.w, SIDE.w, 0.05)
  return toTexture(c)
}

// ---- the getting started manual ------------------------------------------------------------------

// The manual is one insert; "Read as text" shows the same sections.
export const manualPlan = () => [{ kind: 'manual' }]

// strips are cut at this height
const STRIP = 1600
function drawManual(ctx, p, shelf, w) {
  const m = 76
  const tw = w - m * 2
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, ctx.canvas.height)
  // the cover strip
  bar(ctx, 0, 0, w, 290, NAVY)
  text(ctx, `${catalog(p, shelf)} · GETTING STARTED`, m, 74, 28, '#c9d6ee', 700, TYPE)
  ctx.font = `900 ${fit(ctx, p.title.toUpperCase(), TITLE, 900, tw, 126)}px ${TITLE}`
  ctx.fillStyle = '#fff'
  ctx.fillText(p.title.toUpperCase(), m, 190)
  text(ctx, (p.kicker || '').toUpperCase(), m, 246, 34, '#c9d6ee', 600)
  let y = 372
  ctx.fillStyle = INK
  ctx.font = `600 39px ${BODY}`
  y = wrap(ctx, p.what || '', m, y, tw, 49) + 34

  let n = 0
  const chapter = (s) => {
    n += 1
    y += 20
    bar(ctx, m, y, 64, 64, NAVY)
    text(ctx, String(n), m + 32, y + 50, 46, '#fff', 900, TITLE, 'center')
    text(ctx, s, m + 88, y + 50, 50, NAVY, 900, TITLE)
    bar(ctx, m + 88, y + 66, tw - 88, 3, NAVY)
    y += 128
  }

  chapter('WHAT I DO')
  ctx.font = `500 34px ${BODY}`
  for (const d of p.does || []) {
    bar(ctx, m + 6, y - 20, 12, 12, NAVY)
    ctx.fillStyle = INK
    y = wrap(ctx, d, m + 34, y, tw - 34, 42) + 6
  }

  chapter('PROBLEMS I SOLVED')
  for (const s of p.solved || []) {
    const top = y - 32
    for (const [k, v, weight] of [['THE PROBLEM', s.problem, 700], ['WHAT I DID', s.did, 500], ['HOW IT ENDED', s.ended, 500]]) {
      text(ctx, k, m + 30, y, 23, NAVY_LT, 700, TYPE)
      y += 36
      ctx.fillStyle = INK
      ctx.font = `${weight} 34px ${BODY}`
      y = wrap(ctx, v, m + 30, y, tw - 50, 41) + 8
    }
    // a hairline under each problem, no side bar
    bar(ctx, m + 30, y - 12, tw - 60, 2, 'rgba(30,55,99,0.25)')
    y += 26
  }

  const tools = p.tools || []
  if (tools.length) {
    chapter(tools.length > 1 ? 'TOOLS I BUILT FOR IT' : 'A TOOL I BUILT FOR IT')
    standIn(ctx, p.screen, m, y - 24, tw, 400)
    y += 440
    for (const t of tools) {
      floppy(ctx, m, y - 36, 48)
      text(ctx, t.name.toUpperCase(), m + 68, y, 38, NAVY, 900, TITLE)
      y += 44
      ctx.fillStyle = INK
      ctx.font = `500 33px ${BODY}`
      y = wrap(ctx, t.line, m + 68, y, tw - 68, 40) + 22
    }
  }

  chapter('THE STORY')
  ctx.font = `500 35px ${BODY}`
  ctx.fillStyle = INK
  for (const para of p.story || []) y = wrap(ctx, para, m, y, tw, 46) + 22

  chapter('WORKS WITH')
  ctx.font = `600 34px ${BODY}`
  ctx.fillStyle = INK
  y = wrap(ctx, p.worksWith || '', m, y, tw, 42) + 50

  // The last strip should end like a real manual: a quick-reference box (the case's own "what I do" lines)
  // and a stamped "end of manual" block sitting at the foot of the final page, never a near-empty strip.
  const END_H = 250
  const lines = p.does || []
  const measure = (k) => {
    ctx.font = `500 31px ${BODY}`
    let t = 0
    for (let i = 0; i < k; i++) t += wrap(ctx, lines[i], m + 70, 9300, tw - 100, 39) - 9300 + 14
    return 108 + t + 24
  }
  const strips = Math.ceil((y + 124) / STRIP)
  const room = strips * STRIP - END_H - y
  let k = 0
  while (k < lines.length && measure(k + 1) <= room - 30) k++
  const natural = (y + 124) % STRIP
  const wantEnd = natural !== 0 && natural / STRIP < 0.8
  if (wantEnd && k >= 1) {
    const bh = measure(k)
    const gap = Math.min(70, Math.max(24, (room - bh) / 2))
    const by = y + gap
    bar(ctx, m, by, tw, bh, FIELD)
    ctx.strokeStyle = NAVY
    ctx.lineWidth = 3
    ctx.strokeRect(m, by, tw, bh)
    bar(ctx, m, by, tw, 66, NAVY)
    text(ctx, 'QUICK REFERENCE', m + 28, by + 47, 36, '#fff', 900, TITLE)
    text(ctx, 'WHAT I DO, AT A GLANCE', m + tw - 28, by + 44, 22, '#c9d6ee', 700, TYPE, 'right')
    let qy = by + 66 + 52
    for (let i = 0; i < k; i++) {
      text(ctx, String(i + 1), m + 28, qy, 28, NAVY, 900, TITLE)
      ctx.fillStyle = INK
      ctx.font = `500 31px ${BODY}`
      qy = wrap(ctx, lines[i], m + 70, qy, tw - 100, 39) + 14
    }
  }
  if (wantEnd) y = strips * STRIP - END_H
  bar(ctx, m, y, tw, 3, NAVY)
  y += 54
  text(ctx, 'DONE ON THE CLOCK BY RYAN ZEGALIA', m, y, 24, SOFT, 700, TYPE)
  text(ctx, catalog(p, shelf), w - m, y, 24, SOFT, 700, TYPE, 'right')
  if (wantEnd) {
    // a rubber stamp, a little off true
    ctx.save()
    ctx.translate(w / 2, y + 120)
    ctx.rotate(-0.035)
    ctx.strokeStyle = NAVY
    ctx.fillStyle = NAVY
    ctx.globalAlpha = 0.85
    ctx.lineWidth = 5
    ctx.strokeRect(-250, -52, 500, 104)
    ctx.lineWidth = 2
    ctx.strokeRect(-240, -42, 480, 84)
    ctx.font = `900 54px ${TITLE}`
    ctx.textAlign = 'center'
    ctx.fillText('END OF MANUAL', 0, 18)
    ctx.restore()
    return strips * STRIP
  }
  return y + 70
}

// The manual is one long sheet, cut into strips no taller than a phone's GPU will take.
export async function manualTextures(p, shelf) {
  const w = MANUAL_W
  const [scratch, sctx] = canvas(w, 9600, { willReadFrequently: true })
  const h = Math.min(9600, Math.ceil(drawManual(sctx, p, shelf, w)))
  grain(sctx, w, h, 0.025)
  const strips = []
  for (let y = 0; y < h; y += STRIP) {
    const sh = Math.min(STRIP, h - y)
    strips.push({ tex: toTexture(slice(scratch, y, sh)), h: sh / w })
  }
  scratch.width = 1
  return { strips, height: h / w }
}
