import { paintChecklistConfetti } from "../../../lib/checklistConfetti";
import {
  ASPECT,
  clamp01,
  fbm,
  Field,
  fieldU,
  fieldV,
  H,
  hash,
  makeStepper,
  Painter,
  paintField,
  paintGrid,
  paintPlotted,
  shade,
  TAU,
  W,
} from "./canvas";

/* ========================================================================
   Geometry: things that spin, weave, or trace a path.
   ===================================================================== */

/* -- Braid: strands weaving past each other ------------------------------- */

const BRAID_STRANDS = 2;

function paintBraid(t: number): string {
  return paintPlotted((plot) => {
    for (let strand = 0; strand < BRAID_STRANDS; strand += 1) {
      const phase = (strand / BRAID_STRANDS) * TAU;
      for (let sample = 0; sample <= 180; sample += 1) {
        const u = (sample / 180) * ASPECT * 2 - ASPECT;
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

/* -- Helix: a double helix with rungs between the strands ----------------- */

/* Keep spin gentle: the depth-driven shade + rung thrash strobes hard at the
   old 2.3 rad/s rate, which reads almost epileptic at loader FPS. */
const HELIX_SPIN = 0.7;

function paintHelix(t: number): string {
  return paintPlotted((plot) => {
    for (let rung = 0; rung < 9; rung += 1) {
      const u = -ASPECT + (rung / 8) * ASPECT * 2;
      const angle = u * 2.1 - t * HELIX_SPIN;
      const top = Math.sin(angle) * 0.74;
      const bottom = -top;
      for (let step = 0; step <= 10; step += 1) {
        plot(u, top + (bottom - top) * (step / 10), 0.1);
      }
    }
    for (let sample = 0; sample <= 170; sample += 1) {
      const u = (sample / 170) * ASPECT * 2 - ASPECT;
      const angle = u * 2.1 - t * HELIX_SPIN;
      const depth = (Math.cos(angle) + 1) / 2;
      plot(u, Math.sin(angle) * 0.74, 0.25 + 0.75 * depth);
      plot(u, -Math.sin(angle) * 0.74, 0.25 + 0.75 * (1 - depth));
    }
  });
}

/* -- Wireframe solids ----------------------------------------------------- */

type Vertex = readonly [number, number, number];
type Edge = readonly [number, number];

function paintWireframe(
  vertices: readonly Vertex[],
  edges: readonly Edge[],
  t: number,
  spin: number,
  size: number,
): string {
  const yaw = t * spin;
  const pitch = 0.5 + Math.sin(t * 0.6) * 0.3;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  const projected = vertices.map(([x, y, z]) => {
    const rx = x * cosYaw + z * sinYaw;
    const rz = z * cosYaw - x * sinYaw;
    const ry = y * cosPitch - rz * sinPitch;
    const depth = rz * cosPitch + y * sinPitch;
    const scale = (1.9 / (3.6 + depth)) * size;
    return [rx * scale, ry * scale, depth] as const;
  });

  return paintPlotted((plot) => {
    for (const [from, to] of edges) {
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

const CUBE_VERTICES: readonly Vertex[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

const CUBE_EDGES: readonly Edge[] = [
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

const OCTAHEDRON_VERTICES: readonly Vertex[] = [
  [1.35, 0, 0],
  [-1.35, 0, 0],
  [0, 1.35, 0],
  [0, -1.35, 0],
  [0, 0, 1.35],
  [0, 0, -1.35],
];

const OCTAHEDRON_EDGES: readonly Edge[] = [
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  [2, 4],
  [4, 3],
  [3, 5],
  [5, 2],
];

const paintCube: Painter = (t) => paintWireframe(CUBE_VERTICES, CUBE_EDGES, t, 1.1, 0.95);
const paintOctahedron: Painter = (t) =>
  paintWireframe(OCTAHEDRON_VERTICES, OCTAHEDRON_EDGES, t, 1.35, 0.95);

/* -- Torus: the classic shaded donut, z-buffered and Lambert-lit ---------- */

const TORUS_X_SCALE = 9.2;
const TORUS_Y_SCALE = TORUS_X_SCALE * 0.6;

function paintTorus(t: number): string {
  const light = new Float32Array(W * H);
  const depthBuffer = new Float32Array(W * H);
  const spinA = t * 1.0;
  const spinB = t * 0.5;
  const cosA = Math.cos(spinA);
  const sinA = Math.sin(spinA);
  const cosB = Math.cos(spinB);
  const sinB = Math.sin(spinB);

  for (let theta = 0; theta < TAU; theta += 0.09) {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    /* A tube of radius 1 swept around a ring of radius 2. */
    const ringX = 2 + cosT;
    for (let phi = 0; phi < TAU; phi += 0.03) {
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const x = ringX * (cosB * cosP + sinA * sinB * sinP) - sinT * cosA * sinB;
      const y = ringX * (sinB * cosP - sinA * cosB * sinP) + sinT * cosA * cosB;
      const z = 5 + cosA * ringX * sinP + sinT * sinA;
      const ooz = 1 / z;
      const px = Math.round(W / 2 + TORUS_X_SCALE * ooz * x);
      const py = Math.round(H / 2 - TORUS_Y_SCALE * ooz * y);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const lambert =
        cosP * cosT * sinB -
        cosA * cosT * sinP -
        sinA * sinT +
        cosB * (cosA * sinT - cosT * sinA * sinP);
      if (lambert <= 0) continue;
      const index = py * W + px;
      if (ooz <= depthBuffer[index]) continue;
      depthBuffer[index] = ooz;
      light[index] = lambert / Math.SQRT2;
    }
  }

  const rows: string[] = [];
  for (let y = 0; y < H; y += 1) {
    let row = "";
    for (let x = 0; x < W; x += 1) row += shade(light[y * W + x]);
    rows.push(row);
  }
  return rows.join("\n");
}

/* -- Globe: meridians and parallels, back face culled --------------------- */

function paintGlobe(t: number): string {
  const yaw = t * 0.85;
  const tilt = 0.42;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);

  const project = (lat: number, lon: number) => {
    const x = Math.cos(lat) * Math.cos(lon + yaw);
    const y = Math.sin(lat);
    const z = Math.cos(lat) * Math.sin(lon + yaw);
    return [x, y * cosTilt - z * sinTilt, y * sinTilt + z * cosTilt] as const;
  };

  return paintPlotted((plot) => {
    for (let ring = 0; ring < 5; ring += 1) {
      const lat = -Math.PI / 3 + (ring / 4) * ((2 * Math.PI) / 3);
      for (let step = 0; step <= 90; step += 1) {
        const [x, y, z] = project(lat, (step / 90) * TAU);
        if (z < 0) continue;
        plot(x * 0.9, y * 0.9, 0.22 + 0.78 * z);
      }
    }
    for (let meridian = 0; meridian < 6; meridian += 1) {
      const lon = (meridian / 6) * TAU;
      for (let step = 0; step <= 70; step += 1) {
        const [x, y, z] = project(-Math.PI / 2 + (step / 70) * Math.PI, lon);
        if (z < 0) continue;
        plot(x * 0.9, y * 0.9, 0.22 + 0.78 * z);
      }
    }
  });
}

/* -- Funnel: stacked rings spinning into a vortex ------------------------- */

const FUNNEL_RINGS = 5;

function paintFunnel(t: number): string {
  return paintPlotted((plot) => {
    for (let ring = 0; ring < FUNNEL_RINGS; ring += 1) {
      const f = ring / (FUNNEL_RINGS - 1);
      const v = -0.85 + f * 1.7;
      const radius = 0.95 - f * 0.68;
      /* Each ring lags the one above it, which is what makes it swirl. */
      const spin = t * 2.2 + f * 2.2;
      for (let step = 0; step <= 46; step += 1) {
        /* An arc rather than a closed ring: a full ellipse spun about its own
           axis is indistinguishable from a still one. The gap is the motion. */
        const angle = spin + (step / 46) * TAU * 0.72;
        const depth = (Math.cos(angle) + 1) / 2;
        plot(Math.sin(angle) * radius, v + Math.cos(angle) * radius * 0.2, 0.2 + 0.8 * depth);
      }
    }
  });
}

/* -- Barber pole: a spinning cylinder with capped ends -------------------- */

function paintBarberPole(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 70; step += 1) {
      const v = -0.86 + (step / 70) * 1.72;
      plot(-0.6, v, 0.14);
      plot(0.6, v, 0.14);
    }
    for (let stripe = 0; stripe < 2; stripe += 1) {
      for (let step = 0; step <= 180; step += 1) {
        const v = -0.86 + (step / 180) * 1.72;
        const angle = v * 4.4 + t * 3.2 + stripe * Math.PI;
        const depth = (Math.cos(angle) + 1) / 2;
        /* Drop the far side of the cylinder so the pole reads as solid. */
        if (depth < 0.15) continue;
        plot(Math.sin(angle) * 0.6, v, 0.28 + 0.72 * depth);
      }
    }
  });
}

/* -- Oscilloscope: a swept waveform over a faint baseline ----------------- */

/* Phase rates used to be 5 / 3.2 rad/s — the trace thrashed hard enough at
   loader FPS to strobe. Keep the dual-tone shape, just sweep it gently. */
const OSCILLOSCOPE_CARRIER = 1.35;
const OSCILLOSCOPE_MOD = 0.85;

function paintOscilloscope(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 60; step += 1) {
      plot((step / 60) * ASPECT * 2 - ASPECT, 0, 0.07);
    }
    for (let step = 0; step <= 220; step += 1) {
      const u = (step / 220) * ASPECT * 2 - ASPECT;
      const x = u / ASPECT;
      const envelope = Math.exp(-x * x * 0.55);
      const wave =
        Math.sin(x * 7 - t * OSCILLOSCOPE_CARRIER) * 0.58 +
        Math.sin(x * 11.5 + t * OSCILLOSCOPE_MOD) * 0.26;
      plot(
        u,
        wave * envelope,
        0.35 + 0.65 * Math.abs(Math.cos(x * 7 - t * OSCILLOSCOPE_CARRIER)),
      );
    }
  });
}

/* -- Lissajous: a comet head dragging a figure behind it ------------------ */

function paintLissajous(t: number): string {
  return paintPlotted((plot) => {
    const samples = 260;
    for (let i = 0; i < samples; i += 1) {
      const s = (i / samples) * TAU;
      const u = Math.sin(s * 3 + t * 0.35) * ASPECT * 0.78;
      const v = Math.sin(s * 2) * 0.8;
      const lead = (((t * 0.55 - i / samples) % 1) + 1) % 1;
      plot(u, v, 0.1 + 0.9 * Math.pow(1 - lead, 5));
    }
  });
}

/* -- Star polygon breathing between a star and a polygon ------------------ */

function paintStarPoly(t: number): string {
  const points = 6;
  const inner = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.95));
  const spin = t * 0.55;

  return paintPlotted((plot) => {
    const corners: Array<readonly [number, number]> = [];
    for (let i = 0; i < points * 2; i += 1) {
      const radius = i % 2 === 0 ? 0.9 : inner;
      const angle = (i / (points * 2)) * TAU + spin;
      corners.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    for (let i = 0; i < corners.length; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      for (let step = 0; step <= 20; step += 1) {
        const f = step / 20;
        /* One highlight chasing the outline, rather than each edge flickering. */
        const along = (i + f) / corners.length;
        const lead = (((t * 0.4 - along) % 1) + 1) % 1;
        plot(
          a[0] + (b[0] - a[0]) * f,
          a[1] + (b[1] - a[1]) * f,
          0.4 + 0.6 * Math.pow(1 - lead, 4),
        );
      }
    }
  });
}

/* -- Ribbon: a cubic bezier dancing between four moving anchors ----------- */

function paintRibbon(t: number): string {
  const anchors: Array<readonly [number, number]> = [
    [-ASPECT * 0.92, Math.sin(t * 1.1) * 0.65],
    [-ASPECT * 0.3, Math.sin(t * 1.7 + 1) * 0.88],
    [ASPECT * 0.3, Math.sin(t * 1.3 + 2) * 0.88],
    [ASPECT * 0.92, Math.sin(t * 0.9 + 3) * 0.65],
  ];

  return paintPlotted((plot) => {
    for (let band = -2; band <= 2; band += 1) {
      for (let step = 0; step <= 130; step += 1) {
        const s = step / 130;
        const m = 1 - s;
        const w0 = m * m * m;
        const w1 = 3 * m * m * s;
        const w2 = 3 * m * s * s;
        const w3 = s * s * s;
        const x = w0 * anchors[0][0] + w1 * anchors[1][0] + w2 * anchors[2][0] + w3 * anchors[3][0];
        const y = w0 * anchors[0][1] + w1 * anchors[1][1] + w2 * anchors[2][1] + w3 * anchors[3][1];
        const edge = 1 - Math.abs(band) / 3;
        plot(x, y + band * 0.08, edge * (0.35 + 0.65 * Math.sin(s * Math.PI)));
      }
    }
  });
}

/* -- Tetrahedron: the simplest solid, tumbling ----------------------------- */

const TETRAHEDRON_VERTICES: readonly Vertex[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
];

const TETRAHEDRON_EDGES: readonly Edge[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

const paintTetrahedron: Painter = (t) =>
  paintWireframe(TETRAHEDRON_VERTICES, TETRAHEDRON_EDGES, t, 1.25, 1.05);

/* -- Trefoil: a knot spinning on a turntable, shaded by depth -------------- */

function paintTrefoil(t: number): string {
  const yaw = t * 0.9;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 240; sample += 1) {
      const s = (sample / 240) * TAU;
      const x = (Math.sin(s) + 2 * Math.sin(2 * s)) / 3;
      const y = (Math.cos(s) - 2 * Math.cos(2 * s)) / 3;
      const z = -Math.sin(3 * s) / 1.5;
      const rx = x * cosYaw + z * sinYaw;
      const rz = z * cosYaw - x * sinYaw;
      /* Strands brighten as they swing toward the camera. */
      plot(rx * ASPECT * 0.62, y * 0.82, 0.2 + 0.8 * clamp01((rz + 1.15) / 2.3));
    }
  });
}

/* -- Rose: a three-petal rhodonea with a highlight chasing the stem -------- */

function paintRose(t: number): string {
  return paintPlotted((plot) => {
    const samples = 300;
    for (let i = 0; i < samples; i += 1) {
      const s = (i / samples) * TAU;
      const radius = Math.sin(3 * s) * 0.92;
      const angle = s + t * 0.35;
      const lead = (((t * 0.5 - i / samples) % 1) + 1) % 1;
      plot(
        Math.cos(angle) * radius * 1.4,
        Math.sin(angle) * radius,
        0.14 + 0.86 * Math.pow(1 - lead, 4),
      );
    }
  });
}

/* -- Spirograph: a five-lobed hypotrochoid, slowly morphing ---------------- */

function paintSpirograph(t: number): string {
  const wobble = Math.sin(t * 0.3) * 1.5;
  return paintPlotted((plot) => {
    const samples = 320;
    for (let i = 0; i < samples; i += 1) {
      const s = (i / samples) * TAU;
      const u = (Math.cos(s) * 0.62 + Math.cos(5 * s + wobble) * 0.3) * ASPECT * 0.85;
      const v = (Math.sin(s) * 0.62 - Math.sin(5 * s + wobble) * 0.3) * 0.9;
      const lead = (((t * 0.45 - i / samples) % 1) + 1) % 1;
      plot(u, v, 0.15 + 0.85 * Math.pow(1 - lead, 4));
    }
  });
}

/* -- Gear: a toothed wheel grinding around its hub ------------------------- */

function paintGear(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 320; step += 1) {
      const angle = (step / 320) * TAU;
      /* Squash a cosine into a near-square profile so the teeth get flat tops. */
      const tooth = clamp01(Math.cos(8 * (angle - t * 0.55)) * 2.6 + 0.5);
      const radius = 0.58 + tooth * 0.24;
      plot(Math.cos(angle) * radius * 1.42, Math.sin(angle) * radius, 0.45 + 0.5 * tooth);
    }
    for (let step = 0; step <= 70; step += 1) {
      const angle = (step / 70) * TAU;
      plot(Math.cos(angle) * 0.22 * 1.42, Math.sin(angle) * 0.22, 0.4);
    }
  });
}

