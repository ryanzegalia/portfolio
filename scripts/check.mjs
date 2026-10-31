// The rules from the project content schema that a script can enforce. Runs before every build.
// Errors stop the build; warnings are printed for a person to look at.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SHELVES } from '../src/shelves.js'
import { PICKS } from '../src/picks.js'

const ROOT = new URL('../content/projects/', import.meta.url).pathname
const PROJECT_SLUGS = readdirSync(ROOT).sort().filter((slug) => existsSync(join(ROOT, slug, 'project.json')))
// Internal names that mean nothing to a visitor (or leak the house layout).
const INTERNAL = /\b(?:[a-z0-9-]+\.internal\b)|:\d{4,5}\b/i
const errors = []
const warnings = []
// Private vocabulary checks run before export; the list is intentionally not distributed.
const NAMES = null
warnings.push('(all): private vocabulary list absent; publication scanning is separate')
// On the clock is about the work, said plainly: no bragging about my own stuff (Ryan, 2026-10-29)
const BRAG = /\b(most[- ]used|best|record[- ]breaking|world[- ]class|the only one|unmatched|second to none)\b/i

for (const slug of PROJECT_SLUGS) {
  const dir = join(ROOT, slug)
  const file = join(dir, 'project.json')
  const p = JSON.parse(readFileSync(file, 'utf8'))
  const err = (m) => errors.push(`${slug}: ${m}`)
  const warn = (m) => warnings.push(`${slug}: ${m}`)

  // On the clock boxes carry the job, not a project: their own fields, their own rules
  const job = p.shelf === 'on-the-clock'
  const need = job
    ? ['title', 'kicker', 'shelf', 'tagline', 'sticker', 'what', 'does', 'solved', 'worksWith', 'story', 'credit', 'status', 'palette', 'screen']
    : ['title', 'kicker', 'shelf', 'tagline', 'what', 'built', 'credit', 'starring', 'status', 'requirements', 'rating', 'ratingWord', 'palette']
  for (const f of need) {
    if (p[f] === undefined || p[f] === '' || (Array.isArray(p[f]) && !p[f].length)) err(`missing "${f}"`)
  }
  if (job) {
    if (p.does && (p.does.length < 8 || p.does.length > 16)) err(`"does" has ${p.does.length} lines (8 to 16)`)
    for (const d of p.does || []) if (d.length > 90) err(`"does" line over 90 characters: "${d.slice(0, 40)}..."`)
    if (p.solved && (p.solved.length < 3 || p.solved.length > 5)) err(`"solved" has ${p.solved.length} problems (3 to 5)`)
    for (const x of p.solved || []) if (!x.problem || !x.did || !x.ended) err(`a solved problem needs "problem", "did" and "ended"`)
    if ((p.tools || []).length > 8) err(`more than 8 tools`)
    for (const t of p.tools || []) if (!t.name || !t.line || t.name.length > 28) err(`a tool needs a name (28 characters max) and a line`)
    const words = (p.story || []).join(' ').split(/\s+/).length
    if (words < 100 || words > 300) err(`story is ${words} words (100 to 300)`)
    if ((p.sticker || '').length > 64) err(`sticker is over 64 characters`)
    const brag = BRAG.exec(JSON.stringify(p))
    if (brag) err(`brags ("${brag[0]}"): say what was done, plainly`)
  }
  if (p.shelf && !SHELVES[p.shelf]) err(`unknown shelf "${p.shelf}"`)
  if (p.tagline?.length > 80) err(`tagline is ${p.tagline.length} characters (max 80)`)
  if (!job && p.built && (p.built.length < 2 || p.built.length > 5)) err(`"built" has ${p.built.length} bullets (2 to 5)`)
  for (const b of p.built || []) if (b.length > 120) err(`"built" bullet over 120 characters: "${b.slice(0, 40)}..."`)
  if (p.requirements && p.requirements.length > 6) err(`"requirements" has ${p.requirements.length} items (max 6)`)
  if (p.rating && !/^[A-Z]$/.test(p.rating)) err(`rating must be one capital letter`)
  if (p.remix) {
    for (const f of ['of', 'by', 'changed']) if (!p.remix[f]) err(`remix is missing "${f}"`)
    if (!/remix/i.test(p.credit || '')) err(`it's a remix, so the credit has to say so`)
  }
  if (p.photo && !existsSync(join(dir, p.photo))) err(`photo "${p.photo}" not found`)
  if (!job && !p.photo && !p.art) warn(`no photo and no drawn art: add a real photo`)
  else if (!job && !p.photo) warn(`no real photo yet (drawn art for now): put it on the photo list`)

  const mk = p.making
  if (!mk && !job) warn(`no insert yet ("making")`)
  else if (mk) {
    if (!mk.problem) warn(`insert has no "problem"`)
    if (mk.how && (mk.how.length < 2 || mk.how.length > 4)) err(`insert "how" has ${mk.how.length} steps (2 to 4)`)
    for (const b of mk.broke || []) if (!b.title || !b.body) err(`a "broke" story needs a title and a body`)
    for (const x of mk.proof || []) {
      if (!x.caption) err(`every proof item needs a caption`)
      if (x.type === 'image' && !existsSync(join(dir, x.src))) err(`proof image "${x.src}" not found`)
    }
    if (!mk.credits?.length) warn(`insert has no credits`)
  }
  if (p.history && (p.history.git || p.history.gitea) && !existsSync(join(dir, 'stats.json'))) err(`has a history source but no stats.json: run npm run stats`)

  const text = JSON.stringify({ ...p, palette: undefined, history: undefined, photo: undefined })
  const leak = INTERNAL.exec(text)
  if (leak) err(`uses an internal name a visitor won't know: "${leak[0]}"`)
  if (text.includes('—')) err(`contains an em dash`)
  if (/\[R\d+\]/.test(text)) err(`still carries a results-bank row id like [R26]: that's for us, not the site`)
  const name = NAMES && NAMES.exec(text)
  if (name) err(`names something from work ("${name[0]}"): use a generic word`)
}

const knownSlugs = new Set(PROJECT_SLUGS)
for (const slug of PROJECT_SLUGS) {
  const picks = PICKS[slug]
  if (!Array.isArray(picks) || picks.length !== 2) {
    errors.push(`${slug}: needs exactly two staff picks (has ${Array.isArray(picks) ? picks.length : 0})`)
    continue
  }
  for (const pick of picks) if (!knownSlugs.has(pick?.slug)) errors.push(`${slug}: staff pick names unknown case "${pick?.slug}"`)
}

for (const w of warnings) console.log(`  warn  ${w}`)
for (const e of errors) console.log(`  ERROR ${e}`)
console.log(`${warnings.length} warnings`)
console.log(`${errors.length} errors`)
process.exit(errors.length ? 1 : 0)
