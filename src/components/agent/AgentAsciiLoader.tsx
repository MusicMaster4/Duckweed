import { useEffect, useState } from "react";

import type { AgentId } from "../../lib/agents/types";

/**
 * Startup animations are rendered per frame from a small signed field instead of
 * a handful of canned strings, so each provider gets motion that actually reads
 * as its own mark: Codex weaves strands, Claude pulses its starburst, Grok fires
 * diagonal comets, Cursor spins a wireframe cube, opencode rains glyphs.
 */
const W = 28;
const H = 10;
/** Monospace advance width relative to the (line-height: 1) cell height. */
const CELL_RATIO = 0.6;
const ASPECT = (W * CELL_RATIO) / H;
const RAMP = " .:-=+*▒#%@▓█";
const FPS = 24;

type Field = (u: number, v: number, t: number) => number;
type Painter = (t: number) => string;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function shade(value: number): string {
  return RAMP[Math.round(clamp01(value) * (RAMP.length - 1))];
}

function hash(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function paintField(field: Field, t: number): string {
  const rows: string[] = [];
  for (let y = 0; y < H; y += 1) {
    const v = ((y + 0.5) / H) * 2 - 1;
    let row = "";
    for (let x = 0; x < W; x += 1) {
      const u = (((x + 0.5) / W) * 2 - 1) * ASPECT;
      row += shade(field(u, v, t));
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Splat-based painter for line art: plot() takes field coords, not cells. */
function paintPlotted(draw: (plot: (u: number, v: number, weight: number) => void) => void): string {
  const buffer = new Float32Array(W * H);
  const plot = (u: number, v: number, weight: number) => {
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

  const rows: string[] = [];
  for (let y = 0; y < H; y += 1) {
    let row = "";
    for (let x = 0; x < W; x += 1) row += shade(buffer[y * W + x]);
    rows.push(row);
  }
  return rows.join("\n");
}

/* -- Codex: three strands weaving past each other, like the OpenAI knot --- */

const BRAID_STRANDS = 2;
const BRAID_SAMPLES = 180;

function paintBraid(t: number): string {
  return paintPlotted((plot) => {
    for (let strand = 0; strand < BRAID_STRANDS; strand += 1) {
      const phase = (strand / BRAID_STRANDS) * Math.PI * 2;
      for (let sample = 0; sample <= BRAID_SAMPLES; sample += 1) {
        const u = (sample / BRAID_SAMPLES) * ASPECT * 2 - ASPECT;
        /* Pinch the braid at both ends so it reads as one knot, not wallpaper. */
        const envelope = Math.cos((u / ASPECT) * (Math.PI / 2));
        const angle = u * 1.3 - t * 2.2 + phase;
        /* cos() stands in for depth: a strand brightens as it swings forward. */
        const depth = (Math.cos(angle) + 1) / 2;
        plot(
          u,
          Math.sin(angle) * 0.8 * Math.pow(envelope, 0.55),
          (0.2 + 0.8 * depth * depth) * Math.pow(envelope, 0.45),
        );
      }
    }
  });
}

/* -- Claude: a twelve-ray starburst breathing out from the core ----------- */

const CLAUDE_RAYS = 12;

const claudeField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  const theta = Math.atan2(v, u);
  let best = Math.exp(-(radius * radius) / 0.03);
  for (let k = 0; k < CLAUDE_RAYS; k += 1) {
    const angle = (k / CLAUDE_RAYS) * Math.PI * 2 + t * 0.22;
    const delta =
      (((theta - angle + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    /* delta * radius is the perpendicular distance, so rays keep one width. */
    const offset = delta * radius;
    const spine = Math.exp(-(offset * offset) / 0.0075);
    if (spine < 0.05) continue;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.6 - (k % 6) * 0.52);
    const reach = 0.5 + 0.42 * pulse;
    const along = Math.exp(-Math.pow(radius / reach, 4));
    best = Math.max(best, spine * along * (0.45 + 0.55 * pulse));
  }
  return best;
};

/* -- Grok: comet streaks running the logo's lower-left → upper-right sweep - */

const GROK_LANES = 7;

const grokField: Field = (u, v, t) => {
  const along = u * 0.82 - v * 0.57;
  const across = u * 0.57 + v * 0.82;
  let best = 0;
  for (let k = 0; k < GROK_LANES; k += 1) {
    const cycle = (t * 0.45 + k * 0.29) % 1;
    const head = -2.4 + cycle * 5.2;
    const lead = head - along;
    /* Sharp leading edge, exponential tail dragging behind the head. */
    const body = lead < 0 ? Math.exp(-(lead * lead) / 0.02) : Math.exp(-lead / 0.36);
    const lane = Math.exp(-Math.pow((across - (k - (GROK_LANES - 1) / 2) * 0.42) / 0.3, 2));
    const streak = body * lane;
    if (streak > best) best = streak;
  }
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.95), 5) * 1.0);
  return best * vignette * 1.3;
};

/* -- Cursor: an actual rotating wireframe cube ---------------------------- */

const CUBE_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

const CUBE_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

function paintCube(t: number): string {
  const yaw = t * 1.1;
  const pitch = 0.5 + Math.sin(t * 0.6) * 0.3;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  const projected = CUBE_VERTICES.map(([x, y, z]) => {
    const rx = x * cosYaw + z * sinYaw;
    const rz = z * cosYaw - x * sinYaw;
    const ry = y * cosPitch - rz * sinPitch;
    const depth = rz * cosPitch + y * sinPitch;
    const scale = (1.9 / (3.6 + depth)) * 0.95;
    return [rx * scale, ry * scale, depth] as const;
  });

  return paintPlotted((plot) => {
    for (const [from, to] of CUBE_EDGES) {
      const a = projected[from];
      const b = projected[to];
      for (let step = 0; step <= 34; step += 1) {
        const f = step / 34;
        const depth = a[2] + (b[2] - a[2]) * f;
        plot(
          a[0] + (b[0] - a[0]) * f,
          a[1] + (b[1] - a[1]) * f,
          0.3 + 0.7 * clamp01((1.8 - depth) / 3.6),
        );
      }
    }
  });
}

/* -- opencode: glyph rain inside a chasing terminal frame ----------------- */

const RAIN_GLYPHS = "01<>[]{}/\\|=+*-_$#%&?:;~^";
const PERIMETER = 2 * (W + H) - 4;

function perimeterIndex(x: number, y: number): number {
  if (y === 0) return x;
  if (x === W - 1) return W - 1 + y;
  if (y === H - 1) return W - 1 + H - 1 + (W - 1 - x);
  return PERIMETER - y;
}

function paintRain(t: number): string {
  const runner = Math.floor(((t * 0.5) % 1) * PERIMETER);
  const inner = H - 2;
  const rows: string[] = [];

  for (let y = 0; y < H; y += 1) {
    let row = "";
    for (let x = 0; x < W; x += 1) {
      const onEdge = y === 0 || y === H - 1 || x === 0 || x === W - 1;
      if (onEdge) {
        const lead = (perimeterIndex(x, y) - runner + PERIMETER) % PERIMETER;
        const hot = lead < 5;
        if (y === 0 && x === 0) row += "┌";
        else if (y === 0 && x === W - 1) row += "┐";
        else if (y === H - 1 && x === 0) row += "└";
        else if (y === H - 1 && x === W - 1) row += "┘";
        else if (y === 0 || y === H - 1) row += hot ? "━" : "─";
        else row += hot ? "┃" : "│";
        continue;
      }

      const column = x - 1;
      const speed = 2.2 + hash(column) * 3.4;
      const offset = hash(column + 17) * (inner + 6);
      const head = ((t * speed + offset) % (inner + 6)) - 1;
      const behind = head - (y - 1);
      if (behind < 0 || behind > 5) {
        row += " ";
        continue;
      }
      if (behind < 1.6) {
        const seed = column * 31 + y * 7 + Math.floor(t * 10 + column * 3);
        row += RAIN_GLYPHS[Math.floor(hash(seed) * RAIN_GLYPHS.length)];
        continue;
      }
      row += shade(0.85 - behind / 5.6);
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export const ASCII_PAINTERS: Record<AgentId, Painter> = {
  codex: paintBraid,
  claude: (t) => paintField(claudeField, t),
  grok: (t) => paintField(grokField, t),
  cursor: paintCube,
  opencode: paintRain,
};

export function AgentAsciiLoader({
  agent,
  label = "Starting session",
}: {
  agent: AgentId;
  label?: string;
}) {
  const [frame, setFrame] = useState(() => ASCII_PAINTERS[agent](0));

  useEffect(() => {
    const paint = ASCII_PAINTERS[agent];
    setFrame(paint(0));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const started = performance.now();
    let handle = 0;
    let last = 0;
    const tick = (now: number) => {
      handle = window.requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      last = now;
      setFrame(paint((now - started) / 1000));
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [agent]);

  return (
    <div className={`agent-ascii-loader is-${agent}`} role="status" aria-label={label}>
      <pre aria-hidden="true">{frame}</pre>
      <span className="agent-ascii-bar" aria-hidden="true" />
      <span className="agent-ascii-label">{label}</span>
    </div>
  );
}
