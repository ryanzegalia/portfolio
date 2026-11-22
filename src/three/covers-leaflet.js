// What's inside a rental tape's clamshell: the tape itself, and the folded "Behind the scenes"
// leaflet tucked in on top of it. The leaflet is a z-fold strip: a cover panel, the same pages the
// booklet prints (Booklet.jsx reads the same fields), and the store's back panel.
import { canvas, toTexture, fit, wrap, grain, sticker, ratingBox, barcode, hash, drawArt, initial, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { PAGE, PAPER, DIM, M, catalog, tick, still, bookletPlan, pageTexture, proofImages } from './covers-booklet.js'

// A strip of panels needs no even count, so it skips the booklet's ruled notes page.
export const leafletPlan = (p) => bookletPlan(p).filter((pg) => pg.kind !== 'notes')

// Every inside panel: the leaflet's name on a band in the shelf's color, the catalog number at the
// foot, and a little shadow printed along each crease.
function panel(ctx, p, shelf) {
  const { w, h } = PAGE
  const width = w - M * 2
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = shelf.color
  ctx.fillRect(0, 0, w, 104)
  ctx.fillStyle = CREAM
  const band = shelf.extras.toUpperCase()
  ctx.font = `900 ${fit(ctx, band, TITLE, 900, width * 0.56, 62, 30)}px ${TITLE}`
  ctx.fillText(band, M, 74)
  const title = p.title.toUpperCase()
  ctx.font = `700 ${fit(ctx, title, TYPE, 700, width * 0.4, 26, 16)}px ${TYPE}`
  ctx.textAlign = 'right'
  ctx.fillText(title, w - M, 70)

  ctx.fillStyle = INK
  ctx.fillRect(M, h - 112, width, 2)
  ctx.font = `400 24px ${TYPE}`
  ctx.fillStyle = DIM
  ctx.fillText('BE KIND, REWIND', w - M, h - 58)
  ctx.textAlign = 'left'
  ctx.fillText(catalog(p, shelf), M, h - 58)

  for (const [x0, x1] of [[0, 34], [w, w - 34]]) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, 'rgba(60,40,20,0.12)')
    g.addColorStop(1, 'rgba(60,40,20,0)')
    ctx.fillStyle = g
    ctx.fillRect(Math.min(x0, x1), 104, 34, h - 104)
  }
}

// The front panel, the one you see while it's folded: a rental brochure's masthead over the still.
async function leafletCover(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const bg = pal.bg || '#141414'
  const accent = pal.accent || shelf.color
  const ink = pal.ink || CREAM
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.fillStyle = shelf.color
  ctx.fillRect(0, 0, w, 300)
  ctx.fillStyle = INK
  ctx.font = `700 30px ${TYPE}`
  ctx.fillText('RYAN ZEGALIA PRESENTS', 60, 66)
  ctx.textAlign = 'right'
  ctx.fillText(catalog(p, shelf), w - 60, 66)
  ctx.textAlign = 'left'
  const band = shelf.extras.toUpperCase()
  ctx.fillStyle = CREAM
  ctx.font = `900 ${fit(ctx, band, TITLE, 900, w - 120, 200)}px ${TITLE}`
  ctx.fillText(band, 56, 256)
  ctx.fillStyle = INK
  ctx.fillRect(0, 300, w, 12)

  const art = { y: 360, h: 560 }
  const img = await loadImage(p.photoUrl)
  if (img) {
    ctx.save()
    ctx.translate(w / 2, art.y + art.h / 2)
    ctx.rotate(0.03)
    still(ctx, img, -(w - 140) / 2, -art.h / 2, w - 140, art.h, 14)
    ctx.restore()
  } else if (!p.art || p.art === 'none') {
    // no photo yet: the big letter, like the booklet's cover
    ctx.save()
    ctx.globalAlpha = 0.14
    ctx.fillStyle = accent
    for (let i = 0; i < w; i += 56) ctx.fillRect(i, art.y, 22, art.h)
    ctx.globalAlpha = 1
    ctx.font = `900 520px ${TITLE}`
    ctx.textAlign = 'center'
    ctx.fillText(initial(p.title), w / 2, art.y + art.h - 40)
    ctx.restore()
  } else {
    drawArt(ctx, p.art, 0, art.y - 48, w, art.h + 48, accent)
    const g = ctx.createLinearGradient(0, art.y + art.h * 0.5, 0, art.y + art.h)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, bg)
    ctx.fillStyle = g
    ctx.fillRect(0, art.y - 48, w, art.h + 48)
  }
  if (shelf.sticker) sticker(ctx, shelf.sticker, w - 210, 352, 0.07, { size: 28 })

  ctx.fillStyle = accent
  ctx.font = `700 30px ${TYPE}`
  ctx.fillText('THE MAKING OF', 62, 990)
  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, w - 120, 160)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillStyle = ink
  ctx.fillText(title, 58, 1010 + ts * 0.78)
  ctx.font = `600 40px ${BODY}`
  wrap(ctx, p.tagline, 62, 1070 + ts * 0.78, w - 340, 46)

  ratingBox(ctx, w - 210, h - 225, p.rating || 'B', p.ratingWord || 'Built', ink)
  if (p.remix) sticker(ctx, `REMIX OF ${p.remix.of.toUpperCase()}`, 300, h - 150, -0.05, { bg: CREAM, size: 28 })
  ctx.fillStyle = 'rgba(243,234,214,0.75)'
  ctx.font = `600 30px ${BODY}`
  ctx.fillText(p.remix ? 'REMIXED AND RUN BY RYAN ZEGALIA' : 'BUILT AND RUN BY RYAN ZEGALIA', 60, h - 56)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// The last panel, the store's back of the brochure.
