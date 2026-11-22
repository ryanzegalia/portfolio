// Draws VHS sleeve art (front, back, spine) from a project's data onto canvases.
// The same data drives every media type; each media gets its own drawing set.
import * as THREE from 'three'

export const FRONT = { w: 1024, h: 1824 }
export const SPINE = { w: 256, h: 1824 }

const TITLE = '"Big Shoulders Display"'
const BODY = '"Barlow Condensed"'
const TYPE = '"Courier Prime"'
const CREAM = '#f3ead6'
const INK = '#17120e'

const imageCache = new Map()
export function loadImage(url) {
  if (!url) return Promise.resolve(null)
  if (!imageCache.has(url)) {
    imageCache.set(
      url,
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
        img.src = url
      }),
    )
  }
  return imageCache.get(url)
}

// Every printed surface is drawn once, read back by grain() and handed to WebGL, so it lives in memory
// ({ willReadFrequently: true }) rather than on the graphics card: on Chrome's OpenGL path big card-side
// canvases (the README sheet, the gatefold faces) came back blank and printed black.
function canvas(w, h, opts = { willReadFrequently: true }) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d', opts)]
}

function toTexture(c) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

// Largest font size (up to max) at which text fits in width.
function fit(ctx, text, family, weight, width, max, min = 20) {
  let size = max
  while (size > min) {
    ctx.font = `${weight} ${size}px ${family}`
    if (ctx.measureText(text).width <= width) break
    size -= 4
  }
  return size
}

function wrap(ctx, text, x, y, width, lineHeight) {
  const words = text.split(' ')
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > width && line) {
      ctx.fillText(line, x, y)
      line = word
      y += lineHeight
    } else line = test
  }
  if (line) ctx.fillText(line, x, y)
  return y + lineHeight
}

function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height)
  const iw = img.width * s
  const ih = img.height * s
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih)
  ctx.restore()
}

function grain(ctx, w, h, amount = 0.06) {
  const d = ctx.getImageData(0, 0, w, h)
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * amount
    d.data[i] += n
    d.data[i + 1] += n
    d.data[i + 2] += n
  }
  ctx.putImageData(d, 0, 0)
}

function sticker(ctx, text, x, y, angle, { bg = '#f2d64b', fg = INK, size = 34, pad = 18 } = {}) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.font = `700 ${size}px ${TYPE}`
  const w = ctx.measureText(text).width + pad * 2
  const h = size + pad * 1.4
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(-w / 2 + 4, -h / 2 + 5, w, h)
  ctx.fillStyle = bg
  ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, 2)
  ctx.restore()
}

function ratingBox(ctx, x, y, letter, word, fg) {
  ctx.save()
  ctx.strokeStyle = fg
  ctx.fillStyle = fg
  ctx.lineWidth = 5
  ctx.strokeRect(x, y, 150, 150)
  ctx.textAlign = 'center'
  ctx.font = `700 26px ${BODY}`
  ctx.fillText('RATED', x + 75, y + 32)
  ctx.font = `900 86px ${TITLE}`
  ctx.fillText(letter, x + 75, y + 112)
  ctx.font = `700 22px ${BODY}`
  ctx.fillText(`FOR ${word.toUpperCase()}`, x + 75, y + 140)
  ctx.restore()
}

function barcode(ctx, x, y, w, h, seed) {
  ctx.fillStyle = '#fff'
  ctx.fillRect(x - 12, y - 12, w + 24, h + 50)
  ctx.fillStyle = INK
  let px = x
  let r = seed
  while (px < x + w) {
    r = (r * 9301 + 49297) % 233280
    const bw = 2 + (r % 4) * 2
    if ((r >> 3) % 2) ctx.fillRect(px, y, bw, h)
    px += bw + 2
  }
  ctx.font = `400 22px ${TYPE}`
  ctx.textAlign = 'center'
  ctx.fillText(`0 ${String(seed).padStart(5, '0')} 26031 9`, x + w / 2, y + h + 26)
  ctx.textAlign = 'left'
}

// The big letter a cover shows when there's no photo yet: "The Home Server" gets an H, not a T.
const initial = (title) => title.replace(/^the\s+/i, '')[0].toUpperCase()

function hash(s) {
  let h = 7
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 99991
  return h
}

