/**
 * The empty pane's duck, as ASCII.
 *
 * Nothing here is a fixed picture: every frame is a character grid built from
 * scratch, so the motion is the glyphs changing rather than a bitmap slid
 * around by CSS. That is what makes it read as terminal art — the duck's edge
 * dissolves and re-forms as it rides the swell, and the water is only ever
 * `~-_` finding new columns to sit in.
 *
 * The duck itself is traced from `src-tauri/icons/Square310x310Logo.png`,
 * cropped to x 34..281, y 98..204 — the bird down to, but not including, the
 * icon's own waterline. It is stored as vertical spans rather than a grid of
 * characters so it can be sampled at *any* resolution: a wide pane gets a
 * seventy-column duck, a cramped split gets a fifteen-column one, and neither
 * is a resized copy of the other.
 */

/** The crop the spans live in, in icon pixels. */
const SRC_W = 247;
const SRC_H = 106;

/** Stored columns across that crop, two icon pixels each. */
const SPAN_COLS = 124;

/**
 * Four base36 pairs per column: two vertical spans as `[top, bottom)` in crop
 * pixels. Two, because the throat columns have background between the head and
 * the breast. An empty span is `bottom <= top`, which the overlap maths below
 * already treats as nothing.
 */
const SPAN_DATA =
  "13140000101600000z1700000y1700000y1700000x1700000x1700000w1700000v1700000u1700000t1600000s1600000q1600000p1500000n1500000i1400000e142b2t0b14262y0814222y06141z2y05141w2y03151t2y02161r2y01161o2y01171k2y00191f2y002y0000002y0000002y0000002y0000002y0000002y0000012y0000012y0000022y0000032y0000052y0000062y0000082y00000a1s1w2y0d1l1z2y0h1f1z2y0m181z2y1y2y00001y2y00001x2y00001w2y00001v2y00001u2y00001t2y00001s2y00001s2y00001r2y00001q2y00001p2y00001p2y00001o2y00001o2y00001n2y00001n2y00001m2y00001m2y00001m2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001m2y00001m2y00001m2y00001m2y00001m2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001m2y00001m2y00001m2y00001m2y00001l2y00001l2y00001l2y00001k2y00001j2y00001i2y00001i2x00001h2w00001g2u00001f2s00001e2q00001d1q1s2o1c1n1r2m1b1k1r2j1c1e202h1p1w202e1o1u1z2c1o1s1z2a1y2800001y2600001x2400001x210000";

const SPANS = (() => {
  const out = new Int16Array(SPAN_COLS * 4);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(SPAN_DATA.slice(i * 2, i * 2 + 2), 36);
  return out;
})();

/**
 * How much of the cell `[x0,x1) × [y0,y1)` — crop pixels — the duck fills.
 * Exact in y, averaged over the stored columns in x, which is why the edges
 * land on the soft end of the ramp instead of stair-stepping.
 */
function coverage(x0: number, x1: number, y0: number, y1: number): number {
  const first = Math.max(0, Math.min(SPAN_COLS - 1, Math.floor((x0 / SRC_W) * SPAN_COLS)));
  const last = Math.max(first + 1, Math.min(SPAN_COLS, Math.ceil((x1 / SRC_W) * SPAN_COLS)));
  let ink = 0;
  for (let c = first; c < last; c++) {
    const i = c * 4;
    ink += Math.max(0, Math.min(SPANS[i + 1], y1) - Math.max(SPANS[i], y0));
    ink += Math.max(0, Math.min(SPANS[i + 3], y1) - Math.max(SPANS[i + 2], y0));
  }
  return ink / ((y1 - y0) * (last - first));
}

/** Dark to light. Coverage picks the glyph; the shimmer nudges the pick. */
const RAMP = " .,:;i1tfLCG08@";

/** Surface glyphs, ordered by where their ink sits inside the cell. */
const SURFACE = "~-_";

const TAU = Math.PI * 2;

/** Shared cadence for every animated duck in the app. */
export const DUCK_FPS = 15;

/** Retained for the standalone walking-frame renderer. */
const WALK_CYCLE_SECONDS = 1.35;

/** Water rows kept below the surface, for the swell to move through. */
const ROWS_BELOW = 3;

/** Keep the pond shallow when a split only has a handful of character rows. */
function waterRows(rows: number): number {
  return Math.min(ROWS_BELOW, Math.max(1, Math.floor(rows / 4)));
}

