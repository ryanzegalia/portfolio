// The list of printed surfaces baked to images at build time (scripts/bake.mjs), fetched as early as the
// page starts. Null in dev, or when the build could not bake: then every surface is drawn as before.
export const manifest = import.meta.env.PROD
  ? fetch(`${import.meta.env.BASE_URL}baked/manifest.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  : Promise.resolve(null)
