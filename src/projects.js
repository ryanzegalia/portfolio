// Every folder in content/projects is one item on the shelf: project.json plus optional photo.
const data = import.meta.glob('/content/projects/*/project.json', { eager: true, import: 'default' })
const stats = import.meta.glob('/content/projects/*/stats.json', { eager: true, import: 'default' })
const images = import.meta.glob('/content/projects/*/*.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' })

export const PROJECTS = Object.entries(data)
  .map(([path, p]) => {
    const dir = path.replace(/\/project\.json$/, '')
    const slug = dir.split('/').pop()
    const img = (name) => images[`${dir}/${name}`] || null
    return { ...p, slug, img, stats: stats[`${dir}/stats.json`] || null, photoUrl: p.photo ? img(p.photo) : null }
  })
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

export const byShelf = (id) => PROJECTS.filter((p) => p.shelf === id)

const COVER_CAPTIONS = {
  '1-vs-100': 'the show controls, current question and Mob totals.',
  'car-thing-vitals': 'the Car Thing system-vitals dashboard.',
  'ds-widescreen': 'a kart race filling the widescreen display.',
  'every-site-in-the-house': 'the house site directory with service status rows.',
  fatterdarr: 'the encoding dashboard with its queue and active jobs.',
  fatterdex: 'the living Pokédex, box by box.',
  fatterpad: 'the Thor input test with button and stick readouts.',
  fatterplay: 'the game-library home screen and its featured title.',
  fatterwatch: 'an investigation report tracing a drive alert to a USB disconnect.',
  'fmp-astrology-days': 'a paid ticket confirmation on the event page.',
  'fmp-boystrip': 'the shared trip calendar with open, maybe and out days.',
  'fmp-chunky-swag': 'the Chunky 2027 landing page and sign-up.',
  'fmp-fatter-tracker': 'the live game scoreboard with four player panels.',
  'fmp-fatterjam': 'the TV player beside its phone remote.',
  'fmp-hat-tracker': 'the win-loss board and Hot Takes list.',
  'fmp-the-bethlmite': 'the postcard map and its location pins.',
  'home-server': 'the server overview with system meters and running containers.',
  'jellyfin-home-screen': 'the Fatterflix home screen with its featured film and collections.',
  'mt-box-art-while-i-sleep': 'a contact sheet of finished game covers.',
  'mt-campaign-chronicler': 'a recorded game session split into chapters.',
  'mt-find-anything': 'a terminal search and its four matching files.',
  'mt-gpu-traffic-cop': 'the GPU scheduler priority table and recent activity.',
  'mt-one-save-everywhere': 'the save bridge status and its latest checks.',
  'mt-upstream-watch': 'the watcher’s morning release post.',
  'offline-achievements': 'a retro game with its saved-offline achievement notice.',
  'pinball-two-screens': 'the pinball table running across both screens.',
  'pokebonk-two-screens': 'the Pokédex and collection views across two screens.',
  'pokedaisy-on-the-thor': 'the companion’s party and battle screens.',
  rgos: 'the two-screen game library and its system shelves.',
  'the-alert-desk': 'the alert queue with severity and status counts.',
  'the-library': 'the game library grouped by system.',
  'the-nightly-backup': 'the backup dashboard, health strip and recent-run calendar.',
  'the-rental-store': 'the working 3D rental-store view.',
  'thor-both-ways': "the SteamOS library's On This Thor tab.",
  'thor-bottom-screen': 'the Thor’s top-screen library and bottom-screen controls.',
  'two-boxes-one-address': 'the two-box failover check in a terminal.',
  'vin-fatterflix-look': 'the Fatterflix sign-in screen and its custom look.',
  'vin-fatterverse': 'the session galaxy in its wall-display view.',
  'vin-fatterwall': 'the projector HUD with its clock and system notes.',
  'vin-picture-to-part': 'the rendered rack vent with its printed lattice.',
  'vin-wasteland-nine': 'the game scene with its character and action panels.',
  'watch-your-watts': 'the power dashboard with live load, cost and history.',
  'wow-on-thor': 'the game on the top screen and its utility view below.',
}

export function coverStill(p) {
  if (!p?.photoUrl || p.shelf === 'on-the-clock' || p.shelf === 'how-things-ship') return null
  return { src: p.photoUrl, caption: `The cover picture: ${COVER_CAPTIONS[p.slug] || p.title}` }
}

export const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export const fmtMonth = (d) => new Date(`${d.slice(0, 7)}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

// One sourced start date, shared by printed surfaces and the plain reader.
export function numbers(p) {
  const s = p.stats || {}
  // project.json `started` wins (the 8-track cover reads the same order), then stats.json
  const first = p.started || p.history?.started || s.started || s.first
  const items = first ? [['Started', fmtMonth(first)]] : []
  return { items, note: '' }
}
