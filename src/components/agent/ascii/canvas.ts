/**
 * Shared plumbing for the ASCII startup art. Every animation is a pure
 * `(seconds) => string` painter over a fixed character grid; this module owns
 * the grid, the density ramp, and the three ways of filling it.
 *
 * Coordinates: `u` spans ±ASPECT and `v` spans ±1, chosen so that one unit of
 * u and one unit of v cover the same number of screen pixels. Circles drawn in
 * these coordinates come out round despite the cells being taller than wide.
 */
export const W = 28;
export const H = 10;
/** Monospace advance width relative to the (line-height: 1) cell height. */
export const CELL_RATIO = 0.6;
export const ASPECT = (W * CELL_RATIO) / H;
export const RAMP = " .:-=+*▒#%@▓█";
export const TAU = Math.PI * 2;

/** Intensity in 0..1 sampled per cell. */
export type Field = (u: number, v: number, t: number) => number;
/** Seconds since the animation started, in; one rendered frame, out. */
export type Painter = (t: number) => string;

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function shade(value: number): string {
  return RAMP[Math.round(clamp01(value) * (RAMP.length - 1))];
}

export function hash(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function hash2(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise. Cheap, and smooth enough for clouds and fire. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smoothstep(x - xi);
  const fy = smoothstep(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm(x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += noise2(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

export function fieldU(x: number): number {
  return (((x + 0.5) / W) * 2 - 1) * ASPECT;
}

export function fieldV(y: number): number {
  return ((y + 0.5) / H) * 2 - 1;
}

function render(buffer: ArrayLike<number>): string {
  const rows: string[] = [];
  for (let y = 0; y < H; y += 1) {
    let row = "";
    for (let x = 0; x < W; x += 1) row += shade(buffer[y * W + x]);
    rows.push(row);
  }
  return rows.join("\n");
}

/** Sample a continuous field once per cell. */
export function paintField(field: Field, t: number): string {
  const rows: string[] = [];
  for (let y = 0; y < H; y += 1) {
    const v = fieldV(y);
    let row = "";
    for (let x = 0; x < W; x += 1) row += shade(field(fieldU(x), v, t));
    rows.push(row);
  }
  return rows.join("\n");
}

/** Compute an intensity directly per cell, for grid-aligned art. */
export function paintGrid(compute: (x: number, y: number) => number): string {
  const buffer = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) buffer[y * W + x] = compute(x, y);
  }
  return render(buffer);
}

/**
 * Splat-based painter for line art. `plot` takes field coordinates and spreads
 * each sample over the four cells around it, so curves stay smooth instead of
 * stair-stepping. Brightest sample wins, which keeps overlapping strokes clean.
 */
export function paintPlotted(
  draw: (plot: (u: number, v: number, weight: number) => void) => void,
): string {
  const buffer = new Float32Array(W * H);
  const plot = (u: number, v: number, weight: number) => {
    if (weight <= 0) return;
    const gx = ((u / ASPECT + 1) / 2) * W - 0.5;
    const gy = ((v + 1) / 2) * H - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const px = x0 + dx;
        const py = y0 + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const falloff = (1 - Math.abs(gx - px)) * (1 - Math.abs(gy - py));
        if (falloff <= 0) continue;
        const index = py * W + px;
        const lit = weight * Math.min(1, falloff * 1.7);
        if (lit > buffer[index]) buffer[index] = lit;
      }
    }
  };

  draw(plot);
  return render(buffer);
}

/**
 * Drives a simulation that only moves forwards. Painters must stay callable at
 * any `t`, so asking for an earlier generation than the one already reached
 * replays from the seed rather than returning stale state.
 */
export function makeStepper<T>(seed: (epoch: number) => T, step: (state: T) => T, epochLength = 0) {
  let state: T | null = null;
  let generation = -1;
  let epoch = -1;

  return (target: number): T => {
    const wanted = epochLength > 0 ? Math.floor(target / epochLength) : 0;
    if (state === null || target < generation || wanted !== epoch) {
      epoch = wanted;
      state = seed(epoch);
      generation = epochLength > 0 ? wanted * epochLength : 0;
    }
    /* Bound the catch-up so a long-backgrounded tab cannot stall a frame. */
    const limit = Math.min(target, generation + 240);
    while (generation < limit) {
      state = step(state);
      generation += 1;
    }
    return state;
  };
}
