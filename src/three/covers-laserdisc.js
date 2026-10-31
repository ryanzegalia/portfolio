// Draws the AI workstation shelf's LaserDisc special editions: the 12-inch jacket (front, back,
// spine) and the gatefold that opens out of it. The Walkthrough's gatefold is a triple fold with
// the journey drawn as one line map across all three panels; the other cases fold out to two.
import { canvas, toTexture, fit, wrap, grain, barcode, ratingBox, hash, TITLE, BODY, TYPE, CREAM, INK } from './covers.js'
import { PAPER, DIM, lines } from './covers-booklet.js'

// One unit is 100 mm, a little bigger than life like the other media so the jacket reads.
export const LD = { s: 2.05, t: 0.07 }
export const FACE = 1200
// where the journey's line runs on the gatefold, in panel pixels: Gatefold3D draws it live there
export const MAP = { y: 214, r: 49, thick: 22 }
const GOLD = '#e0b04a'
const GOLD_DK = '#9a7426'
const NIGHT = '#0f1b22'

const catalog = (p, shelf) => `${shelf.code}-${String(p.order ?? 0).padStart(2, '0')}`

function text(ctx, s, x, y, size, color = INK, weight = 600, family = BODY, align = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = align
  ctx.fillText(s, x, y)
  ctx.textAlign = 'left'
}

// Gold foil: a band of light running across the letters.
function foil(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h)
  g.addColorStop(0, GOLD_DK)
  g.addColorStop(0.35, '#f6dc8e')
  g.addColorStop(0.55, GOLD)
  g.addColorStop(1, GOLD_DK)
  return g
}

// Stars over the city: count of them scattered across the top of the area. Returns the seed so the
// skyline after it carries on from the same sequence.
function stars(ctx, r, w, top, h, count) {
  ctx.fillStyle = 'rgba(255,240,210,0.7)'
  for (let i = 0; i < count; i++) {
    r = (r * 9301 + 49297) % 233280
    const x = (r / 233280) * w
    r = (r * 9301 + 49297) % 233280
    const y = top + (r / 233280) * h
    ctx.fillRect(x, y, 2 + (r % 3), 2 + (r % 3))
  }
  return r
}

// A row of buildings standing on base, a few windows lit; scale shrinks it for the gatefold's band.
function skyline(ctx, r, w, base, tall, scale = 1) {
  ctx.fillStyle = '#071015'
  let x = 0
  while (x < w) {
    r = (r * 9301 + 49297) % 233280
    const bw = (40 + (r % 90)) * scale
    const bh = (90 + (r % tall)) * scale
    ctx.fillRect(x, base - bh, bw, bh + 2000)
    ctx.fillStyle = 'rgba(240,200,110,0.55)'
    for (let wy = base - bh + 16 * scale; wy < base - 24 * scale; wy += 28 * scale) for (let wx = x + 10 * scale; wx < x + bw - 12 * scale; wx += 22 * scale) if ((Math.round(wx) * Math.round(wy) + r) % 7 < 2) ctx.fillRect(wx, wy, 8 * scale, 12 * scale)
    ctx.fillStyle = '#071015'
    x += bw + 6 * scale
  }
  return r
}

// ---- the front covers ------------------------------------------------------------------------
// Every jacket's front shows the thing itself: the name, the plain line, and one drawn picture of
// what the case is. Each picture is drawn in its own w x h box (top left 0, 0) and scaled to fill
// the space the title and the line leave free. Keyed like the moments, by the case's scene type.

// the jacket's sky: the case's own colour fading to night, a scatter of stars, dark corners
function coverSky(ctx, p, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, (p.palette && p.palette.bg) || NIGHT)
  sky.addColorStop(1, '#05080b')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)
  stars(ctx, hash(p.slug || p.title), w, 90, h * 0.8, 70)
  const v = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.3, w / 2, h * 0.55, w * 0.78)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

// a rubber stamp, tilted, centred on 0, 0 after the caller's translate
function stamp(ctx, word, size, color, lw = 4) {
  ctx.font = `900 ${size}px ${TITLE}`
  const tw = ctx.measureText(word).width
  box(ctx, -tw / 2 - size * 0.4, -size * 0.72, tw + size * 0.8, size * 1.3, 6, null, color, lw)
  text(ctx, word, 0, size * 0.34, size, color, 900, TITLE, 'center')
}

// grey bars standing in for a line of writing
function bars(ctx, x, y, widths, color, thick = 8, gap = 18) {
  widths.forEach((bw, i) => box(ctx, x, y + i * gap, bw, thick, thick / 2, color))
}

