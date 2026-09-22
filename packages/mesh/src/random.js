/**
 * A seeded random number generator, so a simulation run can be repeated exactly.
 *
 * Math.random() cannot do this. A failure found by an unseeded simulation is a story; a failure
 * found by a seeded one is a bug report with a reproduction.
 *
 * mulberry32: small, fast, good enough for deciding which packets to drop. Not for keys.
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  next.chance = (probability) => next() < probability;
  next.pick = (items) => items[Math.floor(next() * items.length)];
  next.shuffled = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  return next;
}
