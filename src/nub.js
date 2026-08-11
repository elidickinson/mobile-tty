// The velocity nub: displacement sets scroll *speed*, not distance, so a fixed
// thumb-sized pad can travel the whole buffer. Constants are the ones accepted
// on device; see docs/numbers.md.

export const DEAD_ZONE = 14
export const DIVISOR = 14
export const EXPONENT = 1.6
export const MAX_V = 45

/** Pixels per frame for a pull of `displacement` pixels. */
export function velocity(displacement, gain = 1) {
  const past = Math.abs(displacement) - DEAD_ZONE
  if (past <= 0) return 0
  return Math.sign(displacement) * Math.min(Math.pow(past / DIVISOR, EXPONENT) * gain, MAX_V)
}