/* -- Clock: hands sweeping a dial at demo speed ---------------------------- */

function paintClock(t: number): string {
  return paintPlotted((plot) => {
    for (let tick = 0; tick < 12; tick += 1) {
      const angle = (tick / 12) * TAU;
      plot(Math.cos(angle) * 1.3, Math.sin(angle) * 0.86, tick % 3 === 0 ? 0.75 : 0.28);
    }
    const minute = Math.PI / 2 - t * 2.4;
    const hour = Math.PI / 2 - t * 0.2;
    for (let step = 0; step <= 30; step += 1) {
      const f = step / 30;
      plot(Math.cos(minute) * 1.12 * f, -Math.sin(minute) * 0.74 * f, 0.9);
      if (f <= 0.6) plot(Math.cos(hour) * 1.12 * f, -Math.sin(hour) * 0.74 * f, 0.55);
    }
    plot(0, 0, 1);
  });
}

/* -- Atom: electrons circling a nucleus on tilted shells ------------------- */

function paintAtom(t: number): string {
  return paintPlotted((plot) => {
    plot(0, 0, 1);
    for (let glow = 0; glow < TAU; glow += 0.9) {
      plot(Math.cos(glow) * 0.1, Math.sin(glow) * 0.08, 0.8);
    }
    for (let shell = 0; shell < 3; shell += 1) {
      const tilt = (shell / 3) * Math.PI;
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);
      const place = (s: number): readonly [number, number] => {
        const x = Math.cos(s) * 1.08;
        const y = Math.sin(s) * 0.34;
        return [x * cosTilt - y * sinTilt, x * sinTilt + y * cosTilt];
      };
      for (let step = 0; step <= 90; step += 1) {
        const [u, v] = place((step / 90) * TAU);
        plot(u, v, 0.13);
      }
      const [eu, ev] = place(t * (2 + shell * 0.5) + shell * 2.1);
      plot(eu, ev, 1);
      plot(eu + 0.1, ev, 0.45);
      plot(eu - 0.1, ev, 0.45);
    }
  });
}

