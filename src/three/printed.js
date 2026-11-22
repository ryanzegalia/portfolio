import { wakeShelf, continueShelfMotion } from './motion-wake.js'
// Every printed surface (covers, backs, spines, labels, insert pages) is drawn by the covers-*.js code.
// The build runs that code once in headless Chrome and saves each texture as a WebP (scripts/bake.mjs);
// here each texture function is wrapped so that, when the build baked its result, the images are
// fetched and decoded off the main thread and the same structure is rebuilt around them. Nothing is
// drawn on the page then, and no grain pass runs. Without a bake (dev) the original code draws.
// Wrapped functions always return a promise: callers await everything they get back.
import * as THREE from 'three'
import { fullCaseSurface } from './printed-tiers.js'
import { manifest } from '../baked.js'
import * as covers from './covers.js'
import * as cart from './covers-cart.js'
import * as leaflet from './covers-leaflet.js'
import * as booklet from './covers-booklet.js'
import * as track from './covers-8track.js'
import * as floppy from './covers-floppy.js'
import * as cassette from './covers-cassette.js'
import * as vinyl from './covers-vinyl.js'
import * as pcbox from './covers-pcbox.js'
import * as filmcan from './covers-filmcan.js'
import * as laserdisc from './covers-laserdisc.js'

export const RAW = {
  vhsFront: covers.vhsFront, vhsBack: covers.vhsBack, vhsSpine: covers.vhsSpine, signTexture: covers.signTexture, woodTexture: covers.woodTexture,
  cartFront: cart.cartFront, cartBack: cart.cartBack, cartTop: cart.cartTop, bookletTextures: booklet.bookletTextures,
  tapeFace: leaflet.tapeFace, leafletTextures: leaflet.leafletTextures,
  trackFront: track.trackFront, trackBack: track.trackBack, trackLabel: track.trackLabel, sleeveTextures: track.sleeveTextures,
  floppyFront: floppy.floppyFront, floppyBack: floppy.floppyBack, printoutTextures: floppy.printoutTextures,
  cassetteFront: cassette.cassetteFront, cassetteBack: cassette.cassetteBack, cassetteSpine: cassette.cassetteSpine, tapeShell: cassette.tapeShell, jcardTextures: cassette.jcardTextures,
  lpFront: vinyl.lpFront, lpBack: vinyl.lpBack, recordFace: vinyl.recordFace, recordSheen: vinyl.recordSheen, sleeveSides: vinyl.sleeveSides,
  pcFront: pcbox.pcFront, pcBack: pcbox.pcBack, pcSide: pcbox.pcSide, pcLidTop: pcbox.pcLidTop, manualTextures: pcbox.manualTextures,
  canFront: filmcan.canFront, canBack: filmcan.canBack, canBand: filmcan.canBand, filmTextures: filmcan.filmTextures,
  ldFront: laserdisc.ldFront, ldBack: laserdisc.ldBack, gatefoldTextures: laserdisc.gatefoldTextures, discLabel: laserdisc.discLabel, discSheen: laserdisc.discSheen,
}

// what each case asks for: its own surfaces first, then its insert's
const PER_MEDIA = {
  cartridge: [['cartFront'], ['cartBack'], ['cartTop'], ['bookletTextures']],
  vhs: [['vhsFront'], ['vhsBack'], ['vhsSpine'], ['tapeFace'], ['leafletTextures']],
  '8track': [['trackFront'], ['trackBack'], ['trackLabel'], ['sleeveTextures']],
  floppy: [['floppyFront'], ['floppyBack'], ['printoutTextures']],
  cassette: [['cassetteFront'], ['cassetteBack'], ['tapeShell', 'A'], ['tapeShell', 'B'], ['cassetteSpine'], ['jcardTextures']],
  vinyl: [['lpFront'], ['lpBack'], ['lpBack', true], ['recordFace'], ['sleeveSides']],
  pcbox: [['pcFront'], ['pcBack'], ['pcSide'], ['pcLidTop'], ['manualTextures']],
  filmcan: [['canFront'], ['canBack'], ['canBack', true], ['canBand'], ['filmTextures']],
  laserdisc: [['ldFront'], ['ldBack'], ['ldBack', true], ['discLabel'], ['gatefoldTextures']],
}
const SHARED = { vinyl: 'recordSheen', laserdisc: 'discSheen' }
// the shelf boards' wood, as Scene.jsx's Shelf asks for it
export const WOOD = { board: [[96, 60, 34], 5], back: [[38, 24, 16], 9] }