const COVER_ART = {
  // The Walkthrough: one request, a chat bubble, carried along the six-stop line
  walk: [760, 330, (ctx, p, a, w, h) => {
    const stops = p.journey || []
    const n = Math.max(1, stops.length)
    const x0 = 70
    const step = (w - 140) / Math.max(1, n - 1)
    const ly = 168
    const at = 3
    ctx.strokeStyle = 'rgba(243,234,214,0.18)'
    ctx.lineWidth = 18
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, ly)
    ctx.lineTo(w - 70, ly)
    ctx.stroke()
    ctx.strokeStyle = a
    ctx.beginPath()
    ctx.moveTo(x0, ly)
    ctx.lineTo(x0 + step * at, ly)
    ctx.stroke()
    stops.forEach((s, i) => {
      const x = x0 + i * step
      const done = i <= at
      ctx.fillStyle = done ? CREAM : '#1a262d'
      ctx.beginPath()
      ctx.arc(x, ly, 26, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = done ? INK : 'rgba(243,234,214,0.45)'
      ctx.lineWidth = 6
      ctx.stroke()
      text(ctx, String(i + 1), x, ly + 10, 28, done ? INK : 'rgba(243,234,214,0.6)', 900, TITLE, 'center')
      ctx.font = `700 24px ${BODY}`
      lines(ctx, s.name || '', step - 8).forEach((l, j) => text(ctx, l, x, ly + 70 + j * 26, 24, done ? CREAM : 'rgba(243,234,214,0.6)', 700, BODY, 'center'))
    })
    // the bubble riding the line, with the road behind it
    const bx = x0 + step * at
    const bw = 190
    const bh = 82
    const by = ly - 66 - bh
    ctx.strokeStyle = 'rgba(243,234,214,0.35)'
    ctx.lineWidth = 4
    for (let k = 0; k < 3; k++) {
      ctx.beginPath()
      ctx.moveTo(bx - bw / 2 - 30 - k * 8, by + 22 + k * 20)
      ctx.lineTo(bx - bw / 2 - 90 - k * 24, by + 22 + k * 20)
      ctx.stroke()
    }
    box(ctx, bx - bw / 2, by, bw, bh, 20, CREAM)
    ctx.fillStyle = CREAM
    ctx.beginPath()
    ctx.moveTo(bx - 16, by + bh - 2)
    ctx.lineTo(bx, by + bh + 26)
    ctx.lineTo(bx + 16, by + bh - 2)
    ctx.fill()
    bars(ctx, bx - bw / 2 + 22, by + 22, [bw - 44, bw - 80, bw - 110], 'rgba(23,18,14,0.55)', 9, 18)
  }],
  // Done Means Done: the goal board, and only the goals with proof get the DONE stamp
  board: [640, 360, (ctx, p, a, w, h) => {
    box(ctx, 0, 0, w, h, 14, 'rgba(8,12,14,0.6)', 'rgba(243,234,214,0.25)', 2)
    text(ctx, 'GOALS', 24, 34, 18, 'rgba(243,234,214,0.6)', 700, TYPE)
    ctx.fillStyle = 'rgba(243,234,214,0.15)'
    ctx.fillRect(24, 48, w - 48, 2)
    const rows = (p.moment && p.moment.scene && p.moment.scene.rows) || []
    const gap = (h - 70) / Math.max(1, rows.length)
    rows.forEach(([goal, state, proof], i) => {
      const y = 62 + i * gap + gap / 2
      const met = state === 'met'
      box(ctx, 26, y - 26, 30, 30, 5, null, met ? a : 'rgba(243,234,214,0.35)', 3)
      if (met) tick(ctx, 41, y - 11, 24, a, 5)
      const gs = fit(ctx, goal, BODY, 600, w - 250, 30, 16)
      text(ctx, goal, 74, y - 2, gs, met ? CREAM : 'rgba(243,234,214,0.55)', 600)
      text(ctx, met ? `PROOF: ${proof.toUpperCase()}` : 'NO PROOF YET', 74, y + 24, 14, met ? a : 'rgba(243,234,214,0.4)', 700, TYPE)
      ctx.save()
      ctx.translate(w - 84, y - 2)
      ctx.rotate(met ? -0.08 : 0)
      if (met) stamp(ctx, 'DONE', 30, a, 4)
      else {
        ctx.setLineDash([6, 6])
        box(ctx, -52, -20, 104, 38, 6, null, 'rgba(243,234,214,0.35)', 2)
        ctx.setLineDash([])
        text(ctx, 'OPEN', 0, 7, 18, 'rgba(243,234,214,0.55)', 700, TYPE, 'center')
      }
      ctx.restore()
    })
  }],
  // The Bouncers: the guard log, two moves stamped REFUSED
  log: [660, 340, (ctx, p, a, w, h) => {
    box(ctx, 0, 0, w, h, 14, 'rgba(8,12,14,0.6)', 'rgba(243,234,214,0.25)', 2)
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, 14)
    ctx.clip()
    SCENES.log(ctx, { ...p.moment.scene, accent: a }, w, h)
    ctx.restore()
  }],
  // The Approval Window: one big dialog on the screen, a timer, YES and NO, the phone beside it
  tally: [680, 400, (ctx, p, a, w, h) => {
    const desk = h - 54
    ctx.fillStyle = '#2a1d14'
    ctx.fillRect(0, desk, w, h - desk)
    ctx.fillStyle = 'rgba(243,234,214,0.18)'
    ctx.fillRect(0, desk, w, 3)
    // the monitor
    const mw = 500
    const mh = 300
    box(ctx, mw / 2 - 30, mh, 60, desk - mh, 0, '#10161c')
    box(ctx, mw / 2 - 90, desk - 10, 180, 12, 4, '#10161c')
    box(ctx, 0, 0, mw, mh, 14, '#0a0f14', 'rgba(243,234,214,0.3)', 3)
    // the one window
    const dx = 34
    const dy = 26
    const dw = mw - 68
    const dh = mh - 52
    box(ctx, dx, dy, dw, dh, 10, '#16222f', a, 3)
    ctx.fillStyle = a
    ctx.fillRect(dx + 2, dy + 2, dw - 4, 34)
    text(ctx, 'A CHAT NEEDS YOUR OK', dx + 18, dy + 26, 17, '#0d1420', 700, TYPE)
    // the timer
    ctx.strokeStyle = '#0d1420'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(dx + dw - 82, dy + 19, 9, 0, Math.PI * 2)
    ctx.moveTo(dx + dw - 82, dy + 19)
    ctx.lineTo(dx + dw - 82, dy + 13)
    ctx.moveTo(dx + dw - 82, dy + 19)
    ctx.lineTo(dx + dw - 77, dy + 19)
    ctx.stroke()
    text(ctx, '15:00', dx + dw - 16, dy + 26, 17, '#0d1420', 700, TYPE, 'right')
    text(ctx, 'One exact action, once.', dx + 20, dy + 80, 28, CREAM, 700)
    bars(ctx, dx + 20, dy + 100, [dw - 60, dw - 110, dw - 150], 'rgba(243,234,214,0.28)', 8, 20)
    box(ctx, dx + 20, dy + 162, dw - 40, 30, 6, 'rgba(0,0,0,0.35)')
    bars(ctx, dx + 34, dy + 173, [dw - 160], 'rgba(243,234,214,0.5)', 8)
    box(ctx, dx + dw - 210, dy + dh - 46, 88, 34, 6, a)
    text(ctx, 'YES', dx + dw - 166, dy + dh - 22, 18, '#0d1420', 700, TYPE, 'center')
    box(ctx, dx + dw - 110, dy + dh - 46, 88, 34, 6, null, 'rgba(243,234,214,0.55)', 2)
    text(ctx, 'NO', dx + dw - 66, dy + dh - 22, 18, CREAM, 700, TYPE, 'center')
    // the phone beside it, asking the same
    const px = 560
    const pw = 92
    const ph = 172
    const py = desk - ph + 8
    box(ctx, px, py, pw, ph, 14, '#0a0f14', 'rgba(243,234,214,0.45)', 3)
    box(ctx, px + 8, py + 18, pw - 16, ph - 36, 6, '#16222f')
    ctx.fillStyle = a
    ctx.fillRect(px + 8, py + 18, pw - 16, 14)
    bars(ctx, px + 16, py + 46, [pw - 32, pw - 46], 'rgba(243,234,214,0.3)', 6, 14)
    box(ctx, px + 14, py + ph - 56, 30, 18, 4, a)
    box(ctx, px + pw - 44, py + ph - 56, 30, 18, 4, null, 'rgba(243,234,214,0.55)', 2)
  }],
  // Memory That Argues Back: fact cards, one struck out and replaced, one gone dusty
  facts: [680, 380, (ctx, p, a, w, h) => {
    const card = (x, y, rot, draw) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rot)
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 18
      ctx.shadowOffsetY = 8
      box(ctx, -130, -88, 260, 176, 6, PAPER)
      ctx.restore()
      ctx.fillStyle = 'rgba(196,85,60,0.7)'
      ctx.fillRect(-130, -52, 260, 3)
      ctx.fillStyle = 'rgba(90,140,190,0.3)'
      for (let ly = -18; ly < 80; ly += 28) ctx.fillRect(-130, ly, 260, 2)
      draw()
      ctx.restore()
    }
    // the old fact, struck out
    card(150, 120, -0.08, () => {
      text(ctx, 'FACT 412', -112, -62, 18, INK, 700, TYPE)
      bars(ctx, -112, -34, [210, 180, 200], 'rgba(23,18,14,0.5)', 8, 28)
      ctx.strokeStyle = RED
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(-118, 30)
      ctx.lineTo(118, -40)
      ctx.stroke()
    })
    // the one that replaced it
    card(250, 250, 0.05, () => {
      text(ctx, 'FACT 977', -112, -62, 18, INK, 700, TYPE)
      text(ctx, 'REPLACES 412', 112, -62, 15, GOLD_DK, 700, TYPE, 'right')
      bars(ctx, -112, -34, [200, 216, 150], 'rgba(23,18,14,0.6)', 8, 28)
      tick(ctx, 92, 54, 30, '#3f8a4f', 6)
    })
    // the one nobody has looked at since
    card(510, 170, 0.07, () => {
      text(ctx, 'FACT 88', -112, -62, 18, INK, 700, TYPE)
      bars(ctx, -112, -34, [190, 210, 170], 'rgba(23,18,14,0.35)', 8, 28)
      ctx.fillStyle = 'rgba(120,110,90,0.35)'
      ctx.fillRect(-130, -88, 260, 176)
      let r = 7
      ctx.fillStyle = 'rgba(70,60,45,0.35)'
      for (let i = 0; i < 90; i++) {
        r = (r * 9301 + 49297) % 233280
        const sx = (r / 233280) * 256 - 128
        r = (r * 9301 + 49297) % 233280
        ctx.fillRect(sx, (r / 233280) * 172 - 86, 2 + (r % 3), 2 + (r % 3))
      }
      ctx.save()
      ctx.translate(10, 18)
      ctx.rotate(-0.16)
      stamp(ctx, 'RECHECK', 38, RED, 5)
      ctx.restore()
    })
  }],
  // Twenty Chats at Once: the grid of chats, and one note going to the mailbox
  chats: [700, 360, (ctx, p, a, w, h) => {
    const n = (p.moment && p.moment.scene && p.moment.scene.count) || 20
    const cols = 5
    const rows = Math.ceil(n / cols)
    const cw = 84
    const ch = (h - 20) / rows
    const from = 9
    for (let i = 0; i < n; i++) {
      const x = 10 + (i % cols) * (cw + 6)
      const y = 10 + Math.floor(i / cols) * ch
      const hot = i === from
      box(ctx, x, y, cw, ch - 8, 6, hot ? '#2a2015' : '#141c22', hot ? a : 'rgba(243,234,214,0.25)', hot ? 3 : 2)
      ctx.fillStyle = hot ? a : 'rgba(243,234,214,0.14)'
      ctx.fillRect(x + 2, y + 2, cw - 4, 9)
      box(ctx, x + cw - 46, y + 18, 38, 14, 6, 'rgba(243,234,214,0.45)')
      box(ctx, x + 8, y + 40, 44, 14, 6, 'rgba(243,234,214,0.2)')
    }
    // the mailbox: a post box on its stand, flag up
    const mx = 610
    const my = 150
    box(ctx, mx - 8, my + 50, 16, h - my - 60, 2, '#3a2a1a')
    ctx.fillStyle = '#2a2015'
    ctx.strokeStyle = a
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(mx - 60, my + 56)
    ctx.lineTo(mx - 60, my - 10)
    ctx.arc(mx, my - 10, 60, Math.PI, 0)
    ctx.lineTo(mx + 60, my + 56)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    box(ctx, mx - 34, my - 6, 68, 10, 4, '#0a0f14')
    ctx.fillStyle = a
    ctx.fillRect(mx + 60, my - 50, 6, 60)
    ctx.fillRect(mx + 60, my - 50, 30, 18)
    text(ctx, 'MAILBOX', mx, h - 6, 18, CREAM, 700, TYPE, 'center')
    // the note on its way, from the one chat to the slot
    const sx = 10 + (from % cols) * (cw + 6) + cw
    const sy = 10 + Math.floor(from / cols) * ch + ch / 2 - 4
    ctx.setLineDash([10, 9])
    ctx.strokeStyle = 'rgba(243,234,214,0.55)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(sx + 6, sy)
    ctx.quadraticCurveTo(500, sy - 40, mx - 40, my)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.save()
    ctx.translate(520, 128)
    ctx.rotate(-0.25)
    box(ctx, -38, -25, 76, 50, 4, CREAM, INK, 2)
    ctx.strokeStyle = INK
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-36, -22)
    ctx.lineTo(0, 6)
    ctx.lineTo(36, -22)
    ctx.stroke()
    ctx.restore()
  }],
  // Cheap Helpers, Checked Work: small helpers hand in cards, a checker reads each one through a glass
  burn: [700, 380, (ctx, p, a, w, h) => {
    const person = (x, y, s, fill) => {
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.arc(x, y - s * 1.1, s * 0.55, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(x - s, y + s * 0.9)
      ctx.quadraticCurveTo(x - s, y - s * 0.4, x, y - s * 0.4)
      ctx.quadraticCurveTo(x + s, y - s * 0.4, x + s, y + s * 0.9)
      ctx.closePath()
      ctx.fill()
    }
    const card = (x, y, rot, mark) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rot)
      box(ctx, -26, -18, 52, 36, 3, PAPER, 'rgba(23,18,14,0.4)', 1)
      bars(ctx, -18, -8, [36, 26], 'rgba(23,18,14,0.45)', 4, 10)
      ctx.restore()
      if (mark === 'ok') tick(ctx, x + 30, y - 22, 20, a, 5)
      if (mark === 'no') cross(ctx, x + 30, y - 22, 16, RED, 5)
    }
    // six helpers, each with a card held out
    for (let i = 0; i < 6; i++) {
      const x = 50 + (i % 3) * 80
      const y = 120 + Math.floor(i / 3) * 130
      person(x, y, 24, a)
      card(x + 34, y + 20, -0.1 + (i % 3) * 0.08)
    }
    text(ctx, 'CHEAP HELPERS', 130, h - 14, 18, CREAM, 700, TYPE, 'center')
    // cards on their way to the checker
    ctx.setLineDash([8, 8])
    arrow(ctx, 290, 150, 380, 172, 'rgba(243,234,214,0.5)', 3)
    arrow(ctx, 290, 280, 380, 220, 'rgba(243,234,214,0.5)', 3)
    ctx.setLineDash([])
    // the checker, big, with the glass over a card
    person(600, 236, 58, CREAM)
    card(440, 130, -0.06, 'ok')
    card(440, 270, 0.05, 'no')
    card(480, 196, 0.02)
    ctx.strokeStyle = GOLD
    ctx.lineWidth = 10
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(534, 238)
    ctx.lineTo(500, 214)
    ctx.stroke()
    ctx.lineWidth = 7
    ctx.fillStyle = 'rgba(243,234,214,0.15)'
    ctx.beginPath()
    ctx.arc(482, 198, 34, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    text(ctx, 'THE CHECKER', 600, h - 14, 18, CREAM, 700, TYPE, 'center')
  }],
  // The Hands: the four things it can reach, laid out on the desk
  hands: [640, 300, (ctx, p, a, w, h) => SCENES.hands(ctx, { ...p.moment.scene, accent: a }, w, h)],
}