/* -- Spring: a coil breathing between compression and extension ------------ */

function paintSpring(t: number): string {
  const half = ASPECT * (0.6 + 0.3 * Math.sin(t * 1.7));
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) {
      const v = -0.62 + (step / 14) * 1.24;
      plot(-half - 0.14, v, 0.5);
      plot(half + 0.14, v, 0.5);
    }
    for (let sample = 0; sample <= 240; sample += 1) {
      const f = sample / 240;
      /* The winding phase drifts with time, so the coil visibly turns. */
      const angle = f * TAU * 7 - t * 2.6;
      const depth = (Math.cos(angle) + 1) / 2;
      plot(-half + f * half * 2, Math.sin(angle) * 0.55, 0.25 + 0.75 * depth);
    }
  });
}

/* ========================================================================
   Motion: particles, physics, and things that travel.
   ===================================================================== */

/* -- Comets: streaks running lower-left to upper-right -------------------- */

const COMET_LANES = 7;

const cometField: Field = (u, v, t) => {
  const along = u * 0.82 - v * 0.57;
  const across = u * 0.57 + v * 0.82;
  let best = 0;
  for (let k = 0; k < COMET_LANES; k += 1) {
    const cycle = (t * 0.45 + k * 0.29) % 1;
    const head = -2.4 + cycle * 5.2;
    const lead = head - along;
    /* Sharp leading edge, exponential tail dragging behind the head. */
    const body = lead < 0 ? Math.exp(-(lead * lead) / 0.02) : Math.exp(-lead / 0.36);
    const lane = Math.exp(-Math.pow((across - (k - (COMET_LANES - 1) / 2) * 0.42) / 0.3, 2));
    const streak = body * lane;
    if (streak > best) best = streak;
  }
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.95), 5));
  return best * vignette * 1.3;
};

/* -- Warp: a starfield streaking past the camera -------------------------- */

const WARP_STARS = 28;

function paintWarp(t: number): string {
  return paintPlotted((plot) => {
    for (let star = 0; star < WARP_STARS; star += 1) {
      const angle = hash(star) * TAU;
      const speed = 0.26 + hash(star + 91) * 0.32;
      const cycle = (t * speed + hash(star + 7)) % 1;
      /* Squaring the phase makes stars accelerate as they near the rim, and
         the trail stretches with them, which is what sells the warp. */
      const far = cycle * cycle * 1.9;
      const near = Math.max(0, far - (0.16 + far * 0.6));
      const brightness = clamp01(0.22 + far * 0.75);
      const cos = Math.cos(angle) * ASPECT * 0.62;
      const sin = Math.sin(angle) * 0.62;
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        const distance = near + (far - near) * f;
        plot(cos * distance, sin * distance, brightness * (0.15 + 0.85 * f * f));
      }
    }
  });
}

/* -- Orbits: bodies on tilted ellipses, each dragging a tail -------------- */

function paintOrbits(t: number): string {
  return paintPlotted((plot) => {
    for (let glow = 0; glow < TAU; glow += 0.6) {
      plot(Math.cos(glow) * 0.1, Math.sin(glow) * 0.1, 1);
    }
    for (let body = 1; body <= 2; body += 1) {
      const major = 0.1 + body * 0.66;
      const minor = major * 0.42;
      /* Roughly Keplerian: the wider the orbit, the slower the sweep. */
      const speed = 1.5 / Math.pow(major, 1.4);
      /* Dash the guide path; a solid ellipse of dots reads as a haze. */
      for (let step = 0; step < 80; step += 5) {
        const s = (step / 80) * TAU;
        plot(Math.cos(s) * major, Math.sin(s) * minor, 0.09);
      }
      for (let tail = 0; tail < 9; tail += 1) {
        const s = t * speed - tail * 0.07;
        const x = Math.cos(s) * major;
        const y = Math.sin(s) * minor;
        plot(x, y, Math.pow(1 - tail / 9, 1.4));
        if (tail === 0) {
          plot(x + 0.11, y, 0.7);
          plot(x - 0.11, y, 0.7);
        }
      }
    }
  });
}

/* -- Bounce: a ball with a motion trail over a floor line ----------------- */

function paintBounce(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 44; step += 1) {
      plot((step / 44) * ASPECT * 2 - ASPECT, 0.9, 0.12);
    }
    const trail = 9;
    for (let ghost = trail; ghost >= 0; ghost -= 1) {
      const moment = t - ghost * 0.05;
      const u = Math.sin(moment * 1.05) * ASPECT * 0.72;
      const height = Math.abs(Math.sin(moment * 3.1));
      const v = 0.78 - height * 1.6;
      const weight = Math.pow(1 - ghost / (trail + 1), 2);
      for (let angle = 0; angle < TAU; angle += 0.5) {
        for (let radius = 0.5; radius <= 1.001; radius += 0.5) {
          plot(u + Math.cos(angle) * 0.17 * radius, v + Math.sin(angle) * 0.17 * radius, weight);
        }
      }
    }
  });
}

/* -- Fireworks: shells that rise, burst, and fall ------------------------- */

const FIREWORK_PERIOD = 2.4;

function paintFireworks(t: number): string {
  return paintPlotted((plot) => {
    for (let shell = 0; shell < 2; shell += 1) {
      const clock = t + shell * 1.15;
      const round = Math.floor(clock / FIREWORK_PERIOD);
      const local = (clock % FIREWORK_PERIOD) / FIREWORK_PERIOD;
      const originU = (hash(round * 13 + shell * 5) * 2 - 1) * ASPECT * 0.62;
      const originV = -0.45 + hash(round * 7 + shell * 3) * 0.45;

      if (local < 0.22) {
        const rise = local / 0.22;
        const v = 0.95 - rise * (0.95 - originV);
        plot(originU, v, 0.95);
        plot(originU, v + 0.14, 0.4);
        plot(originU, v + 0.28, 0.15);
        continue;
      }

      const age = (local - 0.22) / 0.78;
      const fade = Math.pow(1 - age, 1.5);
      const fall = age * age * 0.85;
      for (let spark = 0; spark < 22; spark += 1) {
        const angle = (spark / 22) * TAU + hash(round * 31 + shell) * 0.4;
        const speed = 0.6 + hash(spark * 17 + shell) * 0.45;
        /* Each spark is a short streak, so the burst reads as motion. */
        for (let tail = 0; tail < 3; tail += 1) {
          const reach = Math.pow(Math.max(0, age - tail * 0.06), 0.55) * speed;
          plot(
            originU + Math.cos(angle) * reach * 1.25,
            originV + Math.sin(angle) * reach * 0.78 + fall,
            fade * (1 - tail * 0.28),
          );
        }
      }
    }
  });
}

/* -- Snake: a worm crawling a wandering path ------------------------------ */

function paintSnake(t: number): string {
  return paintPlotted((plot) => {
    const length = 30;
    for (let segment = length; segment >= 0; segment -= 1) {
      const s = t * 1.5 - segment * 0.085;
      const u = Math.sin(s) * ASPECT * 0.72 + Math.sin(s * 0.41) * 0.35;
      const v = Math.sin(s * 1.61 + 1.1) * 0.74;
      plot(u, v, Math.pow(1 - segment / (length + 1), 0.75));
    }
  });
}

/* -- Pendulum wave: bobs whose periods drift in and out of phase ---------- */

function paintPendulum(t: number): string {
  const count = 9;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 60; step += 1) {
      plot((step / 60) * ASPECT * 1.7 - ASPECT * 0.85, -0.95, 0.09);
    }
    for (let bob = 0; bob < count; bob += 1) {
      const u = -ASPECT * 0.78 + (bob / (count - 1)) * ASPECT * 1.56;
      /* Periods fan out slightly, so the row drifts in and out of phase. */
      const frequency = 1.45 + bob * 0.13;
      const v = Math.sin(t * frequency) * 0.68;
      plot(u, v, 1);
      plot(u, v - 0.15, 0.38);
      plot(u, v + 0.15, 0.38);
    }
  });
}

/* -- Flow field: particles swept along a drifting noise field ------------- */

function paintFlowField(t: number): string {
  return paintPlotted((plot) => {
    for (let particle = 0; particle < 42; particle += 1) {
      let x = (hash(particle * 3.1) * 2 - 1) * ASPECT;
      let y = hash(particle * 7.9) * 2 - 1;
      const phase = (t * 0.5 + hash(particle * 11.3)) % 1;
      const advance = Math.floor(phase * 22);
      const drift = t * 0.12;
      for (let step = 0; step < advance; step += 1) {
        const angle = fbm(x * 0.5, y * 0.5 + drift, 2) * TAU;
        x += Math.cos(angle) * 0.09;
        y += Math.sin(angle) * 0.09;
      }
      /* Fade the trail in and out over the particle's life so respawns
         never pop into existence at full brightness. */
      const life = Math.sin(phase * Math.PI);
      for (let step = 0; step < 9; step += 1) {
        const angle = fbm(x * 0.5, y * 0.5 + drift, 2) * TAU;
        x += Math.cos(angle) * 0.09;
        y += Math.sin(angle) * 0.09;
        plot(x, y, life * (0.25 + 0.75 * (step / 8)));
      }
    }
  });
}

