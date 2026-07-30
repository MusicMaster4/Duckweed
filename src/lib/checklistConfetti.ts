/**
 * Short-lived ASCII celebration for the tools checklist all-clear moment.
 *
 * Pure `seconds -> frame` painter so tests can sample frames without React.
 * Sparse glyphs drift through the panel, changing character as they fall.
 * This keeps the effect in the same low-fi language as the app's ambient ASCII
 * scenes instead of reading as a conventional particle overlay.
 */

/** How long new flakes keep spawning from the top. */
export const CONFETTI_SPAWN_S = 1.45;

/**
 * Seconds for the slowest flake to travel from top to bottom.
 * Faster flakes finish earlier; duration below waits for the slow ones.
 */
export const CONFETTI_FALL_S = 3.35;

/** Full celebration lifetime before the overlay unmounts. */
export const CONFETTI_DURATION_S = CONFETTI_SPAWN_S + CONFETTI_FALL_S + 0.25;

export const CONFETTI_DURATION_MS = Math.round(CONFETTI_DURATION_S * 1000);

/**
 * Tall grid sized by CSS to fill the checklist height. Row H-1 is the visual
 * bottom of the panel.
 */
export const CONFETTI_W = 40;
export const CONFETTI_H = 32;

/**
 * The density ramp mirrors the shared ASCII canvas. Each flake walks through
 * it at its own tempo, which creates the characteristic flicker of the app's
 * field animations without randomizing the painter.
 */
const GLYPH_RAMP = ".:+*x#%@";
const FLAKE_COUNT = 68;
const GLYPH_RATE = 8;

/**
 * Whether the celebration overlay should still be mounted at time `t`
 * (seconds since the all-clear edge).
 */
export function confettiActive(t: number): boolean {
  return t >= 0 && t < CONFETTI_DURATION_S;
}

/**
 * Falling, morphing ASCII confetti.
 *
 * Deterministic in `t`. Spawns only during {@link CONFETTI_SPAWN_S}; every flake
 * reaches the bottom before it dies. Position moves slowly while glyph density
 * changes more quickly, so the eye reads a living ASCII field instead of fixed
 * symbols translated down the panel.
 */
export function paintChecklistConfetti(t: number): string {
  const grid: string[] = Array.from({ length: CONFETTI_W * CONFETTI_H }, () => " ");

  if (t < 0 || t >= CONFETTI_DURATION_S) return blankFrame();

  const bottom = CONFETTI_H - 1;

  for (let i = 0; i < FLAKE_COUNT; i += 1) {
    // Front-load the burst, then taper arrivals so the effect starts with a
    // clear celebratory beat and settles into a quieter fall.
    const birth = Math.pow(hash(i * 17.3 + 2.1), 1.5) * CONFETTI_SPAWN_S;
    const age = t - birth;
    if (age < 0) continue;

    // A narrow speed range keeps the fall calm while avoiding a rigid curtain.
    const fallTime = CONFETTI_FALL_S * (0.82 + hash(i * 5.9) * 0.18);
    if (age > fallTime) continue;

    const progress = age / fallTime;
    // Nearly linear motion feels like a gentle drift. The small acceleration
    // keeps flakes from appearing parked along the top edge.
    const fallProgress = progress * (0.78 + 0.22 * progress);
    const headY = fallProgress * (bottom + 1.4) - 0.4;
    if (headY < -0.5) continue;

    const x0 = hash(i * 3.7) * (CONFETTI_W - 1);
    const swaySpeed = 0.75 + hash(i * 4.2) * 0.65;
    const swayPhase = hash(i) * Math.PI * 2;
    const swaySize = 0.35 + hash(i * 8.1) * 0.85;
    const x = Math.round(x0 + Math.sin(age * swaySpeed + swayPhase) * swaySize);
    const y = Math.floor(headY);
    if (x < 0 || x >= CONFETTI_W || y < 0 || y >= CONFETTI_H) continue;

    const glyphStep = Math.floor(age * (GLYPH_RATE + hash(i * 9.7) * 4));
    const glyphPhase = Math.floor(hash(i * 13.1 + 0.3) * GLYPH_RAMP.length);
    // A triangle wave moves from faint to dense and back. Neighboring flakes
    // have different periods, so the field shimmers without flashing in sync.
    const cycle = (glyphStep + glyphPhase) % (GLYPH_RAMP.length * 2 - 2);
    const rampIndex =
      cycle < GLYPH_RAMP.length ? cycle : GLYPH_RAMP.length * 2 - 2 - cycle;
    const idx = y * CONFETTI_W + x;
    grid[idx] = GLYPH_RAMP[rampIndex]!;

    // A small minority leave a one-cell echo. It adds motion continuity while
    // staying far away from the long vertical trails of Matrix-style rain.
    if (hash(i * 19.7) > 0.72 && y > 0) {
      const echo = (y - 1) * CONFETTI_W + x;
      if (grid[echo] === " ") grid[echo] = rampIndex > 3 ? ":" : ".";
    }
  }

  const rows: string[] = [];
  for (let y = 0; y < CONFETTI_H; y += 1) {
    rows.push(grid.slice(y * CONFETTI_W, (y + 1) * CONFETTI_W).join(""));
  }
  return rows.join("\n");
}

function blankFrame(): string {
  const row = " ".repeat(CONFETTI_W);
  return Array.from({ length: CONFETTI_H }, () => row).join("\n");
}

/** Same cheap hash the ASCII painters use; kept local so this module stays pure. */
function hash(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}