// The title in gold foil, on two lines when one would shrink it too far. Returns the y under it.
function coverTitle(ctx, p, w, y) {
  let main = p.title.toUpperCase()
  if (/^THE /.test(main)) {
    text(ctx, 'THE', w / 2, y + 38, 50, CREAM, 900, TITLE, 'center')
    y += 50
    main = main.slice(4)
  }
  let rows = [main]
  let ts = fit(ctx, main, TITLE, 900, w - 120, 168, 40)
  if (ts < 118) {
    // break at the comma when there is one, else at the space nearest the middle
    const words = main.split(' ')
    let cut = words.findIndex((x) => x.endsWith(',')) + 1
    if (!cut) {
      let best = 1
      for (let i = 1; i < words.length; i++) if (Math.abs(words.slice(0, i).join(' ').length - main.length / 2) < Math.abs(words.slice(0, best).join(' ').length - main.length / 2)) best = i
      cut = best
    }
    rows = [words.slice(0, cut).join(' '), words.slice(cut).join(' ')]
    ts = Math.min(...rows.map((r) => fit(ctx, r, TITLE, 900, w - 120, 132, 40)))
  }
  ctx.font = `900 ${ts}px ${TITLE}`
  ctx.textAlign = 'center'
  for (const r of rows) {
    const base = y + ts * 0.8
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillText(r, w / 2 + 6, base + 7)
    ctx.fillStyle = foil(ctx, 0, y, w, ts)
    ctx.fillText(r, w / 2, base)
    y += ts * 0.9
  }
  ctx.textAlign = 'left'
  return y
}

export async function ldFront(p, shelf) {
  const [c, ctx] = canvas(FACE, FACE)
  const w = FACE
  const h = FACE
  const accent = (p.palette && p.palette.accent) || GOLD
  coverSky(ctx, p, w, h)
  // the special edition banner
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, 92)
  ctx.fillStyle = foil(ctx, 0, 0, w, 92)
  ctx.fillRect(0, 88, w, 6)
  text(ctx, 'RYAN ZEGALIA PRESENTS', 48, 58, 30, CREAM, 700)
  text(ctx, 'SPECIAL EDITION', w - 48, 58, 30, GOLD, 900, TITLE, 'right')
  // the name, then what it is in a few words
  let y = coverTitle(ctx, p, w, 116)
  ctx.font = `700 40px ${BODY}`
  const kicker = (p.kicker || '').toUpperCase()
  text(ctx, kicker, w / 2, y + 40, fit(ctx, kicker, BODY, 700, w - 160, 40, 24), accent, 700, BODY, 'center')
  const picTop = y + 82
  // the plain line, sat on the format strip
  ctx.font = `600 36px ${BODY}`
  const rows = lines(ctx, p.tagline || '', w - 160)
  const lastBase = h - 108
  rows.forEach((l, i) => text(ctx, l, w / 2, lastBase - (rows.length - 1 - i) * 44, 36, CREAM, 600, BODY, 'center'))
  const picBottom = lastBase - (rows.length - 1) * 44 - 36 - 30
  // the picture of the thing itself, as big as the space between allows
  const art = COVER_ART[p.coverArt || (p.journey?.length ? 'walk' : p.moment?.scene?.type)]
  if (art) {
    const [dw, dh, draw] = art
    const s = Math.min((w - 120) / dw, (picBottom - picTop) / dh)
    ctx.save()
    ctx.translate((w - dw * s) / 2, picTop + (picBottom - picTop - dh * s) / 2)
    ctx.scale(s, s)
    draw(ctx, p, accent, dw, dh)
    ctx.restore()
  }
  // the format strip
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(0, h - 78, w, 78)
  text(ctx, '12" LASERDISC  ·  GATEFOLD  ·  DIRECTOR\'S NOTES INSIDE', 48, h - 30, 24, CREAM, 700, TYPE)
  text(ctx, catalog(p, shelf), w - 48, h - 30, 24, GOLD, 700, TYPE, 'right')
  grain(ctx, w, h, 0.04)
  return toTexture(c)
}