const part = (a) => (a == null ? '' : a.slug ?? a.code ?? (typeof a === 'object' ? JSON.stringify(a) : String(a)))
export const keyOf = (name, args) => [name, ...args.map(part)].join('/')

// Every call the site makes, in the order the wall needs them (for the bake): rows as App.jsx builds them.
export function bakeCalls(projects, shelves) {
  const rows = Object.keys(shelves).filter((id) => PER_MEDIA[shelves[id].media] && projects.some((p) => p.shelf === id))
  const calls = []
  const add = (name, args, row, slug = null) => calls.push({ key: keyOf(name, args), name, args, row, slug })
  rows.forEach((id, row) => {
    const shelf = shelves[id]
    add('signTexture', [shelf], row)
    add('woodTexture', [WOOD.board[0], WOOD.board[1] + row], row)
    add('woodTexture', [WOOD.back[0], WOOD.back[1] + row], row)
    if (SHARED[shelf.media]) add(SHARED[shelf.media], [], row)
    for (const p of projects.filter((x) => x.shelf === id)) for (const [name, ...extra] of PER_MEDIA[shelf.media]) add(name, [p, shelf, ...extra], row, p.slug)
  })
  return calls
}

const FONTS = ['900 100px "Big Shoulders Display"', '700 100px "Big Shoulders Display"', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"', '400 40px "Barlow Condensed"', '700 30px "Courier Prime"', '400 30px "Courier Prime"']
let fontsP = null
const fonts = () => (fontsP ||= Promise.all(FONTS.map((f) => document.fonts.load(f))))

// Loading order: the shelf in view first, then its neighbours; a pulled-out case's insert jumps the queue.
let focus = 0
let renderer = null
// setPrintFocus is called by the wall's frame loop. Two RAFs plus a short idle beat keep
// insert prefetch off the first wall frame; changing aisle cancels the old idle request.
let idle = null
let scheduledRow = null
export function setPrintFocus(row) {
  focus = row
  if (scheduledRow === row) return
  scheduledRow = row
  clearTimeout(idle)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (focus !== row) return
    idle = setTimeout(() => prefetchShelf(row), 650)
  }))
}
export const setPrintRenderer = (gl) => void (renderer = gl)
const near = (a, b) => (a.urgent ? -1 : Math.abs(a.row - focus) + (a.background ? 0.25 : 0)) - (b.urgent ? -1 : Math.abs(b.row - focus) + (b.background ? 0.25 : 0))

const blobs = new Map()
const waiting = []
let fetching = 0
function pump() {
  waiting.sort(near)
  while (fetching < 6 && waiting.length) {
    const w = waiting.shift()
    fetching++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    fetch(`${import.meta.env.BASE_URL}baked/${w.file}`, { signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() })
      .then(w.resolve, (error) => {
        // A failed promise must never poison the shared cache. Retry at the back of
        // the queue (urgent requests still lead); exhausted attempts draw locally.
        if (++w.attempt < 3) waiting.push(w)
        else { blobs.delete(w.file); w.reject(error) }
      })
      .finally(() => {
        clearTimeout(timeout)
        fetching--
        pump()
      })
  }
}
function blob(file, row, urgent = false, background = false) {
  if (!blobs.has(file)) blobs.set(file, new Promise((resolve, reject) => waiting.push({ file, row, urgent, background, attempt: 0, resolve, reject })))
  else if (urgent) waiting.forEach((w) => w.file === file && (w.urgent = true))
  pump()
  return blobs.get(file)
}