/* -- Network: nodes with pulses running along their links ----------------- */

function paintNetwork(t: number): string {
  const nodes: Array<readonly [number, number]> = [];
  for (let node = 0; node < 10; node += 1) {
    nodes.push([
      (hash(node * 5.1) * 2 - 1) * ASPECT * 0.85 + Math.sin(t * 0.4 + node) * 0.07,
      (hash(node * 9.7) * 2 - 1) * 0.82 + Math.cos(t * 0.33 + node) * 0.06,
    ]);
  }

  return paintPlotted((plot) => {
    let link = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]) > 1.1) continue;
        const pulse = (t * 0.5 + link * 0.19) % 1;
        link += 1;
        for (let step = 0; step <= 26; step += 1) {
          const f = step / 26;
          const near = Math.exp(-Math.pow((f - pulse) / 0.13, 2));
          plot(
            nodes[i][0] + (nodes[j][0] - nodes[i][0]) * f,
            nodes[i][1] + (nodes[j][1] - nodes[i][1]) * f,
            0.12 + 0.88 * near,
          );
        }
      }
    }
    for (const [x, y] of nodes) plot(x, y, 1);
  });
}

/* -- Galaxy: two spiral arms of twinkling stars turning together ----------- */

function paintGalaxy(t: number): string {
  return paintPlotted((plot) => {
    plot(0, 0, 1);
    for (let glow = 0; glow < TAU; glow += 0.8) {
      plot(Math.cos(glow) * 0.1, Math.sin(glow) * 0.07, 0.9);
    }
    for (let arm = 0; arm < 2; arm += 1) {
      for (let star = 0; star < 55; star += 1) {
        const f = star / 55;
        const radius = (0.14 + f * 0.85) * (1 + (hash(star * 3.1 + arm * 17) - 0.5) * 0.16);
        const angle = arm * Math.PI + f * 3.3 + t * 0.7 + (hash(star * 7.3 + arm * 29) - 0.5) * 0.5;
        const twinkle = 0.65 + 0.35 * Math.sin(t * 2.8 + star * 2.1 + arm * 3.3);
        plot(Math.cos(angle) * radius * 1.45, Math.sin(angle) * radius, (1 - f * 0.75) * twinkle);
      }
    }
  });
}

/* -- Waves: swells rolling toward the viewer with parallax ----------------- */

function paintWaves(t: number): string {
  return paintPlotted((plot) => {
    for (let row = 0; row <= 5; row += 1) {
      const depth = row / 5;
      const width = ASPECT * (1.88 - depth);
      for (let col = 0; col <= 60; col += 1) {
        const x = col / 60 - 0.5;
        const crest = Math.sin(x * 7.5 + depth * 4.2 - t * 2.3);
        const v = 0.84 - depth * 1.66 - crest * 0.15 * (1 - depth * 0.45);
        plot(x * width, v, (0.3 + 0.7 * (1 - depth)) * (0.55 + 0.45 * crest));
      }
    }
  });
}

/* -- Bubbles: wobbling rings rising and dissolving -------------------------- */

function paintBubbles(t: number): string {
  return paintPlotted((plot) => {
    for (let bubble = 0; bubble < 7; bubble += 1) {
      const speed = 0.16 + hash(bubble * 5.7) * 0.2;
      const cycle = (t * speed + hash(bubble * 3.3)) % 1;
      const radius = 0.08 + hash(bubble * 9.1) * 0.14;
      const u = (hash(bubble * 7.7) * 2 - 1) * ASPECT * 0.7 + Math.sin(t * 1.7 + bubble * 2.2) * 0.14;
      const v = 0.95 - cycle * 1.9;
      /* Fade in at the bottom and out at the top, so respawns never pop. */
      const life = Math.sin(cycle * Math.PI);
      for (let angle = 0; angle < TAU; angle += 0.45) {
        plot(
          u + Math.cos(angle) * radius * 1.6,
          v + Math.sin(angle) * radius,
          life * (0.4 + 0.6 * ((Math.sin(angle + 0.8) + 1) / 2)),
        );
      }
    }
  });
}

/* -- Screensaver: the bouncing box that never quite hits the corner -------- */

function bouncePhase(x: number): number {
  const cycle = ((x % 2) + 2) % 2;
  return cycle < 1 ? cycle : 2 - cycle;
}

function paintScreensaver(t: number): string {
  return paintPlotted((plot) => {
    for (let ghost = 2; ghost >= 0; ghost -= 1) {
      const moment = t - ghost * 0.11;
      const cu = (bouncePhase(moment * 0.41 + 0.3) * 2 - 1) * (ASPECT - 0.62);
      const cv = (bouncePhase(moment * 0.567) * 2 - 1) * 0.56;
      const weight = 1 - ghost * 0.38;
      for (let step = 0; step <= 18; step += 1) {
        const f = step / 18;
        plot(cu - 0.5 + f, cv - 0.3, weight);
        plot(cu - 0.5 + f, cv + 0.3, weight);
        plot(cu - 0.5, cv - 0.3 + f * 0.6, weight);
        plot(cu + 0.5, cv - 0.3 + f * 0.6, weight);
      }
    }
  });
}

/* -- Raindrops: streaks falling onto a floor and splashing ------------------ */

function paintRaindrops(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 44; step += 1) {
      plot((step / 44) * ASPECT * 2 - ASPECT, 0.82, 0.1);
    }
    for (let drop = 0; drop < 6; drop += 1) {
      const period = 1.1 + hash(drop * 3.7) * 0.9;
      const clock = t / period + hash(drop * 8.1);
      const round = Math.floor(clock);
      const local = clock - round;
      /* Each round lands somewhere new, seeded by the round number. */
      const u = (hash(round * 17 + drop * 29) * 2 - 1) * ASPECT * 0.82;
      if (local < 0.55) {
        const v = -1 + (local / 0.55) * 1.8;
        plot(u, v, 0.95);
        plot(u, v - 0.16, 0.45);
        plot(u, v - 0.32, 0.18);
        continue;
      }
      const age = (local - 0.55) / 0.45;
      const reach = age * 0.55;
      const fade = 1 - age;
      plot(u - reach * 1.3, 0.82 - reach * 0.35, fade * 0.8);
      plot(u + reach * 1.3, 0.82 - reach * 0.35, fade * 0.8);
      plot(u - reach * 0.8, 0.82 - reach * 0.5, fade * 0.5);
      plot(u + reach * 0.8, 0.82 - reach * 0.5, fade * 0.5);
    }
  });
}

/* -- Windmill: four blades turning on a mast -------------------------------- */

function paintWindmill(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 20; step += 1) {
      plot(0, -0.25 + (step / 20) * 1.15, 0.3);
    }
    for (let step = 0; step <= 30; step += 1) {
      plot((step / 30) * ASPECT * 1.4 - ASPECT * 0.7, 0.9, 0.12);
    }
    for (let blade = 0; blade < 4; blade += 1) {
      const angle = t * 1.6 + (blade / 4) * TAU;
      for (let step = 0; step <= 26; step += 1) {
        const f = step / 26;
        plot(Math.cos(angle) * 1.05 * f, -0.25 + Math.sin(angle) * 0.62 * f, 0.35 + 0.65 * f);
      }
    }
    plot(0, -0.25, 1);
  });
}

/* -- Hourglass: sand draining from the top bulb into a rising pile ---------- */

const HOURGLASS_PERIOD = 3.4;

function paintHourglass(t: number): string {
  const drained = (t / HOURGLASS_PERIOD) % 1;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    const funnel = 0.16 + Math.abs(v) * 0.75;
    const outside = Math.abs(u) - funnel;
    if (outside > 0.12) return 0;
    if (outside > -0.12 || Math.abs(v) > 0.82) return 0.4;
    if (v < 0) {
      /* Sand left in the top bulb sits against the neck. */
      return v >= -0.82 * (1 - drained) ? 0.75 : 0;
    }
    /* The pile grows into a cone; the stream above it flickers. */
    const pile = 0.85 - 0.8 * drained + Math.abs(u) * 0.45;
    if (v >= pile) return 0.75;
    if (Math.abs(u) < 0.09) return 0.5 + 0.5 * hash(y * 3.1 + Math.floor(t * 11) * 7.7);
    return 0;
  });
}

/* ========================================================================
   Fields: continuous patterns sampled per cell.
   ===================================================================== */

/* -- Starburst: twelve rays breathing out from a core --------------------- */

const BURST_RAYS = 12;