export function ldBack(p, shelf, phone = false) {
  if (phone) {
    // A legible jacket edition, not the desktop's fine print scaled down to a phone.
    const [c, ctx] = canvas(FACE, FACE)
    ctx.fillStyle = '#101417'
    ctx.fillRect(0, 0, FACE, FACE)
    ctx.fillStyle = GOLD
    ctx.fillRect(0, 0, FACE, 10)
    const m = 64, width = FACE - m * 2
    text(ctx, p.title.toUpperCase(), m, 122, fit(ctx, p.title.toUpperCase(), TITLE, 900, width, 84), GOLD, 900, TITLE)
    ctx.font = `600 52px ${BODY}`
    ctx.fillStyle = CREAM
    let y = wrap(ctx, p.tagline || p.what || '', m, 205, width, 62) + 60
    const chapters = p.journey?.length ? p.journey : p.steps || []
    if (chapters.length) {
      text(ctx, 'CHAPTER LIST', m, y, 40, GOLD, 900, TITLE)
      y += 64
      for (const [i, chapter] of chapters.entries()) {
        ctx.font = `600 46px ${BODY}`
        ctx.fillStyle = CREAM
        y = wrap(ctx, `${i + 1}  ${chapter.name}`, m, y, width, 56) + 10
      }
    } else if (p.starring) {
      text(ctx, 'STARRING', m, y, 40, GOLD, 900, TITLE)
      ctx.font = `600 48px ${BODY}`
      ctx.fillStyle = CREAM
      wrap(ctx, p.starring, m, y + 64, width, 58)
    }
    ctx.fillStyle = GOLD_DK
    ctx.fillRect(m, 1010, width, 3)
    ctx.font = `600 44px ${BODY}`
    ctx.fillStyle = CREAM
    wrap(ctx, p.credit || '', m, 1070, width, 52)
    grain(ctx, FACE, FACE, 0.035)
    return toTexture(c)
  }
  const [c, ctx] = canvas(FACE, FACE)
  const w = FACE
  const h = FACE
  ctx.fillStyle = '#101417'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = foil(ctx, 0, 0, w, 10)
  ctx.fillRect(0, 0, w, 10)
  const m = 64
  let y = 112
  ctx.font = `900 ${fit(ctx, p.title.toUpperCase(), TITLE, 900, w - m * 2, 92)}px ${TITLE}`
  ctx.fillStyle = GOLD
  ctx.fillText(p.title.toUpperCase(), m, y)
  y += 56
  const head = (s) => {
    text(ctx, s, m, y, 34, GOLD, 900, TITLE)
    ctx.fillStyle = GOLD_DK
    ctx.fillRect(m, y + 12, w - m * 2, 3)
    y += 56
  }
  // A gatefold with steps (or two panels) prints what it is and everything I built in full, so the
  // back is its own thing: the pitch, then a short cut (who it stars, its chapters, what it was
  // recorded with). The walkthrough's gatefold is the journey, so its back keeps both.
  if (!p.journey?.length) {
    ctx.font = `600 60px ${BODY}`
    ctx.fillStyle = CREAM
    y = wrap(ctx, p.tagline || p.what || '', m, y + 24, w - m * 2, 70) + 56
    if (p.starring) {
      head('STARRING')
      ctx.font = `600 44px ${BODY}`
      ctx.fillStyle = CREAM
      y = wrap(ctx, p.starring, m, y + 6, w - m * 2, 54) + 44
    }
    const st = p.steps || []
    if (st.length) {
      head('CHAPTER LIST')
      const cw = (w - m * 2) / st.length
      st.forEach((s, i) => {
        text(ctx, `CHAPTER ${i + 1}`, m + i * cw, y, 24, '#a9b4bb', 700, TYPE)
        text(ctx, s.name, m + i * cw, y + 56, Math.min(50, fit(ctx, s.name, BODY, 600, cw - 24, 50)), CREAM, 600)
      })
      y += 56 + 70
    }
    if (p.requirements?.length) {
      head('RECORDED WITH')
      ctx.font = `600 42px ${BODY}`
      ctx.fillStyle = CREAM
      y = wrap(ctx, p.requirements.join('  ·  '), m, y + 6, w - m * 2, 52) + 10
    }
    return finishBack(ctx, c, p, w, h, m)
  }
  ctx.font = `600 36px ${BODY}`
  ctx.fillStyle = CREAM
  y = wrap(ctx, p.what || '', m, y, w - m * 2, 44) + 24
  head('SPECIAL FEATURES')
  ctx.font = `600 32px ${BODY}`
  for (const b of p.built || []) {
    ctx.fillStyle = GOLD
    ctx.fillText('◆', m, y)
    ctx.fillStyle = CREAM
    y = wrap(ctx, b, m + 38, y, w - m * 2 - 40, 38) + 4
  }
  y += 18
  const ch = p.journey || []
  if (ch.length) {
    head('CHAPTER LIST')
    const half = Math.ceil(ch.length / 2)
    const cw = (w - m * 2) / 2
    ch.forEach((s, i) => {
      const col = i < half ? 0 : 1
      const row = i < half ? i : i - half
      if (row === 0) text(ctx, col ? 'SIDE B' : 'SIDE A', m + col * cw, y, 22, DIM, 700, TYPE)
      text(ctx, `${i + 1}  ${s.name}`, m + col * cw, y + 40 + row * 40, 31, CREAM, 600)
    })
    y += 40 + half * 40 + 10
  }
  return finishBack(ctx, c, p, w, h, m)
}

// the foot of every back: the rating, the credit and status, the barcode
function finishBack(ctx, c, p, w, h, m) {
  const by = h - 210
  ratingBox(ctx, m, by, p.rating || 'A', p.ratingWord || 'Approved', GOLD)
  text(ctx, p.credit || '', m + 180, by + 50, 28, CREAM, 700)
  text(ctx, `${p.status || ''}`, m + 180, by + 90, 24, '#a9b4bb', 400, TYPE)
  barcode(ctx, w - m - 280, by + 30, 280, 84, hash(p.slug || p.title))
  grain(ctx, w, h, 0.035)
  return toTexture(c)
}

export function ldSpine(p, shelf) {
  const [c, ctx] = canvas(1200, 64)
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, 1200, 64)
  text(ctx, p.title.toUpperCase(), 40, 46, 38, GOLD, 900, TITLE)
  text(ctx, catalog(p, shelf), 1160, 44, 26, CREAM, 700, TYPE, 'right')
  return toTexture(c)
}

// ---- the gatefold --------------------------------------------------------------------------

// How many panels the gatefold opens to. App reads its length for paging. On a phone a journey
// gatefold reads one stop at a time instead, so each chapter is big enough to read. A case with
// steps opens to three panels, one step each.
export const gatefoldPlan = (p, single) => (p.journey?.length ? (single ? p.journey.map((_, i) => i) : [0, 1, 2]) : p.steps?.length ? [0, 1, 2] : [0, 1])

// the night band across the top of the journey gatefold, where the line map runs
const BAND = 384
const SCREEN = '#0c161c'
const RED = '#c4553c'

function paper(ctx, w, h) {
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(80,60,30,0.08)'
  for (let x = FACE; x < w; x += FACE) {
    const g = ctx.createLinearGradient(x - 30, 0, x + 30, 0)
    g.addColorStop(0, 'rgba(60,40,20,0)')
    g.addColorStop(0.5, 'rgba(60,40,20,0.16)')
    g.addColorStop(1, 'rgba(60,40,20,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - 30, 0, 60, h)
  }
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

// A paragraph wrapped to width; returns the baseline after its last line.
function para(ctx, s, x, y, width, size, lh, color, weight = 600, family = BODY) {
  ctx.font = `${weight} ${size}px ${family}`
  ctx.fillStyle = color
  for (const l of lines(ctx, s || '', width)) {
    ctx.fillText(l, x, y)
    y += lh
  }
  return y
}

function tick(ctx, x, y, s, color, lw = 5) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x - s * 0.5, y)
  ctx.lineTo(x - s * 0.12, y + s * 0.38)
  ctx.lineTo(x + s * 0.55, y - s * 0.42)
  ctx.stroke()
}

function cross(ctx, x, y, s, color, lw = 5) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x - s / 2, y - s / 2)
  ctx.lineTo(x + s / 2, y + s / 2)
  ctx.moveTo(x + s / 2, y - s / 2)
  ctx.lineTo(x - s / 2, y + s / 2)
  ctx.stroke()
}

function arrow(ctx, x0, y0, x1, y1, color, lw = 3) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1 - 10, y1)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - 14, y1 - 8)
  ctx.lineTo(x1 - 14, y1 + 8)
  ctx.fill()
}

// ---- the frame grabs --------------------------------------------------------------------------
// Every chapter of a journey has a still, like the frame grabs in a special edition's notes: a
// small drawn scene of that stop, filled with what really happened there (the stop's `scene` in
// its project.json). Drawn inside a w x h frame whose top left is 0, 0.