// Procedural cover art for projects with no photo yet.
function drawArt(ctx, kind, x, y, w, h, accent) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  if (kind === 'spotlights') {
    for (let i = 0; i < 5; i++) {
      const sx = x + w * (0.1 + i * 0.2)
      const g = ctx.createLinearGradient(sx, y, sx, y + h)
      g.addColorStop(0, 'rgba(255,240,200,0.55)')
      g.addColorStop(1, 'rgba(255,240,200,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(sx - 18, y)
      ctx.lineTo(sx + 18, y)
      ctx.lineTo(x + w / 2 + (i - 2) * 120 + 90, y + h)
      ctx.lineTo(x + w / 2 + (i - 2) * 120 - 90, y + h)
      ctx.fill()
    }
    // the mob: a hundred heads in rows
    ctx.fillStyle = 'rgba(0,0,0,0.85)'
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 20; col++) {
        const cx = x + 30 + col * ((w - 60) / 19) + (row % 2) * 16
        const cy = y + h * 0.62 + row * 70
        ctx.beginPath()
        ctx.arc(cx, cy, 20, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillRect(cx - 26, cy + 18, 52, 60)
      }
    }
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(x + w / 2, y + h * 0.5, 34, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(x + w / 2 - 40, y + h * 0.5 + 30, 80, 120)
  } else if (kind === 'trophy') {
    const cx = x + w / 2
    const cy = y + h * 0.48
    for (let i = 0; i < 24; i++) {
      ctx.strokeStyle = i % 2 ? 'rgba(233,162,59,0.18)' : 'rgba(233,162,59,0.06)'
      ctx.lineWidth = 60
      ctx.beginPath()
      const a = (i / 24) * Math.PI * 2
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * 1400, cy + Math.sin(a) * 1400)
      ctx.stroke()
    }
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.moveTo(cx - 170, cy - 200)
    ctx.lineTo(cx + 170, cy - 200)
    ctx.quadraticCurveTo(cx + 160, cy + 40, cx + 30, cy + 70)
    ctx.lineTo(cx + 30, cy + 150)
    ctx.lineTo(cx + 110, cy + 170)
    ctx.lineTo(cx + 110, cy + 210)
    ctx.lineTo(cx - 110, cy + 210)
    ctx.lineTo(cx - 110, cy + 170)
    ctx.lineTo(cx - 30, cy + 150)
    ctx.lineTo(cx - 30, cy + 70)
    ctx.quadraticCurveTo(cx - 160, cy + 40, cx - 170, cy - 200)
    ctx.fill()
    ctx.lineWidth = 26
    ctx.strokeStyle = accent
    ctx.beginPath()
    ctx.arc(cx - 175, cy - 110, 70, Math.PI * 0.5, Math.PI * 1.5)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx + 175, cy - 110, 70, -Math.PI * 0.5, Math.PI * 0.5)
    ctx.stroke()
    // a little plane, because it unlocks on a plane
    ctx.fillStyle = CREAM
    ctx.save()
    ctx.translate(x + w * 0.78, y + h * 0.14)
    ctx.rotate(-0.35)
    ctx.fillRect(-90, -10, 180, 20)
    ctx.fillRect(-20, -70, 34, 140)
    ctx.fillRect(-90, -34, 22, 68)
    ctx.restore()
  } else if (kind === 'unlock') {
    // the pop-up the handheld shows when you earn one, over a dimmed game; nothing from a real game
    const sky = ctx.createLinearGradient(0, y, 0, y + h)
    sky.addColorStop(0, '#22304d')
    sky.addColorStop(1, '#0b0f18')
    ctx.fillStyle = sky
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = '#1a2640'
    ctx.beginPath()
    ctx.moveTo(x, y + h)
    for (let i = 0; i <= 8; i++) ctx.lineTo(x + (w * i) / 8, y + h * (0.52 + ((i * 7) % 5) * 0.03))
    ctx.lineTo(x + w, y + h)
    ctx.fill()
    ctx.fillStyle = '#26365a'
    ctx.fillRect(x, y + h * 0.8, w, h * 0.2)
    for (const [bx, by] of [[0.1, 0.6], [0.17, 0.6], [0.64, 0.68], [0.71, 0.68], [0.78, 0.68]]) ctx.fillRect(x + w * bx, y + h * by, w * 0.07, w * 0.07)
    ctx.fillStyle = '#34497a'
    ctx.fillRect(x + w * 0.32, y + h * 0.8 - 96, 46, 96)
    ctx.beginPath()
    ctx.arc(x + w * 0.32 + 23, y + h * 0.8 - 122, 28, 0, Math.PI * 2)
    ctx.fill()
    // earned with no internet: a plane overhead
    ctx.fillStyle = 'rgba(243,234,214,0.55)'
    ctx.save()
    ctx.translate(x + w * 0.8, y + h * 0.12)
    ctx.rotate(-0.25)
    ctx.fillRect(-80, -9, 160, 18)
    ctx.fillRect(-18, -62, 30, 124)
    ctx.fillRect(-80, -30, 20, 60)
    ctx.restore()
    const pw = Math.round(w * 0.82)
    const ph = 196
    const px = x + (w - pw) / 2
    const py = y + h * 0.3
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.beginPath()
    ctx.roundRect(px + 8, py + 14, pw, ph, 20)
    ctx.fill()
    ctx.fillStyle = '#1d2531'
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, 20)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 3
    ctx.stroke()
    const bs = ph - 52
    const bx = px + 26
    const by = py + 26
    const badge = ctx.createLinearGradient(bx, by, bx + bs, by + bs)
    badge.addColorStop(0, '#ffe39a')
    badge.addColorStop(1, accent)
    ctx.fillStyle = badge
    ctx.beginPath()
    ctx.roundRect(bx, by, bs, bs, 16)
    ctx.fill()
    ctx.fillStyle = INK
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      const r = i % 2 ? bs * 0.15 : bs * 0.34
      ctx.lineTo(bx + bs / 2 + Math.cos(a) * r, by + bs / 2 + 4 + Math.sin(a) * r)
    }
    ctx.closePath()
    ctx.fill()
    const tx = bx + bs + 30
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = CREAM
    ctx.font = `700 42px ${BODY}`
    ctx.fillText('ACHIEVEMENT UNLOCKED', tx, py + 74)
    ctx.fillStyle = 'rgba(243,234,214,0.32)'
    ctx.fillRect(tx, py + 102, pw * 0.4, 20)
    ctx.fillRect(tx, py + 136, pw * 0.28, 16)
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.roundRect(px + pw - 168, py + 24, 142, 44, 22)
    ctx.fill()
    ctx.fillStyle = INK
    ctx.font = `700 26px ${TYPE}`
    ctx.textAlign = 'center'
    ctx.fillText('OFFLINE', px + pw - 97, py + 55)
    ctx.textAlign = 'left'
  }
  ctx.restore()
}