// Textures go to the graphics card a few per frame (about 6 ms of uploads), nearest shelf first, so a
// burst of arrivals never stalls a frame.
const uploads = []
let ticking = false
function tick() {
  const t0 = performance.now()
  uploads.sort(near)
  while (renderer && !renderer.getContext().isContextLost() && uploads.length && performance.now() - t0 < 6) {
    const u = uploads.shift()
    try {
      if (!u.tex.userData.print?.disposed) renderer.initTexture(u.tex)
      u.resolve(u.tex)
    } catch (error) { u.reject(error) }
  }
  ticking = uploads.length > 0
  if (ticking) requestAnimationFrame(tick)
}
function upload(tex, row, urgent) {
  return new Promise((resolve, reject) => {
    uploads.push({ tex, row, urgent, resolve, reject })
    if (!ticking) (ticking = true), requestAnimationFrame(tick)
  })
}

const PROPS = ['colorSpace', 'anisotropy', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'generateMipmaps']
async function texture(d, row, urgent) {
  const b = await blob(d.$t, row, urgent)
  if (!b) throw new Error(`missing ${d.$t}`)
  // WebGL ignores flipY and premultiplyAlpha for ImageBitmaps: the bitmap is made that way instead
  const bmp = await createImageBitmap(b, { imageOrientation: d.p.flipY ? 'flipY' : 'from-image', premultiplyAlpha: d.p.premultiplyAlpha ? 'premultiply' : 'none' })
  const t = new THREE.Texture(bmp)
  for (const k of PROPS) t[k] = d.p[k]
  t.repeat.fromArray(d.p.repeat)
  t.offset.fromArray(d.p.offset)
  t.center.fromArray(d.p.center)
  t.rotation = d.p.rotation
  t.flipY = false
  t.premultiplyAlpha = false
  t.needsUpdate = true
  return upload(t, row, urgent)
}
async function rebuild(s, row, urgent) {
  if (s && s.$t) return texture(s, row, urgent)
  if (Array.isArray(s)) return Promise.all(s.map((x) => rebuild(x, row, urgent)))
  if (s && typeof s === 'object') return Object.fromEntries(await Promise.all(Object.entries(s).map(async ([k, v]) => [k, await rebuild(v, row, urgent)])))
  return s
}
const files = (s, out = []) => {
  if (s && s.$t) out.push(s.$t)
  else if (s && typeof s === 'object') Object.values(s).forEach((v) => files(v, out))
  return out
}