const SCENES = {
  // the chat window: the brief I pasted, then what I said
  chat(ctx, sc, w, h) {
    ctx.fillStyle = 'rgba(243,234,214,0.06)'
    ctx.fillRect(0, 0, w, 36)
    text(ctx, 'NEW CHAT', 20, 24, 16, 'rgba(243,234,214,0.55)', 700, TYPE)
    let by = 66
    if (sc.attach) {
      const cw = 186
      box(ctx, w - 22 - cw, 50, cw, 30, 8, null, GOLD, 2)
      text(ctx, sc.attach.toUpperCase(), w - 22 - cw / 2, 71, 15, GOLD, 700, TYPE, 'center')
      by = 92
    }
    ctx.font = `600 26px ${BODY}`
    const said = lines(ctx, sc.said || '', 300)
    const bw = 332
    const bx = w - 22 - bw
    box(ctx, bx, by, bw, said.length * 31 + 26, 16, CREAM)
    said.forEach((l, i) => text(ctx, l, bx + 16, by + 35 + i * 31, 26, INK, 600))
    // the AI, already on it
    box(ctx, 22, by + said.length * 31 + 40, 86, 34, 17, 'rgba(243,234,214,0.12)')
    for (let d = 0; d < 3; d++) {
      ctx.fillStyle = GOLD
      ctx.beginPath()
      ctx.arc(46 + d * 19, by + said.length * 31 + 57, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    box(ctx, 20, h - 48, w - 40, 32, 16, 'rgba(243,234,214,0.08)')
    ctx.fillStyle = GOLD
    ctx.fillRect(38, h - 41, 3, 18)
  },
  // the notes that ride along: each card threads into the request before the AI reads it
  attach(ctx, sc, w, h) {
    const bx = 298
    const bw = w - bx - 20
    ctx.font = `600 21px ${BODY}`
    const to = lines(ctx, sc.to || '', bw - 28)
    const bh = to.length * 26 + 26
    const by = h / 2 - bh / 2
    const cards = sc.cards || []
    const gap = (h - 40) / Math.max(1, cards.length)
    cards.forEach((c, i) => {
      const y = 20 + i * gap + (gap - 56) / 2
      ctx.strokeStyle = GOLD
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(226, y + 28)
      ctx.bezierCurveTo(266, y + 28, 258, by + bh / 2, bx, by + bh / 2)
      ctx.stroke()
      box(ctx, 20, y, 206, 56, 10, '#1c2a32', 'rgba(224,176,74,0.6)', 2)
      const label = c.toUpperCase()
      const sz = fit(ctx, label, TITLE, 800, 176, 24, 14)
      text(ctx, label, 36, y + 36, sz, CREAM, 800, TITLE)
      ctx.fillStyle = GOLD
      ctx.beginPath()
      ctx.arc(226, y + 28, 5, 0, Math.PI * 2)
      ctx.fill()
    })
    box(ctx, bx, by, bw, bh, 16, CREAM)
    to.forEach((l, i) => text(ctx, l, bx + 14, by + 32 + i * 26, 21, INK, 600))
  },
  // the guards: every action walks up to the post; most go on, some are turned away
  gate(ctx, sc, w, h) {
    const gx = 262
    const glow = ctx.createLinearGradient(gx - 40, 0, gx + 40, 0)
    glow.addColorStop(0, 'rgba(224,176,74,0)')
    glow.addColorStop(0.5, 'rgba(224,176,74,0.18)')
    glow.addColorStop(1, 'rgba(224,176,74,0)')
    ctx.fillStyle = glow
    ctx.fillRect(gx - 40, 0, 80, h)
    ctx.fillStyle = GOLD
    ctx.fillRect(gx - 3, 14, 6, h - 28)
    const acts = sc.actions || []
    const gap = (h - 20) / Math.max(1, acts.length)
    acts.forEach(([what, how], i) => {
      const y = 10 + i * gap + gap / 2
      box(ctx, 16, y - 22, 206, 44, 10, '#1c2a32', 'rgba(243,234,214,0.25)', 2)
      const sz = fit(ctx, what, BODY, 600, 180, 22, 14)
      text(ctx, what, 30, y + 8, sz, CREAM, 600)
      if (how === 'pass') {
        ctx.setLineDash([8, 7])
        arrow(ctx, 226, y, 398, y, 'rgba(243,234,214,0.6)', 3)
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(224,176,74,0.18)'
        ctx.beginPath()
        ctx.arc(436, y, 22, 0, Math.PI * 2)
        ctx.fill()
        tick(ctx, 436, y, 22, GOLD, 5)
      } else if (how === 'asks me') {
        // it waits at the guard while a window asks me
        arrow(ctx, 226, y, gx - 10, y, 'rgba(243,234,214,0.6)', 3)
        ctx.setLineDash([6, 6])
        ctx.strokeStyle = GOLD
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(gx + 8, y)
        ctx.lineTo(318, y)
        ctx.stroke()
        ctx.setLineDash([])
        box(ctx, 318, y - 30, w - 334, 60, 8, '#16242c', GOLD, 2)
        ctx.fillStyle = GOLD
        ctx.fillRect(319, y - 29, w - 336, 14)
        text(ctx, 'ASKS ME', 330, y + 14, 22, CREAM, 900, TITLE)
        box(ctx, w - 104, y - 6, 38, 24, 4, GOLD)
        text(ctx, 'YES', w - 85, y + 11, 13, INK, 700, TYPE, 'center')
        box(ctx, w - 60, y - 6, 38, 24, 4, null, 'rgba(243,234,214,0.5)', 2)
        text(ctx, 'NO', w - 41, y + 11, 13, CREAM, 700, TYPE, 'center')
      } else {
        arrow(ctx, 226, y, gx - 10, y, 'rgba(243,234,214,0.6)', 3)
        cross(ctx, gx + 30, y, 18, RED, 6)
        ctx.save()
        ctx.translate(400, y)
        ctx.rotate(-0.06)
        const word = how.toUpperCase()
        ctx.font = `900 28px ${TITLE}`
        const tw = ctx.measureText(word).width
        box(ctx, -tw / 2 - 12, -20, tw + 24, 40, 4, null, RED, 3)
        text(ctx, word, 0, 10, 28, RED, 900, TITLE, 'center')
        ctx.restore()
      }
    })
  },
  // the plan: a sheet with its finish line and the goals that have to be proven
  plan(ctx, sc, w, h) {
    ctx.save()
    ctx.translate(w / 2, h / 2 + 2)
    ctx.rotate(-0.02)
    const pw = w - 64
    const ph = h - 34
    const x0 = -pw / 2
    const y0 = -ph / 2
    box(ctx, x0, y0, pw, ph, 6, PAPER)
    text(ctx, 'PLAN', x0 + 22, y0 + 42, 32, INK, 900, TITLE)
    text(ctx, (sc.title || '').toUpperCase(), x0 + 96, y0 + 40, 17, DIM, 700, TYPE)
    // the finish line's flag
    const fx = x0 + pw - 70
    const fy = y0 + 16
    ctx.fillStyle = INK
    ctx.fillRect(fx - 4, fy, 4, 44)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) ctx.fillRect(fx + c * 11, fy + r * 9, 11, 9)
    ctx.strokeStyle = INK
    ctx.lineWidth = 2
    ctx.strokeRect(fx, fy, 44, 27)
    ctx.fillStyle = GOLD_DK
    ctx.fillRect(x0 + 22, y0 + 58, pw - 44, 3)
    ;(sc.goals || []).forEach((g, i) => {
      const [goal, proof] = Array.isArray(g) ? g : [g, '']
      const y = y0 + 96 + i * (proof ? 54 : 40)
      box(ctx, x0 + 22, y - 20, 24, 24, 4, null, INK, 3)
      const sz = fit(ctx, goal, BODY, 600, pw - 90, 24, 16)
      text(ctx, goal, x0 + 60, y, sz, INK, 600)
      if (proof) text(ctx, proof.toUpperCase(), x0 + 60, y + 22, 16, GOLD_DK, 700, TYPE)
    })
    ctx.restore()
  },
  // the legwork and the proof: helpers read the days, a checker re-reads, numbers that fail go
  proof(ctx, sc, w, h) {
    const cols = [86, w / 2, w - 86]
    const top = 92
    // the helpers, one dot each
    const n = sc.helpers || 0
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / 5)
      const c = i % 5
      ctx.fillStyle = GOLD
      ctx.beginPath()
      ctx.arc(cols[0] - 52 + c * 26, top - 42 + r * 26, 8, 0, Math.PI * 2)
      ctx.fill()
    }
    // the days they read, a stack of pages under a glass
    for (let i = 3; i >= 0; i--) {
      ctx.save()
      ctx.translate(cols[1] - 6 + i * 8, top - 6 - i * 6)
      ctx.rotate((i - 1.5) * 0.06)
      box(ctx, -42, -50, 84, 104, 3, i ? '#d9ccb0' : PAPER)
      if (!i) for (let l = 0; l < 6; l++) box(ctx, -30, -34 + l * 14, l === 5 ? 34 : 60, 5, 2, 'rgba(23,18,14,0.35)')
      ctx.restore()
    }
    ctx.strokeStyle = GOLD
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(cols[1] + 26, top + 6, 26, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cols[1] + 45, top + 25)
    ctx.lineTo(cols[1] + 64, top + 44)
    ctx.stroke()
    // the stamp for what didn't survive the check
    ctx.save()
    ctx.translate(cols[2], top)
    ctx.rotate(-0.18)
    ctx.strokeStyle = RED
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(0, 0, 54, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, 45, 0, Math.PI * 2)
    ctx.stroke()
    text(ctx, 'CUT', 0, 12, 38, RED, 900, TITLE, 'center')
    ctx.restore()
    arrow(ctx, cols[0] + 64, top, cols[1] - 70, top, 'rgba(243,234,214,0.5)', 3)
    arrow(ctx, cols[1] + 80, top, cols[2] - 64, top, 'rgba(243,234,214,0.5)', 3)
    const figs = [
      [n, 'HELPERS', CREAM],
      [sc.days, 'DAYS READ', CREAM],
      [sc.cut, 'OLD NUMBERS CUT', RED],
    ]
    figs.forEach(([v, label, color], i) => {
      text(ctx, String(v ?? ''), cols[i], h - 50, 54, color, 900, TITLE, 'center')
      text(ctx, label, cols[i], h - 22, 15, 'rgba(243,234,214,0.6)', 700, TYPE, 'center')
    })
  },
  // the goals closing, each on its own kind of proof
  close(ctx, sc, w, h) {
    const rows = sc.rows || []
    const gap = (h - 30) / Math.max(1, rows.length)
    rows.forEach(([goal, proof], i) => {
      const y = 15 + i * gap + gap / 2
      box(ctx, 16, y - 22, 150, 44, 10, '#1c2a32', 'rgba(243,234,214,0.25)', 2)
      const gs = fit(ctx, goal, BODY, 600, 126, 22, 14)
      text(ctx, goal, 30, y + 8, gs, CREAM, 600)
      arrow(ctx, 170, y, 194, y, 'rgba(243,234,214,0.5)', 3)
      ctx.save()
      ctx.translate(310, y)
      ctx.rotate(-0.03)
      ctx.font = `700 16px ${TYPE}`
      const ps = fit(ctx, proof, TYPE, 700, 204, 20, 12)
      box(ctx, -110, -18, 220, 36, 4, null, GOLD, 2)
      text(ctx, proof, 0, 6, ps, GOLD, 700, TYPE, 'center')
      ctx.restore()
      ctx.fillStyle = 'rgba(224,176,74,0.18)'
      ctx.beginPath()
      ctx.arc(w - 40, y, 22, 0, Math.PI * 2)
      ctx.fill()
      tick(ctx, w - 40, y, 22, GOLD, 5)
    })
  },
  // the handoff: the calls I made, written into the rulebook, and the next chat starting from it
  handoff(ctx, sc, w, h) {
    ctx.save()
    ctx.translate(152, h / 2)
    ctx.rotate(-0.025)
    const pw = 270
    const ph = h - 36
    box(ctx, -pw / 2, -ph / 2, pw, ph, 5, PAPER)
    text(ctx, (sc.title || 'Rulebook').toUpperCase(), -pw / 2 + 20, -ph / 2 + 34, 16, GOLD_DK, 700, TYPE)
    let y = -ph / 2 + 70
    for (const r of sc.rules || []) {
      ctx.fillStyle = GOLD_DK
      ctx.fillRect(-pw / 2 + 20, y - 8, 10, 3)
      y = para(ctx, r, -pw / 2 + 40, y, pw - 60, 21, 24, INK, 600) + 6
    }
    ctx.restore()
    arrow(ctx, 296, h / 2, 336, h / 2, GOLD, 4)
    ctx.save()
    ctx.shadowColor = 'rgba(224,176,74,0.55)'
    ctx.shadowBlur = 24
    box(ctx, 346, 54, w - 366, h - 108, 12, '#16242c', GOLD, 3)
    ctx.restore()
    text(ctx, (sc.next || 'Next chat').toUpperCase(), 362, 92, 26, CREAM, 900, TITLE)
    text(ctx, 'STARTS WARM', 362, 116, 14, GOLD, 700, TYPE)
    for (let l = 0; l < 3; l++) box(ctx, 362, 138 + l * 18, [116, 96, 70][l], 7, 3, 'rgba(243,234,214,0.22)')
  },
  // ---- the moments: one still per case, drawn from what really happened (its moment's scene) ----
  // a goal board: met goals carry the proof that closed them, open ones wait
  board(ctx, sc, w, h) {
    const rows = sc.rows || []
    const gap = (h - 40) / Math.max(1, rows.length)
    rows.forEach(([goal, state, proof], i) => {
      const y = 20 + i * gap + gap / 2
      const met = state === 'met'
      box(ctx, 24, y - 26, w - 48, 52, 10, met ? '#1c2a32' : 'rgba(243,234,214,0.04)', met ? 'rgba(243,234,214,0.3)' : 'rgba(243,234,214,0.14)', 2)
      box(ctx, 42, y - 12, 24, 24, 4, null, met ? sc.accent : 'rgba(243,234,214,0.35)', 3)
      if (met) tick(ctx, 54, y, 20, sc.accent, 4)
      const gs = fit(ctx, goal, BODY, 600, w * 0.5, 26, 16)
      text(ctx, goal, 84, y + 9, gs, met ? CREAM : 'rgba(243,234,214,0.5)', 600)
      const word = (met ? proof : 'waiting on proof').toUpperCase()
      text(ctx, word, w - 44, y + 7, 16, met ? sc.accent : 'rgba(243,234,214,0.4)', 700, TYPE, 'right')
    })
  },
  // a guard log: each move, and what the guard said
  log(ctx, sc, w, h) {
    ctx.fillStyle = 'rgba(243,234,214,0.06)'
    ctx.fillRect(0, 0, w, 40)
    text(ctx, 'GUARD LOG', 24, 27, 17, 'rgba(243,234,214,0.6)', 700, TYPE)
    const rows = sc.lines || []
    const gap = (h - 60) / Math.max(1, rows.length)
    rows.forEach(([how, what], i) => {
      const y = 50 + i * gap + gap / 2
      const ok = how === 'pass'
      if (ok) tick(ctx, 44, y - 2, 22, GOLD, 5)
      else cross(ctx, 44, y - 2, 18, sc.accent, 5)
      const ws = fit(ctx, what, BODY, 600, w - 280, 28, 16)
      text(ctx, what, 80, y + 8, ws, CREAM, 600)
      const word = ok ? 'GOES AHEAD' : 'REFUSED'
      ctx.save()
      ctx.translate(w - 110, y)
      ctx.rotate(-0.04)
      box(ctx, -78, -19, 156, 38, 4, null, ok ? GOLD : sc.accent, 3)
      text(ctx, word, 0, 8, 22, ok ? GOLD : sc.accent, 900, TITLE, 'center')
      ctx.restore()
    })
  },
  // the approval window's tally: how many asks, and how I answered
  tally(ctx, sc, w, h) {
    box(ctx, 24, 20, w - 48, h - 40, 10, '#16222f', sc.accent, 2)
    ctx.fillStyle = sc.accent
    ctx.fillRect(25, 21, w - 50, 30)
    text(ctx, (sc.title || '').toUpperCase(), 44, 43, 18, '#0d1420', 700, TYPE)
    text(ctx, sc.total || '', w - 44, 43, 18, '#0d1420', 700, TYPE, 'right')
    const bars = sc.bars || []
    const most = Math.max(1, ...bars.map((b) => b[1]))
    const gap = (h - 110) / Math.max(1, bars.length)
    bars.forEach(([label, v], i) => {
      const y = 76 + i * gap + gap / 2
      text(ctx, label.toUpperCase(), 48, y + 8, 24, CREAM, 900, TITLE)
      const bw = ((w - 340) * v) / most
      box(ctx, 200, y - 16, Math.max(8, bw), 32, 6, i === 2 ? 'rgba(243,234,214,0.35)' : sc.accent)
      text(ctx, String(v), 214 + Math.max(8, bw), y + 10, 30, CREAM, 900, TITLE)
    })
  },
  // the fact list: most rows never reached the prompt, and nearly none had been rechecked
  facts(ctx, sc, w, h) {
    const n = 9
    const rowH = (h - 40) / n
    for (let i = 0; i < n; i++) {
      const y = 20 + i * rowH
      const reached = i % 3 === 0
      box(ctx, 24, y + 4, w * 0.62, rowH - 8, 5, reached ? 'rgba(180,142,240,0.28)' : 'rgba(243,234,214,0.06)')
      for (let l = 0; l < 2; l++) box(ctx, 40, y + 10 + l * 9, (reached ? 0.5 : 0.42) * w - l * 60, 4, 2, reached ? 'rgba(243,234,214,0.8)' : 'rgba(243,234,214,0.2)')
      if (!reached) {
        ctx.strokeStyle = 'rgba(243,234,214,0.25)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(30, y + rowH / 2)
        ctx.lineTo(24 + w * 0.62 - 6, y + rowH / 2)
        ctx.stroke()
      }
    }
    ;(sc.left || '').split('\n').forEach((l, j) => text(ctx, l, w * 0.62 + 44, 60 + j * 26, 18, 'rgba(243,234,214,0.7)', 700, TYPE))
    ctx.save()
    ctx.translate(w * 0.82, h * 0.6)
    ctx.rotate(-0.12)
    ctx.font = `900 30px ${TITLE}`
    const st = lines(ctx, (sc.stamp || '').toUpperCase(), 200)
    box(ctx, -116, -st.length * 18 - 14, 232, st.length * 36 + 24, 6, null, sc.accent, 4)
    st.forEach((l, j) => text(ctx, l, 0, -st.length * 18 + 22 + j * 36, 30, sc.accent, 900, TITLE, 'center'))
    ctx.restore()
  },
  // twenty chats side by side, one note going to a mailbox instead of waking anyone
  chats(ctx, sc, w, h) {
    const n = sc.count || 20
    const cols = 5
    const rows = Math.ceil(n / cols)
    const cw = (w * 0.6 - 30) / cols
    const ch = (h - 40) / rows
    for (let i = 0; i < n; i++) {
      const x = 24 + (i % cols) * cw
      const y = 20 + Math.floor(i / cols) * ch
      const busy = (i * 7) % 3 === 0
      box(ctx, x + 4, y + 4, cw - 8, ch - 8, 6, busy ? '#2a2015' : 'rgba(243,234,214,0.05)', busy ? sc.accent : 'rgba(243,234,214,0.18)', 2)
      for (let l = 0; l < 2; l++) box(ctx, x + 12, y + 14 + l * 10, cw - 32 - l * 14, 4, 2, 'rgba(243,234,214,0.3)')
    }
    // the mailbox
    const mx = w * 0.8
    const my = h * 0.42
    arrow(ctx, w * 0.6, my, mx - 70, my, sc.accent, 4)
    box(ctx, mx - 60, my - 44, 120, 80, 14, '#2a2015', sc.accent, 3)
    ctx.strokeStyle = sc.accent
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(mx - 40, my - 24)
    ctx.lineTo(mx, my + 2)
    ctx.lineTo(mx + 40, my - 24)
    ctx.stroke()
    text(ctx, 'MAILBOX', mx, my + 66, 18, CREAM, 700, TYPE, 'center')
    ctx.font = `600 22px ${BODY}`
    lines(ctx, sc.cost || '', 220).forEach((l, j) => text(ctx, l, mx, my + 100 + j * 26, 22, 'rgba(243,234,214,0.75)', 600, BODY, 'center'))
  },
  // the runaway: a meter pinned past red, and the refusal that came after
  burn(ctx, sc, w, h) {
    const cx = w * 0.3
    const cy = h * 0.72
    const r = h * 0.5
    for (let i = 0; i < 24; i++) {
      const a = Math.PI + (i / 23) * Math.PI
      ctx.strokeStyle = i > 16 ? RED : 'rgba(243,234,214,0.35)'
      ctx.lineWidth = i > 16 ? 6 : 4
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82)
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      ctx.stroke()
    }
    const na = Math.PI * 1.97
    ctx.strokeStyle = sc.accent
    ctx.lineWidth = 7
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(na) * r * 0.9, cy + Math.sin(na) * r * 0.9)
    ctx.stroke()
    ctx.fillStyle = sc.accent
    ctx.beginPath()
    ctx.arc(cx, cy, 12, 0, Math.PI * 2)
    ctx.fill()
    text(ctx, (sc.tokens || '').toUpperCase(), cx, cy + 44, 26, CREAM, 900, TITLE, 'center')
    const x = w * 0.62
    text(ctx, String(sc.helpers ?? ''), x, h * 0.36, 64, CREAM, 900, TITLE)
    text(ctx, 'HELPERS, NO LIMITS', x, h * 0.36 + 28, 16, 'rgba(243,234,214,0.6)', 700, TYPE)
    text(ctx, (sc.time || '').toUpperCase(), x, h * 0.36 + 76, 30, CREAM, 900, TITLE)
    ctx.save()
    ctx.translate(x + 110, h * 0.82)
    ctx.rotate(-0.05)
    box(ctx, -110, -22, 220, 44, 4, null, sc.accent, 3)
    text(ctx, 'NOW REFUSED', 0, 9, 26, sc.accent, 900, TITLE, 'center')
    ctx.restore()
  },
  // what the AI can reach, laid out on the desk
  hands(ctx, sc, w, h) {
    const tools = sc.tools || []
    const gw = (w - 48) / Math.max(1, tools.length)
    tools.forEach((t, i) => {
      const x = 24 + i * gw + gw / 2
      const y = h * 0.44
      ctx.strokeStyle = sc.accent
      ctx.fillStyle = '#1e1420'
      ctx.lineWidth = 3
      if (i === 0) {
        // the phone, a tap rippling out
        box(ctx, x - 36, y - 64, 72, 128, 12, '#1e1420', sc.accent, 3)
        ctx.strokeStyle = 'rgba(240,106,176,0.5)'
        for (const rr of [12, 24, 36]) {
          ctx.beginPath()
          ctx.arc(x, y + 6, rr, 0, Math.PI * 2)
          ctx.stroke()
        }
      } else if (i === 1) {
        // the signed-in browser
        box(ctx, x - 70, y - 52, 140, 104, 8, '#1e1420', sc.accent, 3)
        ctx.fillStyle = sc.accent
        ctx.fillRect(x - 69, y - 51, 138, 18)
        box(ctx, x - 14, y - 4, 28, 24, 4, null, CREAM, 3)
        ctx.strokeStyle = CREAM
        ctx.beginPath()
        ctx.arc(x, y - 6, 9, Math.PI, 0)
        ctx.stroke()
      } else if (i === 2) {
        // the image maker
        box(ctx, x - 60, y - 48, 120, 96, 6, '#1e1420', sc.accent, 3)
        ctx.fillStyle = sc.accent
        ctx.beginPath()
        ctx.moveTo(x - 46, y + 36)
        ctx.lineTo(x - 10, y - 8)
        ctx.lineTo(x + 14, y + 16)
        ctx.lineTo(x + 28, y + 2)
        ctx.lineTo(x + 46, y + 36)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x + 26, y - 24, 10, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // the graphics card, jobs lined up
        box(ctx, x - 70, y - 34, 140, 68, 8, '#1e1420', sc.accent, 3)
        for (const fx of [-32, 22]) {
          ctx.beginPath()
          ctx.arc(x + fx, y, 20, 0, Math.PI * 2)
          ctx.stroke()
        }
        for (let q = 0; q < 3; q++) box(ctx, x - 60 + q * 44, y + 48, 36, 14, 4, q ? 'rgba(243,234,214,0.25)' : sc.accent)
      }
      text(ctx, t.toUpperCase(), x, h - 26, 20, CREAM, 900, TITLE, 'center')
    })
  },
}