const burstField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  const theta = Math.atan2(v, u);
  let best = Math.exp(-(radius * radius) / 0.03);
  for (let k = 0; k < BURST_RAYS; k += 1) {
    const angle = (k / BURST_RAYS) * TAU + t * 0.22;
    const delta = ((((theta - angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
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

/* -- Plasma: four interfering sine waves ---------------------------------- */

const plasmaField: Field = (u, v, t) => {
  const sum =
    Math.sin(u * 2.4 + t * 1.3) +
    Math.sin(v * 3.1 - t * 0.9) +
    Math.sin((u + v) * 2.1 + t * 1.7) +
    Math.sin(Math.hypot(u, v) * 4.4 - t * 2.1);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.62, v * 0.95), 4) * 0.9);
  /* Raw interference never reaches the ends of its range, so stretch it. */
  return clamp01((0.5 + sum / 8 - 0.34) / 0.46) * vignette;
};

/* -- Ripples: expanding rings from drifting emitters ---------------------- */

const rippleField: Field = (u, v, t) => {
  let best = 0;
  for (let k = 0; k < 3; k += 1) {
    const cx = Math.cos(t * 0.41 + k * 2.2) * 0.95;
    const cy = Math.sin(t * 0.53 + k * 1.7) * 0.5;
    const radius = Math.hypot(u - cx, v - cy);
    const wave = 0.5 + 0.5 * Math.cos(radius * 6.5 - t * 4.2 - k);
    const crest = Math.pow(wave, 3.4) * Math.exp(-radius * 1.95);
    if (crest > best) best = crest;
  }
  return best * 1.75;
};

/* -- Sonar: clean rings leaving a single pinging centre ------------------- */

const sonarField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  let best = Math.exp(-(radius * radius) / 0.008) * 0.95;
  for (let ping = 0; ping < 3; ping += 1) {
    const phase = (t * 0.42 + ping / 3) % 1;
    const distance = Math.abs(radius - phase * 1.6);
    const ring = Math.exp(-(distance * distance) / 0.006) * (1 - phase * 0.55);
    if (ring > best) best = ring;
  }
  return best;
};

/* -- Interference: two sources, with visible nodal lines ------------------ */

const interferenceField: Field = (u, v, t) => {
  const separation = 0.5 + 0.25 * Math.sin(t * 0.45);
  const first = Math.hypot(u, v - separation);
  const second = Math.hypot(u, v + separation);
  const wave = Math.cos(first * 8.5 - t * 4) + Math.cos(second * 8.5 - t * 4);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.92), 4) * 0.85);
  return clamp01((Math.abs(wave) / 2 - 0.18) / 0.7) * vignette;
};

/* -- Spiral: two arms winding out of the centre --------------------------- */

const spiralField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  const theta = Math.atan2(v, u);
  const wave = Math.cos(2 * theta - radius * 2.6 + t * 2.4);
  const arm = Math.pow(Math.max(0, wave), 1.1);
  /* Fade at the rim, and punch a small hole in the eye of the spiral. */
  const rim = Math.exp(-Math.pow(radius / 1.15, 3));
  const eye = 1 - Math.exp(-radius * 4);
  return arm * rim * eye * 1.15;
};

/* -- Tunnel: the demoscene standby, flying down a ringed shaft ------------ */

const tunnelField: Field = (u, v, t) => {
  const radius = Math.max(0.1, Math.hypot(u * 0.72, v));
  const angle = Math.atan2(v, u * 0.72);
  const depth = 1 / radius + t * 1.5;
  const rings = 0.5 + 0.5 * Math.cos(depth * 3.4);
  const spokes = 0.5 + 0.5 * Math.cos(angle * 6 + t * 0.4);
  /* Far wall (small radius) falls off, which is what reads as distance. */
  return Math.pow(rings * 0.62 + spokes * 0.38, 2.6) * clamp01(radius * 1.4) * 1.35;
};

/* -- Metaballs: blobs merging and splitting ------------------------------- */

const metaballsField: Field = (u, v, t) => {
  let sum = 0;
  for (let ball = 0; ball < 4; ball += 1) {
    const cx = Math.cos(t * 0.63 + ball * 1.9) * 1.0;
    const cy = Math.sin(t * 0.47 + ball * 2.3) * 0.6;
    const distance = (u - cx) * (u - cx) + (v - cy) * (v - cy);
    sum += 0.15 / (distance + 0.03);
  }
  return clamp01((sum - 0.75) * 0.6);
};

/* -- Voronoi: cell walls between drifting sites --------------------------- */

const voronoiField: Field = (u, v, t) => {
  let nearest = Infinity;
  let second = Infinity;
  for (let site = 0; site < 7; site += 1) {
    const cx = Math.cos(t * 0.31 + site * 2.1) * ASPECT * 0.78;
    const cy = Math.sin(t * 0.44 + site * 1.3) * 0.8;
    const distance = Math.hypot(u - cx, v - cy);
    if (distance < nearest) {
      second = nearest;
      nearest = distance;
    } else if (distance < second) {
      second = distance;
    }
  }
  /* The gap between the two closest sites is zero exactly on a wall. */
  return Math.pow(1 - clamp01((second - nearest) / 0.19), 2);
};

/* -- Moire: two ring patterns sliding across each other ------------------- */

const moireField: Field = (u, v, t) => {
  const offset = Math.cos(t * 0.5) * 0.55;
  const first = 0.5 + 0.5 * Math.cos(Math.hypot(u - offset, v) * 13);
  const second = 0.5 + 0.5 * Math.cos(Math.hypot(u + offset, v) * 13);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.62, v * 0.95), 4) * 0.9);
  return clamp01((first * second - 0.2) * 1.9) * vignette;
};

/* -- Kaleidoscope: a pattern folded into six mirrored sectors ------------- */

const KALEIDO_SECTOR = TAU / 6;

const kaleidoscopeField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  const raw = Math.atan2(v, u) + t * 0.3;
  const folded = Math.abs((((raw % KALEIDO_SECTOR) + KALEIDO_SECTOR) % KALEIDO_SECTOR) - KALEIDO_SECTOR / 2);
  const x = Math.cos(folded) * radius;
  const y = Math.sin(folded) * radius;
  const value = 0.5 + 0.5 * Math.sin(x * 5.5 + t * 1.5) * Math.cos(y * 7 - t * 1.1);
  return clamp01((value - 0.22) / 0.6) * Math.exp(-Math.pow(radius / 1.05, 4));
};

/* -- Diamonds: a lattice pulsing in radial waves -------------------------- */

const DIAMOND_PITCH = 0.34;

const diamondsField: Field = (u, v, t) => {
  const cu = Math.round(u / DIAMOND_PITCH) * DIAMOND_PITCH;
  const cv = Math.round(v / DIAMOND_PITCH) * DIAMOND_PITCH;
  /* Manhattan distance to the cell centre draws a diamond, not a circle. */
  const inset = Math.abs(u - cu) / DIAMOND_PITCH + Math.abs(v - cv) / DIAMOND_PITCH;
  const radius = Math.hypot(cu, cv);
  const pulse = 0.5 + 0.5 * Math.sin(radius * 4.5 - t * 3.2);
  return clamp01((0.25 + 0.7 * pulse - inset) / 0.45) * Math.exp(-Math.pow(radius / 1.25, 3));
};

/* -- Clouds: drifting fractal noise --------------------------------------- */

const cloudsField: Field = (u, v, t) => {
  const value = fbm(u * 0.7 + t * 0.18, v * 1.05 + Math.sin(t * 0.13) * 0.35, 3);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.92), 4) * 0.8);
  return clamp01((value - 0.44) / 0.3) * vignette;
};

/* -- Fire: noise rising through a bottom-weighted mask -------------------- */

const fireField: Field = (u, v, t) => {
  const fromTop = (v + 1) / 2;
  const noise = fbm(u * 1.5 + Math.sin(t * 0.4) * 0.3, (1 - fromTop) * 3 - t * 2.4, 3);
  const base = Math.pow(fromTop, 2.1);
  return clamp01((noise * 1.35 + base * 0.9 - 0.7) * 1.7);
};

/* -- Radar: a sweep with afterglow, range rings, and contacts ------------- */

const radarField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  if (radius > 0.96) return 0;
  const sweep = t * 2.1;
  const behind = (((sweep - Math.atan2(v, u)) % TAU) + TAU) % TAU;
  const beam = Math.exp(-behind * 0.85) * (0.4 + 0.6 * (1 - radius));
  const rings = Math.pow(0.5 + 0.5 * Math.cos(radius * 15), 10) * 0.2;
  let contacts = 0;
  for (let blip = 0; blip < 4; blip += 1) {
    const range = 0.28 + hash(blip * 3.7) * 0.58;
    const bearing = hash(blip * 11.3) * TAU + t * 0.12;
    const distance = Math.hypot(u - Math.cos(bearing) * range, v - Math.sin(bearing) * range);
    const seen = Math.exp(-((((sweep - bearing) % TAU) + TAU) % TAU) * 0.85);
    contacts = Math.max(contacts, Math.exp(-(distance * distance) / 0.005) * seen);
  }
  return Math.max(rings, Math.max(beam, contacts));
};

/* -- Checker: the rotozoom floor from every 90s demo ------------------------ */

const checkerField: Field = (u, v, t) => {
  const zoom = 2.6 + Math.sin(t * 0.7) * 1.2;
  const spin = t * 0.35;
  const x = (u * Math.cos(spin) - v * Math.sin(spin)) * zoom;
  const y = (u * Math.sin(spin) + v * Math.cos(spin)) * zoom;
  const cell = (Math.floor(x) + Math.floor(y)) & 1;
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.62, v * 0.95), 4) * 0.9);
  return (cell === 1 ? 0.9 : 0.18) * vignette;
};

