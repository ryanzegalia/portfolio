// Draws the "Build the missing tool" shelf's shareware floppies: the 3.5" disk's front (the shutter's
// track and window, and the printed label; the metal shutter itself is modelled in Scene.jsx) and back
// (hub and write-protect tab), and the README that prints out of a dot-matrix printer when you load
// one: a tractor-feed sheet of green-bar paper you scroll (Printout3D.jsx).
import * as THREE from 'three'
import { canvas, toTexture, fit, wrap, spread, grain, cover, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'

// One unit is 100 mm, bigger than life like the other media so the label reads.
export const FL = { w: 1.24, h: 1.3, t: 0.05 }
const FW = 1000
const FH = Math.round((FW * FL.h) / FL.w)
const PRINT_W = 1000
const STRIP = 1600
const RIBBON = '#2b2f3a'
const BAR = 'rgba(120,190,140,0.22)'
const SHEET = '#f4f1e6'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`
const accentOf = (p) => (p.palette && p.palette.accent) || '#2bb3a8'
const deep = (hex) => `rgb(${[16, 8, 0].map((b) => Math.round(((parseInt(hex.slice(1), 16) >> b) & 255) * 0.42)).join(',')})`

function text(ctx, s, x, y, size, color = INK, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

// The plastic shell: the disk's colour, its chamfered corner, and a soft moulded edge.
function shell(ctx, p) {
  const accent = accentOf(p)
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(FW - 60, 0)
  ctx.lineTo(FW, 60)
  ctx.lineTo(FW, FH)
  ctx.lineTo(0, FH)
  ctx.closePath()
  ctx.fill()
  const g = ctx.createLinearGradient(0, 0, FW, FH)
  g.addColorStop(0, 'rgba(255,255,255,0.18)')
  g.addColorStop(0.5, 'rgba(255,255,255,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.22)')
  ctx.fillStyle = g
  ctx.fill()
}

// The metal shutter, as fractions of the disk: its size, and its window across and down it. Shut, the
// window sits over plastic; it slides over until the window lines up with the disk's own window.
export const SHUTTER = { w: 0.56, h: 0.32, win: [0.62, 0.82], winY: [40 / 335, 255 / 335] }

// Under the shutter: the recess it slides in, and the window onto the brown disk inside.
function track(ctx) {
  const sw = FW * SHUTTER.w
  const sh = FH * SHUTTER.h
  const slide = sw * ((SHUTTER.win[0] + SHUTTER.win[1]) / 2 - 0.5)
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  ctx.fillRect((FW - sw) / 2 - slide - 6, 0, sw + slide * 2 + 12, sh + 6)
  const ww = sw * (SHUTTER.win[1] - SHUTTER.win[0])
  const wy = sh * SHUTTER.winY[0]
  const wh = sh * (SHUTTER.winY[1] - SHUTTER.winY[0])
  const wx = FW / 2 - ww / 2
  ctx.fillStyle = '#16120f'
  ctx.fillRect(wx - 5, wy - 5, ww + 10, wh + 10)
  const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh)
  g.addColorStop(0, '#4a3524')
  g.addColorStop(0.45, '#6b4e33')
  g.addColorStop(1, '#3a2a1c')
  ctx.fillStyle = g
  ctx.fillRect(wx, wy, ww, wh)
}

// A drawn picture for a disk with no screenshot yet, printed in the label's picture strip; keyed on "art".
function search(ctx, p, x, y, w, h) {
  ctx.fillStyle = '#20242c'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = SHEET
  ctx.beginPath()
  ctx.roundRect(x + 20, y + 16, w - 40, 54, 27)
  ctx.fill()
  ctx.strokeStyle = INK
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(x + 54, y + 41, 13, 0, Math.PI * 2)
  ctx.moveTo(x + 63, y + 51)
  ctx.lineTo(x + 74, y + 62)
  ctx.stroke()
  text(ctx, 'ext:pdf  size:>100kb', x + 88, y + 53, 30, INK, 700, TYPE)
  for (let r = 0; r < 3; r++) {
    const ry = y + 92 + r * 44
    ctx.fillStyle = accentOf(p)
    ctx.beginPath()
    ctx.moveTo(x + 30, ry)
    ctx.lineTo(x + 52, ry)
    ctx.lineTo(x + 62, ry + 10)
    ctx.lineTo(x + 62, ry + 34)
    ctx.lineTo(x + 30, ry + 34)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(244,241,230,0.8)'
    ctx.fillRect(x + 80, ry + 10, 220 + ((r * 97) % 160), 14)
    ctx.fillStyle = 'rgba(244,241,230,0.4)'
    ctx.fillRect(x + w - 300, ry + 10, 70, 14)
    ctx.fillRect(x + w - 200, ry + 10, 160, 14)
  }
}
const FLOPPY_ART = { search }

export async function floppyFront(p, shelf) {
  const [c, ctx] = canvas(FW, FH)
  shell(ctx, p)
  track(ctx)
  // the printed label
  const lx = 80
  const ly = FH * 0.37
  const lw = FW - 160
  const lh = FH - ly - 50
  ctx.fillStyle = CREAM
  ctx.fillRect(lx, ly, lw, lh)
  ctx.fillStyle = accentOf(p)
  ctx.fillRect(lx, ly, lw, 54)
  text(ctx, 'SHAREWARE', lx + 24, ly + 38, 30, INK, 900, TITLE)
  text(ctx, `DISK 1 OF 1  ·  ${catalog(p, shelf)}`, lx + lw - 24, ly + 37, 22, INK, 700, TYPE, 'right')
  // the picture is printed on the label, under the maker's strip, the way a boxed disk carried its art
  const img = await loadImage(p.photoUrl)
  // the whole picture is printed, fitted into the space with a dark mat round it (never cropped to a strip)
  const draw = img
    ? (x, y, dw, dh) => {
        ctx.fillStyle = '#14171c'
        ctx.fillRect(x, y, dw, dh)
        const s = Math.min(dw / img.width, dh / img.height)
        ctx.drawImage(img, x + (dw - img.width * s) / 2, y + (dh - img.height * s) / 2, img.width * s, img.height * s)
      }
    : FLOPPY_ART[p.art] && ((x, y, dw, dh) => FLOPPY_ART[p.art](ctx, p, x, y, dw, dh))
  let top = ly + 54
  if (draw) {
    const ph = 280
    draw(lx + 14, top + 14, lw - 28, ph)
    ctx.strokeStyle = 'rgba(23,18,14,0.45)'
    ctx.lineWidth = 3
    ctx.strokeRect(lx + 14, top + 14, lw - 28, ph)
    top += ph + 14
  }
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, lw - 60, draw ? 68 : 104, 44)
  text(ctx, title, lx + 30, top + 16 + ts * 0.9, ts, INK, 900, TITLE)
  let y = top + 16 + ts * 0.9 + (draw ? 34 : 52)
  // what it is, in the disk's colour darkened until it reads on the cream label
  text(ctx, (p.kicker || '').toUpperCase(), lx + 30, y, 32, deep(accentOf(p)), 900, TITLE)
  // ruled lines, the way every label had them, with the tagline written on
  const rows = draw ? 2 : 3
  ctx.fillStyle = 'rgba(23,18,14,0.18)'
  for (let r = 0; r < rows; r++) ctx.fillRect(lx + 30, y + 46 + r * 46, lw - 60, 2)
  ctx.font = `600 32px ${BODY}`
  const words = (p.tagline || '').split(' ')
  let line = ''
  let row = 0
  for (const w of words) {
    const t = line ? `${line} ${w}` : w
    if (ctx.measureText(t).width > lw - 70 && line) {
      text(ctx, line, lx + 34, y + 38 + row * 46, 32, '#1d3a8a', 600)
      line = w
      row++
      if (row >= rows) break
    } else line = t
  }
  if (line && row < rows) text(ctx, line, lx + 34, y + 38 + row * 46, 32, '#1d3a8a', 600)
  grain(ctx, FW, FH, 0.04)
  return toTexture(c)
}

export function floppyBack(p, shelf) {
  const [c, ctx] = canvas(FW, FH)
  shell(ctx, p)
  track(ctx)
  // the metal hub, low on the disk
  const cx = FW / 2
  const cy = FH * 0.88
  const g = ctx.createRadialGradient(cx - 24, cy - 24, 8, cx, cy, 110)
  g.addColorStop(0, '#eceef0')
  g.addColorStop(1, '#8a8e93')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, 100, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#3a3e45'
  ctx.fillRect(cx - 20, cy - 20, 40, 40)
  ctx.fillRect(cx + 44, cy - 14, 26, 40)
  // write-protect tab and the high-density hole
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(70, FH - 170, 70, 110)
  ctx.fillStyle = '#d8dadc'
  ctx.fillRect(74, FH - 166, 62, 50)
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(FW - 140, FH - 170, 70, 70)
  text(ctx, '▲ INSERT THIS END', cx, FH * 0.32 + 40, 26, 'rgba(0,0,0,0.55)', 700, TYPE, 'center')
  // the back label, as a disk carried one: the plain line and a short cut of what it does
  const lx = 80
  const ly = FH * 0.32 + 66
  const lw = FW - 160
  const lh = cy - 100 - 24 - ly
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 3
  ctx.fillStyle = CREAM
  ctx.fillRect(lx, ly, lw, lh)
  ctx.restore()
  ctx.fillStyle = accentOf(p)
  ctx.fillRect(lx, ly, lw, 46)
  text(ctx, p.title.toUpperCase(), lx + 22, ly + 34, fit(ctx, p.title.toUpperCase(), TITLE, 900, lw - 220, 34, 20), INK, 900, TITLE)
  text(ctx, `SIDE B  ·  ${catalog(p, shelf)}`, lx + lw - 22, ly + 31, 20, INK, 700, TYPE, 'right')
  const cut = spread(p.built || [], 3)
  let k = 1.25
  let y = 0
  for (; k >= 0.7; k -= 0.05) {
    const px = (n) => Math.round(n * k)
    y = ly + 46 + px(40)
    ctx.save()
    ctx.beginPath()
    ctx.rect(lx, ly + 47, lw, lh - 47)
    ctx.clip()
    ctx.fillStyle = CREAM
    ctx.fillRect(lx, ly + 47, lw, lh - 47)
    ctx.font = `700 ${px(32)}px ${BODY}`
    ctx.fillStyle = '#1d3a8a'
    y = wrap(ctx, p.tagline || '', lx + 24, y, lw - 48, px(37)) + px(8)
    ctx.font = `600 ${px(27)}px ${BODY}`
    for (const f of cut) {
      ctx.fillStyle = deep(accentOf(p))
      ctx.fillText('•', lx + 26, y + 2)
      ctx.fillStyle = INK
      y = wrap(ctx, f, lx + 52, y + 2, lw - 76, px(31)) + px(7)
    }
    if ((p.built || []).length > cut.length) {
      ctx.font = `italic 600 ${px(24)}px ${BODY}`
      ctx.fillStyle = 'rgba(23,18,14,0.6)'
      ctx.fillText('...and more in the README.', lx + 52, y + 2)
      y += px(28)
    }
    ctx.restore()
    if (y <= ly + lh - 10) break
  }
  if (k < 0.75) console.warn(`[shelf] back label of "${p.title}" had to shrink to ${Math.round(k * 100)}%: cut some words`)
  grain(ctx, FW, FH, 0.04)
  return toTexture(c)
}

// ---- the printout ------------------------------------------------------------------------------

export const printPlan = () => [{ kind: 'printout' }]

// One page of the fan-fold paper: green bars every other pair of lines, the tractor holes down both
// edges, the fold along the top. It's tiled down the sheet and the type goes on over it, so where the
// head hasn't struck yet the printer shows this same page and the paper matches exactly.
const PAGE = 1400
function paperPage(w) {
  const lh = 50
  const [c, ctx] = canvas(w, PAGE, { willReadFrequently: true })
  ctx.fillStyle = SHEET
  ctx.fillRect(0, 0, w, PAGE)
  for (let y = 0; y < PAGE; y += lh * 4) {
    ctx.fillStyle = BAR
    ctx.fillRect(60, y, w - 120, lh * 2)
  }
  for (let y = 25; y < PAGE; y += 50) {
    for (const x of [30, w - 30]) {
      ctx.fillStyle = '#1a1612'
      ctx.beginPath()
      ctx.arc(x, y, 10, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.strokeStyle = 'rgba(80,70,50,0.25)'
  ctx.setLineDash([6, 8])
  ctx.beginPath()
  ctx.moveTo(0, 1)
  ctx.lineTo(w, 1)
  ctx.stroke()
  ctx.setLineDash([])
  grain(ctx, w, PAGE, 0.02)
  return c
}

// Monospace text wrapped to a number of characters, the way a printer lays it down.
function columns(s, n) {
  const out = []
  let line = ''
  for (const w of (s || '').split(/\s+/)) {
    if (!w) continue
    if ((line + ' ' + w).trim().length > n && line) {
      out.push(line)
      line = w
    } else line = (line + ' ' + w).trim()
  }
  if (line) out.push(line)
  return out
}

// Dot-matrix print: each line struck twice, a hair apart, with the ribbon fading a little.
function strike(ctx, s, x, y, size, alpha = 1) {
  ctx.font = `700 ${size}px ${TYPE}`
  ctx.fillStyle = `rgba(43,47,58,${0.78 * alpha})`
  ctx.fillText(s, x, y)
  ctx.fillStyle = `rgba(43,47,58,${0.5 * alpha})`
  ctx.fillText(s, x + 1.5, y + 1)
}

// The README's type, struck over the paper. Returns where the sheet ends and where each row ends.
function drawPrintout(ctx, p, shelf, w) {
  const m = 96
  const size = 34
  const lh = 50
  const cols = Math.floor((w - m * 2) / (size * 0.6))
  // where each printed row ends (px down the sheet), so the printer can strike them one at a time
  const rows = []
  let y = 90
  const line = (s, alpha) => {
    strike(ctx, s, m, y, size, alpha)
    rows.push(y + 15)
    y += lh
  }
  const gap = () => (y += lh * 0.5)
  line(`README.TXT            ${catalog(p, shelf)}`)
  gap()
  // the banner: the name in big letters, printed in passes so you can see the head's rows
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, w - m * 2, 150, 60)
  const [bc, bctx] = canvas(w, Math.ceil(ts * 1.1))
  bctx.font = `900 ${ts}px ${TITLE}`
  bctx.fillStyle = RIBBON
  bctx.fillText(title, m, ts * 0.8)
  bctx.globalCompositeOperation = 'destination-out'
  for (let r = 0; r < ts; r += 7) bctx.fillRect(0, r, w, 2)
  ctx.drawImage(bc, 0, y)
  rows.push(y + ts + 8)
  y += ts + 30
  line(columns((p.kicker || '').toUpperCase(), cols)[0] || '')
  line('='.repeat(cols))
  gap()
  const head = (s) => {
    line(s)
    line('-'.repeat(s.length))
  }
  const body = (s) => columns(s, cols).forEach((l) => line(l))
  head('WHAT IT IS')
  body(p.what)
  gap()
  const mk = p.making || {}
  if (mk.problem) {
    head('WHY I WROTE IT')
    body(mk.problem)
    gap()
  }
  if (mk.how?.length) {
    head('HOW IT WORKS')
    mk.how.forEach((step, i) => {
      columns(step, cols - 4).forEach((l, j) => line(`${j ? '    ' : ` ${i + 1}. `}${l}`))
    })
    gap()
  }
  if (p.run?.length) {
    head('TRY IT')
    const top = y - lh * 0.75
    // a terminal keeps its indents: a long line wraps at a space under its own indent, and only a
    // word longer than the whole line gets cut
    for (const r of p.run) {
      const pad = `  ${r.match(/^\s*/)[0]}`
      const n = cols - pad.length
      const words = r.trim().split(/\s+/).flatMap((wd) => wd.match(new RegExp(`.{1,${n}}`, 'g')) || [])
      columns(words.join(' '), n).forEach((l) => line(pad + l))
    }
    ctx.strokeStyle = 'rgba(43,47,58,0.5)'
    ctx.lineWidth = 2
    ctx.strokeRect(m - 14, top, w - m * 2 + 28, y - top - lh * 0.4)
    gap()
  }
  if (p.moment?.what) {
    head(p.moment.when ? `HOW IT STARTED (${p.moment.when.toUpperCase()})` : 'HOW IT STARTED')
    body(p.moment.what)
    gap()
  }
  if (p.built?.length) {
    head('WHAT I BUILT')
    for (const b of p.built) columns(b, cols - 3).forEach((l, j) => line(`${j ? '   ' : ' * '}${l}`))
    gap()
  }
  if (p.requirements?.length) {
    head('REQUIRES')
    body(p.requirements.join(', '))
    gap()
  }
  body(`${p.credit || ''}`.toUpperCase())
  gap()
  line('*** END OF FILE ***', 0.8)
  // the tear-off: the sheet ends on a ragged edge
  y += lh * 0.6
  return { end: y, rows }
}

function slice(src, y, h) {
  const [c, ctx] = canvas(src.width, h)
  ctx.drawImage(src, 0, y, src.width, h, 0, 0, src.width, h)
  return c
}

// px is the sheet's width in canvas pixels, the unit that rows and strip tops are measured in
export async function printoutTextures(p, shelf) {
  const w = PRINT_W
  const page = paperPage(w)
  // a tall scratch canvas comes back empty on some GPU paths unless it's kept in memory
  const [scratch, sctx] = canvas(w, 9600, { willReadFrequently: true })
  for (let y = 0; y < 9600; y += PAGE) sctx.drawImage(page, 0, y)
  const { end, rows } = drawPrintout(sctx, p, shelf, w)
  const h = Math.min(9600, Math.ceil(end))
  const strips = []
  for (let y = 0; y < h; y += STRIP) {
    const sh = Math.min(STRIP, h - y)
    strips.push({ tex: toTexture(slice(scratch, y, sh)), h: sh / w, top: y })
  }
  scratch.width = 1
  const paper = toTexture(page)
  paper.wrapT = THREE.RepeatWrapping
  return { strips, height: h / w, paper, tile: PAGE, rows: rows.filter((r) => r < h), px: w }
}