// One chapter's still, set into the notes like a frame grab: a dark screen with soft corners.
function frameGrab(ctx, s, x, y, w, h) {
  ctx.save()
  ctx.shadowColor = 'rgba(40,25,10,0.35)'
  ctx.shadowBlur = 20
  ctx.shadowOffsetY = 8
  box(ctx, x, y, w, h, 12, SCREEN)
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 12)
  ctx.clip()
  ctx.translate(x, y)
  const draw = s.scene && SCENES[s.scene.type]
  if (draw) draw(ctx, s.scene, w, h)
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.66)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.4)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

// The night band the line map runs through: the cover's own city, widescreen.
function nightBand(ctx, p, W) {
  const sky = ctx.createLinearGradient(0, 0, 0, BAND)
  sky.addColorStop(0, '#060b0f')
  sky.addColorStop(0.65, (p.palette && p.palette.bg) || NIGHT)
  sky.addColorStop(1, '#1a2628')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, BAND)
  ctx.save()
  ctx.translate(W / 2, BAND)
  ctx.scale(1, 0.16)
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.55)
  glow.addColorStop(0, 'rgba(224,176,74,0.22)')
  glow.addColorStop(1, 'rgba(224,176,74,0)')
  ctx.fillStyle = glow
  ctx.fillRect(-W / 2, -BAND / 0.16, W, BAND / 0.16)
  ctx.restore()
  // the buildings run down past the band; keep them in it
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, W, BAND)
  ctx.clip()
  const r = stars(ctx, hash((p.slug || p.title) + 'band'), W, 0, BAND * 0.62, 240)
  skyline(ctx, r, W, BAND, 160, 0.55)
  ctx.restore()
}