/* -- Aurora: curtains of light rippling under a wavy crest ------------------ */

const auroraField: Field = (u, v, t) => {
  const crest = -0.35 + (fbm(u * 0.55 + t * 0.2, t * 0.11, 2) - 0.5) * 1.2;
  const below = v - crest;
  /* Sharp above the crest, a long soft drape below it. */
  const drape = below >= 0 ? Math.exp(-below * 2.4) : Math.exp(-(below * below) / 0.02);
  const rays =
    0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(u * 7.5 + fbm(u * 1.1 + 40, t * 0.26, 2) * 8), 2);
  return clamp01(drape * rays * 1.2) * clamp01((0.92 - v) / 0.5);
};

/* -- Square tunnel: concentric frames rushing out of a wandering eye -------- */

const squareTunnelField: Field = (u, v, t) => {
  const x = u / ASPECT - Math.sin(t * 0.4) * 0.2;
  const y = v - Math.cos(t * 0.55) * 0.16;
  /* Chebyshev distance is what makes the rings square. */
  const radius = Math.max(Math.abs(x), Math.abs(y), 0.07);
  const rings = 0.5 + 0.5 * Math.cos(0.85 / radius + t * 2.4);
  return Math.pow(rings, 2.2) * clamp01(radius * 1.5) * 1.25;
};

/* -- Petals: a flower outline blooming and turning -------------------------- */

const petalsField: Field = (u, v, t) => {
  /* Stretch the flower horizontally so it fills the wide canvas. */
  const radius = Math.hypot(u / 1.4, v);
  const theta = Math.atan2(v, u / 1.4);
  const petals = 0.5 + 0.5 * Math.cos(theta * 6 - t * 0.9);
  const bloom = 0.55 + 0.3 * Math.sin(t * 1.3);
  const outline = Math.exp(-Math.pow((radius - bloom * petals) / 0.2, 2));
  const core = Math.exp(-(radius * radius) / 0.02);
  return Math.max(outline * (0.4 + 0.6 * petals), core);
};

/* ========================================================================
   Extra collection: small scenes with their own motion language.
   ===================================================================== */

type Plot = (u: number, v: number, weight: number) => void;

function plotSegment(
  plot: Plot,
  fromU: number,
  fromV: number,
  toU: number,
  toV: number,
  weight: number,
  samples = 24,
): void {
  for (let step = 0; step <= samples; step += 1) {
    const f = step / samples;
    plot(fromU + (toU - fromU) * f, fromV + (toV - fromV) * f, weight);
  }
}

/* -- Lightning: a restless fork crossing the whole field ---------------- */

function paintLightning(t: number): string {
  return paintPlotted((plot) => {
    const drift = Math.sin(t * 2.7) * 0.28;
    let previousU = -ASPECT;
    let previousV = -0.55 + drift;
    for (let joint = 1; joint <= 8; joint += 1) {
      const nextU = -ASPECT + (joint / 8) * ASPECT * 2;
      const nextV =
        (joint === 8 ? 0.45 : (hash(joint * 9.7 + t * 1.9) - 0.5) * 1.25) + drift * 0.3;
      plotSegment(plot, previousU, previousV, nextU, nextV, 0.95, 12);
      if (joint === 3 || joint === 6) {
        const forkV = nextV + (hash(joint + t) - 0.5) * 0.9;
        plotSegment(plot, nextU, nextV, nextU + 0.45, forkV, 0.42, 9);
      }
      previousU = nextU;
      previousV = nextV;
    }
  });
}

/* -- Fountain: bright droplets following looping parabolas -------------- */

function paintFountain(t: number): string {
  return paintPlotted((plot) => {
    plotSegment(plot, -0.48, 0.82, 0.48, 0.82, 0.5, 30);
    for (let drop = 0; drop < 17; drop += 1) {
      const age = (t * 0.58 + drop / 17) % 1;
      const direction = drop % 2 === 0 ? 1 : -1;
      const u = direction * age * (0.3 + hash(drop) * 1.2);
      const v = 0.74 - age * (2.4 - age * 2.2);
      plot(u, v, 0.35 + 0.65 * (1 - age));
    }
  });
}

/* -- Heartbeat: an ECG trace travelling through a monitor --------------- */

function paintHeartbeat(t: number): string {
  return paintPlotted((plot) => {
    const scroll = (t * 1.25) % 1;
    for (let sample = 0; sample <= 190; sample += 1) {
      const u = (sample / 190) * ASPECT * 2 - ASPECT;
      const phase = (((u / ASPECT + 1) / 2 + scroll) % 1) * 8;
      let v = 0;
      if (phase > 2.25 && phase < 2.55) v = -(phase - 2.25) * 1.2;
      else if (phase < 2.85 && phase >= 2.55) v = -0.36 + (phase - 2.55) * 4.1;
      else if (phase < 3.12 && phase >= 2.85) v = 0.87 - (phase - 2.85) * 4.7;
      else if (phase < 3.55 && phase >= 3.12) v = -0.4 + (phase - 3.12) * 0.95;
      plot(u, v, 0.42 + 0.58 * (sample / 190));
    }
  });
}

/* -- Infinity: two light packets chase around a lemniscate -------------- */

function paintInfinity(t: number): string {
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 220; sample += 1) {
      const angle = (sample / 220) * TAU;
      const u = Math.sin(angle) * 1.35;
      const v = Math.sin(angle * 2) * 0.62;
      const chase = 0.5 + 0.5 * Math.cos(angle * 2 - t * 3.2);
      plot(u, v, 0.18 + 0.82 * Math.pow(chase, 5));
    }
  });
}

/* -- Jellyfish: a breathing bell with drifting tentacles ---------------- */

function paintJellyfish(t: number): string {
  return paintPlotted((plot) => {
    const breathe = 0.88 + Math.sin(t * 2.1) * 0.12;
    for (let sample = 0; sample <= 100; sample += 1) {
      const angle = Math.PI + (sample / 100) * Math.PI;
      plot(Math.cos(angle) * 0.95 * breathe, -0.2 + Math.sin(angle) * 0.68, 0.85);
    }
    plotSegment(plot, -0.95 * breathe, -0.2, 0.95 * breathe, -0.2, 0.35, 36);
    for (let strand = -3; strand <= 3; strand += 1) {
      for (let sample = 0; sample <= 38; sample += 1) {
        const f = sample / 38;
        const u = strand * 0.23 + Math.sin(f * 5 + t * 2 + strand) * 0.09;
        plot(u, -0.15 + f * 1.02, 0.7 * (1 - f * 0.55));
      }
    }
  });
}

/* -- Butterfly: mirrored wings flap around a quiet body ----------------- */

function paintButterfly(t: number): string {
  return paintPlotted((plot) => {
    const flap = 0.68 + Math.abs(Math.sin(t * 2.4)) * 0.5;
    for (const side of [-1, 1]) {
      for (let sample = 0; sample <= 120; sample += 1) {
        const angle = (sample / 120) * TAU;
        const lobe = 0.42 + 0.25 * Math.cos(angle * 2);
        const u = side * (0.18 + Math.abs(Math.cos(angle)) * lobe * flap);
        const v = Math.sin(angle) * (0.78 - 0.16 * Math.cos(angle));
        plot(u, v, 0.42 + 0.45 * Math.abs(Math.sin(angle)));
      }
    }
    plotSegment(plot, 0, -0.58, 0, 0.65, 0.9, 28);
  });
}

/* -- Magnetic field: flux lines bend between two moving poles ----------- */

function paintMagneticField(t: number): string {
  return paintPlotted((plot) => {
    const wobble = Math.sin(t * 1.4) * 0.12;
    for (const arc of [-0.72, -0.44, -0.2, 0.2, 0.44, 0.72]) {
      for (let sample = 0; sample <= 70; sample += 1) {
        const f = sample / 70;
        const u = -1.18 + f * 2.36;
        const v = arc * Math.sin(f * Math.PI) + wobble * Math.cos(f * TAU);
        const pulse = 0.55 + 0.45 * Math.cos(f * 12 - t * 3);
        plot(u, v, 0.22 + 0.68 * pulse);
      }
    }
    plot(-1.2, wobble, 1);
    plot(1.2, -wobble, 1);
  });
}

/* -- Satellite: a moon circles a slowly rotating ringed planet ---------- */

function paintSatellite(t: number): string {
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 90; sample += 1) {
      const angle = (sample / 90) * TAU;
      plot(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, 0.72);
      plot(Math.cos(angle) * 1.35, Math.sin(angle) * 0.66, 0.24);
    }
    const moonAngle = t * 1.7;
    const moonU = Math.cos(moonAngle) * 1.35;
    const moonV = Math.sin(moonAngle) * 0.66;
    plot(moonU, moonV, 1);
    plot(moonU + 0.08, moonV, 0.65);
    plotSegment(plot, -0.43, Math.sin(t) * 0.1, 0.43, -Math.sin(t) * 0.1, 0.34, 18);
  });
}

/* -- Mountain range: layered peaks slide at different speeds ------------ */