export async function vhsFront(p, shelf) {
  const { w, h } = FRONT
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const bg = pal.bg || '#141414'
  const accent = pal.accent || shelf.color
  const ink = pal.ink || CREAM
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // distributor band
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, 96)
  ctx.fillStyle = shelf.color
  ctx.fillRect(0, 96, w, 10)
  ctx.fillStyle = CREAM
  ctx.font = `700 34px ${BODY}`
  ctx.textBaseline = 'middle'
  ctx.fillText('RYAN ZEGALIA PRESENTS', 48, 50)
  ctx.textAlign = 'right'
  ctx.fillText(shelf.name.toUpperCase(), w - 48, 50)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  const artTop = 106
  const artH = 1150
  const img = await loadImage(p.photoUrl)
  if (img) {
    // screenshots are wide, so they go on as a tilted framed still over a loud backdrop
    const glow = ctx.createRadialGradient(w / 2, artTop + artH * 0.42, 40, w / 2, artTop + artH * 0.42, w)
    glow.addColorStop(0, accent)
    glow.addColorStop(1, bg)
    ctx.globalAlpha = 0.55
    ctx.fillStyle = glow
    ctx.fillRect(0, artTop, w, artH)
    ctx.globalAlpha = 0.12
    ctx.fillStyle = INK
    for (let i = -h; i < w + h; i += 70) {
      ctx.beginPath()
      ctx.moveTo(i, artTop)
      ctx.lineTo(i + 34, artTop)
      ctx.lineTo(i + 34 - artH * 0.6, artTop + artH)
      ctx.lineTo(i - artH * 0.6, artTop + artH)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    const sw = w - 150
    const sh = Math.round((sw * img.height) / img.width)
    ctx.save()
    ctx.translate(w / 2, artTop + 120 + sh / 2)
    ctx.rotate(-0.04)
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetY = 18
    ctx.fillStyle = '#f7f2e6'
    ctx.fillRect(-sw / 2 - 16, -sh / 2 - 16, sw + 32, sh + 70)
    ctx.shadowColor = 'transparent'
    cover(ctx, img, -sw / 2, -sh / 2, sw, sh)
    ctx.fillStyle = INK
    ctx.font = `400 26px ${TYPE}`
    ctx.fillText('ACTUAL SCREENSHOT', -sw / 2, sh / 2 + 40)
    ctx.restore()
    const g = ctx.createLinearGradient(0, artTop + artH * 0.7, 0, artTop + artH)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, bg)
    ctx.fillStyle = g
    ctx.fillRect(0, artTop, w, artH)
  } else {
    drawArt(ctx, p.art, 0, artTop, w, artH, accent)
    const g = ctx.createLinearGradient(0, artTop + artH * 0.6, 0, artTop + artH)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, bg)
    ctx.fillStyle = g
    ctx.fillRect(0, artTop, w, artH)
  }

  // title block
  const title = p.title.toUpperCase()
  ctx.fillStyle = ink
  const ts = fit(ctx, title, TITLE, 900, w - 110, 250)
  ctx.font = `900 ${ts}px ${TITLE}`
  const ty = 1250 + Math.min(ts, 220) * 0.55
  ctx.fillText(title, 55, ty)
  if (p.kicker) {
    const k = p.kicker.toUpperCase()
    const ks = fit(ctx, k, TITLE, 900, w - 110, 120, 40)
    ctx.font = `900 ${ks}px ${TITLE}`
    ctx.fillStyle = accent
    ctx.fillText(k, 55, ty + ks * 0.95 + 6)
  }
  ctx.fillStyle = ink
  ctx.font = `600 46px ${BODY}`
  wrap(ctx, p.tagline, 58, 1640, w - 120, 54)
  ctx.fillStyle = 'rgba(243,234,214,0.7)'
  ctx.font = `600 26px ${BODY}`
  ctx.textAlign = 'center'
  const credit = p.remix ? 'REMIXED AND RUN BY RYAN ZEGALIA' : 'BUILT AND RUN BY RYAN ZEGALIA'
  ctx.fillText(credit.split('').join(String.fromCharCode(8202)), w / 2, h - 96)
  ctx.textAlign = 'left'

  // footer
  ctx.fillStyle = INK
  ctx.fillRect(0, h - 70, w, 70)
  ctx.fillStyle = CREAM
  ctx.font = `700 28px ${BODY}`
  ctx.textBaseline = 'middle'
  ctx.fillText(`${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`, 48, h - 35)
  ctx.textAlign = 'right'
  ctx.fillText(p.status ? p.status.toUpperCase() : '', w - 48, h - 35)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  if (p.remix) {
    // above the title, in the faded foot of the art, so it never sits on the picture
    const label = `REMIX OF ${p.remix.of.toUpperCase()}`
    ctx.font = `700 30px ${TYPE}`
    sticker(ctx, label, w - 60 - (ctx.measureText(label).width + 36) / 2, 1172, -0.04, { bg: CREAM, size: 30 })
  } else if (p.status === 'Now filming') sticker(ctx, 'COMING SOON', w - 200, 190, 0.1)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