/** Share of the pane's columns the duck spans, and the ends of the leash. */
const WIDTH_SHARE = 0.52;
const MIN_DUCK_COLS = 12;
const MAX_DUCK_COLS = 76;

/** Its own bob, on top of whatever the wave under it is doing. */
const BOB_ROWS = 0.3;
const BOB_PERIOD = 5.5;

/** Rocking, as a shear across the body: bow up, stern down, and back. */
const ROCK_ROWS = 0.55;
const ROCK_PERIOD = 8.3;

/** How hard the shimmer pushes a cell along the ramp. */
const SHIMMER = 0.24;

export interface DuckLayout {
  /** Character cell size, in px, for the stage element. */
  font: number;
  /** Canvas size in characters. */
  cols: number;
  rows: number;
  /** The duck's own box inside that canvas; rows is fractional on purpose. */
  duckCols: number;
  duckRows: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Cell size for a pond of this size. Small enough that even a stubby split
 * gets a grid worth drawing on — the art scales down with the pane instead of
 * switching itself off.
 */
export function duckFontSize(width: number, height: number): number {
  return clamp(Math.round(Math.min(height / 18, width / 62)), 7, 16);
}

/** Fit the duck to the pond: half the width, or the height, whichever binds. */
export function duckLayout(
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  font: number,
): DuckLayout {
  const cols = Math.max(1, Math.floor(width / cellW));
  const rows = Math.max(1, Math.floor(height / cellH));
  // What one column of duck costs in rows, once the cell's aspect is folded in.
  const rowsPerCol = (SRC_H / SRC_W) * (cellW / cellH);
  const availableDuckRows = Math.max(1, rows - waterRows(rows));
  const duckCols = Math.round(
    clamp(
      Math.min(cols * WIDTH_SHARE, availableDuckRows / rowsPerCol),
      MIN_DUCK_COLS,
      Math.min(MAX_DUCK_COLS, cols),
    ),
  );
  return { font, cols, rows, duckCols, duckRows: Math.max(2, duckCols * rowsPerCol) };
}

/** Surface height for column `c`, in rows below the baseline. */
function wave(c: number, t: number): number {
  return (
    0.42 * Math.sin(c * 0.21 - t * 1.15) +
    0.26 * Math.sin(c * 0.085 - t * 0.42) +
    0.12 * Math.sin(c * 0.5 - t * 2.1)
  );
}

/**
 * Smooth ±1 noise. Two drifting sine products rather than a random number:
 * the texture has to crawl across the duck, not seethe in place, and every
 * frame has to be reproducible from `t` alone.
 */
function shimmer(c: number, r: number, t: number): number {
  return (
    0.6 * Math.sin(c * 0.8 + t * 1.9) * Math.sin(r * 1.6 - t * 1.3) +
    0.4 * Math.sin((c + r * 2) * 0.35 - t * 2.7)
  );
}

export interface DuckFrame {
  /** The bird. */
  duck: string;
  /** The water it sits in, same grid, drawn underneath. */
  water: string;
}

/**
 * Build one frame at time `t` seconds. Pure: same layout and time, same two
 * strings, which keeps the whole animation a function of the clock.
 */
export function renderDuckFrame(layout: DuckLayout, t: number): DuckFrame {
  const { cols, rows, duckCols, duckRows } = layout;

  const baseline = rows - waterRows(rows);
  const surface = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    // In a two-row split the swell still needs to leave part of the top cell
    // dry, otherwise every phase can momentarily push the bird off-canvas.
    surface[c] = clamp(baseline + wave(c, t), Math.min(0.6, rows - 0.2), rows - 0.2);
  }

  const left = Math.floor((cols - duckCols) / 2);
  const centre = clamp(left + (duckCols >> 1), 0, cols - 1);
  // It rides the swell under its middle, then bobs a little on its own.
  const bottom = surface[centre] + BOB_ROWS * Math.sin((TAU * t) / BOB_PERIOD);
  const rock = ROCK_ROWS * Math.sin((TAU * t) / ROCK_PERIOD);

  const bird: string[] = [];
  const pond: string[] = [];