// A complete, correctly sized stock object is returned immediately. Its stable texture
// references survive late uploads: no remount, invisible page, or animation waiting on I/O.
let white = null
function stockImage() {
  if (!white) {
    white = document.createElement('canvas')
    white.width = white.height = 2
    const ctx = white.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 2, 2)
  }
  return white
}
function stockColor(name) {
  if (name === 'recordSheen' || name === 'discSheen') return '#000000'
  if (/^pc(Front|Back|Side|Lid)/.test(name) || name === 'sleeveTextures') return '#c7aa82'
  if (/^can/.test(name) || name === 'discLabel') return '#b9b7b1'
  if (name === 'filmTextures') return '#b99562'
  if (name === 'recordFace' || name === 'tapeShell') return '#353434'
  if (name === 'printoutTextures') return '#dbe4ce'
  return '#e2d8c0'
}
const residents = new Set()
let printView = { slug: null, slugs: new Set(), back: false, phone: typeof matchMedia === 'function' && matchMedia('(max-width: 640px) and (orientation: portrait)').matches }
let viewKey = ''
export function setPrintView(slug, neighbours, back, phone) {
  const key = `${slug}|${neighbours.join(',')}|${back}|${phone}`
  if (key === viewKey) return
  viewKey = key
  printView = { slug, slugs: new Set(slug ? [slug, ...neighbours] : []), back, phone }
  residents.forEach((print) => print.update())
}
const releaseInk = (ink) => { ink?.dispose(); ink?.image?.close?.() }
export function printedMemory() {
  const inks = new Set()
  let full = 0
  for (const print of residents) {
    if (print.wall) inks.add(print.wall)
    if (print.full) { inks.add(print.full); full++ }
  }
  return { residents: residents.size, fullCaseSurfaces: full, inkTextures: inks.size,
    inkBytes: Math.round([...inks].reduce((n, t) => n + t.image.width * t.image.height * 4 * (t.generateMipmaps ? 4 / 3 : 1), 0)) }
}
function stockShape(shape, entry, name, draw) {
  let fallback = null
  const visit = (s, path = []) => {
    if (s?.$t) {
      const t = new THREE.Texture(stockImage())
      for (const k of PROPS) t[k] = s.p[k]
      t.repeat.fromArray(s.p.repeat); t.offset.fromArray(s.p.offset); t.center.fromArray(s.p.center)
      t.rotation = s.p.rotation
      t.flipY = false
      t.needsUpdate = true
      const print = t.userData.print = { stock: new THREE.Color(stockColor(name)), slug: entry.slug, at: Infinity, disposed: false }
      let wallFile = null, fullWanted = false, wallVersion = 0, fullVersion = 0
      const urgent = () => !!entry.slug && entry.slug === urgentSlug.current
      // Only immutable, correctly sized GPU allocations. A cancelled decode/upload is disposed
      // even if its component disappeared before the promise returned.
      const load = async (desc, valid, install) => {
        let ink
        try {
          const options = { imageOrientation: s.p.flipY ? 'flipY' : 'from-image', premultiplyAlpha: s.p.premultiplyAlpha ? 'premultiply' : 'none' }
          let image
          try { image = await createImageBitmap(await blob(desc.$t, entry.row, urgent()), options) }
          catch {
            if (!valid()) return
            const raw = await (fallback ||= draw())
            const source = path.reduce((o, k) => o[k], raw)
            image = await createImageBitmap(source.image, { ...options, imageOrientation: source.flipY ? 'flipY' : 'from-image', resizeWidth: desc.w, resizeHeight: desc.h, resizeQuality: 'high' })
          }
          if (!valid()) { image.close?.(); return }
          ink = new THREE.Texture(image)
          for (const k of PROPS) ink[k] = s.p[k]
          ink.flipY = false
          ink.userData.print = print
          ink.needsUpdate = true
          await upload(ink, entry.row, urgent())
          if (!valid()) { releaseInk(ink); return }
          install(ink)
          wakeShelf()
        } catch (error) {
          releaseInk(ink)
          if (!valid()) return
          console.warn('[printed] retrying local recovery', name, error)
          fallback = null
          blobs.delete(desc.$t)
          setTimeout(() => { if (valid()) load(desc, valid, install) }, 2000)
        }
      }
      print.update = () => {
        const wall = (printView.phone ? s.phone : s.wall) || s
        if (wallFile !== wall.$t) {
          wallFile = wall.$t
          const version = ++wallVersion
          load(wall, () => !print.disposed && wallVersion === version, (ink) => {
            const previous = print.wall
            print.wall = ink
            if (print.full) print.base = ink
            else { print.ink = ink; print.at = performance.now() }
            releaseInk(previous)
          })
        }
        const wanted = !!s.wall && fullCaseSurface(name, entry.slug, printView)
        if (wanted === fullWanted) return
        fullWanted = wanted
        const version = ++fullVersion
        if (wanted) load(s, () => !print.disposed && fullVersion === version && fullWanted, (ink) => {
          print.full = print.ink = ink
          print.base = print.wall
          print.at = performance.now()
        })
        else {
          const previous = print.full
          print.full = print.base = null
          print.ink = print.wall
          print.at = print.wall ? -Infinity : Infinity
          releaseInk(previous)
        }
      }
      residents.add(print)
      t.addEventListener('dispose', () => {
        print.disposed = true
        residents.delete(print)
        releaseInk(print.full)
        releaseInk(print.wall)
        print.ink = print.full = print.wall = print.base = null
      })
      print.update()
      return t
    }
    if (Array.isArray(s)) return s.map((v, i) => visit(v, [...path, i]))
    if (s && typeof s === 'object') return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, visit(v, [...path, k])]))
    return s
  }
  return visit(shape)
}