export async function vhsBack(p, shelf) {
  return backCover(p, shelf, FRONT, { short: true })
}

// A short cut across a list: n entries picked evenly from the first to the last, so a back shows the
// spread of the work (the insert has every line).
export function spread(list, n) {
  const all = list || []
  if (n >= all.length) return all
  return Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, n - 1))])
}

export async function backCover(p, shelf, { w, h }, { compact = false, photo = true, short = false } = {}) {
  const [c, ctx] = canvas(w, h)
  const img = await loadImage(p.photoUrl)
  const limit = h - 270
  // shrink the type until everything clears the bottom strip
  let k = 1
  if (short) {
    // the pitch, a short cut of what I built and a spec box, set large: start big, shrink the type a
    // little, then let the starring row go (the insert has all of it)
    const opts = { shown: Math.min(3, (p.built || []).length), starring: true }
    k = 1.2
    for (;;) {
      if (drawBackBody(ctx, p, shelf, compact || !photo ? null : img, k, w, h, compact, opts) <= limit) break
      if (k > 0.92) k -= 0.04
      else if (opts.starring) opts.starring = false
      else if (k > 0.72) k -= 0.04
      else break
    }
  } else {
    for (k = 1; k >= 0.6; k -= 0.06) {
      if (drawBackBody(ctx, p, shelf, compact || !photo ? null : img, k, w, h, compact) <= limit) break
    }
  }
  if (k < 0.72) console.warn(`[shelf] back of "${p.title}" had to shrink to ${Math.round(k * 100)}%: cut some words`)
  const m = 60
  const by = h - 230
  ratingBox(ctx, m, by, p.rating || 'B', p.ratingWord || 'Built', INK)
  barcode(ctx, w - m - 300, by + 20, 300, 90, hash(p.slug))
  ctx.font = `700 26px ${BODY}`
  ctx.fillStyle = INK
  ctx.fillText('A RYAN ZEGALIA PRODUCTION', m + 180, by + 60)
  ctx.font = `400 22px ${TYPE}`
  ctx.fillText('Made at home. Runs at home.', m + 180, by + 96)
  // the shelf's sticker sits in the gap between the credit and the barcode, covering neither; a back
  // too narrow for that gets it under the rating box instead
  const label = shelf.sticker || 'BE KIND, REWIND'
  ctx.font = `700 30px ${TYPE}`
  const sw = ctx.measureText(label).width + 36
  const left = m + 166
  const right = w - m - 328
  if (sw <= right - left) sticker(ctx, label, (left + right) / 2, by + 162, -0.06, { size: 30 })
  else sticker(ctx, label, w / 2, by + 190, -0.06, { size: 30 })
  grain(ctx, w, h, 0.035)
  return toTexture(c)
}

