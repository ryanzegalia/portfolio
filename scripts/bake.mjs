// node scripts/bake.mjs   (runs before `vite build`)
// Draws every printed surface of the site once, with the site's own drawing code in headless Chrome,
// and saves each texture as a WebP under public/baked/ plus public/baked/manifest.json, which
// src/three/printed.js reads so the live page loads images instead of drawing. If Chrome or
// playwright-core can't be found the bake is skipped (the old bake removed) and the site draws as before.
// env: BAKE_Q (WebP quality, default 0.8: 29 MB, text reads the same at 1:1), BAKE_CACHE_DIR (vite's cache for the bake server),
// CHROME_PATH, PLAYWRIGHT_CORE (path to a playwright-core install), BAKE_PNG=<dir> with BAKE_PNG_MATCH=<regex>
// (also save the matching surfaces as lossless PNGs there, to compare against the WebPs).
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public/baked')
const Q = +(process.env.BAKE_Q || 0.8)
const t0 = Date.now()

async function playwright() {
  const tries = [process.env.PLAYWRIGHT_CORE, join(root, 'node_modules/playwright-core/')]
  for (const p of tries.filter(Boolean)) {
    try {
      return createRequire(p.endsWith('/') ? p : p + '/')('playwright-core')
    } catch {}
  }
  return null
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

rmSync(out, { recursive: true, force: true })
const pw = await playwright()
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p))
if (!pw || !chrome) {
  console.warn(`[bake] skipped (${!pw ? 'no playwright-core' : 'no Chrome'}): the site will draw its surfaces in the browser`)
  process.exit(0)
}