  for (let r = 0; r < rows; r++) {
    let ink = "";
    let wet = "";
    for (let c = 0; c < cols; c++) {
      const s = surface[c];
      const depth = s - r;

      // ---- the bird, drawn only in cells the water has not claimed
      let glyph = " ";
      const dc = c - left;
      if (dc >= 0 && dc < duckCols && depth >= 0.15) {
        const top = bottom - duckRows + (dc / duckCols - 0.5) * rock;
        let y0 = ((r - top) / duckRows) * SRC_H;
        let y1 = ((r + 1 - top) / duckRows) * SRC_H;
        // Past the bottom of the crop we keep sampling its last pixel row, so
        // the body carries on under the water instead of ending in mid-air
        // whenever the duck rides high.
        const over = Math.max(0, y1 - SRC_H);
        y0 -= over;
        y1 -= over;
        if (y1 > 0) {
          const fill =
            coverage((dc / duckCols) * SRC_W, ((dc + 1) / duckCols) * SRC_W, y0, y1) *
            (1 + SHIMMER * shimmer(c, r, t));
          // At two or three rows high a single cell covers so much source art
          // that its average can fall below the first visible ramp step. Keep
          // any genuine coverage visible in that emergency-sized layout.
          const sampled = Math.floor(fill * RAMP.length);
          const step = fill > 0 && rows <= 3 ? Math.max(1, sampled) : sampled;
          glyph = RAMP[clamp(step, 0, RAMP.length - 1)];
        }
      }
      ink += glyph;

      // ---- the water: the surface where it crosses this row, a thin scatter
      // below it so the pond has a body and not just a line
      if (depth >= 0 && depth < 1) wet += SURFACE[depth < 0.34 ? 0 : depth < 0.67 ? 1 : 2];
      else if (depth < 0 && shimmer(c, r, t) > 0.62) wet += ".";
      else wet += " ";
    }
    bird.push(ink);
    pond.push(wet);
  }

  // A two-row split can collapse the whole sampled silhouette between ramp
  // thresholds. Leave a single ink cell as a thumbnail instead of making the
  // animation blink out entirely.
  if (rows <= 3 && !bird.some((line) => /\S/.test(line))) {
    const row = Math.max(0, Math.min(rows - 1, baseline - 1));
    const line = bird[row];
    bird[row] = `${line.slice(0, centre)}${RAMP[Math.floor(RAMP.length * 0.65)]}${line.slice(centre + 1)}`;
  }

  return { duck: bird.join("\n"), water: pond.join("\n") };
}

type Point = readonly [number, number];

function capsule(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const vx = bx - ax;
  const vy = by - ay;
  const length2 = vx * vx + vy * vy;
  const along = length2 === 0 ? 0 : clamp(((x - ax) * vx + (y - ay) * vy) / length2, 0, 1);
  const dx = x - (ax + along * vx);
  const dy = y - (ay + along * vy);
  return dx * dx + dy * dy <= radius * radius;
}