function paintMountainRange(t: number): string {
  return paintPlotted((plot) => {
    for (let layer = 0; layer < 3; layer += 1) {
      const base = 0.72 - layer * 0.28;
      const speed = t * (0.16 + layer * 0.08);
      let previousU = -ASPECT;
      let previousV = base;
      for (let point = 1; point <= 18; point += 1) {
        const u = -ASPECT + (point / 18) * ASPECT * 2;
        const ridge = Math.abs(Math.sin(point * (1.1 + layer * 0.19) + speed));
        const v = base - ridge * (0.44 + layer * 0.1);
        plotSegment(plot, previousU, previousV, u, v, 0.35 + layer * 0.23, 6);
        previousU = u;
        previousV = v;
      }
    }
  });
}

/* -- Circuit pulse: energy routes through an angular circuit board ------ */

function paintCircuitPulse(t: number): string {
  return paintGrid((x, y) => {
    const path = (x + Math.floor(y / 2) * 5) % W;
    const wire = y % 3 === 1 && x % 6 < 5;
    const via = x % 6 === 0 && y > 0 && y < H - 1;
    if (!wire && !via) return 0;
    const head = (t * 10) % W;
    const distance = (path - head + W) % W;
    return distance < 2 ? 1 : distance < 6 ? 0.65 - distance * 0.07 : 0.16;
  });
}

/* -- Chaser grid: a bright cell snakes across a field of quiet nodes ----- */

function paintChaserGrid(t: number): string {
  const columns = 14;
  const rows = 5;
  const head = Math.floor(t * 11) % (columns * rows);
  return paintGrid((x, y) => {
    if (x % 2 !== 0 || y % 2 !== 0) return 0;
    const column = Math.floor(x / 2);
    const row = Math.floor(y / 2);
    const order = row % 2 === 0 ? row * columns + column : row * columns + columns - 1 - column;
    const trail = (head - order + columns * rows) % (columns * rows);
    return trail === 0 ? 1 : trail < 7 ? 0.75 - trail * 0.08 : 0.12;
  });
}

/* -- Prism: a beam splits into a moving fan after crossing a triangle ---- */

function paintPrism(t: number): string {
  return paintPlotted((plot) => {
    const corners = [
      [-0.38, 0.58],
      [0, -0.58],
      [0.38, 0.58],
    ] as const;
    for (let edge = 0; edge < 3; edge += 1) {
      const from = corners[edge];
      const to = corners[(edge + 1) % 3];
      plotSegment(plot, from[0], from[1], to[0], to[1], 0.72, 20);
    }
    const entryV = Math.sin(t * 1.6) * 0.34;
    plotSegment(plot, -ASPECT, entryV, -0.25, entryV * 0.35, 0.65, 34);
    for (let ray = -2; ray <= 2; ray += 1) {
      plotSegment(plot, 0.25, entryV * 0.2, ASPECT, entryV + ray * 0.24, 0.48 + ray * 0.08, 34);
    }
  });
}

/* -- Meteor shower: diagonal streaks wrap cleanly around the canvas ------ */

function paintMeteorShower(t: number): string {
  return paintPlotted((plot) => {
    for (let meteor = 0; meteor < 12; meteor += 1) {
      const travel = (t * (0.36 + hash(meteor) * 0.35) + hash(meteor + 20)) % 1;
      const u = ASPECT + 0.6 - travel * (ASPECT * 2 + 1.2);
      const v = -0.95 + hash(meteor + 40) * 1.9 + travel * 0.55;
      plotSegment(plot, u, v, u + 0.34, v - 0.2, 0.45 + hash(meteor + 60) * 0.5, 10);
    }
  });
}

/* -- Fan: offset blades fold open and closed around a pinned center ------ */

function paintFan(t: number): string {
  return paintPlotted((plot) => {
    const spread = 0.45 + Math.abs(Math.sin(t * 1.45)) * 0.7;
    for (let blade = -4; blade <= 4; blade += 1) {
      const angle = -Math.PI / 2 + blade * 0.16 * spread;
      const endU = Math.cos(angle) * 1.35;
      const endV = Math.sin(angle) * 0.86 + 0.72;
      plotSegment(plot, 0, 0.72, endU, endV, 0.34 + (blade + 4) * 0.07, 28);
    }
    plot(0, 0.72, 1);
  });
}

/* -- Scanlines: two sweeping bands reveal a fine interference texture ---- */

const scanlinesField: Field = (u, v, t) => {
  const horizontal = Math.exp(-Math.pow((v - Math.sin(t * 1.9) * 0.72) / 0.13, 2));
  const vertical = Math.exp(-Math.pow((u - Math.cos(t * 1.35) * ASPECT * 0.78) / 0.16, 2));
  const texture = 0.5 + 0.5 * Math.sin(u * 13 + v * 7 - t * 3);
  return Math.max(horizontal, vertical) * (0.45 + texture * 0.55);
};

/* -- Eclipse: a dark travelling disc cuts through a bright corona -------- */

const eclipseField: Field = (u, v, t) => {
  const centerU = Math.sin(t * 0.85) * 0.58;
  const distance = Math.hypot(u - centerU, v * 1.05);
  const corona = Math.exp(-Math.pow((distance - 0.55) / 0.13, 2));
  const flare = Math.pow(0.5 + 0.5 * Math.sin(Math.atan2(v, u - centerU) * 9 - t * 2.2), 6);
  return corona * (0.55 + flare * 0.45);
};

/* -- Honeycomb: a hexagonal lattice rolls under a soft wave ------------- */

const honeycombField: Field = (u, v, t) => {
  const x = u * 4.2 + t * 0.75;
  const y = v * 4.8;
  const a = Math.abs(Math.sin(x));
  const b = Math.abs(Math.sin(x * 0.5 + y * 0.86));
  const c = Math.abs(Math.sin(x * 0.5 - y * 0.86));
  const edge = 1 - Math.min(a, b, c);
  return Math.pow(edge, 7) * (0.55 + 0.45 * Math.sin(v * 3 - t) ** 2);
};

/* -- Barcode: uneven columns scan sideways with a travelling highlight --- */

const barcodeField: Field = (u, v, t) => {
  const column = Math.floor(((u / ASPECT + 1) / 2) * W);
  const stripe = hash(column * 3.7) > 0.48 ? 1 : 0.16;
  const scanner = Math.exp(-Math.pow((u - Math.sin(t * 1.7) * ASPECT * 0.9) / 0.2, 2));
  const clipped = Math.abs(v) < 0.76 - hash(column + 90) * 0.3 ? 1 : 0;
  return clipped * stripe * (0.28 + scanner * 0.72);
};

/* -- Caustics: watery ridges drift and cross like light on a pool -------- */

const causticsField: Field = (u, v, t) => {
  const first = Math.abs(Math.sin(u * 5.4 + Math.sin(v * 3.1 - t) * 2.1 + t * 1.4));
  const second = Math.abs(Math.sin(v * 6.2 + Math.sin(u * 2.7 + t * 0.8) * 1.8 - t));
  return Math.pow(1 - Math.min(first, second), 4.5);
};

/* -- Shockwave: a compressed front expands from alternating corners ------ */

const shockwaveField: Field = (u, v, t) => {
  const cycle = (t * 0.58) % 1;
  const originU = Math.floor(t * 0.58) % 2 === 0 ? -ASPECT : ASPECT;
  const originV = Math.floor(t * 0.58) % 3 === 0 ? -1 : 1;
  const radius = cycle * 4.1;
  const distance = Math.hypot(u - originU, v - originV);
  return Math.exp(-Math.pow((distance - radius) / 0.13, 2)) * (1 - cycle * 0.35);
};

/* -- Curtain: vertical strands sway with delayed, layered motion --------- */

const curtainField: Field = (u, v, t) => {
  const strand = Math.pow(0.5 + 0.5 * Math.cos(u * 16), 10);
  const fold = 0.5 + 0.5 * Math.sin(v * 3.4 + Math.sin(u * 2.2 - t * 1.3) * 2.4 + t);
  const hem = Math.exp(-Math.pow((v - Math.sin(u * 2.1 - t) * 0.42) / 0.12, 2));
  return Math.max(strand * fold * 0.62, hem * 0.8);
};

/* -- Lattice: a perspective floor rolls toward a low horizon ------------ */

const latticeField: Field = (u, v, t) => {
  const depth = clamp01((v + 1) / 2);
  const perspectiveX = Math.abs(Math.sin((u / (0.18 + depth)) * 1.25));
  const perspectiveY = Math.abs(Math.sin(7 / (depth + 0.13) - t * 3.2));
  const line = 1 - Math.min(perspectiveX, perspectiveY);
  return Math.pow(line, 8) * depth;
};

/* -- Quasar: a hot core throws a twisting horizontal jet ---------------- */

const quasarField: Field = (u, v, t) => {
  const core = Math.exp(-(u * u + v * v) / 0.045);
  const jetCenter = Math.sin(u * 5 - t * 2) * 0.12;
  const jet = Math.exp(-Math.pow((v - jetCenter) / (0.08 + Math.abs(u) * 0.025), 2));
  const fade = Math.exp(-Math.abs(u) * 0.85);
  return Math.max(core, jet * fade * (0.5 + 0.5 * Math.cos(u * 13 - t * 4)));
};

/* -- Mandala: nested angular petals rotate in opposite directions -------- */