const { createServer } = await import('vite')
const port = await freePort()
const server = await createServer({
  root,
  configFile: join(root, 'vite.config.js'),
  cacheDir: process.env.BAKE_CACHE_DIR || join(tmpdir(), `shelf-bake-vite-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`),
  // node_modules may be a link to another checkout: let vite serve the fonts from there too
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } },
  logLevel: 'warn',
})
await server.listen()
const browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let failed = 0
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on('pageerror', (e) => console.warn(`[bake] page error: ${e.message}`))
  await page.goto(`http://127.0.0.1:${port}/?bake`, { waitUntil: 'networkidle' })
  const list = await page.evaluate(async () => {
    const { PROJECTS } = await import('/src/projects.js')
    const { SHELVES } = await import('/src/shelves.js')
    const { bakeCalls } = await import('/src/three/printed.js')
    const FONTS = ['900 100px "Big Shoulders Display"', '700 100px "Big Shoulders Display"', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"', '400 40px "Barlow Condensed"', '700 30px "Courier Prime"', '400 30px "Courier Prime"']
    await Promise.all(FONTS.map((f) => document.fonts.load(f)))
    const missing = FONTS.filter((f) => !document.fonts.check(f))
    if (missing.length) throw new Error(`fonts did not load: ${missing.join(', ')}`)
    return bakeCalls(PROJECTS, SHELVES).map(({ key, row, slug }) => ({ key, row, slug }))
  })
  const entries = {}
  let bytes = 0
  for (let i = 0; i < list.length; i++) {
    const { key, row, slug } = list[i]
    const png = !!process.env.BAKE_PNG && new RegExp(process.env.BAKE_PNG_MATCH || '.').test(key)
    const res = await page.evaluate(async ({ i, Q, png }) => {
      const { PROJECTS } = await import('/src/projects.js')
      const { SHELVES } = await import('/src/shelves.js')
      const { bakeCalls, RAW } = await import('/src/three/printed.js')
      const { CASE_SURFACES, wallSurfaceLimit, wallDimensions } = await import('/src/three/printed-tiers.js')
      const call = bakeCalls(PROJECTS, SHELVES)[i]
      const files = []
      const P = ['flipY', 'premultiplyAlpha', 'colorSpace', 'anisotropy', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'generateMipmaps', 'rotation']
      const walk = (v, name) => {
        if (v && v.isTexture) {
          let c = v.image
          if (!c || !c.width) throw new Error(`${name}: texture without an image`)
          if (!(c instanceof HTMLCanvasElement)) {
            const d = document.createElement('canvas')
            d.width = c.width
            d.height = c.height
            d.getContext('2d').drawImage(c, 0, 0)
            c = d
          }
          const index = files.length
          files.push([name, c.toDataURL('image/webp', Q), png ? c.toDataURL('image/png') : null])
          const p = Object.fromEntries(P.map((k) => [k, v[k]]))
          Object.assign(p, { repeat: v.repeat.toArray(), offset: v.offset.toArray(), center: v.center.toArray() })
          const shape = { $t: index, w: c.width, h: c.height, p }
          if (CASE_SURFACES.has(call.name)) for (const [tier, limit] of [['wall', wallSurfaceLimit(call.name)], ['phone', wallSurfaceLimit(call.name, true)]]) {
            const small = document.createElement('canvas')
            ;[small.width, small.height] = wallDimensions(c.width, c.height, limit)
            const g = small.getContext('2d')
            g.imageSmoothingQuality = 'high'
            g.drawImage(c, 0, 0, small.width, small.height)
            shape[tier] = { $t: files.length, w: small.width, h: small.height, p }
            files.push([`${name}-${tier}`, small.toDataURL('image/webp', Q), null])
          }
          return shape
        }
        if (Array.isArray(v)) return v.map((x, j) => walk(x, `${name}-${String(j + 1).padStart(2, '0')}`))
        if (v && typeof v === 'object') {
          if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`${name}: can't bake a ${v.constructor?.name}`)
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${name}-${k}`)]))
        }
        if (typeof v === 'function') throw new Error(`${name}: can't bake a function`)
        return v
      }
      try {
        const shape = walk(await RAW[call.name](...call.args), call.name)
        return { shape, files }
      } catch (e) {
        return { error: e.message }
      }
    }, { i, Q, png })
    if (res.error) {
      failed++
      console.warn(`[bake] ${key}: ${res.error} (it will be drawn in the browser)`)
      continue
    }
    const dir = key.split('/').slice(1, 2).join('') || 'shared'
    const names = res.files.map(([name, url, lossless]) => {
      if (lossless) {
        mkdirSync(join(process.env.BAKE_PNG, dir), { recursive: true })
        writeFileSync(join(process.env.BAKE_PNG, dir, `${name}.png`), Buffer.from(lossless.split(',')[1], 'base64'))
      }
      const buf = Buffer.from(url.split(',')[1], 'base64')
      const file = `${dir}/${name}-${createHash('sha1').update(buf).digest('hex').slice(0, 8)}.webp`
      mkdirSync(join(out, dir), { recursive: true })
      writeFileSync(join(out, file), buf)
      bytes += buf.length
      return file
    })
    const fix = (s) => (s && typeof s === 'object' ? (Array.isArray(s) ? s.map(fix) : Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === '$t' ? names[v] : fix(v)]))) : s)
    entries[key] = { row, slug, shape: fix(res.shape) }
  }
  let environment = null
  try {
    const encoded = await page.evaluate(async () => (await import('/src/three/StudioEnvironment.jsx')).bakeEnvironment())
    const data = gzipSync(Buffer.from(encoded, 'base64'), { level: 9 })
    environment = `studio-${createHash('sha1').update(data).digest('hex').slice(0, 8)}.bin.gz`
    writeFileSync(join(out, environment), data)
    console.log(`[bake] studio reflection map: ${(data.length / 1024).toFixed(0)} KB`)
  } catch (error) {
    // A missing lighting bake must not throw away successfully baked printing.
    console.warn(`[bake] studio lighting will render live: ${error.message}`)
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ q: Q, entries, environment }))
  console.log(`[bake] ${Object.keys(entries).length} of ${list.length} surfaces baked, ${(bytes / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s${failed ? `, ${failed} left to draw live` : ''}`)
} catch (e) {
  console.warn(`[bake] failed, the site will draw its surfaces in the browser: ${e.message}`)
  rmSync(out, { recursive: true, force: true })
} finally {
  await browser.close()
  await server.close()
}
