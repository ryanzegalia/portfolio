// How fast an insert comes out of its case and goes back in. The first insert of each kind of media
// in a visit is the showcase (ctl.show, set by the app as it starts out): the whole motion with every
// moving part given its moment, readable by about 1.2 to 1.4 s and back in by about 0.5 s. Every later
// one of that kind runs at the normal pace: readable by 0.55 to 0.65 s, back in by about 0.35 s.
// Each insert passes how many times longer its own showcase runs; reduced motion cuts to the end.
export const NORMAL = 1.6
export const SHOWCASE = 1.25
export const SHOW = 2.3
export const tempo = (c, show = SHOW) => (c.reduced ? 0.01 : c.show ? show * SHOWCASE : NORMAL)

// A showcase move has weight: a critically damped spring toward the target. From rest it eases in,
// carries, and settles without overshoot. v holds each channel's speed under its key; w is how stiff
// it is (about 3.9 / w seconds to cover nine tenths of the way). Exact for any frame time.
export function spring(v, key, x, target, w, dt) {
  const d = x - target
  const u = v[key] || 0
  const a = u + w * d
  const k = Math.exp(-w * dt)
  v[key] = (u - w * a * dt) * k
  return target + (d + a * dt) * k
}
// ease in and out over the beat a to b (seconds), 0 before it and 1 after
export const beat = (t, a, b) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}
// ease out only, with a long soft tail: for the settle at the end of a move
export const settle = (t, a, b) => 1 - (1 - Math.min(1, Math.max(0, (t - a) / (b - a)))) ** 4