function polygon(x: number, y: number, points: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Legs and feet added beneath the swimming duck's exact body silhouette. */
function walkingLegs(x: number, y: number, t: number, bob: number): boolean {
  const phase = (TAU * t) / WALK_CYCLE_SECONDS;
  // The feet face left with the duck. Each gait is half a cycle apart: the
  // planted foot stays broad on the floor while its partner shortens, lifts,
  // and moves forward before taking the weight.
  for (let index = 0; index < 2; index++) {
    const legPhase = phase + index * Math.PI;
    const swing = 0.048 * Math.cos(legPhase);
    const lift = 0.052 * Math.max(0, Math.sin(legPhase));
    const hipX = index === 0 ? 0.43 : 0.58;
    const hipY = 0.665 + bob;
    const kneeX = hipX + swing * 0.38;
    const kneeY = 0.79 - lift * 0.25;
    const ankleX = hipX + swing;
    const ankleY = 0.875 - lift;

    if (
      capsule(x, y, hipX, hipY, kneeX, kneeY, 0.018) ||
      capsule(x, y, kneeX, kneeY, ankleX, ankleY, 0.017)
    ) {
      return true;
    }

    const footY = 0.925 - lift;
    const footLength = lift > 0.012 ? 0.085 : 0.125;
    const toeX = ankleX - footLength;
    if (
      polygon(x, y, [
        [ankleX + 0.026, footY - 0.026],
        [ankleX - 0.012, footY - 0.038],
        [toeX + 0.035, footY - 0.032],
        [toeX - 0.004, footY - 0.014],
        [toeX + 0.022, footY],
        [toeX - 0.012, footY + 0.018],
        [toeX + 0.04, footY + 0.032],
        [ankleX + 0.026, footY + 0.021],
      ])
    ) {
      return true;
    }
  }

  return false;
}

const WALK_SAMPLES = 3;

/**
 * Build the dry-land duck from its own animated silhouette.
 *
 * Every cell is supersampled from the complete walking pose and converted to
 * the same density ramp as the swimmer. At 15 FPS both the textured edge and
 * the anatomy change; no prepared picture is translated or cross-faded.
 */
export function renderWalkingDuckFrame(layout: DuckLayout, t: number): DuckFrame {
  const { cols, rows, duckCols } = layout;
  const groundRow = Math.max(0, rows - 2);
  const walkRows = Math.max(1, Math.min(groundRow + 1, Math.round(duckCols * 0.35)));
  const top = groundRow - walkRows + 1;
  const left = Math.floor((cols - duckCols) / 2);
  const centre = clamp(left + (duckCols >> 1), 0, cols - 1);
  const bird = Array.from({ length: rows }, () => Array(cols).fill(" "));
  const ground = Array.from({ length: rows }, () => Array(cols).fill(" "));
  const phase = (TAU * t) / WALK_CYCLE_SECONDS;
  const bob = 0.006 * (0.5 + 0.5 * Math.cos(phase * 2));
  // The same traced body the swimming renderer samples, placed high enough to
  // leave room for the legs. Keeping this mapping intact makes head, beak,
  // breast, belly, and tail match between the two empty states.
  const bodyTop = 0.035 + bob;
  const bodyBottom = 0.67 + bob;

  for (let r = Math.max(0, top); r <= groundRow; r++) {
    for (let dc = 0; dc < duckCols; dc++) {
      const c = left + dc;
      if (c < 0 || c >= cols) continue;
      const x0 = dc / duckCols;
      const x1 = (dc + 1) / duckCols;
      const y0 = (r - top) / walkRows;
      const y1 = (r - top + 1) / walkRows;
      let bodyFill = 0;
      if (y1 > bodyTop && y0 < bodyBottom) {
        bodyFill = coverage(
          x0 * SRC_W,
          x1 * SRC_W,
          ((y0 - bodyTop) / (bodyBottom - bodyTop)) * SRC_H,
          ((y1 - bodyTop) / (bodyBottom - bodyTop)) * SRC_H,
        );
      }

      let legHits = 0;
      for (let sy = 0; sy < WALK_SAMPLES; sy++) {
        for (let sx = 0; sx < WALK_SAMPLES; sx++) {
          const x = (dc + (sx + 0.5) / WALK_SAMPLES) / duckCols;
          const y = (r - top + (sy + 0.5) / WALK_SAMPLES) / walkRows;
          if (walkingLegs(x, y, t, bob)) legHits++;
        }
      }
      const legFill = legHits / (WALK_SAMPLES * WALK_SAMPLES);
      const fill = 1 - (1 - bodyFill) * (1 - legFill);
      if (fill <= 0) continue;
      const textured = fill * (1 + SHIMMER * shimmer(c, r, t));
      const step = Math.max(1, Math.floor(textured * RAMP.length));
      bird[r][c] = RAMP[clamp(step, 0, RAMP.length - 1)];
    }
  }

  const offset = Math.floor(t * 3.2);
  const frameIndex = Math.floor(t * DUCK_FPS);
  const near = "__-___..";
  const far = " .     ";
  for (let c = 0; c < cols; c++) {
    ground[groundRow][c] =
      (c + frameIndex) % 29 === 0
        ? "~"
        : near[(c - offset + near.length * 1000) % near.length];
    if (groundRow + 1 < rows) {
      ground[groundRow + 1][c] = far[(c - Math.floor(offset * 0.45) + far.length * 1000) % far.length];
    }
  }

  if (!bird.some((line) => line.some((cell) => cell.trim()))) {
    bird[Math.max(0, groundRow - 1)][centre] = RAMP[Math.floor(RAMP.length * 0.65)];
  }

  return {
    duck: bird.map((line) => line.join("")).join("\n"),
    water: ground.map((line) => line.join("")).join("\n"),
  };
}