// One shader mix, not repeated canvas drawing / texture uploads. Paper grain and faint
// rules stay visible while the ink arrives; geometry and its shadows never fade away.
const stockGLSL = `
uniform float uPrintPage;
uniform float uPrintInk;
uniform vec3 uPrintStock;
uniform sampler2D uPrintMap;
uniform sampler2D uPrintBase;
uniform float uPrintBaseReady;
vec4 printStock(vec2 uv) {
  float grain = fract(sin(dot(floor(uv * 900.0), vec2(12.9898,78.233))) * 43758.5453);
  float rule = step(0.975, fract(uv.y * 22.0)) * step(0.09, uv.x) * step(uv.x, 0.91);
  return mix(vec4(uPrintStock * (0.97 + grain * 0.03 - rule * 0.035), 1.0), texture2D(uPrintBase, uv), uPrintBaseReady);
}
// Insert pages are read up close at sizes that rarely match their pictures. Average four taps
// spread over this pixel's footprint, one mip level finer, so thin strokes keep an even weight
// (instead of half-blending with the half-size level), then sharpen gently against a softer read.
// It is the same at every frame, still or moving, so the text never visibly changes.
vec4 printInk(vec2 uv) {
  if (uPrintPage < 0.5) return texture2D(uPrintMap, uv);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec4 ink = texture2D(uPrintMap, uv + 0.125 * dx + 0.375 * dy, -1.0);
  ink += texture2D(uPrintMap, uv - 0.125 * dx - 0.375 * dy, -1.0);
  ink += texture2D(uPrintMap, uv + 0.375 * dx - 0.125 * dy, -1.0);
  ink += texture2D(uPrintMap, uv - 0.375 * dx + 0.125 * dy, -1.0);
  ink *= 0.25;
  return clamp(ink + 0.6 * (ink - texture2D(uPrintMap, uv, 0.5)), 0.0, 1.0);
}
`
const printMaterials = new WeakMap()
export function updatePrintedMaterials(scene) {
  const now = performance.now()
  const update = (material) => {
      const print = material?.map?.userData.print
      if (!print) return
      let uniforms = printMaterials.get(material)
      if (!uniforms) {
        uniforms = { uPrintPage: { value: 0 }, uPrintInk: { value: 0 }, uPrintStock: { value: print.stock }, uPrintMap: { value: material.map }, uPrintBase: { value: material.map }, uPrintBaseReady: { value: 0 } }
        printMaterials.set(material, uniforms)
        const before = material.onBeforeCompile
        const cacheKey = material.customProgramCacheKey.bind(material)
        const originalKey = cacheKey()
        material.customProgramCacheKey = () => `${originalKey}:printed-stock-v3`
        material.onBeforeCompile = function (shader, gl) {
          before.call(this, shader, gl)
          Object.assign(shader.uniforms, uniforms)
          shader.fragmentShader = stockGLSL + shader.fragmentShader
            .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment)
            .replace('diffuseColor *= sampledDiffuseColor;', 'sampledDiffuseColor = mix(printStock(vMapUv), sampledDiffuseColor, uPrintInk); diffuseColor *= sampledDiffuseColor;')
            .replace('#include <emissivemap_fragment>', THREE.ShaderChunk.emissivemap_fragment.replace('totalEmissiveRadiance *= emissiveColor.rgb;', 'totalEmissiveRadiance *= mix(printStock(vEmissiveMapUv).rgb, emissiveColor.rgb, uPrintInk);'))
            .replaceAll('texture2D( map, vMapUv )', 'printInk(vMapUv)')
            .replaceAll('texture2D( emissiveMap, vEmissiveMapUv )', 'printInk(vEmissiveMapUv)')
        }
        material.needsUpdate = true
      }
      const ink = THREE.MathUtils.clamp((now - print.at) / 220, 0, 1)
      if (ink < 1 && Number.isFinite(print.at)) continueShelfMotion()
      uniforms.uPrintInk.value = ink * ink * (3 - 2 * ink)
      uniforms.uPrintPage.value = material.map.userData.page ? 1 : 0
      uniforms.uPrintStock.value = print.stock
      uniforms.uPrintMap.value = print.ink || material.map
      uniforms.uPrintBase.value = print.base || material.map
      uniforms.uPrintBaseReady.value = print.base ? 1 : 0
  }
  scene.traverse((object) => {
    if (Array.isArray(object.material)) for (const material of object.material) update(material)
    else update(object.material)
  })
}

