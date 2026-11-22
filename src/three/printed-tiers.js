// Wall art is sampled at shelf distance, not at the in-hand reading distance. Keep two
// baked wall tiers; only the held case and its neighbours need full-resolution GPU copies.
export const WALL_LIMIT = 640
export const PHONE_WALL_LIMIT = 384
const LARGE_FACES = new Set(['pcFront', 'ldFront', 'lpFront', 'vhsFront'])
const SMALL_PARTS = new Set(['tapeShell', 'tapeFace', 'discLabel', 'recordFace', 'trackLabel', 'pcLidTop', 'canBand', 'cartTop'])
export function wallSurfaceLimit(name, phone = false) {
  if (/Back$/.test(name)) return phone ? 192 : 320
  if (SMALL_PARTS.has(name)) return phone ? 192 : 256
  if (LARGE_FACES.has(name)) return phone ? PHONE_WALL_LIMIT : 896
  return phone ? PHONE_WALL_LIMIT : WALL_LIMIT
}
export const CASE_SURFACES = new Set([
  'vhsFront', 'vhsBack', 'vhsSpine', 'tapeFace', 'cartFront', 'cartBack', 'cartTop',
  'trackFront', 'trackBack', 'trackLabel', 'floppyFront', 'floppyBack',
  'cassetteFront', 'cassetteBack', 'cassetteSpine', 'tapeShell',
  'lpFront', 'lpBack', 'recordFace', 'pcFront', 'pcBack', 'pcSide', 'pcLidTop',
  'canFront', 'canBack', 'canBand', 'ldFront', 'ldBack', 'discLabel',
])
export function fullCaseSurface(name, slug, view) {
  if (!CASE_SURFACES.has(name) || !view.slugs.has(slug)) return false
  return !/Back$/.test(name) || (slug === view.slug && view.back)
}
export function wallDimensions(width, height, limit) {
  const scale = Math.min(1, limit / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}