// A journey's gatefold: one wide sheet. The line map runs across the night band at the top, and
// under each stop its chapter: name, what it adds, its still, and what happened this time.
// The night band across the top of a gatefold and the line map running through it: one station
// per stop, its number in the circle and its name under it. Returns where each stop sits.
function bandMap(ctx, p, shelf, W, stops, sub, right) {
  const accent = (p.palette && p.palette.accent) || GOLD
  const k = stops.length
  const ly = MAP.y
  const xs = stops.map((_, i) => ((i + 0.5) / k) * W)
  nightBand(ctx, p, W)
  text(ctx, "DIRECTOR'S NOTES", 70, 78, 50, foil(ctx, 70, 30, 420, 60), 900, TITLE)
  text(ctx, sub, 72, 116, 24, 'rgba(243,234,214,0.62)', 700, TYPE)
  // Keep the shared caption inside the final chapter, so a phone stop never bisects its words.
  if (right) text(ctx, right.toUpperCase(), W - 70, 74, fit(ctx, right.toUpperCase(), TYPE, 700, W / k - 140, 24, 10), 'rgba(243,234,214,0.75)', 700, TYPE, 'right')
  text(ctx, catalog(p, shelf), W - 70, 110, 24, accent, 700, TYPE, 'right')
  // the line itself draws in live when the gatefold opens (Gatefold3D); a faint track shows where
  ctx.strokeStyle = 'rgba(243,234,214,0.16)'
  ctx.lineWidth = 22
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(xs[0], ly)
  ctx.lineTo(xs[k - 1], ly)
  ctx.stroke()
  stops.forEach((s, i) => {
    const x = xs[i]
    ctx.fillStyle = CREAM
    ctx.beginPath()
    ctx.arc(x, ly, 44, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = accent
    ctx.lineWidth = 7
    ctx.stroke()
    text(ctx, String(i + 1), x, ly + 19, 52, INK, 900, TITLE, 'center')
    // the stop's name under it, like a station on the map
    const name = s.name.toUpperCase()
    const ns = fit(ctx, name, TITLE, 900, W / k - 60, 50, 32)
    ctx.font = `900 ${ns}px ${TITLE}`
    const nw = ctx.measureText(name).width
    ctx.fillStyle = 'rgba(8,12,16,0.86)'
    ctx.beginPath()
    ctx.roundRect(x - nw / 2 - 16, ly + 108 - ns * 0.86, nw + 32, ns * 1.06, 8)
    ctx.fill()
    text(ctx, name, x, ly + 108, ns, CREAM, 900, TITLE, 'center')
  })
  ctx.fillStyle = foil(ctx, 0, BAND, W, 8)
  ctx.fillRect(0, BAND, W, 8)
  return xs
}

// A journey's gatefold: one wide sheet. The line map runs across the night band at the top, and
// under each stop its chapter: a still of the example request at that stop, what the stop adds,
// and what happened in the example.
function drawJourney(ctx, p, shelf) {
  const W = FACE * 3
  paper(ctx, W, FACE)
  const stops = p.journey || []
  const k = stops.length
  const xs = bandMap(ctx, p, shelf, W, stops, `SPECIAL EDITION  ·  ${k} CHAPTERS`, p.request && `EXAMPLE REQUEST: "${p.request}"`)
  // the chapters, one under each stop
  const cw = W / k - 88
  stops.forEach((s, i) => {
    const cx = xs[i] - cw / 2
    text(ctx, `CHAPTER ${i + 1}`, cx, BAND + 62, 22, GOLD_DK, 700, TYPE)
    frameGrab(ctx, s, cx, BAND + 84, cw, 280)
    para(ctx, s.adds, cx, BAND + 420, cw, 33, 40, INK, 600)
    text(ctx, 'IN THIS EXAMPLE', cx, BAND + 600, 20, GOLD_DK, 700, TYPE)
    para(ctx, s.example, cx, BAND + 640, cw, 30, 37, INK, 600)
  })
}

// A case with steps: a triple gatefold, one step to a panel. The steps run as a line map across
// the night band; under each, the step in a sentence, then what it is, how it started, and what I
// built, one to a panel.
function drawSteps(ctx, p, shelf) {
  const W = FACE * 3
  paper(ctx, W, FACE)
  const steps = p.steps || []
  bandMap(ctx, p, shelf, W, steps, 'SPECIAL EDITION  ·  HOW IT WORKS', p.title)
  const accent = (p.palette && p.palette.accent) || GOLD
  const mk = p.making || {}
  const mo = p.moment || {}
  const cw = FACE - 200
  const head = (s, x, y) => text(ctx, s, x, y, 24, GOLD_DK, 700, TYPE)
  for (let i = 0; i < 3; i++) {
    const cx = i * FACE + 100
    const st = steps[i]
    head(`STEP ${i + 1}`, cx, BAND + 72)
    let y = st ? para(ctx, st.says, cx, BAND + 132, cw, 44, 54, INK, 700) : BAND + 132
    y = Math.max(y, BAND + 300)
    ctx.fillStyle = 'rgba(23,18,14,0.18)'
    ctx.fillRect(cx, y - 18, cw, 2)
    y += 40
    if (i === 0) {
      head('WHAT IT IS', cx, y)
      y = para(ctx, p.what, cx, y + 54, cw, 38, 48, INK, 600) + 14
      if (mk.problem) para(ctx, mk.problem, cx, y, cw, 34, 44, DIM, 600)
    } else if (i === 1) {
      head('HOW IT STARTED', cx, y)
      // the moment, printed like a still from when it happened
      if (mo.scene) {
        frameGrab(ctx, { scene: { ...mo.scene, accent } }, cx, y + 28, cw, 270)
        y += 270 + 28 + 46
      } else y += 54
      para(ctx, mo.what, cx, y, cw, 32, 40, INK, 600)
    } else {
      head('WHAT I BUILT', cx, y)
      y += 54
      ctx.font = `600 36px ${BODY}`
      for (const b of p.built || []) {
        ctx.fillStyle = accent
        ctx.fillText('◆', cx, y)
        y = para(ctx, b, cx + 44, y, cw - 44, 36, 45, INK, 600) + 10
      }
    }
  }
}

// Any other case: two panels, what it is and what I built.
function drawPair(ctx, p, shelf) {
  const W = FACE * 2
  const H = FACE
  paper(ctx, W, H)
  ctx.fillStyle = NIGHT
  ctx.fillRect(0, 0, W, 120)
  text(ctx, "DIRECTOR'S NOTES", 70, 80, 52, GOLD, 900, TITLE)
  text(ctx, p.title.toUpperCase(), W - 70, 80, 34, CREAM, 700, BODY, 'right')
  const col = (x, title, body) => {
    let y = 230
    text(ctx, title, x, y, 54, INK, 900, TITLE)
    y += 60
    for (const para of body) {
      ctx.font = `500 34px ${BODY}`
      ctx.fillStyle = INK
      y = wrap(ctx, para, x, y, FACE - 160, 43) + 20
    }
  }
  const mk = p.making || {}
  col(80, 'WHAT IT IS', [p.what || '', mk.problem || ''].filter(Boolean))
  col(FACE + 80, 'WHAT I BUILT', p.built || [])
}

export async function gatefoldTextures(p, shelf) {
  const n = gatefoldPlan(p).length
  const [c, ctx] = canvas(FACE * n, FACE)
  if (p.journey?.length) drawJourney(ctx, p, shelf)
  else if (p.steps?.length) drawSteps(ctx, p, shelf)
  else drawPair(ctx, p, shelf)
  grain(ctx, FACE * n, FACE, 0.025)
  const faces = []
  for (let i = 0; i < n; i++) {
    const [fc, fx] = canvas(FACE, FACE)
    fx.drawImage(c, i * FACE, 0, FACE, FACE, 0, 0, FACE, FACE)
    faces.push(toTexture(fc))
  }
  return { faces, cover: await ldFront(p, shelf), back: ldBack(p, shelf) }
}

// The disc's face: mirror silver with the grooves' rings, and the special edition's center label.
export function discLabel(p, shelf) {
  const n = 1024
  const [c, ctx] = canvas(n, n)
  const g = ctx.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n / 2)
  g.addColorStop(0, '#f1f3f6')
  g.addColorStop(0.6, '#c9ced6')
  g.addColorStop(1, '#eef0f3')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, n, n)
  ctx.strokeStyle = 'rgba(90,100,120,0.12)'
  for (let r = n * 0.2; r < n / 2; r += 6) {
    ctx.lineWidth = (r % 4) + 1
    ctx.beginPath()
    ctx.arc(n / 2, n / 2, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n * 0.19, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = foil(ctx, n * 0.3, n * 0.3, n * 0.4, n * 0.4)
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n * 0.17, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n * 0.02, 0, Math.PI * 2)
  ctx.fill()
  // everything printed stays on the gold: the title above the spindle hole, shrunk to fit and put
  // on two lines when one won't go, the small print below it clear of the black ring
  const R = n * 0.17 - 16
  const chord = (dy) => 2 * Math.sqrt(Math.max(0, R * R - dy * dy))
  const title = p.title.toUpperCase()
  const words = title.split(' ')
  const fits = (ls, s) => {
    ctx.font = `900 ${s}px ${TITLE}`
    return ls.every((l, i) => ctx.measureText(l).width <= chord(-44 - (ls.length - 1 - i) * s * 1.02 - s * 0.78))
  }
  let set = null
  for (let s = 46; s >= 34 && !set; s -= 2) if (fits([title], s)) set = { s, ls: [title] }
  for (let s = 46; s >= 18 && !set && words.length > 1; s -= 2) {
    ctx.font = `900 ${s}px ${TITLE}`
    const splits = words.slice(1).map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')])
    const best = splits.reduce((a, b) => (Math.max(...b.map((l) => ctx.measureText(l).width)) < Math.max(...a.map((l) => ctx.measureText(l).width)) ? b : a))
    if (fits(best, s)) set = { s, ls: best }
  }
  set = set || { s: fit(ctx, title, TITLE, 900, chord(80), 46, 18), ls: [title] }
  set.ls.forEach((l, i) => text(ctx, l, n / 2, n / 2 - 44 - (set.ls.length - 1 - i) * set.s * 1.02, set.s, INK, 900, TITLE, 'center'))
  const ed = 'SIDE A · SPECIAL EDITION'
  text(ctx, ed, n / 2, n / 2 + 64, fit(ctx, ed, TYPE, 700, chord(68), 26, 14), INK, 700, TYPE, 'center')
  text(ctx, catalog(p, shelf), n / 2, n / 2 + 102, 22, INK, 700, TYPE, 'center')
  return toTexture(c)
}

// The rainbow a LaserDisc throws off: it stays where the light is while the disc turns under it,
// so it's drawn on its own and laid over the spinning disc.
export function discSheen() {
  const n = 512
  const [c, ctx] = canvas(n, n)
  const g = ctx.createConicGradient(-0.6, n / 2, n / 2)
  const bands = ['rgba(255,80,120,0)', 'rgba(255,90,120,0.5)', 'rgba(255,210,90,0.55)', 'rgba(120,255,170,0.5)', 'rgba(90,170,255,0.55)', 'rgba(190,110,255,0.45)', 'rgba(190,110,255,0)']
  bands.forEach((b, i) => g.addColorStop((i / (bands.length - 1)) * 0.22, b))
  bands.forEach((b, i) => g.addColorStop(0.5 + (i / (bands.length - 1)) * 0.22, b))
  g.addColorStop(0.99, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2)
  ctx.arc(n / 2, n / 2, n * 0.2, 0, Math.PI * 2, true)
  ctx.fill()
  return toTexture(c)
}