const INSERTS = new Set(['bookletTextures', 'leafletTextures', 'sleeveTextures', 'printoutTextures', 'jcardTextures', 'sleeveSides', 'manualTextures', 'filmTextures', 'gatefoldTextures'])
function prefetchShelf(row) {
  manifest.then((m) => {
    if (!m || focus !== row) return
    for (const [key, e] of Object.entries(m.entries)) if (e.row === row && INSERTS.has(key.split('/')[0])) {
      files(e.shape).forEach((f) => blob(f, row, false, true).catch(() => {}))
    }
  })
}

// Fetch a case's insert images ahead of the tap (called when it comes out of the shelf); its
// textures then also jump the upload queue.
const urgentSlug = { current: null }
export function prefetchPrinted(slug, mark = true) {
  if (mark) urgentSlug.current = slug
  manifest.then((m) => {
    if (!m) return
    for (const e of Object.values(m.entries)) if (e.slug === slug) files(e.shape).forEach((f) => blob(f, e.row, mark, !mark).catch(() => {}))
    // Requests may already be decoded and waiting for the GPU when the case is pulled.
    if (mark) for (const u of uploads) if (u.tex.userData.print?.slug === slug) u.urgent = true
  })
}

// A stalled manifest is no reason to wait forever either: use the existing local
// drawing path. Individual asset requests below have their own abort/retry budget.
const availableManifest = import.meta.env.PROD
  ? Promise.race([manifest, new Promise((resolve) => setTimeout(() => resolve(null), 2500))])
  : manifest
// Mark an insert's pages (not its cover, back or plain paper) for the reading filter in printInk.
const markPages = (shape) => {
  const walk = (value, top) => {
    if (value?.isTexture) {
      value.userData.page = true
      // dev draws straight to canvases; give them the stock shader that production's proxies get
      value.userData.print ||= { stock: new THREE.Color('#ffffff'), at: -Infinity }
    } else if (Array.isArray(value)) value.forEach((v) => walk(v))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!top || !['cover', 'back', 'paper'].includes(k)) walk(v)
  }
  walk(shape, true)
  return shape
}
function printed(name, fn) {
  const pages = INSERTS.has(name) ? markPages : (shape) => shape
  if (!import.meta.env.PROD) return INSERTS.has(name) ? (...args) => Promise.resolve(fn(...args)).then(pages) : fn
  return (...args) =>
    availableManifest.then((m) => {
      const key = keyOf(name, args)
      const e = m && m.entries[key]
      const draw = () => Promise.race([fonts().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => fn(...args))
      if (!e) {
        if (m) console.info(`[printed] not baked, drawing: ${key}`)
        return draw().then(pages)
      }
      // Wood and signage aren't printed stock; keep their existing loader.
      if (['woodTexture', 'signTexture'].includes(name)) return rebuild(e.shape, e.row, !!e.slug && e.slug === urgentSlug.current).catch(draw)
      return pages(stockShape(e.shape, e, name, draw))
    })
}

export const {
  vhsFront, vhsBack, vhsSpine, signTexture, woodTexture, cartFront, cartBack, cartTop, bookletTextures, tapeFace, leafletTextures,
  trackFront, trackBack, trackLabel, sleeveTextures, floppyFront, floppyBack, printoutTextures, cassetteFront, cassetteBack, cassetteSpine, tapeShell,
  jcardTextures, lpFront, lpBack, recordFace, recordSheen, sleeveSides, pcFront, pcBack, pcSide, pcLidTop, manualTextures, canFront,
  canBack, canBand, filmTextures, ldFront, ldBack, gatefoldTextures, discLabel, discSheen,
} = Object.fromEntries(Object.entries(RAW).map(([k, fn]) => [k, printed(k, fn)]))
