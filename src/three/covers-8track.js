// An 8-track in its cardboard store sleeve. The sleeve's outside is printed like the shelf's other
// covers; its inside is printed as the machine's service log, read off `making.serviceRecord` (selected dated work and an observed result), so it reads once the sleeve is opened out flat.
import { canvas, toTexture, fit, wrap, grain, sticker, ratingBox, backCover, drawArt, initial, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { PAGE, M, catalog, still, lines } from './covers-booklet.js'
import { fmtDay, fmtMonth } from '../projects.js'

// the sleeve's big faces are the shape of a page, so the log can share the pages' measurements
export const SLEEVE = PAGE
const KRAFT = '#c7a476'
// a cheap store sleeve is printed in one ink
const BROWN = '#3a2415'
const FADED = '#6e4f33'
// dates go on in stamp-pad red, the one ink that reads on brown board
const STAMP = '#a3301d'

// The two inside faces, in order: the side that opens like a cover, then the side it opens from.
export const sleevePlan = () => [{ kind: 'log' }, { kind: 'log', more: true }]

// Bare cardboard: the brown, with fibres running every which way.
function board(ctx, w, h, seed = 7) {
  ctx.fillStyle = KRAFT
  ctx.fillRect(0, 0, w, h)
  let r = seed
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280
  ctx.lineWidth = 2
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const a = rnd() * Math.PI
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(90,58,28,0.12)' : 'rgba(255,240,210,0.10)'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16)
    ctx.stroke()
  }
}

