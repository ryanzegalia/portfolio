// Cartridge label art: the sticker on the front, and a compact sticker on the back.
import { canvas, toTexture, fit, wrap, cover, grain, sticker, ratingBox, backCover, initial, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'

export const LABEL = { w: 1024, h: 980 }

// Drawn pictures of the thing for a cartridge with no screenshot yet, keyed on project.json "art".
function pinball(ctx, p, x, y, w, h, accent) {
  const cx = x + w / 2
  const tw = 430
  const bw = 300
  const sh = 236
  const ty = y + (h - sh * 2 - 40) / 2
  const by = ty + sh + 40
  // the handheld: a wide top screen over a smaller bottom one, open at the hinge
  ctx.fillStyle = '#18181c'
  ctx.beginPath()
  ctx.roundRect(cx - tw / 2 - 20, ty - 20, tw + 40, sh + 40, 24)
  ctx.roundRect(cx - bw / 2 - 110, by - 20, bw + 220, sh + 40, 24)
  ctx.fill()
  ctx.fillStyle = '#0c0c0e'
  ctx.fillRect(cx - tw / 2, ty + sh + 16, tw, 8)
  ctx.fillStyle = '#2c2c33'
  ctx.fillRect(cx - bw / 2 - 85, by + sh / 2 - 10, 60, 20)
  ctx.fillRect(cx - bw / 2 - 65, by + sh / 2 - 30, 20, 60)
  for (const [dx, dy] of [[0, -22], [22, 0], [0, 22], [-22, 0]]) {
    ctx.beginPath()
    ctx.arc(cx + bw / 2 + 55 + dx, by + sh / 2 + dy, 10, 0, Math.PI * 2)
    ctx.fill()
  }
  // one tall table, running down through both screens
  const tl = cx - 150
  const top = ty
  const bot = by + sh
  const table = () => {
    ctx.fillStyle = '#0d0a10'
    ctx.fillRect(cx - tw / 2, top, tw, bot - top)
    const g = ctx.createLinearGradient(0, top, 0, bot)
    g.addColorStop(0, '#2b0b14')
    g.addColorStop(1, '#4a1220')
    ctx.fillStyle = g
    ctx.fillRect(tl, top, 300, bot - top)
    ctx.strokeStyle = CREAM
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(cx, top + 150, 140, Math.PI, 0)
    ctx.stroke()
    for (const [bx, bmy] of [[-70, 120], [70, 120], [0, 185]]) {
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(cx + bx, top + bmy, 28, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = 6
      ctx.stroke()
    }
    const fy = bot - 70
    ctx.fillStyle = accent
    for (const s of [1, -1]) {
      const ex = s > 0 ? tl : tl + 300
      ctx.beginPath()
      ctx.moveTo(ex + s * 20, fy - 90)
      ctx.lineTo(ex + s * 20, fy - 20)
      ctx.lineTo(ex + s * 70, fy - 10)
      ctx.closePath()
      ctx.fill()
    }
    ctx.lineWidth = 18
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tl + 50, fy)
    ctx.lineTo(cx - 22, fy + 22)
    ctx.moveTo(tl + 250, fy)
    ctx.lineTo(cx + 22, fy + 22)
    ctx.stroke()
    ctx.lineCap = 'butt'
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(tl, bot - 30, 300, 30)
    ctx.fillStyle = accent
    for (let i = 0; i < 6; i++) ctx.fillRect(tl + 16 + i * 26, bot - 21, 18, 12)
  }
  for (const [sx, sy, sw] of [[cx - tw / 2, ty, tw], [cx - bw / 2, by, bw]]) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(sx, sy, sw, sh)
    ctx.clip()
    table()
    ctx.restore()
  }
  // the ball, crossing the hinge on its way up
  const gy = ty + sh + 20
  for (let i = 5; i >= 1; i--) {
    ctx.fillStyle = `rgba(243,234,214,${0.5 - i * 0.08})`
    ctx.beginPath()
    ctx.arc(cx + 36 + i * 7, gy + i * 20, 13 - i * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }
  const bg = ctx.createRadialGradient(cx + 32, gy - 4, 2, cx + 36, gy, 15)
  bg.addColorStop(0, '#ffffff')
  bg.addColorStop(1, '#9aa0a8')
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.arc(cx + 36, gy, 15, 0, Math.PI * 2)
  ctx.fill()
}

function widescreen(ctx, p, x, y, w, h) {
  const sh = 420
  const sw = Math.round((sh * 16) / 9)
  const sx = x + (w - sw) / 2
  const sy = y + (h - sh) / 2
  ctx.fillStyle = '#121214'
  ctx.beginPath()
  ctx.roundRect(sx - 18, sy - 18, sw + 36, sh + 36, 22)
  ctx.fill()
  ctx.save()
  ctx.beginPath()
  ctx.rect(sx, sy, sw, sh)
  ctx.clip()
  const sky = ctx.createLinearGradient(0, sy, 0, sy + sh * 0.6)
  sky.addColorStop(0, '#6fb6e8')
  sky.addColorStop(1, '#d6eefc')
  ctx.fillStyle = sky
  ctx.fillRect(sx, sy, sw, sh)
  ctx.fillStyle = '#8fbf7a'
  ctx.beginPath()
  ctx.moveTo(sx, sy + sh)
  for (let i = 0; i <= 10; i++) ctx.lineTo(sx + (sw * i) / 10, sy + sh * (0.5 + ((i * 3) % 4) * 0.035))
  ctx.lineTo(sx + sw, sy + sh)
  ctx.fill()
  ctx.fillStyle = '#5c9a3e'
  ctx.fillRect(sx, sy + sh * 0.64, sw, sh * 0.36)
  ctx.fillStyle = '#c9b48a'
  ctx.beginPath()
  ctx.moveTo(sx + sw / 2 - 16, sy + sh * 0.64)
  ctx.lineTo(sx + sw / 2 + 16, sy + sh * 0.64)
  ctx.lineTo(sx + sw / 2 + 170, sy + sh)
  ctx.lineTo(sx + sw / 2 - 170, sy + sh)
  ctx.fill()
  // trees all the way out to the edges: the extra scenery the wide picture adds
  for (let i = 0; i < 9; i++) {
    const tx = sx + 40 + i * ((sw - 80) / 8)
    if (Math.abs(tx - (sx + sw / 2)) < 90) continue
    const s = 0.7 + ((i * 5) % 3) * 0.2
    const base = sy + sh * 0.72 + ((i * 7) % 3) * 14
    ctx.fillStyle = '#5a3d24'
    ctx.fillRect(tx - 6 * s, base - 30 * s, 12 * s, 30 * s)
    ctx.fillStyle = '#2f6b2f'
    ctx.beginPath()
    ctx.moveTo(tx, base - 130 * s)
    ctx.lineTo(tx + 44 * s, base - 26 * s)
    ctx.lineTo(tx - 44 * s, base - 26 * s)
    ctx.fill()
  }
  // where the DS picture used to stop, and the picture pushing out past it
  const ow = (sh * 4) / 3
  const ox = sx + (sw - ow) / 2
  ctx.setLineDash([16, 12])
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(ox, sy)
  ctx.lineTo(ox, sy + sh)
  ctx.moveTo(ox + ow, sy)
  ctx.lineTo(ox + ow, sy + sh)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  for (const [ax, d] of [[ox - 40, -1], [ox + ow + 40, 1]]) {
    ctx.beginPath()
    ctx.moveTo(ax + d * 22, sy + sh * 0.3)
    ctx.lineTo(ax - d * 10, sy + sh * 0.3 - 22)
    ctx.lineTo(ax - d * 10, sy + sh * 0.3 + 22)
    ctx.fill()
  }
  // the drawn LCD grid
  ctx.fillStyle = 'rgba(0,0,0,0.13)'
  for (let gx = sx; gx < sx + sw; gx += 7) ctx.fillRect(gx, sy, 1.5, sh)
  for (let gy = sy; gy < sy + sh; gy += 7) ctx.fillRect(sx, gy, sw, 1.5)
  ctx.restore()
}

const CART_ART = { pinball, widescreen }

export async function cartFront(p, shelf) {
  const { w, h } = LABEL
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const bg = pal.bg || '#141414'
  const accent = pal.accent || shelf.color
  const ink = pal.ink || CREAM
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // the brand strip every cartridge label has across the top
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, w, 74)
  ctx.fillStyle = INK
  ctx.font = `700 30px ${BODY}`
  ctx.textBaseline = 'middle'
  ctx.fillText('RYAN ZEGALIA PRESENTS', 36, 39)
  ctx.textAlign = 'right'
  ctx.fillText(`${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`, w - 36, 39)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  const artTop = 74
  const artH = 560
  const img = await loadImage(p.photoUrl)
  if (img && img.width / img.height < 0.9) {
    // a tall picture (two stacked screens) stands whole in the middle of a dark window, like the device
    ctx.fillStyle = '#0b0b0d'
    ctx.fillRect(0, artTop, w, artH)
    const ph = artH - 48
    const pw = Math.round((ph * img.width) / img.height)
    ctx.drawImage(img, Math.round((w - pw) / 2), artTop + 24, pw, ph)
  } else if (img) {
    // fill the window, keeping the subject centered; a screenshot's edges matter less on a label
    if (img.width / img.height > 2.2) {
      ctx.fillStyle = '#0b0b0d'
      ctx.fillRect(0, artTop, w, artH)
      ctx.drawImage(img, 0, artTop + 24, w, Math.round((w * img.height) / img.width))
    } else cover(ctx, img, 0, artTop, w, artH)
    const g = ctx.createLinearGradient(0, artTop + artH * 0.55, 0, artTop + artH)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, bg)
    ctx.fillStyle = g
    ctx.fillRect(0, artTop, w, artH)
  } else if (CART_ART[p.art]) {
    CART_ART[p.art](ctx, p, 0, artTop, w, artH, accent)
  } else {
    // no photo yet: a bold type treatment instead of fake art
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, artTop, w, artH)
    ctx.clip()
    ctx.globalAlpha = 0.14
    ctx.fillStyle = accent
    for (let i = -artH; i < w + artH; i += 56) {
      ctx.fillRect(i, artTop, 22, artH)
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = accent
    ctx.font = `900 520px ${TITLE}`
    ctx.textAlign = 'center'
    ctx.fillText(initial(p.title), w / 2, artTop + artH - 40)
    ctx.restore()
  }

  const title = p.title.toUpperCase()
  ctx.fillStyle = ink
  const ts = fit(ctx, title, TITLE, 900, w - 80, 150)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillText(title, 40, artTop + artH + Math.min(ts, 140) * 0.75)
  if (p.kicker) {
    const k = p.kicker.toUpperCase()
    ctx.font = `900 ${fit(ctx, k, TITLE, 900, w - 260, 64, 30)}px ${TITLE}`
    ctx.fillStyle = accent
    ctx.fillText(k, 42, artTop + artH + Math.min(ts, 140) * 0.75 + 70)
  }
  ratingBox(ctx, w - 190, h - 190, p.rating || 'B', p.ratingWord || 'Built', ink)
  ctx.fillStyle = 'rgba(243,234,214,0.7)'
  ctx.font = `600 24px ${BODY}`
  ctx.fillText(p.remix ? 'REMIXED AND RUN BY RYAN ZEGALIA' : 'BUILT AND RUN BY RYAN ZEGALIA', 42, h - 40)
  if (p.remix) {
    // off the photo, so it never lands on a screenshot's own words: left of the rating box, between
    // the kicker and the credit line
    const label = `REMIX OF ${p.remix.of.toUpperCase()}`
    ctx.font = `700 28px ${TYPE}`
    const sw = ctx.measureText(label).width + 36
    sticker(ctx, label, w - 220 - sw / 2, h - 100, 0.06, { bg: CREAM, size: 28 })
  }
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

export function cartBack(p, shelf) {
  return backCover(p, shelf, { w: 1024, h: 1180 }, { compact: true, short: true })
}

// The thin top edge, readable when carts lean in a rack.
export function cartTop(p, shelf) {
  const [c, ctx] = canvas(1024, 96)
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, 1024, 96)
  ctx.fillStyle = (p.palette && p.palette.accent) || shelf.color
  ctx.fillRect(0, 0, 110, 96)
  ctx.fillStyle = CREAM
  ctx.font = `900 56px ${TITLE}`
  ctx.textBaseline = 'middle'
  ctx.fillText(p.title.toUpperCase(), 140, 52)
  ctx.font = `700 30px ${TYPE}`
  ctx.fillStyle = INK
  ctx.fillText(String(p.order ?? 0).padStart(2, '0'), 30, 52)
  return toTexture(c)
}