function drawBackBody(ctx, p, shelf, img, k, w, h, compact = false, short = null) {
  const accent = (p.palette && p.palette.accent) || shelf.color
  const px = (n) => Math.round(n * k)
  ctx.fillStyle = CREAM
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, 18)
  ctx.fillStyle = shelf.color
  ctx.fillRect(0, 18, w, 8)

  const m = 60
  let y = 60 + px(84)
  ctx.fillStyle = INK
  ctx.font = `900 ${fit(ctx, p.title.toUpperCase(), TITLE, 900, w - m * 2, px(120))}px ${TITLE}`
  ctx.fillText(p.title.toUpperCase(), m, y)
  y += px(62)
  ctx.font = `700 ${px(short ? 50 : 42)}px ${BODY}`
  y = wrap(ctx, p.tagline, m, y, w - m * 2, px(short ? 56 : 48)) + px(short ? 22 : 8)

  if (img) {
    const sh = short ? Math.round(250 * Math.min(k, 1)) : px(380)
    ctx.fillStyle = '#fff'
    ctx.fillRect(m - 10, y - 10, w - m * 2 + 20, sh + 20)
    cover(ctx, img, m, y, w - m * 2, sh)
    y += sh + px(56)
  } else y += px(18)

  // a short rule under each heading, never a bar down its left side
  const heading = (text) => {
    ctx.fillStyle = INK
    ctx.font = `900 ${px(44)}px ${TITLE}`
    ctx.fillText(text, m, y)
    ctx.fillStyle = accent
    ctx.fillRect(m, y + px(8), px(56), px(5))
    ctx.fillStyle = INK
    y += px(50)
  }

  if (short) {
    // the pitch is the tagline above; this is a short, different cut of what I built
    heading("WHAT'S INSIDE")
    ctx.font = `600 ${px(36)}px ${BODY}`
    const all = p.built || []
    const cut = spread(all, short.shown)
    for (const f of cut) {
      ctx.fillStyle = accent
      ctx.fillText('•', m + 4, y)
      ctx.fillStyle = INK
      y = wrap(ctx, f, m + 38, y, w - m * 2 - 44, px(43)) + px(8)
    }
    if (all.length > cut.length) {
      ctx.font = `italic 600 ${px(30)}px ${BODY}`
      ctx.fillStyle = '#6b5f50'
      ctx.fillText(`...and ${all.length - cut.length} more inside.`, m + 38, y)
      y += px(36)
    }
    y += px(14)
  } else {
    heading('WHAT IT IS')
    ctx.font = `400 ${px(37)}px ${BODY}`
    y = wrap(ctx, p.what || '', m, y, w - m * 2, px(45)) + px(22)
  }

  if (!compact && !short) {
    heading('WHAT I BUILT')
    ctx.font = `600 ${px(35)}px ${BODY}`
    for (const f of p.built || []) {
      ctx.fillText('•', m + 4, y)
      y = wrap(ctx, f, m + 34, y, w - m * 2 - 40, px(41)) + px(5)
    }
    y += px(16)
  }

  const rows = [
    ['MY PART', p.credit],
    ['STARRING', short && !short.starring ? '' : p.starring],
    ['STATUS', p.progress && !short ? `${p.status}. ${p.progress}` : p.status],
    ['SYSTEM REQUIREMENTS', (p.requirements || []).join(' · ')],
  ]
  ctx.strokeStyle = INK
  ctx.lineWidth = 3
  const boxTop = y
  y += px(40)
  for (const [label, value] of rows) {
    if (!value) continue
    ctx.font = `700 ${px(24)}px ${BODY}`
    ctx.fillStyle = '#6b5f50'
    ctx.fillText(label, m + 20, y)
    y += px(32)
    ctx.font = `600 ${px(short ? 34 : 31)}px ${BODY}`
    ctx.fillStyle = INK
    y = wrap(ctx, value, m + 20, y, w - m * 2 - 40, px(short ? 40 : 37)) + px(10)
  }
  ctx.strokeRect(m, boxTop, w - m * 2, y - boxTop - px(8))
  return y
}