function leafletBack(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const ink = pal.ink || CREAM
  ctx.fillStyle = pal.bg || '#141414'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = shelf.color
  ctx.fillRect(0, 0, w, 104)
  ctx.textAlign = 'center'
  ctx.fillStyle = ink
  const line = shelf.line.toUpperCase()
  ctx.font = `900 ${fit(ctx, line, TITLE, 900, w - 160, 92)}px ${TITLE}`
  ctx.fillText(line, w / 2, 560)
  ctx.font = `700 34px ${BODY}`
  ctx.fillText('A RYAN ZEGALIA PRODUCTION', w / 2, 640)
  ctx.textAlign = 'left'
  sticker(ctx, 'PLEASE REWIND BEFORE RETURNING', w / 2, 820, -0.04, { size: 30 })
  barcode(ctx, w / 2 - 150, h - 300, 300, 90, hash(p.slug))
  ctx.fillStyle = ink
  ctx.font = `700 34px ${TYPE}`
  ctx.textAlign = 'center'
  ctx.fillText(catalog(p, shelf), w / 2, h - 80)
  ctx.textAlign = 'left'
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// Everything the leaflet shows, drawn once. Yields between panels so the case keeps moving.
export async function leafletTextures(p, shelf) {
  const plan = leafletPlan(p)
  const imgs = await proofImages(p, plan)
  const cover = await leafletCover(p, shelf)
  const pages = []
  for (let i = 0; i < plan.length; i++) {
    await tick()
    pages.push(pageTexture(p, shelf, plan[i], i, imgs, panel, 'leaflet panel'))
  }
  return { cover, back: leafletBack(p, shelf), pages }
}

// The tape as it lies in the tray: black shell, smoked window, reels wound all the way back,
// and the store's sticker. Drawn standing up, the way it sits in the case.
export const TAPE = { w: 512, h: 940 }
export function tapeFace(p, shelf) {
  const { w, h } = TAPE
  const [c, ctx] = canvas(w, h)
  ctx.fillStyle = '#141415'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#1e1e20'
  for (let y = 40; y < h - 40; y += 24) {
    ctx.fillRect(16, y, 24, 10)
    ctx.fillRect(w - 40, y, 24, 10)
  }
  const win = { x: 92, y: 130, w: w - 184, h: 520 }
  ctx.fillStyle = '#2c2723'
  ctx.beginPath()
  ctx.roundRect(win.x, win.y, win.w, win.h, 26)
  ctx.fill()
  const reel = (cy, r) => {
    ctx.fillStyle = '#3a2a1e'
    ctx.beginPath()
    ctx.arc(w / 2, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e8e2d4'
    ctx.beginPath()
    ctx.arc(w / 2, cy, 40, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#141415'
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      ctx.beginPath()
      ctx.arc(w / 2 + Math.cos(a) * 26, cy + Math.sin(a) * 26, 6, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(w / 2, cy, 12, 0, Math.PI * 2)
    ctx.fill()
  }
  // be kind: it's rewound, so all the tape is on one reel
  reel(win.y + 150, 128)
  reel(win.y + win.h - 128, 46)
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  ctx.beginPath()
  ctx.moveTo(win.x + 30, win.y)
  ctx.lineTo(win.x + 110, win.y)
  ctx.lineTo(win.x + 20, win.y + win.h)
  ctx.lineTo(win.x - 60 + 30, win.y + win.h)
  ctx.fill()

  const s = { x: 54, y: h - 250, w: w - 108, h: 196 }
  ctx.fillStyle = CREAM
  ctx.fillRect(s.x, s.y, s.w, s.h)
  ctx.fillStyle = shelf.color
  ctx.fillRect(s.x, s.y, s.w, 44)
  ctx.fillStyle = CREAM
  ctx.font = `700 24px ${TYPE}`
  ctx.textAlign = 'center'
  ctx.fillText('PLEASE REWIND', w / 2, s.y + 31)
  ctx.fillStyle = INK
  const title = p.title.toUpperCase()
  ctx.font = `900 ${fit(ctx, title, TITLE, 900, s.w - 30, 72, 30)}px ${TITLE}`
  ctx.fillText(title, w / 2, s.y + 122)
  ctx.font = `400 26px ${TYPE}`
  ctx.fillText(catalog(p, shelf), w / 2, s.y + 170)
  ctx.textAlign = 'left'
  grain(ctx, w, h, 0.04)
  return toTexture(c)
}