const mandalaField: Field = (u, v, t) => {
  const x = u / 1.25;
  const radius = Math.hypot(x, v);
  const angle = Math.atan2(v, x);
  const petals = Math.cos(angle * 8 + t) * 0.12 + Math.cos(angle * 4 - t * 0.7) * 0.09;
  const rings = 0.5 + 0.5 * Math.cos((radius + petals) * 18 - t * 1.5);
  return Math.pow(rings, 6) * clamp01(1.25 - radius);
};

/* -- Dunes: soft ridges migrate at separate depths ---------------------- */

const dunesField: Field = (u, v, t) => {
  let value = 0;
  for (let layer = 0; layer < 4; layer += 1) {
    const ridge =
      0.68 -
      layer * 0.34 +
      Math.sin(u * (1.6 + layer * 0.32) + t * (0.35 + layer * 0.12)) * 0.16;
    const line = Math.exp(-Math.pow((v - ridge) / (0.07 + layer * 0.015), 2));
    value = Math.max(value, line * (0.35 + layer * 0.17));
  }
  return value;
};

/* ========================================================================
   Simulations: state that advances a generation at a time.
   ===================================================================== */

/* -- Rain: glyphs falling inside a chasing terminal frame ----------------- */

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

/* -- Rule 30: an elementary automaton scrolling upward -------------------- */

const RULE30_SECONDS_PER_STEP = 0.085;

function rule30Row(previous: Uint8Array): Uint8Array {
  const next = new Uint8Array(W);
  for (let x = 0; x < W; x += 1) {
    const left = previous[(x - 1 + W) % W];
    const middle = previous[x];
    const right = previous[(x + 1) % W];
    next[x] = left ^ (middle | right) ? 1 : 0;
  }
  return next;
}

function createRule30Painter(): Painter {
  const rule30At = makeStepper<Uint8Array[]>(
    (epoch) => {
      const first = new Uint8Array(W);
      first[(Math.floor(hash(epoch * 41) * W) + W) % W] = 1;
      return [first];
    },
    (rows) => {
      const next = [...rows, rule30Row(rows[rows.length - 1])];
      return next.length > H ? next.slice(next.length - H) : next;
    },
    260,
  );

  return (t) => {
    const rows = rule30At(Math.floor(t / RULE30_SECONDS_PER_STEP));
    const top = H - rows.length;
    return paintGrid((x, y) => {
      const row = rows[y - top];
      if (!row) return 0;
      if (row[x] !== 1) return 0;
      /* Older rows sit higher and dim, so the growth direction is legible. */
      return 0.45 + 0.55 * ((y - top) / Math.max(1, rows.length - 1));
    });
  };
}

/* -- Langton's ant: a two-colour ant plowing its highway ------------------- */

const ANT_SECONDS_PER_STEP = 0.04;

interface AntState {
  cells: Uint8Array;
  x: number;
  y: number;
  /** 0 up, 1 right, 2 down, 3 left. */
  heading: number;
}

function createLangtonPainter(): Painter {
  const antAt = makeStepper<AntState>(
    (epoch) => ({
      cells: new Uint8Array(W * H),
      x: Math.floor(hash(epoch * 7.3) * W),
      y: Math.floor(hash(epoch * 13.7) * H),
      heading: Math.floor(hash(epoch * 3.1) * 4),
    }),
    (state) => {
      /* Turn right on a dark cell, left on a lit one, flip it, walk on. */
      const index = state.y * W + state.x;
      const lit = state.cells[index] === 1;
      state.cells[index] = lit ? 0 : 1;
      const heading = (state.heading + (lit ? 3 : 1)) % 4;
      return {
        cells: state.cells,
        x: (state.x + (heading === 1 ? 1 : heading === 3 ? -1 : 0) + W) % W,
        y: (state.y + (heading === 2 ? 1 : heading === 0 ? -1 : 0) + H) % H,
        heading,
      };
    },
    520,
  );

  return (t) => {
    const state = antAt(Math.floor(t / ANT_SECONDS_PER_STEP));
    return paintGrid((x, y) => {
      if (x === state.x && y === state.y) return 1;
      return state.cells[y * W + x] === 1 ? 0.5 : 0;
    });
  };
}

/* -- Equalizer: bars driven by layered oscillators ------------------------ */

function paintEqualizer(t: number): string {
  return paintGrid((x, y) => {
    if (x % 3 === 2) return 0;
    const bar = Math.floor(x / 3);
    const speed = 1.2 + hash(bar * 3.3) * 2.8;
    const swing = 0.5 + 0.5 * Math.sin(t * speed + bar * 0.8);
    const envelope = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.7 + bar * 0.35));
    const height = swing * envelope * H;
    const fromBottom = H - y;
    if (fromBottom > height) return 0;
    if (fromBottom > height - 1) return 0.5;
    return 0.4 + 0.55 * (1 - fromBottom / H);
  });
}

/** Builds one painter. Called once per surface that shows an animation. */
export type PainterFactory = () => Painter;

/**
 * Most animations are pure functions of time, so every surface can share one
 * instance. Only the simulations below need their own.
 */
function stateless(paint: Painter): PainterFactory {
  return () => paint;
}

function field(source: Field): PainterFactory {
  const paint: Painter = (t) => paintField(source, t);
  return () => paint;
}

/**
 * Named scenes for tool empty states and other ambient surfaces. Kept separate
 * from the random startup pool so each place can pick art that matches what it
 * is saying, rather than rolling the dice every mount.
 */
export const ASCII_SCENES = {
  sonar: field(sonarField),
  radar: field(radarField),
  hourglass: stateless(paintHourglass),
  ripple: field(rippleField),
  network: stateless(paintNetwork),
  pendulum: stateless(paintPendulum),
  waves: stateless(paintWaves),
  clouds: field(cloudsField),
  clock: stateless(paintClock),
  /** One-shot celebration when a checklist tab goes fully clear. */
  fireworks: stateless(paintFireworks),
  /** Full-area falling confetti for checklist all-clear. */
  confetti: stateless(paintChecklistConfetti),
} as const;

export type AsciiSceneId = keyof typeof ASCII_SCENES;

/**
 * The pool the loader draws from. Nothing here is provider-specific: the
 * first time a terminal shows the loader it draws one (random, behind the
 * shared 70% pool cooldown so recent picks sit out), and keeps it for as
 * long as that terminal lives.
 */
export const ASCII_ANIMATIONS: readonly PainterFactory[] = [
  stateless(paintBraid),
  field(burstField),
  field(cometField),
  stateless(paintCube),
  stateless(paintRain),
  stateless(paintTorus),
  field(plasmaField),
  field(rippleField),
  field(spiralField),
  stateless(paintWarp),
  field(metaballsField),
  stateless(paintLissajous),
  field(tunnelField),
  stateless(paintHelix),
  stateless(paintBounce),
  stateless(paintFireworks),
  stateless(paintPendulum),
  stateless(paintOctahedron),
  stateless(paintGlobe),
  /* Rule 30 advances a generation at a time, so two surfaces sharing one
     instance would drag its clock backwards and forwards and reseed on every
     frame. It gets a fresh simulation. Conway is intentionally not in the
     startup pool because its random seed reads like broken glyphs in a still
     frame, even though the simulation itself is valid. */
  createRule30Painter,
  field(voronoiField),
  field(radarField),
  field(kaleidoscopeField),
  field(fireField),
  stateless(paintFunnel),
  stateless(paintOrbits),
  field(cloudsField),
  field(diamondsField),
  field(moireField),
  stateless(paintBarberPole),
  field(sonarField),
  stateless(paintRibbon),
  stateless(paintNetwork),
  stateless(paintEqualizer),
  stateless(paintSnake),
  field(interferenceField),
  stateless(paintFlowField),
  stateless(paintStarPoly),
  stateless(paintOscilloscope),
  stateless(paintTetrahedron),
  field(checkerField),
  stateless(paintGalaxy),
  stateless(paintTrefoil),
  field(auroraField),
  stateless(paintBubbles),
  stateless(paintGear),
  stateless(paintRose),
  field(squareTunnelField),
  stateless(paintRaindrops),
  stateless(paintClock),
  stateless(paintSpring),
  field(petalsField),
  stateless(paintWaves),
  stateless(paintAtom),
  stateless(paintScreensaver),
  stateless(paintSpirograph),
  stateless(paintWindmill),
  stateless(paintHourglass),
  stateless(paintLightning),
  stateless(paintFountain),
  stateless(paintHeartbeat),
  stateless(paintInfinity),
  stateless(paintJellyfish),
  stateless(paintButterfly),
  stateless(paintMagneticField),
  stateless(paintSatellite),
  stateless(paintMountainRange),
  stateless(paintCircuitPulse),
  stateless(paintChaserGrid),
  stateless(paintPrism),
  stateless(paintMeteorShower),
  stateless(paintFan),
  field(scanlinesField),
  field(eclipseField),
  field(honeycombField),
  field(barcodeField),
  field(causticsField),
  field(shockwaveField),
  field(curtainField),
  field(latticeField),
  field(quasarField),
  field(mandalaField),
  field(dunesField),
  /* A simulation like Rule 30 above: each surface needs its own instance. */
  createLangtonPainter,
];
