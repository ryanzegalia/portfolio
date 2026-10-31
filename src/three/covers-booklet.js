// The instruction booklet that comes out of a cartridge: a cover, numbered pages, a back cover.
// Pages read the same fields as the flat insert (Booklet.jsx). Each page shrinks its type to fit
// rather than run off the paper, the same way the case backs do.
import { canvas, toTexture, fit, wrap, grain, sticker, ratingBox, initial, loadImage, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { numbers } from '../projects.js'
import { SHELVES } from '../shelves.js'

export const PAGE = { w: 1000, h: 1400 }
export const PAPER = '#f2e7cf'
export const DIM = '#6b5f50'
export const M = 80 // page margin
const TOP = 150 // where the page body starts
const LIMIT = PAGE.h - 130 // the folio lives below this line

export const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`
export const tick = () => new Promise((r) => setTimeout(r))

// Which pages this booklet has, in order. Empty sections are skipped. A stapled booklet always has
// an even number of pages, so an odd count gets one more at the end ('notes'), printed as the plain
// inside of the back cover (insideBackTexture).
//
// The words of a page rarely fill it, so a page is set the way a printed manual is: the case's own
// screenshots (making.proof, in order) go onto the text pages they follow instead of waiting on a
// page of their own, and the tagline is pulled out as a quote where a page has room for it. Only
// what doesn't fit is left for the proof pages at the back. With no screenshot in the proof list,
// the cover photo is the one picture the manual has. Which page gets what is decided here, without
// fonts or images (App.jsx and Booklet3D.jsx count pages from this), by setting each candidate
// layout on a canvas stand-in that measures text from average letter widths.
const pullQuote = (p) => p.insertQuote || p.tagline
const planned = new WeakMap()
export function bookletPlan(p) {
  if (planned.has(p)) return planned.get(p)
  const mk = p.making || {}
  const text = [{ kind: 'what' }]
  if (mk.how?.length) text.push({ kind: 'how' })
  if (p.built?.length) text.push({ kind: 'built' })
  if (mk.broke?.length) text.push({ kind: 'broke' })
  const proof = mk.proof || []
  const figs = [...proof]
  if (!proof.some((x) => x.type === 'image') && p.photo) figs.push({ type: 'image', src: p.photo, plate: true })
  const shelf = SHELVES[p.shelf] || {}

  const build = (where, pull) => {
    const pages = text.map((pg, i) => ({ ...pg, extras: [...(pull === i ? [{ kind: 'pull' }] : []), ...figs.filter((_, j) => where[j] === i).map((item) => ({ kind: 'fig', item }))] }))
    const rest = proof.filter((x, j) => where[j] === LEFT)
    for (let i = 0; i < rest.length; i += 4) pages.push({ kind: 'proof', items: rest.slice(i, i + 4) })
    pages.push({ kind: 'credits' })
    if (pages.length % 2) pages.push({ kind: 'notes' })
    return pages
  }
  // how empty the pages of a layout are (the credits and notes pages are set either way), or
  // Infinity when something would have to shrink to fit
  const ghost = ghostCtx()
  const memo = {}
  const reach = (pg) => {
    const key = JSON.stringify([pg.kind, pg.items?.map((x) => x.src || x.text), pg.extras?.map((x) => x.kind + (x.item?.src || x.item?.text || ''))])
    return (memo[key] ??= drawPage(ghost, p, shelf, pg, 0, 1, GHOST_IMGS, () => {}))
  }
  const score = (pages) => {
    let s = 0
    for (const pg of pages) {
      if (pg.kind === 'credits' || pg.kind === 'notes') continue
      const y = reach(pg)
      // a page with pictures hands its spare room to them, so it ends at the limit by design: it is
      // only too full when even the smallest picture size doesn't fit
      if (y > (pg.extras?.some((x) => x.kind === 'fig') ? LIMIT : LIMIT - 16)) return Infinity
      const empty = Math.max(0, (LIMIT - y) / (LIMIT - TOP) - 0.1)
      s += empty * empty
    }
    return s + (pages.at(-1).kind === 'notes' ? 0.05 : 0)
  }

  // every way to hand the pictures out in reading order (a picture never lands before the one it
  // follows; whatever doesn't fit goes to the proof pages), the pull quote on any page or none
  const n = Math.min(figs.length, 4)
  // the plain layout (every picture on the proof pages at the back) unless a set one beats it
  const plain = build(figs.map((x) => (x.plate ? NONE : LEFT)), -1)
  let best = { s: score(plain), pages: plain }
  const choose = (j, from, where) => {
    if (j === n) {
      const full = [...where, ...figs.slice(n).map(() => LEFT)]
      for (let pull = -1; pull < text.length; pull++) {
        const pages = build(full, pullQuote(p) ? pull : -1)
        // the pull quote reads best on the first page, right under the reason the thing exists
        const s = score(pages) - (pull === 0 ? 0.01 : 0)
        if (s < best.s) best = { s, pages }
        if (!pullQuote(p)) break
      }
      return
    }
    for (let i = from; i < text.length; i++) choose(j + 1, i, [...where, i])
    // the cover photo stays on the cover when it doesn't fit, it is never a proof page of its own
    choose(j + 1, text.length, [...where, figs[j].plate ? NONE : LEFT])
  }
  choose(0, 0, [])
  const pages = best.pages
  planned.set(p, pages)
  return pages
}
const LEFT = -2 // for the proof pages at the back
const NONE = -3 // not shown inside
const GHOST_IMGS = new Proxy({}, { get: () => ({ width: 1600, height: 1000 }) })

// A canvas stand-in for planning: it draws nothing and measures text from each face's average
// letter width (measured on the site's own words), a little wide so a plan never overfills.
export function ghostCtx() {
  const g = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1 }
  for (const f of ['fillText', 'fillRect', 'strokeRect', 'beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke', 'drawImage', 'save', 'restore', 'translate', 'rotate']) g[f] = () => {}
  g.measureText = function (t) {
    const m = /(\d+)\s+(\d+(?:\.\d+)?)px\s+(.*)/.exec(this.font) || [0, 400, 40, '']
    const em = /Shoulders/.test(m[3]) ? 0.42 : /Courier/.test(m[3]) ? 0.6 : Number(m[1]) >= 600 ? 0.355 : 0.34
    return { width: t.length * Number(m[2]) * em * 1.04 }
  }
  return g
}

// Split text into the lines wrap() would draw, without drawing them.
export function lines(ctx, text, width) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > width && line) {
      out.push(line)
      line = word
    } else line = test
  }
  if (line) out.push(line)
  return out
}

// A screenshot as a framed still: scaled to fit the box, never cropped or stretched.
export function still(ctx, img, x, y, w, h, border = 10) {
  const s = Math.min((w - border * 2) / img.width, (h - border * 2) / img.height)
  const iw = img.width * s
  const ih = img.height * s
  const ix = x + (w - iw) / 2
  const iy = y + (h - ih) / 2
  ctx.fillStyle = 'rgba(0,0,0,0.2)'
  ctx.fillRect(ix - border + 5, iy - border + 7, iw + border * 2, ih + border * 2)
  ctx.fillStyle = '#fff'
  ctx.fillRect(ix - border, iy - border, iw + border * 2, ih + border * 2)
  ctx.drawImage(img, ix, iy, iw, ih)
}

// The booklet's own furniture: paper, the running head, and the folio on the outside corner.
function folio(ctx, p, shelf, i) {
  const { w, h } = PAGE
  const accent = (p.palette && p.palette.accent) || shelf.color
  const right = w - M
  const width = w - M * 2
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)

  // running head: which manual this is, over a rule in the cartridge's accent
  const head = `${p.title} · ${shelf.extras}`.toUpperCase()
  ctx.fillStyle = DIM
  ctx.font = `700 ${fit(ctx, head, TYPE, 700, width, 26, 18)}px ${TYPE}`
  ctx.fillText(head, M, 76)
  ctx.fillStyle = accent
  ctx.fillRect(M, 94, width, 6)

  // folio on the outside corner (left pages on the left), catalog number on the inside
  const left = i % 2 === 0
  ctx.fillStyle = INK
  ctx.fillRect(M, h - 112, width, 2)
  ctx.font = `900 48px ${TITLE}`
  ctx.textAlign = left ? 'left' : 'right'
  ctx.fillText(String(i + 1), left ? M : right, h - 52)
  ctx.font = `400 24px ${TYPE}`
  ctx.fillStyle = DIM
  ctx.textAlign = left ? 'right' : 'left'
  ctx.fillText(catalog(p, shelf), left ? right : M, h - 58)
  ctx.textAlign = 'left'
}

// One inside page at type scale k, on whatever paper `chrome` lays down. Returns how far down the
// content reached.
export function drawPage(ctx, p, shelf, pg, i, k, imgs, chrome) {
  chrome(ctx, p, shelf, i)
  const { w } = PAGE
  const px = (n) => Math.round(n * k)
  const accent = (p.palette && p.palette.accent) || shelf.color
  const mk = p.making || {}
  const right = w - M
  const width = w - M * 2
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  let y = TOP + px(76)
  const heading = (text, kicker) => {
    if (kicker) {
      ctx.font = `700 ${px(26)}px ${TYPE}`
      ctx.fillStyle = DIM
      ctx.fillText(kicker.toUpperCase(), M, y - px(84))
    }
    const t = text.toUpperCase()
    const size = fit(ctx, t, TITLE, 900, width, px(96), 40)
    ctx.fillStyle = INK
    ctx.font = `900 ${size}px ${TITLE}`
    ctx.fillText(t, M, y)
    // a short rule under the heading, never a bar down its left side
    ctx.fillStyle = accent
    ctx.fillRect(M, y + px(14), px(90), px(6))
    ctx.fillStyle = INK
    y += px(80)
  }
  const sub = (text) => {
    y += px(28)
    ctx.font = `900 ${px(56)}px ${TITLE}`
    ctx.fillStyle = INK
    y = wrap(ctx, text.toUpperCase(), M, y, width, px(58)) + px(6)
  }
  const label = (text) => {
    ctx.font = `700 ${px(26)}px ${TYPE}`
    ctx.fillStyle = DIM
    ctx.fillText(text.toUpperCase(), M, y)
    y += px(48)
  }
  const body = (text, { size = 46, weight = 400, x = M, wd = width, color = INK } = {}) => {
    ctx.font = `${weight} ${px(size)}px ${BODY}`
    ctx.fillStyle = color
    y = wrap(ctx, text, x, y, wd, px(size * 1.22))
  }

  if (pg.kind === 'what') {
    heading('What it is')
    body(p.what || '')
    if (mk.problem) {
      sub('Why it needed to exist')
      body(mk.problem)
    }
  } else if (pg.kind === 'how') {
    heading('How it works')
    const spread = px(pg.spread || 0)
    mk.how.forEach((step, n) => {
      // big numbered steps, the way manuals walk you through setup
      const r = px(46)
      const top = y - px(40)
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(M + r, top + r, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = INK
      ctx.font = `900 ${px(66)}px ${TITLE}`
      ctx.textAlign = 'center'
      ctx.fillText(String(n + 1), M + r, top + r + px(24))
      ctx.textAlign = 'left'
      const tx = M + r * 2 + px(30)
      body(step, { x: tx, wd: right - tx })
      const next = Math.max(y, top + r * 2 + px(50)) + px(30) + spread
      // when the steps are spaced out, a line walks down from one numbered circle to the next
      if (spread && n < mk.how.length - 1) {
        ctx.fillStyle = accent
        ctx.fillRect(M + r - px(3), top + r * 2, px(6), next - px(40) - (top + r * 2))
      }
      y = next
    })
  } else if (pg.kind === 'built') {
    heading('What I built')
    for (const b of p.built) {
      y += px(pg.spread || 0)
      ctx.fillStyle = accent
      ctx.fillRect(M, y - px(28), px(18), px(18))
      body(b, { size: 45, weight: 600, x: M + px(40), wd: width - px(40) })
      y += px(26)
    }
  } else if (pg.kind === 'broke') {
    // hard problems solved, not a list of breakdowns: a game manual's tips page, the tape's
    // behind-the-scenes "hard parts"
    if (shelf.media === 'vhs') heading('The hard parts')
    else heading('Hard parts, solved', 'Tips and tricks')
    for (const b of mk.broke) {
      // each story opens with a short rule over its title
      ctx.fillStyle = accent
      ctx.fillRect(M, y - px(62), px(56), px(5))
      ctx.font = `900 ${px(54)}px ${TITLE}`
      ctx.fillStyle = INK
      y = wrap(ctx, b.title.toUpperCase(), M, y, width, px(56)) + px(4)
      body(b.body, { size: 43, x: M, wd: width })
      y += px(34)
    }
  } else if (pg.kind === 'proof') {
    heading(shelf.proof || 'Proof')
    const items = pg.items
    const cols = items.length > 2 ? 2 : 1
    const gap = px(36)
    const cw = (width - gap * (cols - 1)) / cols
    const boxH = px(cols === 2 ? 300 : items.length === 1 ? 600 : 400)
    y -= px(34)
    for (let r = 0; r < items.length; r += cols) {
      let rowEnd = y
      items.slice(r, r + cols).forEach((x, j) => {
        const bx = M + j * (cw + gap)
        let cy = y
        if (x.type === 'image' && imgs[x.src]) {
          still(ctx, imgs[x.src], bx, y, cw, boxH)
          cy = y + boxH + px(44)
        } else if (x.text) {
          // an on-screen quote, drawn as a little screen
          ctx.font = `400 ${px(30)}px ${TYPE}`
          const ls = lines(ctx, x.text, cw - px(48))
          const bh = ls.length * px(38) + px(44)
          ctx.fillStyle = INK
          ctx.fillRect(bx, y, cw, bh)
          ctx.fillStyle = CREAM
          ls.forEach((l, n) => ctx.fillText(l, bx + px(24), y + px(50) + n * px(38)))
          cy = y + bh + px(44)
        }
        ctx.font = `400 ${px(36)}px ${BODY}`
        ctx.fillStyle = INK
        cy = wrap(ctx, x.caption || '', bx, cy, cw, px(42))
        rowEnd = Math.max(rowEnd, cy)
      })
      y = rowEnd + px(24)
    }
  } else if (pg.kind === 'credits') {
    heading('Credits')
    for (const line of mk.credits || ['Built by Ryan Zegalia']) body(line, { size: 44, weight: 600 })
    if (p.credit) body(p.credit, { size: 40, color: DIM })
    if (p.remix?.changed) {
      y += px(18)
      label('What I changed')
      body(p.remix.changed, { size: 40 })
    }

    // the real numbers, counted from the project's own history
    const { items, note } = numbers(p)
    const cells = items.filter(([kk]) => kk !== 'Status')
    const status = items.find(([kk]) => kk === 'Status')
    // no start date and no status: no empty box
    const boxed = cells.length > 0 || !!status?.[1]
    if (boxed) y += px(34)
    const boxTop = y - px(40)
    if (boxed) y += px(30)
    const cw = (width - px(40)) / 2
    for (let n = 0; n < cells.length; n += 2) {
      cells.slice(n, n + 2).forEach(([kk, v], j) => {
        const x = M + px(24) + j * cw
        ctx.font = `700 ${px(24)}px ${TYPE}`
        ctx.fillStyle = DIM
        ctx.fillText(kk.toUpperCase(), x, y)
        ctx.font = `900 ${px(54)}px ${TITLE}`
        ctx.fillStyle = INK
        ctx.fillText(v, x, y + px(56))
      })
      y += px(104)
    }
    if (status?.[1]) {
      ctx.font = `700 ${px(24)}px ${TYPE}`
      ctx.fillStyle = DIM
      ctx.fillText('STATUS', M + px(24), y)
      y += px(48)
      body(status[1], { size: 40, weight: 600, x: M + px(24), wd: width - px(48) })
    }
    if (boxed) {
      ctx.strokeStyle = INK
      ctx.lineWidth = 3
      ctx.strokeRect(M, boxTop, width, y - boxTop - px(22))
    }
    if (note) {
      y += px(10)
      body(note, { size: 32, color: DIM })
    }

    // what it's made with, as little tags
    if (p.requirements?.length) {
      y += px(26)
      label('Made with')
      ctx.font = `600 ${px(38)}px ${BODY}`
      const th = px(58)
      let x = M
      y += px(14)
      for (const t of p.requirements) {
        const tw = ctx.measureText(t).width + px(36)
        if (x + tw > right && x > M) {
          x = M
          y += th + px(14)
        }
        ctx.strokeStyle = INK
        ctx.lineWidth = 3
        ctx.strokeRect(x, y - th + px(14), tw, th)
        ctx.fillStyle = INK
        ctx.fillText(t, x + px(18), y)
        x += tw + px(14)
      }
      y += px(40)
    }
  } else if (pg.kind === 'notes') {
    heading('Notes')
    ctx.strokeStyle = 'rgba(23,18,14,0.22)'
    ctx.lineWidth = 2
    for (let ly = y + 20; ly < LIMIT - 20; ly += 72) {
      ctx.beginPath()
      ctx.moveTo(M, ly)
      ctx.lineTo(right, ly)
      ctx.stroke()
    }
  }
  if (pg.extras?.length) y = drawExtras(ctx, p, pg.extras, y, k, imgs, accent)
  return y
}

// What a text page carries under its words (bookletPlan decides which): the tagline as a pull
// quote between two rules, then the screenshots, each as a framed still with its caption. The
// stills share whatever room the page has left, never bigger than the picture wants at full
// width and never smaller than FIG_MIN, so a page is filled by its own pictures and nothing else.
const FIG_MIN = 270
function drawExtras(ctx, p, extras, y, k, imgs, accent) {
  const px = (n) => Math.round(n * k)
  const width = PAGE.w - M * 2
  const parts = []
  for (const ex of extras) {
    if (ex.kind === 'pull') {
      ctx.font = `900 ${px(60)}px ${TITLE}`
      const ls = lines(ctx, pullQuote(p).toUpperCase(), width - px(100))
      parts.push({ ex, ls, h: px(40) + px(78) + (ls.length - 1) * px(64) + px(40) })
      continue
    }
    const it = ex.item
    ctx.font = `400 ${px(36)}px ${BODY}`
    const cap = it.caption ? lines(ctx, it.caption, width) : []
    const capH = cap.length ? px(34) + cap.length * px(42) : 0
    if (it.type === 'image' && imgs[it.src]) {
      const img = imgs[it.src]
      const nat = Math.min(px(660), Math.round((width - 20) * img.height / img.width) + 20)
      parts.push({ ex, img, cap, capH, nat, h: px(40) + capH })
    } else if (it.text) {
      ctx.font = `400 ${px(30)}px ${TYPE}`
      const ls = lines(ctx, it.text, width - px(48))
      const bh = ls.length * px(38) + px(44)
      parts.push({ ex, ls, bh, cap, capH, h: px(40) + bh + capH })
    }
  }
  let top = y - px(24)
  const pics = parts.filter((x) => x.img)
  const room = LIMIT - px(16) - top - parts.reduce((s, x) => s + x.h, 0)
  // hand the room out evenly, then give what a small picture doesn't need to the others
  let left = room
  const sorted = [...pics].sort((a, b) => a.nat - b.nat)
  sorted.forEach((x, n) => {
    x.box = Math.max(px(FIG_MIN), Math.min(x.nat, Math.floor(left / (sorted.length - n))))
    left -= x.box
  })
  for (const x of parts) {
    top += px(40)
    if (x.ex.kind === 'pull') {
      ctx.fillStyle = accent
      ctx.fillRect(M, top, width, px(6))
      ctx.font = `900 ${px(150)}px ${TITLE}`
      ctx.fillText('\u201c', M - px(4), top + px(128))
      ctx.fillStyle = INK
      ctx.font = `900 ${px(60)}px ${TITLE}`
      x.ls.forEach((l, n) => ctx.fillText(l, M + px(100), top + px(78) + n * px(64)))
      const end = top + px(78) + (x.ls.length - 1) * px(64) + px(34)
      ctx.fillStyle = accent
      ctx.fillRect(M, end, width, px(6))
      top = end + px(6)
      continue
    }
    if (x.img) {
      still(ctx, x.img, M, top, width, x.box)
      top += x.box
    } else {
      ctx.fillStyle = INK
      ctx.fillRect(M, top, width, x.bh)
      ctx.fillStyle = CREAM
      ctx.font = `400 ${px(30)}px ${TYPE}`
      x.ls.forEach((l, n) => ctx.fillText(l, M + px(24), top + px(50) + n * px(38)))
      top += x.bh
    }
    if (x.cap.length) {
      ctx.font = `400 ${px(36)}px ${BODY}`
      ctx.fillStyle = INK
      x.cap.forEach((l, n) => ctx.fillText(l, M, top + px(34) + px(30) + n * px(42)))
      top += x.capH
    }
  }
  return top
}

// The leaflet draws the same pages on its own paper, so `chrome` and the name in the warning vary.
export function pageTexture(p, shelf, pg, i, imgs, chrome = folio, name = 'manual page') {
  const [c, ctx] = canvas(PAGE.w, PAGE.h)
  // a how or built page the pictures didn't reach is set a touch larger and its items spaced out
  // down the page, so it ends composed instead of half empty
  const spaced = (pg.kind === 'how' || pg.kind === 'built') && !pg.extras?.length
  let k = 1
  if (spaced && drawPage(ctx, p, shelf, pg, i, 1, imgs, chrome) < LIMIT * 0.82) {
    for (const up of [1.1, 1.05]) {
      if (drawPage(ctx, p, shelf, pg, i, up, imgs, chrome) <= LIMIT - 90) {
        k = up
        break
      }
    }
    const y = drawPage(ctx, p, shelf, pg, i, k, imgs, chrome)
    const gaps = pg.kind === 'how' ? p.making.how.length : p.built.length
    const spread = Math.min(70, Math.max(0, Math.floor((LIMIT - 70 - y) / gaps / k)))
    if (spread > 0) pg = { ...pg, spread }
  } else {
    // shrink the type until the page clears its footer
    for (; k >= 0.6; k -= 0.05) {
      if (drawPage(ctx, p, shelf, pg, i, k, imgs, chrome) <= LIMIT) break
    }
  }
  if (k < 0.72) console.warn(`[shelf] ${name} ${i + 1} of "${p.title}" had to shrink to ${Math.round(k * 100)}%: cut some words`)
  drawPage(ctx, p, shelf, pg, i, k, imgs, chrome)
  grain(ctx, PAGE.w, PAGE.h, 0.03)
  return toTexture(c)
}

// The front: drawn like the cartridge label, with the manual's band across it.
async function coverTexture(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const bg = pal.bg || '#141414'
  const accent = pal.accent || shelf.color
  const ink = pal.ink || CREAM
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.fillStyle = accent
  ctx.fillRect(0, 0, w, 96)
  ctx.fillStyle = INK
  ctx.font = `700 38px ${BODY}`
  ctx.textBaseline = 'middle'
  ctx.fillText('RYAN ZEGALIA PRESENTS', 52, 50)
  ctx.textAlign = 'right'
  ctx.fillText(catalog(p, shelf), w - 52, 50)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // the screenshot as a tilted framed still; no photo yet means the big letter, like the label
  const img = await loadImage(p.photoUrl)
  const art = { y: 150, w: w - 150, h: 600 }
  if (img) {
    ctx.save()
    ctx.translate(w / 2, art.y + art.h / 2)
    ctx.rotate(-0.035)
    still(ctx, img, -art.w / 2, -art.h / 2, art.w, art.h, 14)
    ctx.restore()
  } else {
    ctx.save()
    ctx.globalAlpha = 0.14
    ctx.fillStyle = accent
    for (let i = 0; i < w; i += 56) ctx.fillRect(i, art.y, 22, art.h)
    ctx.globalAlpha = 1
    ctx.font = `900 560px ${TITLE}`
    ctx.textAlign = 'center'
    ctx.fillText(initial(p.title), w / 2, art.y + art.h - 30)
    ctx.restore()
  }
  if (shelf.sticker) sticker(ctx, shelf.sticker, w - 200, 182, 0.08, { size: 28 })

  const title = p.title.toUpperCase()
  const ts = fit(ctx, title, TITLE, 900, w - 120, 150)
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.fillStyle = ink
  const ty = 805 + ts * 0.76
  ctx.fillText(title, 60, ty)
  if (p.kicker) {
    const kk = p.kicker.toUpperCase()
    ctx.font = `900 ${fit(ctx, kk, TITLE, 900, w - 120, 66, 30)}px ${TITLE}`
    ctx.fillStyle = accent
    ctx.fillText(kk, 62, ty + 76)
  }

  // the band every manual has
  const band = shelf.extras.toUpperCase()
  ctx.fillStyle = CREAM
  ctx.fillRect(0, 1046, w, 118)
  ctx.fillStyle = INK
  ctx.font = `900 ${fit(ctx, band, TITLE, 900, w - 120, 96)}px ${TITLE}`
  ctx.textAlign = 'center'
  ctx.fillText(band, w / 2, 1140)
  ctx.textAlign = 'left'

  ratingBox(ctx, w - 210, h - 205, p.rating || 'B', p.ratingWord || 'Built', ink)
  if (p.remix) sticker(ctx, `REMIX OF ${p.remix.of.toUpperCase()}`, 300, h - 150, -0.05, { bg: CREAM, size: 28 })
  ctx.fillStyle = 'rgba(243,234,214,0.75)'
  ctx.font = `600 30px ${BODY}`
  ctx.fillText(p.remix ? 'REMIXED AND RUN BY RYAN ZEGALIA' : 'BUILT AND RUN BY RYAN ZEGALIA', 60, h - 56)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

function backTexture(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  const ink = pal.ink || CREAM
  ctx.fillStyle = pal.bg || '#141414'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = pal.accent || shelf.color
  ctx.fillRect(0, h - 96, w, 96)
  ctx.textAlign = 'center'
  ctx.fillStyle = ink
  ctx.font = `900 ${fit(ctx, shelf.line.toUpperCase(), TITLE, 900, w - 160, 84)}px ${TITLE}`
  ctx.fillText(shelf.line.toUpperCase(), w / 2, 620)
  ctx.font = `700 34px ${BODY}`
  ctx.fillText('A RYAN ZEGALIA PRODUCTION', w / 2, 700)
  ctx.font = `400 28px ${TYPE}`
  ctx.fillText('Made at home. Runs at home.', w / 2, 750)
  ctx.fillStyle = INK
  ctx.font = `700 34px ${TYPE}`
  ctx.fillText(catalog(p, shelf), w / 2, h - 36)
  ctx.textAlign = 'left'
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// When the words end on a left-hand page, the right-hand one is the inside of the back cover: plain
// cover stock, the way a real manual ends, instead of a ruled page that says "Notes" and stays empty
// (Ryan, 2026-10-30: "it just feels weird that it's there").
function insideBackTexture(p, shelf) {
  const { w, h } = PAGE
  const [c, ctx] = canvas(w, h)
  const pal = p.palette || {}
  ctx.fillStyle = pal.bg || '#141414'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = pal.accent || shelf.color
  ctx.fillRect(0, h - 96, w, 96)
  grain(ctx, w, h, 0.05)
  return toTexture(c)
}

// The screenshots a set of pages shows, loaded once.
export async function proofImages(p, plan) {
  const items = (pg) => [...(pg.items || []), ...(pg.extras || []).map((x) => x.item).filter(Boolean)]
  const srcs = new Set(plan.flatMap((pg) => items(pg).filter((x) => x.type === 'image').map((x) => x.src)))
  const imgs = {}
  await Promise.all([...srcs].map(async (s) => (imgs[s] = await loadImage(p.img(s)))))
  return imgs
}

// Everything the booklet shows, drawn once. Yields between pages so the cartridge keeps moving.
export async function bookletTextures(p, shelf) {
  const plan = bookletPlan(p)
  const imgs = await proofImages(p, plan)
  const cover = await coverTexture(p, shelf)
  const pages = []
  for (let i = 0; i < plan.length; i++) {
    await tick()
    pages.push(plan[i].kind === 'notes' ? insideBackTexture(p, shelf) : pageTexture(p, shelf, plan[i], i, imgs))
  }
  return { cover, back: backTexture(p, shelf), pages }
}