// The sleeve's front: printed edge to edge, with bare cardboard showing at the die-cut edge.
export async function trackFront(p, shelf) {
  const { w, h } = SLEEVE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const bg = pal.bg || '#141414'
  const accent = pal.accent || shelf.color
  const ink = pal.ink || CREAM
  board(ctx, w, h, 3)
  const e = 22
  ctx.fillStyle = bg
  ctx.fillRect(e, e, w - e * 2, h - e * 2)

  ctx.fillStyle = accent
  ctx.fillRect(e, e, w - e * 2, 92)
  ctx.fillStyle = INK
  ctx.font = `700 34px ${BODY}`
  ctx.textBaseline = 'middle'
  ctx.fillText('RYAN ZEGALIA PRESENTS', 60, e + 48)
  ctx.textAlign = 'right'
  ctx.fillText(catalog(p, shelf), w - 60, e + 48)
  ctx.textAlign = 'left'

  // the format badge every 8-track sleeve carried
  const by = 160
  ctx.strokeStyle = ink
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.roundRect(60, by, 330, 76, 38)
  ctx.stroke()
  ctx.fillStyle = ink
  ctx.beginPath()
  ctx.arc(98, by + 38, 30, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = bg
  ctx.font = `900 46px ${TITLE}`
  ctx.textAlign = 'center'
  ctx.fillText('8', 98, by + 41)
  ctx.textAlign = 'left'
  ctx.fillStyle = ink
  ctx.font = `700 30px ${TYPE}`
  ctx.fillText('TRACK TAPE', 144, by + 40)
  ctx.textBaseline = 'alphabetic'

  const art = { y: 280, h: 560 }
  const img = await loadImage(p.photoUrl)
  if (img) {
    ctx.save()
    ctx.translate(w / 2, art.y + art.h / 2)
    ctx.rotate(-0.03)
    still(ctx, img, -(w - 160) / 2, -art.h / 2, w - 160, art.h, 14)
    ctx.restore()
  } else if (!p.art || p.art === 'none') {
    // no photo yet: the big letter, the same as the other covers
    ctx.save()
    ctx.globalAlpha = 0.14
    ctx.fillStyle = accent
    for (let i = e; i < w - e; i += 56) ctx.fillRect(i, art.y, 22, art.h)
    ctx.globalAlpha = 1
    ctx.font = `900 540px ${TITLE}`
    ctx.textAlign = 'center'
    ctx.fillText(initial(p.title), w / 2, art.y + art.h - 30)
    ctx.restore()
  } else drawArt(ctx, p.art, e, art.y, w - e * 2, art.h, accent)
  if (shelf.sticker) sticker(ctx, shelf.sticker, w - 210, 230, 0.08, { size: 28 })

  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, w - 120, 150)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillStyle = ink
  const ty = 890 + ts * 0.76
  ctx.fillText(title, 58, ty)
  if (p.kicker) {
    const kk = p.kicker.toUpperCase()
    ctx.font = `900 ${fit(ctx, kk, TITLE, 900, w - 120, 64, 30)}px ${TITLE}`
    ctx.fillStyle = accent
    ctx.fillText(kk, 60, ty + 72)
  }
  ctx.font = `600 38px ${BODY}`
  ctx.fillStyle = ink
  wrap(ctx, p.tagline, 60, ty + 132, w - 330, 44)

  ratingBox(ctx, w - 212, h - 232, p.rating || 'B', p.ratingWord || 'Built', ink)
  if (p.remix) sticker(ctx, `REMIX OF ${p.remix.of.toUpperCase()}`, 300, h - 150, -0.05, { bg: CREAM, size: 28 })
  ctx.fillStyle = 'rgba(243,234,214,0.75)'
  ctx.font = `600 30px ${BODY}`
  ctx.fillText(p.remix ? 'REMIXED AND RUN BY RYAN ZEGALIA' : 'BUILT AND RUN BY RYAN ZEGALIA', 60, h - 60)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// the picture is on the front, so the back keeps its room for the words
export const trackBack = (p, shelf) => backCover({ ...p, what: p.back?.pitch || p.what, built: p.back?.cut || p.built }, shelf, SLEEVE, { photo: false })

// The little label on the cartridge itself, seen as it slides out of the sleeve.
export function trackLabel(p, shelf) {
  const [c, ctx] = canvas(512, 600)
  ctx.fillStyle = CREAM
  ctx.fillRect(0, 0, 512, 600)
  ctx.fillStyle = (p.palette && p.palette.accent) || shelf.color
  ctx.fillRect(0, 0, 512, 70)
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  const title = p.title.toUpperCase()
  ctx.font = `900 ${fit(ctx, title, TITLE, 900, 460, 90, 30)}px ${TITLE}`
  ctx.fillText(title, 256, 300)
  ctx.font = `400 30px ${TYPE}`
  ctx.fillText(catalog(p, shelf), 256, 360)
  ctx.font = `700 26px ${BODY}`
  ctx.fillText('A RYAN ZEGALIA PRODUCTION', 256, 540)
  grain(ctx, 512, 600, 0.04)
  return toTexture(c)
}

// the project's own start wins: the repo's first commit is often a later move or rebuild
const since = (p) => p.started || p.history?.started || p.stats?.started || p.stats?.first

// Fixed-size type and explicit boxes: a maintenance card, not a shrinking incident dump.
// Both faces fit the existing single-page phone reader and the desktop spread.
function drawLog(ctxs, p, shelf) {
  const record = p.making?.serviceRecord
  if (!record) throw new Error(`Missing service record: ${p.slug}`)
  const width = PAGE.w - M * 2
  const label = (ctx, text, x, y, size = 24) => {
    ctx.fillStyle = FADED
    ctx.font = `700 ${size}px ${TYPE}`
    ctx.fillText(text, x, y)
  }
  const text = (ctx, value, x, y, w, h, size = 40, leading = 48, weight = 400) => {
    ctx.fillStyle = BROWN
    ctx.font = `${weight} ${size}px ${BODY}`
    const rows = lines(ctx, value, w)
    if (rows.length * leading > h || rows.some((row) => ctx.measureText(row).width > w)) {
      throw new Error(`Service card overflow: ${p.slug}: ${value}`)
    }
    rows.forEach((row, i) => ctx.fillText(row, x, y + i * leading))
  }
  const rule = (ctx, y, alpha = 0.5) => {
    ctx.fillStyle = `rgba(58,36,21,${alpha})`
    ctx.fillRect(M, y, width, 2)
  }
  const stamp = (ctx, value, x, y, w, angle = -0.018) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.strokeStyle = STAMP
    ctx.fillStyle = STAMP
    ctx.lineWidth = 3
    ctx.strokeRect(0, -33, w, 48)
    ctx.font = `700 26px ${TYPE}`
    ctx.textAlign = 'center'
    ctx.fillText(value, w / 2, 0)
    ctx.restore()
  }
  ctxs.forEach((ctx, i) => {
    board(ctx, PAGE.w, PAGE.h, 11 + i * 5)
    // A fold edge, staple impressions and a shop-stock border, all on the actual card.
    ctx.fillStyle = 'rgba(58,36,21,0.13)'
    ctx.fillRect(i ? 0 : PAGE.w - 12, 0, 12, PAGE.h)
    ctx.strokeStyle = 'rgba(58,36,21,0.35)'
    ctx.lineWidth = 2
    ctx.strokeRect(38, 35, PAGE.w - 76, PAGE.h - 70)
    for (const x of [M + 8, PAGE.w - M - 28]) {
      ctx.fillStyle = '#765f44'
      ctx.fillRect(x, 57, 22, 4)
      ctx.fillStyle = '#ddc39b'
      ctx.fillRect(x, 56, 22, 2)
    }
    label(ctx, `${catalog(p, shelf)} / KEEP IT RUNNING`, M, 104)
    rule(ctx, 1278)
    label(ctx, i ? 'FIELD NOTES' : 'SELECTED ENTRIES / RETAIN WITH UNIT', M, 1320, 22)
    label(ctx, `0${i + 1}`, PAGE.w - M - 32, 1320)
  })
  const [left, right] = ctxs
  left.fillStyle = BROWN
  left.font = `900 100px ${TITLE}`
  left.fillText('SERVICE LOG', M, 204)
  text(left, p.title, M, 261, width, 55, 46, 55, 700)
  const opened = since(p)
  if (opened) {
    label(left, 'STARTED', M, 326)
    stamp(left, fmtMonth(opened).toUpperCase(), M + 200, 326, 400)
  }
  text(left, record.purpose, M, 403, width, 144)
  label(left, 'DATE / WORK CARRIED OUT', M, 552)
  label(left, 'BY', PAGE.w - M - 40, 552)
  if (record.entries.length !== 3) throw new Error(`Service card needs three selected entries: ${p.slug}`)
  record.entries.forEach((entry, i) => {
    const y = 610 + i * 210
    stamp(left, fmtDay(entry.date).toUpperCase(), M, y, 270, (i - 1) * 0.018)
    label(left, 'RZ', PAGE.w - M - 40, y, 28)
    text(left, entry.text, M + 18, y + 63, width - 36, 144)
    rule(left, y + 169, 0.25)
  })
  label(left, 'STATUS / ' + (p.status || '').toUpperCase(), M, 1244)

  right.fillStyle = BROWN
  right.font = `900 88px ${TITLE}`
  right.fillText('ON THE BENCH', M, 204)
  // A lighter test slip pasted into the kraft record, with a torn/perforated bottom.
  right.fillStyle = 'rgba(58,36,21,0.14)'
  right.fillRect(M + 6, 236, width, 400)
  right.fillStyle = '#e5d1aa'
  right.fillRect(M, 230, width, 400)
  right.save()
  right.setLineDash([3, 9])
  right.strokeStyle = FADED
  right.beginPath()
  right.moveTo(M + 20, 609)
  right.lineTo(PAGE.w - M - 20, 609)
  right.stroke()
  right.restore()
  label(right, 'OBSERVED / ' + fmtDay(record.receipt.date).toUpperCase(), M + 28, 280)
  right.fillStyle = BROWN
  right.font = `900 64px ${TITLE}`
  if (right.measureText(record.receipt.title).width > width - 56) throw new Error(`Receipt heading overflow: ${p.slug}`)
  right.fillText(record.receipt.title, M + 28, 355)
  text(right, record.receipt.text, M + 28, 414, width - 56, 192, 38, 46)

  label(right, 'HOW THE PARTS CONNECT', M, 692)
  // These are functional paths, not invented telemetry or an electrical wiring claim.
  record.route.forEach((part, i) => {
    const x = M + i * 290
    right.strokeStyle = BROWN
    right.lineWidth = 3
    right.strokeRect(x, 724, 260, 70)
    right.font = `700 24px ${BODY}`
    right.fillStyle = BROWN
    if (right.measureText(part).width > 236) throw new Error(`Route label overflow: ${p.slug}`)
    right.textAlign = 'center'
    right.fillText(part, x + 130, 767)
    right.textAlign = 'left'
    if (i < 2) {
      right.beginPath()
      right.moveTo(x + 264, 759)
      right.lineTo(x + 285, 759)
      right.lineTo(x + 279, 752)
      right.moveTo(x + 285, 759)
      right.lineTo(x + 279, 766)
      right.stroke()
    }
  })
  label(right, 'FUNCTIONAL SKETCH / NOT TO SCALE', M, 833, 22)
  right.strokeStyle = BROWN
  right.strokeRect(M, 874, width, 230)
  right.fillStyle = BROWN
  right.font = `900 48px ${TITLE}`
  right.fillText('PARTS AND LABOR', M + 24, 931)
  text(right, p.making.credits.join(' · '), M + 24, 980, width - 48, 126, 36, 42, 600)
  label(right, 'KEEP IN SERVICE', M, 1157)
  text(right, record.care, M, 1207, width, 86, 36, 43)
}

// The sleeve's outside front and two inside faces share the same production bake.
export async function sleeveTextures(p, shelf) {
  const cover = await trackFront(p, shelf)
  const made = [canvas(PAGE.w, PAGE.h), canvas(PAGE.w, PAGE.h)]
  const ctxs = made.map(([, x]) => x)
  drawLog(ctxs, p, shelf)
  for (const x of ctxs) grain(x, PAGE.w, PAGE.h, 0.03)
  return { cover, pages: made.map(([c]) => toTexture(c)) }
}

// Bare cardboard for the faces nobody prints on, drawn once and shared.
let bare = null
export function kraftTexture() {
  if (!bare) {
    const [c, ctx] = canvas(256, 360)
    board(ctx, 256, 360, 5)
    bare = toTexture(c)
  }
  return bare
}
