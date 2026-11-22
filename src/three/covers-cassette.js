// Draws the "For my people" shelf's mixtapes: the J-card seen through the clear case, the tape
// inside it, the spine, and the J-card unfolded into its panels: a cover, a handwritten track list
// for each side, the liner notes, and the back flap.
import { canvas, toTexture, fit, grain, cover, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { PAGE, PAPER, DIM, lines } from './covers-booklet.js'

// One unit is 100 mm, bigger than life like the other media. The case stands on its short edge.
export const CS = { w: 1.0, h: 1.5, t: 0.2 }
const PEN = '#1f3f8f'
const MARKER = '#17120e'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`
const accentOf = (p) => (p.palette && p.palette.accent) || '#e0603a'
const bgOf = (p) => (p.palette && p.palette.bg) || '#2a1a14'

function text(ctx, s, x, y, size, color = INK, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

// Written by hand: italic, a little crooked, each line its own tilt.
function hand(ctx, s, x, y, size, color = PEN, seed = 0) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((((seed * 37) % 7) - 3) * 0.004)
  ctx.fillStyle = color
  ctx.font = `italic 600 ${size}px ${BODY}`
  ctx.fillText(s, 0, 0)
  ctx.restore()
}

function handWrap(ctx, s, x, y, width, size, lh, color = PEN) {
  ctx.font = `italic 600 ${size}px ${BODY}`
  let i = 0
  for (const l of lines(ctx, s || '', width)) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((((i * 37) % 7) - 3) * 0.003)
    ctx.fillStyle = color
    ctx.font = `italic 600 ${size}px ${BODY}`
    ctx.fillText(l, 0, 0)
    ctx.restore()
    y += lh
    i++
  }
  return y
}

// A drawn picture for a tape with no photo yet, on the J-card's front panel; keyed on "art".
// A month of who can go (green yes, yellow maybe, red no), the run that suits everyone ringed in pen.
function calendar(ctx, p, x, y, w, h) {
  ctx.fillStyle = PAPER
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = accentOf(p)
  ctx.fillRect(x, y, w, 80)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(x + 30, y + 30, 220, 22)
  const cw = (w - 40) / 7
  const top = y + 130
  const ch = (h - 150) / 5
  for (let i = 0; i < 7; i++) text(ctx, 'SMTWTFS'[i], x + 20 + cw * i + cw / 2, y + 116, 28, DIM, 700, TYPE, 'center')
  const S = 'oxx.oooo.xxoooxooooo.oo.xxxoooo.oox'
  const COL = { o: '#6cbf73', '.': '#f2c14e', x: '#d9574f' }
  for (let d = 0; d < 35; d++) {
    const cx0 = x + 20 + (d % 7) * cw
    const cy0 = top + Math.floor(d / 7) * ch
    ctx.fillStyle = COL[S[d]]
    ctx.fillRect(cx0 + 4, cy0 + 4, cw - 8, ch - 8)
    if (d < 31) text(ctx, String(d + 1), cx0 + 14, cy0 + 34, 26, 'rgba(23,18,14,0.75)', 700, TYPE)
  }
  ctx.strokeStyle = PEN
  ctx.lineWidth = 7
  ctx.beginPath()
  ctx.ellipse(x + 20 + cw * 3.5, top + ch * 2.5, cw * 2.75, ch * 0.62, -0.03, 0, Math.PI * 2)
  ctx.stroke()
}
const JART = { calendar }

// The J-card's printed face: bold stripes in the tape's colours, the title in marker over them.
function coverArt(ctx, p, shelf, w, h, img = null) {
  const accent = accentOf(p)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, w, h)
  const draw = img ? (x, y, dw, dh) => cover(ctx, img, x, y, dw, dh) : JART[p.art] && ((x, y, dw, dh) => JART[p.art](ctx, p, x, y, dw, dh))
  if (draw) {
    // a picture of the thing printed on the front panel, the tape's colours in a band under it
    const pw = w - 80
    // a very wide picture keeps its whole width: the window follows its shape and sits in the middle of the panel
    const wide = img && img.width / img.height > 1.8
    const ph = wide ? Math.round(pw / (img.width / img.height)) : 700
    const py = wide ? 50 + Math.round((700 - ph) / 2) : 50
    draw(40, py, pw, ph)
    ;[accent, CREAM, accent, '#f2c14e'].forEach((c, i) => {
      ctx.fillStyle = c
      ctx.fillRect(40, py + ph + 6 + i * 12, pw, 8)
    })
  } else {
  ctx.save()
  ctx.translate(w / 2, h * 0.38)
  ctx.rotate(-0.5)
  const bands = [accent, CREAM, accent, '#f2c14e']
  bands.forEach((c, i) => {
    ctx.fillStyle = c
    ctx.globalAlpha = i % 2 ? 0.9 : 1
    ctx.fillRect(-w * 1.2, -h * 0.2 + i * h * 0.07, w * 2.4, h * 0.045)
  })
  ctx.restore()
  ctx.globalAlpha = 1
  }
  // a paper label stuck on, the title written on it in marker
  const lx = w * 0.08
  const ly = h * 0.56
  const lw = w * 0.84
  const lh = h * 0.3
  ctx.save()
  ctx.translate(lx + lw / 2, ly + lh / 2)
  ctx.rotate(-0.03)
  ctx.fillStyle = PAPER
  ctx.fillRect(-lw / 2, -lh / 2, lw, lh)
  ctx.fillStyle = 'rgba(31,63,143,0.25)'
  for (let r = 1; r < 5; r++) ctx.fillRect(-lw / 2 + 20, -lh / 2 + r * (lh / 5), lw - 40, 2)
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, lw - 60, 130, 50)
  text(ctx, title, 0, -lh * 0.1, ts, MARKER, 900, TITLE, 'center')
  // what it is, in plain words, written under the title
  const kk = p.kicker || ''
  ctx.font = `italic 600 46px ${BODY}`
  const kw = ctx.measureText(kk).width
  hand(ctx, kk, -Math.min(kw, lw - 60) / 2, lh * 0.14, kw > lw - 60 ? Math.floor((46 * (lw - 60)) / kw) : 46, PEN, 1)
  hand(ctx, `for my people  ·  vol. ${p.order ?? 1}`, -lw / 2 + 30, lh * 0.38, 30, PEN, 2)
  ctx.restore()
  text(ctx, catalog(p, shelf), w - 40, h - 36, 26, CREAM, 700, TYPE, 'right')
  text(ctx, 'TYPE I  ·  NORMAL BIAS  ·  C60', 40, h - 36, 24, CREAM, 700, TYPE)
}

export async function cassetteFront(p, shelf) {
  const [c, ctx] = canvas(PAGE.w, PAGE.h)
  coverArt(ctx, p, shelf, PAGE.w, PAGE.h, await loadImage(p.photoUrl))
  grain(ctx, PAGE.w, PAGE.h, 0.05)
  return toTexture(c)
}

// The tape itself, lying in the case's tray: shell, label, the two reel windows. Side A, the title,
// shows through the back of the case; side B faces the J-card and says what's on it, in pen.
export function tapeShell(p, shelf, side = 'A') {
  // the shell's own shape, 0.88 by 1.38, standing on its short edge like the case
  const W = 704
  const H = 1104
  const [c, ctx] = canvas(W, H)
  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.rotate(side === 'A' ? Math.PI / 2 : -Math.PI / 2)
  const tw = H
  const th = W
  ctx.fillStyle = '#2a2a2e'
  ctx.fillRect(-tw / 2, -th / 2, tw, th)
  // the label, written on in pen
  ctx.fillStyle = accentOf(p)
  ctx.fillRect(-tw / 2 + 50, -th / 2 + 40, tw - 100, th * 0.62)
  ctx.fillStyle = PAPER
  ctx.fillRect(-tw / 2 + 70, -th / 2 + 60, tw - 140, th * 0.2)
  const words = side === 'A' ? p.title : p.kicker || p.tagline || p.title
  ctx.font = `italic 600 64px ${BODY}`
  const size = Math.min(64, Math.floor((64 * (tw - 200)) / Math.max(1, ctx.measureText(words).width)))
  hand(ctx, words, -tw / 2 + 96, -th / 2 + 60 + th * 0.14, size, PEN, side === 'A' ? 1 : 2)
  text(ctx, side, -tw / 2 + 76, -th / 2 + th * 0.58, 60, MARKER, 900, TITLE)
  // the window: two reels and the tape between them
  ctx.fillStyle = '#0f0f11'
  ctx.beginPath()
  ctx.roundRect(-tw * 0.28, -th / 2 + th * 0.3, tw * 0.56, th * 0.24, 20)
  ctx.fill()
  for (const dx of [-tw * 0.17, tw * 0.17]) {
    ctx.fillStyle = '#5a3a22'
    ctx.beginPath()
    ctx.arc(dx, -th / 2 + th * 0.42, th * 0.1 + (dx < 0 ? 10 : -6), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e8e8ea'
    ctx.beginPath()
    ctx.arc(dx, -th / 2 + th * 0.42, th * 0.045, 0, Math.PI * 2)
    ctx.fill()
  }
  // the five screw heads and the guide holes along the bottom edge
  ctx.fillStyle = '#1c1c1f'
  for (const [x, y] of [[-0.46, -0.42], [0.46, -0.42], [-0.46, 0.42], [0.46, 0.42], [0, 0.42]]) {
    ctx.beginPath()
    ctx.arc(x * tw, y * th, 12, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  grain(ctx, W, H, 0.04)
  return toTexture(c)
}

export function cassetteSpine(p, shelf) {
  const W = 256
  const H = 1400
  const [c, ctx] = canvas(W, H)
  const accent = accentOf(p)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, W, H)
  // The same colour bars and ruled paper label as the front, squeezed onto the folded spine.
  ;[accent, CREAM, accent, '#f2c14e'].forEach((color, i) => {
    ctx.fillStyle = color
    ctx.fillRect(18 + i * 56, 0, 40, H)
  })
  ctx.fillStyle = PAPER
  ctx.fillRect(34, 86, W - 68, H - 172)
  ctx.fillStyle = 'rgba(31,63,143,0.22)'
  for (let y = 150; y < H - 120; y += 86) ctx.fillRect(48, y, W - 96, 2)
  ctx.fillStyle = accent
  ctx.fillRect(34, 86, W - 68, 70)
  ctx.save()
  ctx.translate(156, H - 146)
  ctx.rotate(-Math.PI / 2)
  const ts = fit(ctx, p.title.toUpperCase(), TITLE, 900, H - 430, 104, 58)
  text(ctx, p.title.toUpperCase(), 0, 0, ts, MARKER, 900, TITLE)
  hand(ctx, p.kicker || p.tagline || '', 4, 54, 36, PEN, 3)
  ctx.restore()
  text(ctx, catalog(p, shelf), W / 2, H - 34, 22, CREAM, 700, TYPE, 'center')
  grain(ctx, W, H, 0.035)
  return toTexture(c)
}

// ---- the J-card, unfolded ----------------------------------------------------------------------

// The inside panels, in order; App reads the length for paging. The cover and back flap come too.
// Each panel is printed plainly, one part of the story each: who it's for, what it does, what I
// built, how it went.
export const jcardPlan = (p) => ['for', 'does', 'built', 'went']

const light = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}
// one ink the card can be printed in: the accent, unless it's too pale to read on paper
const printInk = (p) => [accentOf(p), bgOf(p)].find((c) => light(c) < 0.55) || INK

function panelPaper(ctx, p) {
  const { w, h } = PAGE
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, w, 18)
  // a crease shadow down each fold
  for (const x of [0, w]) {
    const g = ctx.createLinearGradient(x - 24, 0, x + 24, 0)
    g.addColorStop(0, 'rgba(60,40,20,0)')
    g.addColorStop(0.5, 'rgba(60,40,20,0.14)')
    g.addColorStop(1, 'rgba(60,40,20,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - 24, 0, 48, h)
  }
}

const LABEL = { for: "WHO IT'S FOR", does: 'WHAT IT DOES', built: 'WHAT I BUILT', went: 'HOW IT WENT', credits: 'CREDITS' }

// One panel at scale k; returns how far down it got.
function drawPanel(ctx, p, kind, k) {
  const { w } = PAGE
  const m = 84
  const width = w - m * 2
  const px = (n) => Math.round(n * k)
  const ink = printInk(p)
  const mk = p.making || {}
  const body = (s, y, weight = 500) => {
    ctx.font = `${weight} ${px(52)}px ${BODY}`
    ctx.fillStyle = INK
    for (const l of lines(ctx, s || '', width)) {
      ctx.fillText(l, m, y)
      y += px(64)
    }
    return y
  }
  const label = (s, y) => {
    text(ctx, s, m, y, px(34), ink, 700, TYPE)
    return y + px(70)
  }
  const list = (items, mark, y) => {
    items.forEach((s, i) => {
      text(ctx, mark === '#' ? String(i + 1) : mark, m, y, px(52), ink, 900, TITLE)
      ctx.font = `500 ${px(50)}px ${BODY}`
      ctx.fillStyle = INK
      for (const l of lines(ctx, s, width - px(66))) {
        ctx.fillText(l, m + px(66), y)
        y += px(62)
      }
      y += px(16)
    })
    return y
  }
  let y = 120
  text(ctx, LABEL[kind], m, y, px(34), ink, 700, TYPE)
  y += px(44)
  if (kind === 'for') {
    // who it's for, big, then why they needed it
    ctx.font = `900 ${px(124)}px ${TITLE}`
    ctx.fillStyle = INK
    for (const l of lines(ctx, (p.starring || 'My people').toUpperCase(), width)) {
      y += px(114)
      ctx.fillText(l, m, y)
    }
    y += px(70)
    if (mk.problem) y = body(mk.problem, y)
  } else if (kind === 'does') {
    y = body(p.what, y + px(56)) + px(24)
    if (mk.how?.length) y = list(mk.how, '#', label('HOW IT WORKS', y))
  } else if (kind === 'built') {
    y = list(p.built || [], '●', y + px(60))
  } else if (kind === 'credits') {
    y = body('Built by Ryan Zegalia.', y + px(56)) + px(30)
    if (p.requirements?.length) y = body(p.requirements.join(', '), label('MADE WITH', y)) + px(30)
    if (mk.credits?.length) y = list(mk.credits, '·', label('WITH THANKS TO', y))
  } else {
    const mo = p.moment || {}
    y += px(56)
    if (mo.what) {
      if (mo.when) y = label(mo.when.toUpperCase(), y) - px(6)
      y = body(mo.what, y) + px(30)
    }
    const st = p.progress ? `${p.status}. ${p.progress}` : p.status
    if (st) y = body(st, label('WHERE IT IS NOW', y))
  }
  return y
}

function panelTexture(p, shelf, kind) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  let k = 1
  for (; k >= 0.64; k -= 0.04) {
    panelPaper(ctx, p)
    if (drawPanel(ctx, p, kind, k) <= h - 110) break
  }
  if (k < 0.72) console.warn(`[shelf] the J-card of "${p.title}" (${kind}) had to shrink to ${Math.round(k * 100)}%: cut some words`)
  text(ctx, `${catalog(p, shelf)}  ·  ${p.title.toUpperCase()}`, 84, h - 60, 24, DIM, 700, TYPE)
  grain(ctx, w, h, 0.04)
  return toTexture(c)
}

// The folded back flap is the mixtape's track list: the same picture, colour bars and handwritten
// label as the front, with the project's sourced pitch and steps instead of generic credits.
export async function cassetteBack(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const accent = accentOf(p)
  ctx.fillStyle = bgOf(p)
  ctx.fillRect(0, 0, w, h)

  const img = await loadImage(p.photoUrl)
  const draw = img ? (x, y, dw, dh) => cover(ctx, img, x, y, dw, dh) : JART[p.art] && ((x, y, dw, dh) => JART[p.art](ctx, p, x, y, dw, dh))
  const artX = 48
  const artY = 44
  const artW = w - artX * 2
  const artH = 350
  if (draw) draw(artX, artY, artW, artH)
  else {
    ctx.save()
    ctx.translate(w / 2, artY + artH / 2)
    ctx.rotate(-0.22)
    ;[accent, CREAM, accent, '#f2c14e'].forEach((color, i) => {
      ctx.fillStyle = color
      ctx.fillRect(-w, -110 + i * 58, w * 2, 34)
    })
    ctx.restore()
  }
  ;[accent, CREAM, accent, '#f2c14e'].forEach((color, i) => {
    ctx.fillStyle = color
    ctx.fillRect(artX, artY + artH + 8 + i * 13, artW, 9)
  })

  const lx = 54
  const ly = 472
  const lw = w - lx * 2
  const lh = h - ly - 68
  ctx.fillStyle = PAPER
  ctx.fillRect(lx, ly, lw, lh)
  ctx.fillStyle = 'rgba(31,63,143,0.2)'
  for (let y = ly + 96; y < ly + lh - 34; y += 62) ctx.fillRect(lx + 24, y, lw - 48, 2)
  text(ctx, 'SIDE B  ·  WHAT IT DOES', lx + 42, ly + 62, 28, accent, 700, TYPE)
  const titleSize = fit(ctx, p.title.toUpperCase(), TITLE, 900, lw - 84, 78, 46)
  text(ctx, p.title.toUpperCase(), lx + 42, ly + 142, titleSize, MARKER, 900, TITLE)

  let y = handWrap(ctx, p.tagline || p.kicker || p.what || '', lx + 42, ly + 204, lw - 84, 37, 46, PEN) + 24
  text(ctx, 'TRACK LIST', lx + 42, y, 26, accent, 700, TYPE)
  y += 54
  for (const [i, item] of (p.making?.how || []).slice(0, 4).entries()) {
    text(ctx, String(i + 1).padStart(2, '0'), lx + 42, y, 34, MARKER, 900, TITLE)
    y = handWrap(ctx, item, lx + 108, y, lw - 158, 32, 40, PEN) + 20
  }
  text(ctx, `${catalog(p, shelf)}  ·  HOME RECORDING`, w - 48, h - 28, 22, CREAM, 700, TYPE, 'right')
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

export async function jcardTextures(p, shelf) {
  const pages = []
  for (const k of jcardPlan(p)) {
    pages.push(panelTexture(p, shelf, k))
    await new Promise((r) => setTimeout(r))
  }
  return { cover: await cassetteFront(p, shelf), back: panelTexture(p, shelf, 'credits'), pages }
}