export function vhsSpine(p, shelf) {
  const { w, h } = SPINE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, h)
  // rental-store label at the top
  ctx.fillStyle = shelf.color
  ctx.fillRect(10, 18, w - 20, 150)
  ctx.fillStyle = CREAM
  ctx.font = `900 46px ${TITLE}`
  ctx.textAlign = 'center'
  ctx.fillText(shelf.code, w / 2, 82)
  ctx.font = `700 40px ${BODY}`
  ctx.fillText(String(p.order ?? 0).padStart(2, '0'), w / 2, 140)
  // title reads top to bottom
  ctx.save()
  ctx.translate(w / 2, 220)
  ctx.rotate(Math.PI / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const title = p.title.toUpperCase()
  // the kicker rides in a smaller line beside the title on every spine, so long and short titles
  // keep the same size and every spine reads the same way (Ryan, 2026-10-30)
  const k = p.kicker ? p.kicker.toUpperCase() : ''
  const ts = fit(ctx, title, TITLE, 900, 1050, 150, 40)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillStyle = pal.ink || CREAM
  ctx.fillText(title, 0, k ? -24 : 4)
  if (k) {
    let ks = 36
    for (; ks > 26; ks -= 2) {
      ctx.font = `700 ${ks}px ${BODY}`
      if (ctx.measureText(k).width <= 1500) break
    }
    ctx.fillStyle = pal.accent || shelf.color
    ctx.fillText(k, 4, 74)
  }
  ctx.restore()
  ctx.fillStyle = CREAM
  ctx.font = `700 30px ${BODY}`
  ctx.textAlign = 'center'
  ctx.fillText('RZ', w / 2, h - 40)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// The shelf's enamel sign.
export function signTexture(shelf) {
  const [c, ctx] = canvas(1400, 300)
  ctx.fillStyle = '#efe5cc'
  ctx.beginPath()
  ctx.roundRect(8, 8, 1384, 284, 34)
  ctx.fill()
  ctx.strokeStyle = INK
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.roundRect(30, 30, 1340, 240, 24)
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.font = `900 120px ${TITLE}`
  ctx.fillText(shelf.name.toUpperCase(), 700, 160)
  ctx.font = `600 52px ${BODY}`
  ctx.fillStyle = '#7a3324'
  ctx.fillText(shelf.line, 700, 234)
  for (const x of [70, 1330]) {
    ctx.fillStyle = '#9a9184'
    ctx.beginPath()
    ctx.arc(x, 150, 14, 0, Math.PI * 2)
    ctx.fill()
  }
  grain(ctx, 1400, 300, 0.05)
  return toTexture(c)
}

// Wood grain for the shelf boards.
export function woodTexture(base = [92, 58, 34], seed = 3) {
  const [c, ctx] = canvas(1024, 256)
  ctx.fillStyle = `rgb(${base.join(',')})`
  ctx.fillRect(0, 0, 1024, 256)
  let r = seed
  for (let i = 0; i < 90; i++) {
    r = (r * 9301 + 49297) % 233280
    const y = (r / 233280) * 256
    const dark = (r % 3) * 0.05 + 0.04
    ctx.strokeStyle = `rgba(30,16,8,${dark})`
    ctx.lineWidth = 1 + (r % 4)
    ctx.beginPath()
    ctx.moveTo(0, y)
    for (let x = 0; x <= 1024; x += 64) ctx.lineTo(x, y + Math.sin(x / 140 + i) * 6)
    ctx.stroke()
  }
  grain(ctx, 1024, 256, 0.08)
  const t = toTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

export { canvas, toTexture, fit, wrap, cover, grain, sticker, ratingBox, barcode, hash, initial, drawArt, TITLE, BODY, TYPE, CREAM, INK }
