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
  hash2,
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

/* ========================================================================
   Second collection: fifty more scenes, grouped the same way as above.
   ===================================================================== */

/* -- Icosahedron: the twenty-sided solid, tumbling slowly ---------------- */

/* Golden ratio times the 0.72 radius the other solids are drawn at. */
const ICO_SHORT = 0.72;
const ICO_LONG = 1.165;

const ICOSAHEDRON_VERTICES: readonly Vertex[] = [
  [-ICO_SHORT, ICO_LONG, 0],
  [ICO_SHORT, ICO_LONG, 0],
  [-ICO_SHORT, -ICO_LONG, 0],
  [ICO_SHORT, -ICO_LONG, 0],
  [0, -ICO_SHORT, ICO_LONG],
  [0, ICO_SHORT, ICO_LONG],
  [0, -ICO_SHORT, -ICO_LONG],
  [0, ICO_SHORT, -ICO_LONG],
  [ICO_LONG, 0, -ICO_SHORT],
  [ICO_LONG, 0, ICO_SHORT],
  [-ICO_LONG, 0, -ICO_SHORT],
  [-ICO_LONG, 0, ICO_SHORT],
];

const ICOSAHEDRON_EDGES: readonly Edge[] = [
  [0, 1],
  [0, 5],
  [0, 7],
  [0, 10],
  [0, 11],
  [1, 5],
  [1, 7],
  [1, 8],
  [1, 9],
  [2, 3],
  [2, 4],
  [2, 6],
  [2, 10],
  [2, 11],
  [3, 4],
  [3, 6],
  [3, 8],
  [3, 9],
  [4, 5],
  [4, 9],
  [4, 11],
  [5, 9],
  [5, 11],
  [6, 7],
  [6, 8],
  [6, 10],
  [7, 8],
  [7, 10],
  [8, 9],
  [10, 11],
];

const paintIcosahedron: Painter = (t) =>
  paintWireframe(ICOSAHEDRON_VERTICES, ICOSAHEDRON_EDGES, t, 0.85, 0.92);

/* -- Pyramid: a square base turning under a single apex ------------------ */

const PYRAMID_VERTICES: readonly Vertex[] = [
  [-1, 0.85, -1],
  [1, 0.85, -1],
  [1, 0.85, 1],
  [-1, 0.85, 1],
  [0, -1.2, 0],
];

const PYRAMID_EDGES: readonly Edge[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
];

const paintPyramid: Painter = (t) =>
  paintWireframe(PYRAMID_VERTICES, PYRAMID_EDGES, t, 0.95, 1.05);

/* -- Tesseract: a 4D cube projected twice on its way to the screen -------- */

function tesseractVertices(): Array<readonly [number, number, number, number]> {
  const list: Array<readonly [number, number, number, number]> = [];
  for (let bits = 0; bits < 16; bits += 1) {
    list.push([
      bits & 1 ? 1 : -1,
      bits & 2 ? 1 : -1,
      bits & 4 ? 1 : -1,
      bits & 8 ? 1 : -1,
    ]);
  }
  return list;
}

/** Two vertices share an edge when their coordinates differ on one axis. */
function tesseractEdges(): Edge[] {
  const list: Edge[] = [];
  for (let from = 0; from < 16; from += 1) {
    for (let axis = 0; axis < 4; axis += 1) {
      const to = from ^ (1 << axis);
      if (to > from) list.push([from, to]);
    }
  }
  return list;
}

const TESSERACT_VERTICES = tesseractVertices();
const TESSERACT_EDGES = tesseractEdges();

function paintTesseract(t: number): string {
  const inner = t * 0.5;
  const outer = t * 0.36;
  const yaw = t * 0.28;

  const projected = TESSERACT_VERTICES.map(([x, y, z, w]) => {
    /* Turn in the xw plane first: that is the rotation with no 3D analogue,
       and it is what makes the inner cube swap places with the outer one. */
    const xw = x * Math.cos(inner) - w * Math.sin(inner);
    const ww = x * Math.sin(inner) + w * Math.cos(inner);
    const yz = y * Math.cos(outer) - z * Math.sin(outer);
    const zz = y * Math.sin(outer) + z * Math.cos(outer);
    const near = 1.9 / (3.1 - ww);
    const x3 = xw * near;
    const y3 = yz * near;
    const z3 = zz * near;
    const rx = x3 * Math.cos(yaw) + z3 * Math.sin(yaw);
    const rz = z3 * Math.cos(yaw) - x3 * Math.sin(yaw);
    const scale = 2 / (3.4 + rz);
    return [rx * scale * 1.3, y3 * scale * 0.78, rz] as const;
  });

  return paintPlotted((plot) => {
    for (const [from, to] of TESSERACT_EDGES) {
      const a = projected[from];
      const b = projected[to];
      for (let step = 0; step <= 20; step += 1) {
        const f = step / 20;
        const depth = a[2] + (b[2] - a[2]) * f;
        plot(
          a[0] + (b[0] - a[0]) * f,
          a[1] + (b[1] - a[1]) * f,
          0.26 + 0.74 * clamp01((1.6 - depth) / 3.2),
        );
      }
    }
  });
}

/* -- Mobius strip: one surface, drawn as three bands with a half twist ---- */

function paintMobius(t: number): string {
  const yaw = t * 0.6;
  const tilt = 0.45;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);

  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 170; sample += 1) {
      const s = (sample / 170) * TAU;
      for (let band = -1; band <= 1; band += 1) {
        /* The half twist: the band offset turns by s/2 over a full lap, so
           the strip comes back joined to its own other side. */
        const half = band * 0.34;
        const radius = 1 + half * Math.cos(s / 2);
        const x = radius * Math.cos(s);
        const z = radius * Math.sin(s);
        const y = half * Math.sin(s / 2);
        const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
        const rz = z * Math.cos(yaw) - x * Math.sin(yaw);
        plot(
          rx * 0.9,
          (y * cosTilt - rz * sinTilt) * 0.9,
          0.22 + 0.78 * clamp01((rz * cosTilt + y * sinTilt + 1.3) / 2.6),
        );
      }
    }
  });
}

/* -- Cone: ribs running from a fixed apex to a turning rim ---------------- */

function paintCone(t: number): string {
  const spin = t * 1.05;
  const tilt = 0.22 + Math.sin(t * 0.5) * 0.12;

  return paintPlotted((plot) => {
    for (let step = 0; step <= 80; step += 1) {
      const angle = (step / 80) * TAU;
      plot(Math.cos(angle) * 1.2, 0.6 + Math.sin(angle) * tilt, 0.28);
    }
    for (let rib = 0; rib < 9; rib += 1) {
      const angle = (rib / 9) * TAU + spin;
      /* Near ribs are the ones swinging toward the viewer, so shade by cos. */
      const depth = (Math.cos(angle) + 1) / 2;
      plotSegment(
        plot,
        0,
        -0.85,
        Math.cos(angle) * 1.2,
        0.6 + Math.sin(angle) * tilt,
        0.18 + 0.8 * depth,
        22,
      );
    }
  });
}

/* -- Sphere spiral: one rhumb line wound pole to pole --------------------- */

function paintSphereSpiral(t: number): string {
  const yaw = t * 0.72;
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 280; sample += 1) {
      const f = sample / 280;
      const lat = -Math.PI / 2 + f * Math.PI;
      const lon = f * TAU * 5 + yaw;
      const z = Math.cos(lat) * Math.sin(lon);
      /* Back half culled, so the winding reads as wrapping a solid ball. */
      if (z < -0.04) continue;
      plot(
        Math.cos(lat) * Math.cos(lon) * 1.32,
        Math.sin(lat) * 0.88,
        0.22 + 0.78 * clamp01((z + 0.04) / 1.04),
      );
    }
  });
}

/* -- Gimbal: three rings turning on axes that never line up --------------- */

function paintGimbal(t: number): string {
  return paintPlotted((plot) => {
    const spins = [t * 0.9, t * 0.62 + 2.1, t * 0.44 + 4.2];
    spins.forEach((spin, ring) => {
      /* Each ring is a circle seen edge on, so its height collapses as it
         turns through the screen plane. */
      const squash = 0.2 + 0.8 * Math.abs(Math.sin(spin));
      const roll = ring * (Math.PI / 3) + spin * 0.25;
      const radius = 0.94 - ring * 0.17;
      for (let step = 0; step <= 100; step += 1) {
        const angle = (step / 100) * TAU;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * squash;
        plot(
          (x * Math.cos(roll) - y * Math.sin(roll)) * 1.4,
          x * Math.sin(roll) + y * Math.cos(roll),
          0.28 + 0.72 * ((Math.cos(angle) + 1) / 2),
        );
      }
    });
  });
}

/* -- Spinning top: a disc precessing around a planted tip ----------------- */

function paintSpinningTop(t: number): string {
  const precession = t * 1.05;
  const lean = 0.24 + Math.sin(t * 0.45) * 0.1;
  const hubU = Math.sin(precession) * lean * 2.4;

  return paintPlotted((plot) => {
    plotSegment(plot, 0, 0.94, hubU * 1.3, -0.78, 0.7, 26);
    for (let step = 0; step <= 64; step += 1) {
      const angle = (step / 64) * TAU;
      const depth = (Math.cos(angle - precession) + 1) / 2;
      const rimU = hubU * 0.6 + Math.cos(angle);
      const rimV = 0.1 + Math.sin(angle) * 0.22;
      plot(rimU, rimV, 0.28 + 0.72 * depth);
      if (step % 8 === 0) plotSegment(plot, 0, 0.94, rimU, rimV, 0.16 + 0.5 * depth, 12);
    }
  });
}

/* -- Times table: chords from n to n times a slowly drifting multiplier ---- */

const TIMES_TABLE_POINTS = 34;

function paintTimesTable(t: number): string {
  /* The multiplier is what picks the figure: 2 draws a cardioid, 3 a nephroid,
     and everything between morphs from one into the next. */
  const multiplier = 2 + ((t * 0.2) % 5);

  return paintPlotted((plot) => {
    for (let point = 0; point < TIMES_TABLE_POINTS; point += 1) {
      const from = (point / TIMES_TABLE_POINTS) * TAU;
      const to = ((point * multiplier) / TIMES_TABLE_POINTS) * TAU;
      /* Chords cover the whole disc at this size, so only a few carry the
         highlight; the rest sit back as the web the envelope is drawn on. */
      plotSegment(
        plot,
        Math.cos(from) * 1.5,
        Math.sin(from) * 0.92,
        Math.cos(to) * 1.5,
        Math.sin(to) * 0.92,
        0.14 + 0.8 * Math.pow(0.5 + 0.5 * Math.cos(from * 3 - t * 1.5), 3),
        14,
      );
    }
  });
}

/* -- Epitrochoid: a small wheel rolling around a big one ------------------ */

function paintEpitrochoid(t: number): string {
  const arm = 0.45 + Math.sin(t * 0.32) * 0.25;
  return paintPlotted((plot) => {
    const samples = 300;
    for (let i = 0; i < samples; i += 1) {
      const s = (i / samples) * TAU;
      const lead = (((t * 0.38 - i / samples) % 1) + 1) % 1;
      /* A gentle exponent so the tail shades all the way round the figure
         instead of dropping to a flat floor a few samples behind the head. */
      plot(
        (Math.cos(s) * 0.7 - Math.cos(s * 7) * arm * 0.4) * ASPECT * 0.82,
        (Math.sin(s) * 0.7 - Math.sin(s * 7) * arm * 0.4) * 0.94,
        0.1 + 0.9 * Math.pow(1 - lead, 2.2),
      );
    }
  });
}

/* -- Phyllotaxis: sunflower seeds on the golden angle --------------------- */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function paintPhyllotaxis(t: number): string {
  return paintPlotted((plot) => {
    for (let seed = 0; seed < 74; seed += 1) {
      const f = seed / 74;
      /* sqrt spacing keeps the seeds at even density instead of crowding
         the rim, which is what makes the two spiral families show up. */
      const radius = Math.sqrt(f) * 0.95;
      const angle = seed * GOLDEN_ANGLE + t * 0.5;
      /* A wave of brightness travelling out from the middle, so the spiral
         families read one at a time instead of as an even speckle. */
      const glow = 0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.4 - radius * 7), 3);
      plot(Math.cos(angle) * radius * 1.52, Math.sin(angle) * radius * 0.95, glow);
    }
  });
}

/* -- Hilbert curve: a space filling path with a pulse running it ---------- */

/* Order 2. A finer curve folds below one cell per leg at this grid size. */
const HILBERT_SIDE = 4;

/** Standard d2xy walk: fold the index down one quadrant at a time. */
function hilbertPoint(index: number): readonly [number, number] {
  let x = 0;
  let y = 0;
  let remaining = index;
  for (let block = 1; block < HILBERT_SIDE; block *= 2) {
    const rx = 1 & Math.floor(remaining / 2);
    const ry = 1 & (remaining ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = block - 1 - x;
        y = block - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += block * rx;
    y += block * ry;
    remaining = Math.floor(remaining / 4);
  }
  return [x, y];
}

function paintHilbert(t: number): string {
  const total = HILBERT_SIDE * HILBERT_SIDE;
  const head = ((t * 0.24) % 1) * total;

  return paintPlotted((plot) => {
    let previous = hilbertPoint(0);
    for (let index = 1; index < total; index += 1) {
      const point = hilbertPoint(index);
      const lead = (head - index + total) % total;
      plotSegment(
        plot,
        (previous[0] / (HILBERT_SIDE - 1) - 0.5) * 2.9,
        (previous[1] / (HILBERT_SIDE - 1) - 0.5) * 1.8,
        (point[0] / (HILBERT_SIDE - 1) - 0.5) * 2.9,
        (point[1] / (HILBERT_SIDE - 1) - 0.5) * 1.8,
        lead < 5 ? 1 - lead * 0.16 : 0.16,
        9,
      );
      previous = point;
    }
  });
}

/* -- Harmonograph: four decaying pendulums drawing one figure ------------- */

function paintHarmonograph(t: number): string {
  const drift = t * 0.11;
  return paintPlotted((plot) => {
    const samples = 260;
    for (let i = 0; i < samples; i += 1) {
      const s = (i / samples) * TAU * 6;
      /* The decay is what turns a closed curve into a spiral of near misses. */
      const decay = Math.exp(-(i / samples) * 1.5);
      const lead = (((t * 0.3 - i / samples) % 1) + 1) % 1;
      plot(
        (Math.sin(s * 1.001 + drift) + Math.sin(s * 2.004 + 1.3)) * 0.72 * decay,
        (Math.sin(s * 1.502 + drift * 1.7) + Math.sin(s * 3.005)) * 0.44 * decay,
        0.12 + 0.88 * Math.pow(1 - lead, 3),
      );
    }
  });
}

/* -- Nautilus: a logarithmic shell with its chamber walls ----------------- */

function paintNautilus(t: number): string {
  const spin = t * 0.5;
  return paintPlotted((plot) => {
    /* Start a third of a turn in: the innermost coil folds into a single
       cell at this size and reads as a blot rather than a shell. */
    for (let sample = 0; sample <= 280; sample += 1) {
      const s = 2.2 + (sample / 280) * TAU * 2.6;
      const radius = 0.055 * Math.exp(s * 0.31);
      if (radius > 1.02) break;
      plot(
        Math.cos(s + spin) * radius * 1.42,
        Math.sin(s + spin) * radius * 0.94,
        0.3 + 0.7 * (radius / 1.02),
      );
    }
    for (let chamber = 0; chamber < 8; chamber += 1) {
      const s = 2.2 + (chamber / 8) * TAU * 2.6;
      const radius = 0.055 * Math.exp(s * 0.31);
      if (radius > 1.02) continue;
      plotSegment(
        plot,
        0,
        0,
        Math.cos(s + spin) * radius * 1.42,
        Math.sin(s + spin) * radius * 0.94,
        0.2,
        12,
      );
    }
  });
}

/* -- Newton's cradle: momentum handed across a row of still balls --------- */

function paintNewtonsCradle(t: number): string {
  const swing = Math.sin(t * 1.9);
  return paintPlotted((plot) => {
    plotSegment(plot, -1.15, -0.92, 1.15, -0.92, 0.35, 34);
    for (let ball = 0; ball < 5; ball += 1) {
      const home = -0.72 + ball * 0.36;
      /* Only the end balls ever leave the stack, and only on their own half
         of the swing. Everything between hangs perfectly still. */
      let angle = 0;
      if (ball === 0 && swing < 0) angle = swing * 0.7;
      if (ball === 4 && swing > 0) angle = swing * 0.7;
      const u = home + Math.sin(angle) * 1.15;
      const v = -0.92 + Math.cos(angle) * 1.4;
      plotSegment(plot, home, -0.92, u, v, 0.3, 16);
      for (let around = 0; around < TAU; around += 0.55) {
        plot(u + Math.cos(around) * 0.14, v + Math.sin(around) * 0.1, 0.95);
      }
    }
  });
}

/* -- Pong: paddles tracking a ball that never quite gets away ------------- */

function paintPong(t: number): string {
  const ballV = (bouncePhase(t * 0.61 + 0.2) * 2 - 1) * 0.62;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 12; step += 1) {
      if (Math.floor(step / 2) % 2 === 0) plot(0, -0.9 + (step / 12) * 1.8, 0.16);
    }
    /* The paddles lag the ball by different amounts, so the rally never ends. */
    plotSegment(plot, -1.52, ballV * 0.85 - 0.3, -1.52, ballV * 0.85 + 0.3, 0.85, 12);
    plotSegment(plot, 1.52, -ballV * 0.7 - 0.3, 1.52, -ballV * 0.7 + 0.3, 0.85, 12);
    for (let ghost = 3; ghost >= 0; ghost -= 1) {
      const moment = t - ghost * 0.06;
      plot(
        (bouncePhase(moment * 0.43) * 2 - 1) * 1.3,
        (bouncePhase(moment * 0.61 + 0.2) * 2 - 1) * 0.62,
        1 - ghost * 0.22,
      );
    }
  });
}

/* -- Rocket: a climb through a starfield falling the other way ------------ */

function paintRocket(t: number): string {
  const climb = (t * 0.28) % 1;
  const v = 0.92 - climb * 1.95;
  const drift = Math.sin(t * 1.1) * 0.3;

  return paintPlotted((plot) => {
    for (let star = 0; star < 13; star += 1) {
      plot(
        (hash(star * 5.3) * 2 - 1) * ASPECT,
        ((hash(star * 9.1) + t * 0.16) % 1) * 2 - 1,
        0.18,
      );
    }
    /* A tall body with stubby fins, so the silhouette survives four cells. */
    plotSegment(plot, drift, v - 0.42, drift - 0.2, v + 0.2, 0.95, 14);
    plotSegment(plot, drift, v - 0.42, drift + 0.2, v + 0.2, 0.95, 14);
    plotSegment(plot, drift - 0.2, v + 0.2, drift + 0.2, v + 0.2, 0.7, 8);
    plotSegment(plot, drift - 0.2, v + 0.2, drift - 0.44, v + 0.42, 0.6, 8);
    plotSegment(plot, drift + 0.2, v + 0.2, drift + 0.44, v + 0.42, 0.6, 8);
    for (let flame = 0; flame < 14; flame += 1) {
      const age = flame / 14;
      const wobble = (hash(flame + Math.floor(t * 11)) - 0.5) * age * 0.6;
      plot(drift + wobble, v + 0.22 + age * 0.85, (1 - age) * 0.9);
    }
  });
}

/* -- Snowfall: flakes swaying down onto a drifted floor ------------------- */

function paintSnowfall(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 44; step += 1) {
      const u = (step / 44) * ASPECT * 2 - ASPECT;
      plot(u, 0.95 - Math.abs(Math.sin(u * 1.3 + 0.7)) * 0.09, 0.5);
    }
    for (let flake = 0; flake < 22; flake += 1) {
      /* Near flakes fall faster and sit brighter, which is the only depth
         cue available when every flake is one character wide. */
      const near = hash(flake * 11.3);
      const sway = Math.sin(t * (0.55 + hash(flake) * 0.6) + flake) * 0.24;
      plot(
        (hash(flake * 7.9) * 2 - 1) * ASPECT * 0.95 + sway,
        ((t * (0.1 + near * 0.2) + hash(flake * 5.1)) % 1) * 2 - 1,
        0.22 + near * 0.78,
      );
    }
  });
}

/* -- Tree: a binary tree with the sway growing toward the tips ------------ */

function growBranch(
  plot: Plot,
  t: number,
  u: number,
  v: number,
  angle: number,
  length: number,
  depth: number,
): void {
  if (depth <= 0) return;
  /* The trunk is rigid and each generation above it bends more, which is how
     a real tree moves: the wind loads the thin ends, not the base. */
  const sway = Math.sin(t * 1.05 + depth * 0.85) * 0.1 * (4 - depth);
  const endU = u + Math.cos(angle + sway) * length * 1.5;
  const endV = v + Math.sin(angle + sway) * length;
  plotSegment(plot, u, v, endU, endV, 0.24 + depth * 0.18, 10);
  growBranch(plot, t, endU, endV, angle - 0.55, length * 0.68, depth - 1);
  growBranch(plot, t, endU, endV, angle + 0.55, length * 0.68, depth - 1);
}

function paintTree(t: number): string {
  return paintPlotted((plot) => {
    growBranch(plot, t, 0, 0.95, -Math.PI / 2, 0.5, 4);
  });
}

/* -- Juggler: three balls in a cascade, each swapping hands --------------- */

function paintJuggler(t: number): string {
  return paintPlotted((plot) => {
    plot(-0.55, 0.84, 0.8);
    plot(0.55, 0.84, 0.8);
    plotSegment(plot, -0.5, 0.92, 0.5, 0.92, 0.3, 20);
    for (let ball = 0; ball < 3; ball += 1) {
      const clock = t * 0.6 + ball / 3;
      const cycle = clock % 1;
      /* Every throw crosses, so the launch side flips each time round. */
      const side = Math.floor(clock) % 2 === 0 ? 1 : -1;
      const u = side * (0.55 - cycle * 1.1);
      const v = 0.78 - Math.sin(cycle * Math.PI) * 1.55;
      for (let around = 0; around < TAU; around += 0.6) {
        plot(u + Math.cos(around) * 0.16, v + Math.sin(around) * 0.11, 0.65);
      }
      plot(u, v, 1);
    }
  });
}

/* -- Dominoes: a topple running down the line ---------------------------- */

function paintDominoes(t: number): string {
  const front = ((t * 0.42) % 3.2) * 4;
  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.86, ASPECT, 0.86, 0.28, 40);
    for (let tile = 0; tile < 10; tile += 1) {
      const fall = clamp01(front - tile);
      /* Upright is straight up; a fallen tile lies almost flat on the next. */
      const angle = -Math.PI / 2 + fall * 1.44;
      const base = -1.35 + tile * 0.3;
      plotSegment(
        plot,
        base,
        0.86,
        base + Math.cos(angle) * 0.9,
        0.86 + Math.sin(angle) * 0.62,
        0.45 + 0.5 * (1 - fall),
        14,
      );
    }
  });
}

/* -- Carousel: seats riding an ellipse and bobbing on their poles --------- */

function paintCarousel(t: number): string {
  return paintPlotted((plot) => {
    plotSegment(plot, -1.5, -0.5, 0, -0.95, 0.5, 22);
    plotSegment(plot, 1.5, -0.5, 0, -0.95, 0.5, 22);
    plotSegment(plot, 0, -0.92, 0, 0.55, 0.32, 24);
    for (let step = 0; step <= 60; step += 1) {
      const angle = (step / 60) * TAU;
      plot(Math.cos(angle) * 1.42, 0.55 + Math.sin(angle) * 0.32, 0.18);
    }
    for (let seat = 0; seat < 6; seat += 1) {
      const angle = t * 0.8 + (seat / 6) * TAU;
      const depth = (Math.cos(angle) + 1) / 2;
      const u = Math.sin(angle) * 1.42;
      const v = 0.21 - Math.cos(angle) * 0.32 - Math.sin(t * 2.2 + seat) * 0.15;
      plotSegment(plot, u, v, u, v + 0.4, 0.18 + 0.35 * depth, 10);
      plot(u, v, 0.35 + 0.65 * depth);
    }
  });
}

/* -- Rollercoaster: a train running a track over its own supports --------- */

function coasterHeight(u: number): number {
  return Math.sin(u * 1.7) * 0.4 + Math.sin(u * 0.83 + 1.1) * 0.26;
}

function paintRollercoaster(t: number): string {
  return paintPlotted((plot) => {
    for (let post = 0; post <= 7; post += 1) {
      const u = -ASPECT + (post / 7) * ASPECT * 2;
      plotSegment(plot, u, coasterHeight(u), u, 0.92, 0.14, 12);
    }
    for (let sample = 0; sample <= 130; sample += 1) {
      const u = (sample / 130) * ASPECT * 2 - ASPECT;
      plot(u, coasterHeight(u), 0.45);
    }
    for (let car = 0; car < 3; car += 1) {
      const u = ((t * 0.4 + car * 0.06) % 1) * (ASPECT * 2 + 0.6) - ASPECT - 0.3;
      plot(u, coasterHeight(u) - 0.16, 1 - car * 0.18);
      plot(u, coasterHeight(u) - 0.3, 0.6 - car * 0.14);
    }
  });
}

/* -- Paper plane: a glide that keeps trading height for speed ------------- */

function paintPaperPlane(t: number): string {
  const travel = (t * 0.26) % 1;
  const u = -ASPECT - 0.4 + travel * (ASPECT * 2 + 0.8);
  const v = Math.sin(travel * TAU * 1.5) * 0.5 - 0.08;
  /* Nose follows the flight path, so the plane pitches into every dive. */
  const pitch = Math.cos(travel * TAU * 1.5) * 0.5;
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  return paintPlotted((plot) => {
    const noseU = u + cosPitch * 0.44;
    const noseV = v + sinPitch * 0.3;
    const upU = u - cosPitch * 0.3 - sinPitch * 0.1;
    const upV = v - sinPitch * 0.2 - 0.26;
    const downU = u - cosPitch * 0.3 + sinPitch * 0.1;
    const downV = v - sinPitch * 0.2 + 0.26;
    plotSegment(plot, noseU, noseV, upU, upV, 0.95, 16);
    plotSegment(plot, noseU, noseV, downU, downV, 0.95, 16);
    plotSegment(plot, upU, upV, downU, downV, 0.6, 12);
    plotSegment(plot, noseU, noseV, (upU + downU) / 2, (upV + downV) / 2, 0.75, 12);
    for (let puff = 0; puff < 9; puff += 1) {
      const back = 0.4 + puff * 0.21;
      plot(u - back, v - sinPitch * back * 0.4 + Math.sin(t * 1.8 + puff) * 0.05, 0.3 - puff * 0.03);
    }
  });
}

/* -- Pistons: three cylinders firing a third of a turn apart -------------- */

function paintPistons(t: number): string {
  const crank = t * 1.4;
  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.62, ASPECT, 0.62, 0.3, 40);
    for (let cylinder = 0; cylinder < 3; cylinder += 1) {
      const u = -1.05 + cylinder * 1.05;
      const angle = crank + cylinder * (TAU / 3);
      const head = 0.16 - Math.cos(angle) * 0.42;
      plotSegment(plot, u - 0.32, -0.92, u - 0.32, 0.4, 0.26, 16);
      plotSegment(plot, u + 0.32, -0.92, u + 0.32, 0.4, 0.26, 16);
      plotSegment(plot, u - 0.3, head, u + 0.3, head, 0.95, 12);
      /* The rod ties the head to a crank pin sliding along the shaft. */
      plotSegment(plot, u, head, u + Math.sin(angle) * 0.2, 0.62, 0.55, 14);
      plot(u + Math.sin(angle) * 0.2, 0.62, 0.85);
    }
  });
}

/* -- Metronome: a weighted arm sweeping inside its case ------------------- */

function paintMetronome(t: number): string {
  const swing = Math.sin(t * 1.5) * 0.5;
  const tipU = Math.sin(swing) * 1.3;
  return paintPlotted((plot) => {
    plotSegment(plot, -0.62, 0.92, 0.62, 0.92, 0.5, 20);
    plotSegment(plot, -0.62, 0.92, -0.2, -0.9, 0.45, 26);
    plotSegment(plot, 0.62, 0.92, 0.2, -0.9, 0.45, 26);
    plotSegment(plot, -0.2, -0.9, 0.2, -0.9, 0.45, 10);
    plotSegment(plot, 0, 0.7, tipU, -0.85, 0.9, 26);
    /* The bob rides low on the arm, where a real one sets a slow tempo. */
    const bobU = tipU * 0.42;
    const bobV = 0.7 - 1.55 * 0.42;
    plot(bobU, bobV, 1);
    plot(bobU + 0.1, bobV, 0.7);
    plot(bobU - 0.1, bobV, 0.7);
  });
}

/* -- Ferris wheel: cars that stay level as the rim turns ------------------ */

function paintFerrisWheel(t: number): string {
  const spin = t * 0.5;
  return paintPlotted((plot) => {
    plotSegment(plot, -0.6, 0.95, 0, 0.05, 0.35, 20);
    plotSegment(plot, 0.6, 0.95, 0, 0.05, 0.35, 20);
    for (let step = 0; step <= 80; step += 1) {
      const angle = (step / 80) * TAU;
      plot(Math.cos(angle) * 1.28, 0.05 + Math.sin(angle) * 0.8, 0.3);
    }
    for (let car = 0; car < 8; car += 1) {
      const angle = spin + (car / 8) * TAU;
      const u = Math.cos(angle) * 1.28;
      const v = 0.05 + Math.sin(angle) * 0.8;
      /* Spokes stop short of the hub: eight of them meeting in the middle
         fills the wheel with haze at this size. */
      plotSegment(plot, u * 0.45, 0.05 + (v - 0.05) * 0.45, u, v, 0.12, 12);
      plot(u, v + 0.12, 1);
      plot(u - 0.09, v + 0.12, 0.6);
      plot(u + 0.09, v + 0.12, 0.6);
    }
    plot(0, 0.05, 0.9);
  });
}

/* -- Dandelion: a head giving up its seeds to the wind -------------------- */

function paintDandelion(t: number): string {
  const headU = -1.15;
  const headV = 0.1;
  /* Seeds leave in a slow sweep and the head refills once it empties. */
  const bare = (t * 0.16) % 1;

  return paintPlotted((plot) => {
    plotSegment(plot, headU, headV, headU + 0.12, 0.95, 0.35, 18);
    for (let spoke = 0; spoke < 18; spoke += 1) {
      if (hash(spoke * 7.7) < bare) continue;
      const angle = (spoke / 18) * TAU;
      plotSegment(
        plot,
        headU,
        headV,
        headU + Math.cos(angle) * 0.34,
        headV + Math.sin(angle) * 0.24,
        0.55,
        8,
      );
    }
    for (let seed = 0; seed < 9; seed += 1) {
      const drift = (t * 0.15 + hash(seed * 3.3)) % 1;
      const u = headU + drift * 3.1;
      const v = headV - Math.sin(drift * 2.4) * 0.6 + Math.sin(t * 1.05 + seed * 2) * 0.12;
      const life = Math.sin(drift * Math.PI);
      plot(u, v, life);
      plot(u - 0.12, v - 0.08, life * 0.45);
      plot(u - 0.12, v + 0.08, life * 0.45);
    }
  });
}

/* -- Swarm: a flock lagging behind a target it never catches -------------- */

function paintSwarm(t: number): string {
  const targetU = Math.sin(t * 0.52) * 1.25;
  const targetV = Math.cos(t * 0.71) * 0.62;

  return paintPlotted((plot) => {
    for (let bird = 0; bird < 26; bird += 1) {
      /* Different lags are the whole trick: the flock stretches into a tail
         on every turn and bunches up again on the straights. */
      const lag = 0.25 + hash(bird * 3.9) * 0.75;
      const orbit = t * (0.85 + hash(bird * 7.1) * 0.65) + bird;
      const spread = 0.22 + hash(bird * 11.7) * 0.42;
      const u = targetU * lag + Math.cos(orbit) * spread * 1.5;
      const v = targetV * lag + Math.sin(orbit) * spread;
      plot(u, v, 0.4 + hash(bird * 5.5) * 0.6);
      plot(u - 0.12, v - 0.06, 0.25);
    }
  });
}

/* -- Koi: two fish circling a pond under expanding rings ------------------ */

function paintKoi(t: number): string {
  return paintPlotted((plot) => {
    for (let ring = 0; ring < 2; ring += 1) {
      const grow = (t * 0.26 + ring / 2) % 1;
      for (let step = 0; step < 44; step += 1) {
        const angle = (step / 44) * TAU;
        plot(Math.cos(angle) * grow * 1.5, Math.sin(angle) * grow * 0.9, (1 - grow) * 0.16);
      }
    }
    for (let fish = 0; fish < 2; fish += 1) {
      const angle = t * (0.58 + fish * 0.18) + fish * Math.PI;
      const radius = 0.68 + fish * 0.22;
      const cx = Math.cos(angle) * radius * 1.5;
      const cy = Math.sin(angle) * radius * 0.8;
      const heading = angle + Math.PI / 2;
      for (let body = 0; body <= 12; body += 1) {
        const f = body / 12;
        /* The wag grows toward the tail, so the body reads as one wave. */
        const wag = Math.sin(t * 3.4 - f * 3.4) * 0.12 * f;
        plot(
          cx - Math.cos(heading) * f * 0.9 - Math.sin(heading) * wag * 1.5,
          cy - Math.sin(heading) * f * 0.6 + Math.cos(heading) * wag,
          1 - f * 0.7,
        );
      }
    }
  });
}

/* -- Conveyor: crates carried over turning rollers ------------------------ */

function paintConveyor(t: number): string {
  const travel = t * 0.5;
  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.55, ASPECT, 0.55, 0.45, 40);
    for (let roller = 0; roller < 7; roller += 1) {
      const u = -1.44 + roller * 0.48;
      for (let step = 0; step < 8; step += 1) {
        const angle = -travel * 3 + (step / 8) * TAU;
        plot(u + Math.cos(angle) * 0.16, 0.74 + Math.sin(angle) * 0.12, 0.3);
      }
      plot(u + Math.cos(-travel * 3) * 0.16, 0.74 + Math.sin(-travel * 3) * 0.12, 0.9);
    }
    for (let crate = 0; crate < 4; crate += 1) {
      const u = ((travel + crate * 0.25) % 1) * (ASPECT * 2 + 0.9) - ASPECT - 0.45;
      const size = 0.22 + hash(crate * 3.3) * 0.16;
      const top = 0.5 - size * 2;
      plotSegment(plot, u - size, top, u + size, top, 0.9, 10);
      plotSegment(plot, u - size, top, u - size, 0.5, 0.9, 8);
      plotSegment(plot, u + size, top, u + size, 0.5, 0.9, 8);
      plotSegment(plot, u - size, 0.5, u + size, 0.5, 0.6, 10);
    }
  });
}

/* -- Wind chime: tubes swinging on their own periods ---------------------- */

function paintWindChime(t: number): string {
  return paintPlotted((plot) => {
    plotSegment(plot, -1.3, -0.85, 1.3, -0.85, 0.4, 34);
    for (let tube = 0; tube < 6; tube += 1) {
      const anchor = -1.1 + tube * 0.44;
      /* A pendulum's period follows its length, so the long tubes lag. */
      const length = 0.6 + hash(tube * 3.3) * 0.75;
      const swing = Math.sin(t * (1.35 - length * 0.4) + tube) * 0.2;
      plotSegment(plot, anchor, -0.85, anchor + swing, -0.85 + length, 0.75, 18);
      plot(anchor + swing, -0.85 + length, 1);
    }
    const clapper = Math.sin(t * 0.75) * 0.5;
    plotSegment(plot, 0, -0.85, clapper, 0.55, 0.3, 16);
    plotSegment(plot, clapper - 0.28, 0.72, clapper + 0.28, 0.72, 0.55, 10);
    plot(clapper, 0.55, 0.9);
  });
}

/* -- Lava lamp: blobs rising and falling in a warm column ----------------- */

const lavaLampField: Field = (u, v, t) => {
  let sum = 0;
  for (let blob = 0; blob < 5; blob += 1) {
    const cx = Math.sin(t * 0.31 + blob * 1.7) * 1.15;
    const rise = ((t * (0.1 + blob * 0.022) + hash(blob * 5.7)) % 1) * 2 - 1;
    const cy = blob % 2 === 0 ? rise : -rise;
    /* Squashing on the way past keeps the blobs from reading as hard discs. */
    const squash = 1 + Math.sin(t * 0.75 + blob) * 0.25;
    const dx = (u - cx) / 1.35;
    const dy = (v - cy) * squash;
    sum += 0.09 / (dx * dx + dy * dy + 0.02);
  }
  return clamp01((sum - 0.85) * 0.85);
};

/* -- Smoke: a column widening and losing its shape as it rises ------------ */

const smokeField: Field = (u, v, t) => {
  const fromBottom = (1 - v) / 2;
  const wander = Math.sin(v * 2.3 - t * 0.55) * 0.35 * fromBottom;
  const column = Math.exp(-Math.pow((u - wander) / (0.16 + fromBottom * 0.75), 2));
  const puff = fbm(u * 1.1 + t * 0.14, v * 1.3 - t * 0.7, 3);
  return clamp01(column * (0.35 + puff * 1.15) * (1.15 - fromBottom * 0.55));
};

/* -- Turing: stripes that keep failing to line up ------------------------- */

const turingField: Field = (u, v, t) => {
  /* Warping the sample point is a cheap stand-in for a reaction diffusion
     solve: the bands fork and rejoin the way real ones do. */
  const warpX = fbm(u * 0.9 + 3.1, v * 0.9 + t * 0.11, 2) * 2 - 1;
  const warpY = fbm(u * 0.9 - 7.3, v * 0.9 - t * 0.09, 2) * 2 - 1;
  const stripe = Math.sin((u + warpX * 1.1) * 2.6 + (v + warpY * 1.1) * 1.8);
  return clamp01((0.78 - Math.abs(stripe)) / 0.62);
};

/* -- Marble: ink veins pulled through a slow current ---------------------- */

const marbleField: Field = (u, v, t) => {
  const warp = fbm(u * 1.3 + t * 0.13, v * 1.3, 3);
  const vein = 0.5 + 0.5 * Math.sin(u * 3.2 + v * 1.6 + warp * 7.5 - t * 0.45);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.92), 4) * 0.7);
  return clamp01(Math.pow(vein, 2.4) * 1.2) * vignette;
};

/* -- Contours: a topographic map of terrain drifting under it ------------- */

const contourField: Field = (u, v, t) => {
  const height = fbm(u * 0.7 + t * 0.09, v * 0.7 + Math.sin(t * 0.08) * 0.4, 3);
  /* Lines fall where the height crosses a level, so they crowd on steep
     ground and spread out on the flats, exactly like a real map. Nine levels
     is about the most that stays legible across ten rows. */
  const line = Math.pow(1 - Math.abs(Math.sin(height * 9)), 3);
  return clamp01(line * (0.55 + height * 0.9));
};

/* -- Thin film: interference bands over a wandering thickness ------------- */

const thinFilmField: Field = (u, v, t) => {
  const thickness = 1.6 + fbm(u * 0.8 + t * 0.1, v * 1.05 - t * 0.06, 3) * 2.4;
  const band = 0.5 + 0.5 * Math.cos(thickness * 7.5 - t * 0.85);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.58, v * 0.9), 4) * 0.7);
  return clamp01(Math.pow(band, 2.2) * 1.25) * vignette;
};

/* -- Vortex street: eddies shed alternately off an obstacle --------------- */

const vortexStreetField: Field = (u, v, t) => {
  let best = 0;
  for (let eddy = 0; eddy < 6; eddy += 1) {
    const cx = -ASPECT + ((eddy * 0.62 + t * 0.5) % (ASPECT * 2 + 0.6));
    /* Alternating sign is what makes it a street rather than a wake. */
    const cy = (eddy % 2 === 0 ? 0.3 : -0.3) * (1 + Math.sin(t * 0.38) * 0.2);
    const dx = u - cx;
    const dy = v - cy;
    const radius = Math.hypot(dx, dy);
    const swirl = 0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 2 - radius * 5 + t * 2.2);
    best = Math.max(best, Math.pow(swirl, 1.4) * Math.exp(-Math.pow(radius / 0.6, 2)));
  }
  /* A thin centreline only, so the eddies read against empty water. */
  return Math.max(best, Math.exp(-Math.pow(v / 0.3, 4)) * 0.16);
};

/* -- Nebula: a cloud lit from inside, with stars in front ----------------- */

const nebulaField: Field = (u, v, t) => {
  const cloud = fbm(u * 0.75 + t * 0.06, v * 0.95 - t * 0.045, 4);
  const core = Math.exp(-Math.pow(Math.hypot(u * 0.62, v) / 0.95, 2));
  const star = hash2(Math.round(u * 9), Math.round(v * 9)) > 0.94 ? 0.9 : 0;
  const twinkle = 0.55 + 0.45 * Math.sin(t * 1.9 + u * 5 + v * 3);
  return Math.max(clamp01((cloud - 0.36) / 0.24) * core * 1.35, star * twinkle);
};

/* -- Crystal: facets growing out from a common seed ----------------------- */

const crystalField: Field = (u, v, t) => {
  const grow = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.65));
  /* Each facet is a half plane at a fixed distance. Taking the furthest one
     gives the polygon's own support function, so the outline traces the hull
     itself rather than six lines running off past its corners. */
  let hull = -Infinity;
  for (let facet = 0; facet < 6; facet += 1) {
    const angle = (facet / 6) * TAU + t * 0.16;
    hull = Math.max(hull, Math.cos(angle) * u * 0.72 + Math.sin(angle) * v);
  }
  const edge = Math.exp(-Math.pow((hull - grow) / 0.09, 2));
  return Math.max(edge, clamp01(1 - hull / grow) * 0.26);
};

/* -- Saddle: contour lines on a hyperbolic sheet -------------------------- */

const saddleField: Field = (u, v, t) => {
  const x = u * 0.72;
  /* x squared minus v squared is the saddle; contouring it draws the family
     of hyperbolas that gives the surface away. */
  const height = x * x - v * v + Math.sin(t * 0.45) * 0.35;
  const lines = Math.pow(1 - Math.abs(Math.sin(height * 4.5 - t * 1.1)), 3);
  return clamp01(lines * (0.45 + 0.75 * Math.exp(-Math.pow(Math.hypot(x, v) / 1.1, 3))));
};

/* -- Zebra: straight stripes pushed around by a slow bend ----------------- */

const zebraField: Field = (u, v, t) => {
  const bend = Math.sin(v * 1.8 + t * 0.45) * 0.55 + Math.sin(v * 0.9 - t * 0.28) * 0.32;
  const stripe = Math.sin((u + bend) * 2.9 + t * 0.5);
  const vignette = Math.exp(-Math.pow(Math.hypot(u * 0.6, v * 0.92), 6) * 0.8);
  return clamp01((Math.abs(stripe) - 0.12) / 0.6) * vignette;
};

/* -- Sunrise: a disc clearing the horizon behind its own glare ------------ */

const sunriseField: Field = (u, v, t) => {
  const climb = 0.55 - (0.5 + 0.5 * Math.sin(t * 0.32)) * 0.85;
  const distance = Math.hypot(u * 0.62, v - climb);
  if (distance < 0.34) return 0.95;
  const outside = distance - 0.34;
  const halo = Math.exp(-Math.pow(outside / 0.4, 2)) * 0.55;
  const rays =
    Math.pow(0.5 + 0.5 * Math.sin(Math.atan2(v - climb, u * 0.62) * 11 + t * 0.45), 4) *
    Math.exp(-outside * 1.6) *
    0.6;
  /* Below the waterline the light breaks into a glitter path. */
  const sea = v > 0.62 ? 0.3 + 0.35 * Math.pow(0.5 + 0.5 * Math.sin(v * 22 + u * 3 - t * 1.4), 3) : 0;
  return Math.max(halo, Math.max(rays, sea));
};

/* -- Beacon: a lamp throwing one beam around a dark shore ----------------- */

const beaconField: Field = (u, v, t) => {
  const sweep = t * 0.7;
  const dv = v + 0.55;
  const gap = (((Math.atan2(dv, u) - sweep) % TAU) + TAU) % TAU;
  const off = Math.min(gap, TAU - gap);
  const radius = Math.hypot(u, dv);
  const beam = Math.exp(-Math.pow(off / 0.22, 2)) * clamp01(1.15 - radius * 0.5);
  return Math.max(Math.exp(-(radius * radius) / 0.012), beam * 0.85);
};

/* -- Cityscape: a skyline scrolling past its own lit windows -------------- */

function paintCityscape(t: number): string {
  const scroll = t * 1.3;
  return paintGrid((x, y) => {
    const world = Math.floor(x + scroll);
    const block = Math.floor(world / 4);
    const height = 3 + Math.floor(hash(block * 3.7) * 6);
    if (y < H - height) return hash2(Math.floor(world / 2), y) > 0.93 ? 0.35 : 0;
    /* One dark column per block reads as the gap between two towers. */
    if (world % 4 === 3) return 0.16;
    if ((y + world) % 2 !== 0) return 0.28;
    return hash2(block * 5 + (world % 4), y) > 0.45 ? 0.9 : 0.22;
  });
}

/* -- Block drop: pieces falling onto a settled stack ---------------------- */

const BLOCK_PERIOD = 1.9;

function paintBlockDrop(t: number): string {
  const round = Math.floor(t / BLOCK_PERIOD);
  const local = (t % BLOCK_PERIOD) / BLOCK_PERIOD;
  const columns = Math.floor(W / 2);

  return paintGrid((x, y) => {
    if (x % 2 === 1) return 0;
    const column = x / 2;
    /* The stack only reshuffles every seventh round, so the field looks like
       it is being built rather than randomised every drop. */
    const stack = 1 + Math.floor(hash(column * 3.1 + Math.floor(round / 7) * 11) * 4);
    const settled = H - stack;
    if (y >= settled) return 0.55 + 0.35 * hash(column * 7.7 + y);
    if (column !== Math.floor(hash(round * 5.3) * columns)) return 0;
    const head = Math.floor(local * (settled + 1));
    return y === head || y === head - 1 ? 1 : 0;
  });
}

/* -- Loading bars: rows filling at their own rates ------------------------ */

function paintLoadingBars(t: number): string {
  return paintGrid((x, y) => {
    if (y % 2 === 1) return 0;
    const bar = y / 2;
    const fill = ((t * (0.2 + hash(bar * 4.1) * 0.28) + hash(bar * 9.3)) % 1) * W;
    if (x === 0 || x === W - 1) return 0.45;
    if (x < fill - 1) return 0.85 - (fill - x) * 0.02;
    if (x < fill) return 1;
    return 0.12;
  });
}

/* -- Sorting: a bubble sort replayed from the same shuffle every cycle ----- */

const SORT_COLUMNS = 14;
const SORT_COMPARISONS = (SORT_COLUMNS * (SORT_COLUMNS - 1)) / 2;

/**
 * Runs the sort from scratch up to `steps` comparisons. Recomputing is cheaper
 * than keeping state, and it keeps the painter a pure function of time, so two
 * panes showing this animation cannot pull each other out of step.
 */
function sortedHeights(steps: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < SORT_COLUMNS; i += 1) values.push(1 + Math.floor(hash(i * 5.7) * (H - 1)));

  let done = 0;
  for (let pass = 0; pass < SORT_COLUMNS && done < steps; pass += 1) {
    for (let i = 0; i < SORT_COLUMNS - 1 - pass && done < steps; i += 1) {
      done += 1;
      if (values[i] > values[i + 1]) {
        const swap = values[i];
        values[i] = values[i + 1];
        values[i + 1] = swap;
      }
    }
  }
  return values;
}

function paintSorting(t: number): string {
  /* A pause past the last comparison lets the sorted result be read. */
  const cycle = Math.floor((t * 7) % (SORT_COMPARISONS + 26));
  const values = sortedHeights(cycle);
  const cursor = cycle % SORT_COLUMNS;

  return paintGrid((x, y) => {
    if (x % 2 === 1) return 0;
    const bar = x / 2;
    if (bar >= SORT_COLUMNS) return 0;
    const fromBottom = H - y;
    if (fromBottom > values[bar]) return 0;
    return bar === cursor ? 1 : 0.35 + 0.4 * (1 - fromBottom / H);
  });
}

/* -- Typewriter: lines filling in behind a blinking cursor ---------------- */

function paintTypewriter(t: number): string {
  const lines = H - 2;
  const perLine = W - 4;
  const total = lines * perLine;
  /* Start a third of the way in, so a freshly mounted loader never opens on
     an all but blank frame. */
  const typed = Math.floor((0.33 + ((t * 0.14) % 1) * 0.67) * total);

  return paintGrid((x, y) => {
    if (y === 0 || y === H - 1) return 0;
    if (x === 0) return 0.2;
    if (x < 2) return 0;
    const column = x - 2;
    if (column >= perLine) return 0;
    const index = (y - 1) * perLine + column;
    if (index > typed) return 0;
    if (index === typed) return Math.floor(t * 2.5) % 2 === 0 ? 1 : 0.3;
    if (column < Math.floor(hash((y - 1) * 3.1) * 5)) return 0;
    /* Gaps in the density ramp read as the spaces between words. */
    const glyph = hash(index * 1.7);
    return glyph > 0.86 ? 0 : 0.35 + glyph * 0.4;
  });
}

/* -- Punch tape: a data roll pulled past the reader ----------------------- */

function paintPunchTape(t: number): string {
  const scroll = t * 2.2;
  const feed = Math.floor(H / 2);
  return paintGrid((x, y) => {
    if (y === 0 || y === H - 1) return 0.3;
    const world = Math.floor(x + scroll);
    /* The unbroken sprocket row runs down the middle of every real tape. */
    if (y === feed) return 0.75;
    /* Blank columns between bytes, and one column of holes per byte, so the
       tape reads as data rather than as static. */
    if (world % 3 === 2) return 0;
    const track = y < feed ? y - 1 : y - 2;
    return (Math.floor(hash(world * 2.7) * 256) >> track) & 1 ? 0.95 : 0.16;
  });
}

/* ========================================================================
   Third collection: weather and material fields, more solids, and a set of
   small machines. Same contract as everything above: a pure function of
   elapsed seconds returning one rendered frame.
   ===================================================================== */

/* -- Ink bloom: a drop opening up in water -------------------------------- */

const inkBloomField: Field = (u, v, t) => {
  const grow = (t * 0.35) % 1;
  /* Noise on the radius is what stops the blot from being a plain circle. */
  const radius = Math.hypot(u, v) + fbm(u * 1.4 + t * 0.2, v * 1.4, 3) * 0.55 - 0.27;
  const edge = clamp01((grow * 1.9 - radius) * 2.4);
  return clamp01(edge * (1 - grow * 0.65) + edge * edge * 0.35);
};

/* -- Magma: a cooling crust with the heat showing through the seams ------- */

const magmaField: Field = (u, v, t) => {
  const flow = fbm(u * 0.9 + t * 0.12, v * 0.9 - t * 0.07, 4);
  /* Cracks sit where the crust noise crosses its midpoint. */
  const crack = 1 - clamp01(Math.abs(flow - 0.5) * 7);
  return clamp01(0.12 + crack * (0.75 + Math.sin(t * 1.6 + flow * 9) * 0.25));
};

/* -- Frost: needles creeping in from every edge --------------------------- */

const frostField: Field = (u, v, t) => {
  const reach = ((t * 0.22) % 1) * 1.3;
  const fromEdge = Math.min(ASPECT - Math.abs(u), 1 - Math.abs(v));
  const grain = fbm(u * 3.1, v * 3.1, 3);
  /* The growth front is ragged: the noise decides which needles run ahead. */
  return clamp01((reach + grain * 0.5 - fromEdge) * 3) * (0.35 + grain * 0.65);
};

/* -- Ocean swell: three wavelengths riding on each other ------------------ */

const oceanSwellField: Field = (u, v, t) => {
  const swell =
    Math.sin(u * 1.2 - t * 1.1) * 0.42 +
    Math.sin(u * 2.7 + t * 0.63) * 0.22 +
    Math.sin(u * 0.6 - t * 0.4) * 0.3;
  const depth = v - swell;
  if (depth < 0) return 0.04;
  /* Foam rides the surface; below it the water darkens with depth. */
  return clamp01(depth < 0.16 ? 1 : 0.62 - depth * 0.4);
};

/* -- Pulsar: two beams from a core that flashes once per turn ------------- */

const pulsarField: Field = (u, v, t) => {
  const angle = Math.atan2(v, u);
  const radius = Math.hypot(u, v);
  const beam = Math.abs(Math.cos(angle - t * 1.5));
  const lobe = Math.pow(beam, 12) * clamp01(1 - radius / 1.7);
  const core = clamp01(1 - radius * 3.4) * (0.6 + Math.sin(t * 6) * 0.4);
  return clamp01(lobe + core * 0.9);
};

/* -- Wormhole: a throat that keeps receding ------------------------------- */

const wormholeField: Field = (u, v, t) => {
  const radius = Math.max(Math.hypot(u, v), 0.001);
  const angle = Math.atan2(v, u);
  /* Depth as 1/r is the trick: the middle is infinitely far away. */
  const depth = 1 / radius + t * 1.1;
  const rings = Math.sin(depth * 3.1) * 0.5 + 0.5;
  const ribs = Math.sin(angle * 3 + depth * 0.8) * 0.5 + 0.5;
  return clamp01((rings * 0.65 + ribs * 0.45) * clamp01(radius * 1.7));
};

/* -- Heat haze: stripes bent by the air above something hot --------------- */

const heatHazeField: Field = (u, v, t) => {
  /* The shimmer is strongest low down, where the air is hottest. */
  const heat = clamp01((v + 0.4) / 1.4);
  const shift = fbm(u * 1.6, v * 2.2 - t * 1.4, 3) - 0.5;
  const stripe = Math.sin((u + shift * heat * 1.3) * 4.4) * 0.5 + 0.5;
  return clamp01(0.14 + stripe * 0.86);
};

/* -- Bokeh: defocused highlights drifting past ---------------------------- */

const bokehField: Field = (u, v, t) => {
  let light = 0.06;
  for (let disc = 0; disc < 7; disc += 1) {
    const drift = t * (0.1 + hash(disc * 3.7) * 0.14);
    const cu = Math.sin(drift + disc) * 1.5;
    const cv = Math.cos(drift * 1.3 + disc * 2.1) * 0.8;
    const size = 0.3 + hash(disc * 9.1) * 0.4;
    const distance = Math.hypot(u - cu, v - cv) / size;
    if (distance > 1) continue;
    /* Bright rim, hollow middle: the signature of an out of focus point. */
    light = Math.max(
      light,
      (0.35 + 0.45 * Math.pow(distance, 3)) * (1 - Math.pow(distance, 8)),
    );
  }
  return clamp01(light);
};

/* -- Gas giant: belts shearing past each other under a storm -------------- */

const gasGiantField: Field = (u, v, t) => {
  const radius = Math.hypot(u / 1.45, v / 0.95);
  if (radius > 1) return 0.03;
  /* Each latitude runs at its own rate, which is what makes the belts. */
  const shear = u * 0.4 + t * (0.3 + Math.sin(v * 3.4) * 0.22);
  const bands = Math.sin(v * 7.2 + Math.sin(shear) * 0.5) * 0.5 + 0.5;
  const storm = clamp01(1 - Math.hypot((u - 0.5) / 0.34, (v - 0.32) / 0.2));
  const limb = clamp01((1 - radius) * 3.2);
  return clamp01((0.24 + bands * 0.6 + storm * 0.5) * limb);
};

/* -- Raked sand: ripples creeping downwind -------------------------------- */

const sandRippleField: Field = (u, v, t) => {
  const warp = fbm(u * 0.7 + t * 0.16, v * 0.7, 3) * 1.6;
  const crest = Math.sin((u * 2.1 + v * 0.9 + warp) * 2.4);
  /* Raising the curve to a power sharpens the crests and widens the troughs,
     which is how low sun reads on sand. */
  return clamp01(0.16 + Math.pow(clamp01(crest * 0.5 + 0.5), 2.2) * 0.84);
};

/* -- Storm front: a wall of cloud crossing with rain behind it ------------ */

const stormFrontField: Field = (u, v, t) => {
  const front = ((t * 0.3) % 1) * (ASPECT * 2.4) - ASPECT * 0.9;
  const body = fbm(u * 1.3 - t * 0.5, v * 1.5 + t * 0.2, 4);
  const mass = clamp01((front - u) * 1.6) * clamp01(body * 1.5 - 0.1);
  /* Rain only falls well behind the leading edge. */
  const wet =
    u < front - 0.5 && hash2(Math.floor(u * 9), Math.floor(v * 6 - t * 9)) > 0.86;
  /* Thin haze ahead of the front, so the sky is never a blank frame. */
  return clamp01(0.05 + body * 0.08 + mass + (wet ? 0.5 : 0));
};

/* -- Oil slick: sheets that fold instead of sliding ----------------------- */

const oilSlickField: Field = (u, v, t) => {
  /* Warp the sample point with noise, then read a second pattern there. */
  const warpedU = u + fbm(u * 1.1 + t * 0.13, v * 1.1, 3) * 2.1;
  const warpedV = v + fbm(u * 1.1, v * 1.1 - t * 0.11, 3) * 2.1;
  const sheen = Math.sin(warpedU * 2.6 + warpedV * 1.8) * 0.5 + 0.5;
  return clamp01(0.1 + Math.pow(sheen, 1.7) * 0.9);
};

/* -- Droplets: rings spreading from a handful of impacts ------------------ */

const dropletsField: Field = (u, v, t) => {
  let bright = 0.05;
  for (let drop = 0; drop < 5; drop += 1) {
    const cycle = (t * 0.45 + hash(drop * 5.3)) % 1;
    const cu = (hash(drop * 2.1) * 2 - 1) * ASPECT * 0.8;
    const cv = (hash(drop * 7.9) * 2 - 1) * 0.75;
    const ring = Math.abs(Math.hypot(u - cu, v - cv) - cycle * 1.5);
    /* Rings thin and fade as they grow, so older ones sit further back. */
    bright = Math.max(bright, clamp01(1 - ring * 7) * (1 - cycle));
  }
  return bright;
};

/* -- Weave: warp and weft trading places at every crossing ---------------- */

const weaveField: Field = (u, v, t) => {
  const shift = t * 0.5;
  const warp = Math.sin((u + shift) * 3.2);
  const weft = Math.sin((v - shift * 0.6) * 3.2);
  /* Whichever strand is nearer its crest is the one lying on top here. */
  const over = Math.abs(warp) > Math.abs(weft);
  return clamp01(0.15 + Math.abs(over ? warp : weft) * (over ? 0.85 : 0.6));
};

/* -- More solids ---------------------------------------------------------- */

/**
 * Every pair of vertices within the given distance. Spares a hand-written edge
 * list for the solids where the edges outnumber the corners.
 */
function edgesWithin(vertices: readonly Vertex[], maxDistance: number): Edge[] {
  const edges: Edge[] = [];
  for (let a = 0; a < vertices.length; a += 1) {
    for (let b = a + 1; b < vertices.length; b += 1) {
      const [ax, ay, az] = vertices[a]!;
      const [bx, by, bz] = vertices[b]!;
      if (Math.hypot(ax - bx, ay - by, az - bz) <= maxDistance) edges.push([a, b]);
    }
  }
  return edges;
}

/* A square antiprism: two squares a quarter turn apart, laced together. */
const ANTIPRISM_VERTICES: readonly Vertex[] = [
  [0.85, -0.8, 0.85],
  [-0.85, -0.8, 0.85],
  [-0.85, -0.8, -0.85],
  [0.85, -0.8, -0.85],
  [1.2, 0.8, 0],
  [0, 0.8, 1.2],
  [-1.2, 0.8, 0],
  [0, 0.8, -1.2],
];

const ANTIPRISM_EDGES = edgesWithin(ANTIPRISM_VERTICES, 2);

function paintAntiprism(t: number): string {
  return paintWireframe(ANTIPRISM_VERTICES, ANTIPRISM_EDGES, t, 0.85, 1.15);
}

/* A cuboctahedron: the twelve points where a cube's edges are cut in half. */
const CUBOCTAHEDRON_VERTICES: readonly Vertex[] = [
  [1.15, 1.15, 0],
  [1.15, -1.15, 0],
  [-1.15, 1.15, 0],
  [-1.15, -1.15, 0],
  [1.15, 0, 1.15],
  [1.15, 0, -1.15],
  [-1.15, 0, 1.15],
  [-1.15, 0, -1.15],
  [0, 1.15, 1.15],
  [0, 1.15, -1.15],
  [0, -1.15, 1.15],
  [0, -1.15, -1.15],
];

const CUBOCTAHEDRON_EDGES = edgesWithin(CUBOCTAHEDRON_VERTICES, 1.8);

function paintCuboctahedron(t: number): string {
  return paintWireframe(CUBOCTAHEDRON_VERTICES, CUBOCTAHEDRON_EDGES, t, 0.62, 1.2);
}

/* -- Hanoi: the four disc solution, replayed move by move ----------------- */

const HANOI_DISCS = 4;

function planHanoi(
  count: number,
  from: number,
  to: number,
  via: number,
  out: [number, number][],
): void {
  if (count === 0) return;
  planHanoi(count - 1, from, via, to, out);
  out.push([from, to]);
  planHanoi(count - 1, via, to, from, out);
}

/** The whole solution, worked out once: 15 moves for four discs. */
const HANOI_PLAN: ReadonlyArray<readonly [number, number]> = (() => {
  const out: [number, number][] = [];
  planHanoi(HANOI_DISCS, 0, 2, 1, out);
  return out;
})();

/** Peg contents after `moves` of the plan, largest disc first. */
function hanoiStacks(moves: number): number[][] {
  const pegs: number[][] = [[], [], []];
  for (let disc = HANOI_DISCS; disc >= 1; disc -= 1) pegs[0]!.push(disc);
  for (let move = 0; move < moves; move += 1) {
    const [from, to] = HANOI_PLAN[move]!;
    const disc = pegs[from]!.pop();
    if (disc !== undefined) pegs[to]!.push(disc);
  }
  return pegs;
}

function paintHanoi(t: number): string {
  /* A pause past the last move lets the finished tower be read. */
  const clock = (t * 1.6) % (HANOI_PLAN.length + 3);
  const done = Math.min(Math.floor(clock), HANOI_PLAN.length);
  const carry = clock - done;
  const stacks = hanoiStacks(done);
  const lifted = done < HANOI_PLAN.length ? stacks[HANOI_PLAN[done]![0]!]!.pop() : undefined;
  const pegU = (peg: number) => -1.1 + peg * 1.1;

  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.9, ASPECT, 0.9, 0.4, 40);
    for (let peg = 0; peg < 3; peg += 1) {
      plotSegment(plot, pegU(peg), 0.9, pegU(peg), -0.45, 0.35, 14);
      stacks[peg]!.forEach((disc, height) => {
        const half = 0.12 + disc * 0.09;
        const v = 0.78 - height * 0.3;
        plotSegment(plot, pegU(peg) - half, v, pegU(peg) + half, v, 0.55 + disc * 0.11, 10);
      });
    }
    if (lifted === undefined) return;
    /* The travelling disc rises, crosses over the pegs, and drops back. */
    const [from, to] = HANOI_PLAN[done]!;
    const arc = Math.sin(Math.min(1, carry) * Math.PI);
    const u = pegU(from) + (pegU(to) - pegU(from)) * Math.min(1, carry);
    const half = 0.12 + lifted * 0.09;
    const v = 0.78 - stacks[from]!.length * 0.3 - arc * 1.3;
    plotSegment(plot, u - half, v, u + half, v, 1, 10);
  });
}

/* -- Torus knot: a strand wrapping three times one way, four the other ---- */

function paintTorusKnot(t: number): string {
  const yaw = t * 0.7;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);

  return paintPlotted((plot) => {
    for (let step = 0; step <= 320; step += 1) {
      const angle = (step / 320) * TAU;
      const radius = 1 + 0.45 * Math.cos(4 * angle);
      const x = radius * Math.cos(3 * angle);
      const z = radius * Math.sin(3 * angle);
      const y = 0.5 * Math.sin(4 * angle);
      const rotatedX = x * cosYaw + z * sinYaw;
      const depth = z * cosYaw - x * sinYaw;
      const scale = 1.5 / (3 + depth);
      plot(rotatedX * scale * 2.1, y * scale * 2.4, 0.22 + 0.78 * clamp01((1.6 - depth) / 3.2));
    }
  });
}

/* -- Hyperboloid: a curved surface built out of straight rods ------------- */

function paintHyperboloid(t: number): string {
  const spin = t * 0.55;
  return paintPlotted((plot) => {
    for (let rod = 0; rod < 12; rod += 1) {
      const base = (rod / 12) * TAU + spin;
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        /* Each rod is straight; the twist between its ends makes the waist. */
        const angle = base + (f - 0.5) * 1.05;
        const depth = Math.sin(angle);
        const scale = 1.5 / (2.6 + depth);
        plot(
          Math.cos(angle) * scale * 2.2,
          (f - 0.5) * 1.8 * scale * 1.9,
          0.25 + 0.75 * clamp01((1.4 - depth) / 2.6),
        );
      }
    }
  });
}

/* -- Superellipse: rings sweeping from pinched star to square ------------- */

function paintSuperellipse(t: number): string {
  const power = 0.6 + (Math.sin(t * 0.8) * 0.5 + 0.5) * 3.4;
  return paintPlotted((plot) => {
    for (let ring = 0; ring < 3; ring += 1) {
      const size = 1 - ring * 0.28;
      for (let step = 0; step <= 200; step += 1) {
        const angle = (step / 200) * TAU;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        plot(
          Math.sign(cosine) * Math.pow(Math.abs(cosine), 2 / power) * 1.55 * size,
          Math.sign(sine) * Math.pow(Math.abs(sine), 2 / power) * 0.92 * size,
          1 - ring * 0.28,
        );
      }
    }
  });
}

/* -- Astroid: the star traced out by a ladder sliding down a wall --------- */

const QUADRANTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function paintAstroid(t: number): string {
  return paintPlotted((plot) => {
    for (let rung = 0; rung <= 18; rung += 1) {
      const f = (rung / 18 + t * 0.09) % 1;
      const angle = f * (Math.PI / 2);
      const endU = Math.cos(angle) * 1.6;
      const endV = Math.sin(angle) * 0.98;
      /* No curve is ever drawn: the star is the envelope of the ladders. */
      for (const [signU, signV] of QUADRANTS) {
        plotSegment(plot, signU * endU, 0, 0, signV * endV, 0.35 + f * 0.5, 16);
      }
    }
  });
}

/* -- Anemone: a crown of arms combing the current ------------------------- */

function paintAnemone(t: number): string {
  return paintPlotted((plot) => {
    for (let arm = 0; arm < 13; arm += 1) {
      const lean = (arm / 12 - 0.5) * 2.2;
      const phase = hash(arm * 4.7) * TAU;
      let u = lean * 0.5;
      let v = 0.95;
      for (let joint = 1; joint <= 9; joint += 1) {
        const f = joint / 9;
        /* Each arm bends more the further it gets from its anchor. */
        const bend = Math.sin(t * 1.7 + phase - f * 2.4) * f * f * 0.6;
        const nextU = lean * (0.5 + f * 0.9) + bend;
        const nextV = 0.95 - f * 1.5;
        plotSegment(plot, u, v, nextU, nextV, 0.3 + f * 0.6, 4);
        u = nextU;
        v = nextV;
      }
      plot(u, v, 1);
    }
  });
}

/* -- Kite: a diamond pulling against its line ----------------------------- */

function paintKite(t: number): string {
  const u = Math.sin(t * 0.55) * 1.05;
  const v = -0.25 + Math.cos(t * 0.8) * 0.32;
  const tilt = Math.sin(t * 0.55 + 1.2) * 0.45;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const corner = (du: number, dv: number) =>
    [u + du * cosTilt - dv * sinTilt, v + du * sinTilt + dv * cosTilt] as const;

  return paintPlotted((plot) => {
    const top = corner(0, -0.45);
    const left = corner(-0.34, 0);
    const right = corner(0.34, 0);
    const tail = corner(0, 0.62);
    plotSegment(plot, top[0], top[1], left[0], left[1], 0.9, 12);
    plotSegment(plot, top[0], top[1], right[0], right[1], 0.9, 12);
    plotSegment(plot, tail[0], tail[1], left[0], left[1], 0.9, 12);
    plotSegment(plot, tail[0], tail[1], right[0], right[1], 0.9, 12);
    plotSegment(plot, left[0], left[1], right[0], right[1], 0.45, 10);
    plotSegment(plot, top[0], top[1], tail[0], tail[1], 0.45, 12);
    /* The tail lags behind the kite and whips hardest at its end. */
    for (let knot = 1; knot <= 8; knot += 1) {
      const f = knot / 8;
      plot(tail[0] - Math.sin(t * 2.1 - f * 3) * f * 0.5, tail[1] + f * 0.9, 0.55 - f * 0.3);
    }
  });
}

/* -- Sailboat: a hull heeling over its own wake --------------------------- */

function paintSailboat(t: number): string {
  const waterAt = (u: number) =>
    0.55 + Math.sin(u * 1.6 - t * 1.4) * 0.12 + Math.sin(u * 0.7 + t) * 0.07;
  const u = Math.sin(t * 0.32) * 0.9;
  const deck = waterAt(u) - 0.06;
  const heel = Math.sin(t * 0.32 + 0.6) * 0.5;

  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 120; sample += 1) {
      const surfaceU = (sample / 120) * ASPECT * 2 - ASPECT;
      plot(surfaceU, waterAt(surfaceU), 0.4);
    }
    plotSegment(plot, u - 0.42, deck, u + 0.42, deck, 0.85, 12);
    plotSegment(plot, u - 0.42, deck, u - 0.2, deck + 0.26, 0.7, 8);
    plotSegment(plot, u + 0.42, deck, u + 0.2, deck + 0.26, 0.7, 8);
    plotSegment(plot, u - 0.2, deck + 0.26, u + 0.2, deck + 0.26, 0.7, 6);
    /* Mast and sails lean together, so the boat reads as heeling, not bent. */
    const mastU = u + heel * 0.8;
    const mastV = deck - 0.95;
    plotSegment(plot, u, deck, mastU, mastV, 0.8, 16);
    plotSegment(plot, mastU, mastV, u - 0.06 + heel * 0.5, deck - 0.04, 0.55, 14);
    plotSegment(plot, mastU, mastV, u + 0.36 + heel * 0.2, deck - 0.04, 0.55, 14);
  });
}

/* -- Lighthouse: a beam sweeping past the viewer -------------------------- */

function paintLighthouse(t: number): string {
  const sweep = t * 1.1;
  return paintPlotted((plot) => {
    /* The beam only shows while it points across this side of the tower, and
       it spreads at the far end rather than at the lamp. */
    for (let ray = -2; ray <= 2; ray += 1) {
      const reach = Math.sin(sweep + ray * 0.05);
      if (reach <= 0.05) continue;
      plotSegment(
        plot,
        -1.1,
        -0.45,
        -1.1 + reach * 3.2,
        -0.45 + ray * 0.14 * reach,
        0.12 + reach * 0.4,
        26,
      );
    }
    plotSegment(plot, -1.28, -0.3, -1.42, 0.95, 0.75, 16);
    plotSegment(plot, -0.92, -0.3, -0.78, 0.95, 0.75, 16);
    plotSegment(plot, -1.42, 0.95, -0.78, 0.95, 0.75, 8);
    plotSegment(plot, -1.32, -0.62, -0.88, -0.62, 0.85, 8);
    plotSegment(plot, -1.32, -0.62, -1.28, -0.3, 0.6, 6);
    plotSegment(plot, -0.88, -0.62, -0.92, -0.3, 0.6, 6);
    plot(-1.1, -0.45, 1);
  });
}

/* -- Crane: a jib slewing while the trolley works its load ---------------- */

function paintCrane(t: number): string {
  const trolley = 0.4 + (Math.sin(t * 0.6) * 0.5 + 0.5) * 0.9;
  const hoist = 0.1 + (Math.sin(t * 0.45 + 1) * 0.5 + 0.5) * 0.8;
  /* Foreshortening the jib is what sells the slew at this size. */
  const reach = Math.cos(Math.sin(t * 0.35) * 0.5);
  const mastU = -0.3;

  return paintPlotted((plot) => {
    plotSegment(plot, mastU, 0.95, mastU, -0.7, 0.7, 20);
    plotSegment(plot, mastU - 0.55 * reach, -0.62, mastU + 1.6 * reach, -0.7, 0.8, 26);
    plotSegment(plot, mastU, -0.95, mastU + 1.6 * reach, -0.7, 0.35, 20);
    plotSegment(plot, mastU, -0.95, mastU - 0.55 * reach, -0.62, 0.35, 10);
    plotSegment(plot, mastU, -0.7, mastU, -0.95, 0.6, 6);
    const hookU = mastU + trolley * 1.6 * reach;
    plotSegment(plot, hookU, -0.68, hookU, -0.68 + hoist * 1.7, 0.4, 18);
    plot(hookU - 0.14, -0.62 + hoist * 1.7, 0.8);
    plot(hookU, -0.62 + hoist * 1.7, 1);
    plot(hookU + 0.14, -0.62 + hoist * 1.7, 0.8);
  });
}

/* -- Seesaw: two riders trading height ------------------------------------ */

function paintSeesaw(t: number): string {
  const lift = Math.sin(t * 1.1) * 0.55;
  return paintPlotted((plot) => {
    plotSegment(plot, -0.28, 0.95, 0, 0.2, 0.6, 12);
    plotSegment(plot, 0.28, 0.95, 0, 0.2, 0.6, 12);
    plotSegment(plot, -1.35, 0.2 - lift, 1.35, 0.2 + lift, 0.9, 34);
    for (const side of [-1, 1] as const) {
      const u = side * 1.16;
      const v = 0.2 + side * lift * 0.86;
      plot(u, v - 0.36, 1);
      plotSegment(plot, u, v - 0.28, u, v - 0.06, 0.7, 6);
      plotSegment(plot, u, v - 0.22, u - 0.18, v - 0.06, 0.5, 5);
      plotSegment(plot, u, v - 0.22, u + 0.18, v - 0.06, 0.5, 5);
    }
  });
}

/* -- Trampoline: airtime, then a bed that gives under the landing --------- */

function paintTrampoline(t: number): string {
  const cycle = (t * 0.9) % 1;
  /* Contact takes the last quarter of the cycle; the rest is flight. */
  const airborne = cycle < 0.75;
  const flight = airborne ? Math.sin((cycle / 0.75) * Math.PI) : 0;
  const sag = airborne ? 0 : Math.sin(((cycle - 0.75) / 0.25) * Math.PI) * 0.42;
  const ball = 0.42 - flight * 1.5 + sag;

  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 60; sample += 1) {
      const u = (sample / 60) * 2.4 - 1.2;
      plot(u, 0.5 + Math.cos((u / 1.2) * (Math.PI / 2)) * sag, 0.55);
    }
    plotSegment(plot, -1.2, 0.5, -1.35, 0.95, 0.4, 8);
    plotSegment(plot, 1.2, 0.5, 1.35, 0.95, 0.4, 8);
    for (let around = 0; around < TAU; around += 0.5) {
      plot(Math.cos(around) * 0.24, ball + Math.sin(around) * 0.16, 0.9);
    }
    plot(0, ball, 1);
  });
}

/* -- Yo-yo: a spool running down its string and climbing back ------------- */

function paintYoyo(t: number): string {
  const travel = 0.3 + Math.abs(Math.sin(t * 0.85)) * 1.35;
  const handV = -0.78;
  const spin = t * 6.5;
  const spoolV = handV + travel;

  return paintPlotted((plot) => {
    plotSegment(plot, -0.34, -0.95, 0, handV, 0.5, 10);
    plotSegment(plot, 0.34, -0.95, 0, handV, 0.5, 10);
    plotSegment(plot, 0, handV, 0, spoolV, 0.35, 20);
    for (let around = 0; around < TAU; around += 0.35) {
      plot(Math.cos(around) * 0.3, spoolV + Math.sin(around) * 0.2, 0.75);
    }
    /* Two marks on the rim are what make the spin readable at this size. */
    for (const mark of [0, Math.PI]) {
      plot(Math.cos(spin + mark) * 0.22, spoolV + Math.sin(spin + mark) * 0.15, 1);
    }
  });
}

/* -- Spinning coin: a disc whose width collapses as it turns --------------- */

function paintSpinningCoin(t: number): string {
  const face = Math.cos(t * 3.1);
  const wobble = Math.sin(t * 0.7) * 0.12;
  return paintPlotted((plot) => {
    plotSegment(plot, -1.5, 0.9, 1.5, 0.9, 0.3, 30);
    for (let step = 0; step <= 90; step += 1) {
      const angle = (step / 90) * TAU;
      plot(Math.cos(angle) * 0.95 * face, wobble + Math.sin(angle) * 0.6, 0.8);
    }
    plotSegment(plot, -0.95 * face, wobble, 0.95 * face, wobble, 0.4, 18);
    /* The face only catches the light when the coin is turned toward us. */
    plot(0, wobble, Math.abs(face) > 0.4 ? 0.95 : 0.3);
  });
}

/* -- Hummingbird: wings far faster than the drift ------------------------- */

function paintHummingbird(t: number): string {
  const u = Math.sin(t * 0.6) * 0.9;
  const v = -0.1 + Math.sin(t * 0.9 + 1) * 0.3;
  const beat = Math.sin(t * 22);

  return paintPlotted((plot) => {
    plotSegment(plot, 1.2, 0.95, 1.15, 0.15, 0.35, 12);
    for (let petal = 0; petal < 5; petal += 1) {
      const angle = (petal / 5) * TAU;
      plot(1.15 + Math.cos(angle) * 0.26, 0.15 + Math.sin(angle) * 0.17, 0.6);
    }
    plotSegment(plot, u - 0.34, v, u + 0.3, v - 0.06, 0.9, 12);
    plotSegment(plot, u + 0.3, v - 0.06, u + 0.62, v - 0.02, 0.7, 8);
    plotSegment(plot, u - 0.34, v, u - 0.72, v + 0.16, 0.5, 8);
    for (const side of [-1, 1] as const) {
      plotSegment(plot, u, v - 0.02, u - 0.2, v + side * beat * 0.5, 0.55, 8);
      plotSegment(plot, u, v - 0.02, u + 0.18, v + side * beat * 0.42, 0.55, 8);
    }
    plot(u + 0.34, v - 0.1, 1);
  });
}

/* -- Caterpillar: a hump travelling from tail to head --------------------- */

function paintCaterpillar(t: number): string {
  const crawl = ((t * 0.24) % 1) * (ASPECT * 2 + 1.4) - ASPECT - 0.7;
  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.7, ASPECT, 0.7, 0.35, 40);
    for (let segment = 0; segment < 8; segment += 1) {
      const f = segment / 7;
      /* The bunch runs back to front, which is how an inchworm moves. */
      const bunch = Math.sin(t * 3 - f * 4.2);
      const u = crawl - f * (0.3 - bunch * 0.07);
      const v = 0.52 - Math.max(0, bunch) * 0.3;
      for (let around = 0; around < TAU; around += 0.7) {
        plot(u + Math.cos(around) * 0.16, v + Math.sin(around) * 0.11, 0.45 + f * 0.15);
      }
      plot(u, v, 0.9);
      if (segment > 0 && segment < 7) plotSegment(plot, u, v + 0.1, u, 0.68, 0.3, 5);
    }
    plot(crawl + 0.16, 0.44, 1);
  });
}

/* -- Octopus: eight arms curling on their own phases ---------------------- */

function paintOctopus(t: number): string {
  const headV = -0.42 + Math.sin(t * 0.9) * 0.16;
  return paintPlotted((plot) => {
    for (let around = 0; around < TAU; around += 0.3) {
      plot(Math.cos(around) * 0.45, headV + Math.sin(around) * 0.34, 0.8);
    }
    plot(-0.16, headV - 0.05, 1);
    plot(0.16, headV - 0.05, 1);
    for (let arm = 0; arm < 8; arm += 1) {
      const spread = (arm / 7 - 0.5) * 1.6;
      let u = spread * 0.45;
      let v = headV + 0.3;
      for (let joint = 1; joint <= 7; joint += 1) {
        const f = joint / 7;
        /* Offsetting the phase per arm is what stops them marching in step. */
        const curl = Math.sin(t * 2.1 + arm * 1.3 - f * 3.4) * f * 0.45;
        const nextU = spread * (0.45 + f * 0.85) + curl;
        const nextV = headV + 0.3 + f * 1.05;
        plotSegment(plot, u, v, nextU, nextV, 0.28 + (1 - f) * 0.5, 4);
        u = nextU;
        v = nextV;
      }
    }
  });
}

/* -- Spider web: a sagging orb web with something caught in it ------------ */

const WEB_SPOKES = 8;

function paintSpiderWeb(t: number): string {
  const struggle = t * 0.8;
  return paintPlotted((plot) => {
    for (let spoke = 0; spoke < WEB_SPOKES; spoke += 1) {
      const angle = (spoke / WEB_SPOKES) * TAU;
      plotSegment(plot, 0, 0, Math.cos(angle) * 1.6, Math.sin(angle) * 0.98, 0.4, 18);
    }
    for (let ring = 1; ring <= 4; ring += 1) {
      const size = ring / 4;
      for (let step = 0; step <= 64; step += 1) {
        const angle = (step / 64) * TAU;
        /* Real webs sag between spokes, so pull each span toward the middle. */
        const sag = 1 - Math.abs(Math.sin(angle * (WEB_SPOKES / 2))) * 0.12;
        plot(
          Math.cos(angle) * 1.6 * size * sag,
          Math.sin(angle) * 0.98 * size * sag,
          0.3 + size * 0.3,
        );
      }
    }
    const flyU = Math.cos(struggle) * 1.15;
    const flyV = Math.sin(struggle) * 0.7;
    plot(flyU, flyV, 1);
    plot(flyU + Math.sin(t * 13) * 0.12, flyV - 0.1, 0.7);
    plot(0, 0, 0.95);
    plot(-0.12, -0.08, 0.6);
    plot(0.12, 0.08, 0.6);
  });
}

/* -- Radio tower: a lattice mast pushing rings out ------------------------ */

function paintRadioTower(t: number): string {
  return paintPlotted((plot) => {
    for (let ring = 0; ring < 3; ring += 1) {
      const grow = (t * 0.5 + ring / 3) % 1;
      for (let step = 0; step <= 50; step += 1) {
        const angle = (step / 50) * TAU;
        plot(Math.cos(angle) * grow * 1.7, -0.8 + Math.sin(angle) * grow * 1.05, (1 - grow) * 0.55);
      }
    }
    plotSegment(plot, -0.42, 0.95, 0, -0.55, 0.6, 22);
    plotSegment(plot, 0.42, 0.95, 0, -0.55, 0.6, 22);
    for (let rung = 0; rung < 6; rung += 1) {
      const f = rung / 6;
      const half = 0.42 * (1 - f);
      plotSegment(plot, -half, 0.95 - f * 1.5, half, 0.95 - f * 1.5, 0.35, 8);
    }
    plotSegment(plot, 0, -0.55, 0, -0.8, 0.7, 6);
    plot(0, -0.8, 1);
  });
}

/* -- Hot air balloon: a slow climb off the bottom of the frame ------------ */

function paintHotAirBalloon(t: number): string {
  const rise = 0.9 - ((t * 0.14) % 1) * 2.2;
  const drift = Math.sin(t * 0.5) * 0.35;

  return paintPlotted((plot) => {
    for (let step = 0; step <= 70; step += 1) {
      const angle = (step / 70) * TAU;
      /* Teardrop: wide at the crown, pinched at the throat. */
      const pinch = 0.62 + 0.38 * Math.cos(angle * 0.5);
      plot(drift + Math.cos(angle) * 0.62 * pinch, rise - 0.28 + Math.sin(angle) * 0.5, 0.75);
    }
    for (const rib of [-1, 0, 1]) {
      plotSegment(plot, drift + rib * 0.3, rise - 0.74, drift + rib * 0.16, rise + 0.16, 0.4, 12);
    }
    plotSegment(plot, drift - 0.2, rise + 0.2, drift - 0.16, rise + 0.42, 0.5, 6);
    plotSegment(plot, drift + 0.2, rise + 0.2, drift + 0.16, rise + 0.42, 0.5, 6);
    plotSegment(plot, drift - 0.16, rise + 0.42, drift + 0.16, rise + 0.42, 0.9, 6);
    plotSegment(plot, drift - 0.16, rise + 0.42, drift - 0.16, rise + 0.6, 0.9, 4);
    plotSegment(plot, drift + 0.16, rise + 0.42, drift + 0.16, rise + 0.6, 0.9, 4);
    plotSegment(plot, drift - 0.16, rise + 0.6, drift + 0.16, rise + 0.6, 0.9, 6);
  });
}

/* -- Parachute: a canopy swinging its load under it ----------------------- */

function paintParachute(t: number): string {
  const fall = ((t * 0.16) % 1) * 2.6 - 1.3;
  const sway = Math.sin(t * 1.2) * 0.4;
  /* Lag between the canopy and the jumper is what makes the swing read. */
  const tilt = Math.cos(t * 1.2) * 0.22;

  return paintPlotted((plot) => {
    for (let step = 0; step <= 40; step += 1) {
      const angle = Math.PI + (step / 40) * Math.PI;
      plot(sway + tilt * 0.4 + Math.cos(angle) * 0.78, fall + Math.sin(angle) * 0.42, 0.8);
    }
    for (let line = 0; line <= 4; line += 1) {
      const angle = Math.PI + (line / 4) * Math.PI;
      plotSegment(
        plot,
        sway + tilt * 0.4 + Math.cos(angle) * 0.78,
        fall + Math.sin(angle) * 0.42,
        sway + tilt,
        fall + 0.66,
        0.3,
        10,
      );
    }
    plot(sway + tilt, fall + 0.72, 1);
    plotSegment(plot, sway + tilt, fall + 0.7, sway + tilt, fall + 0.95, 0.6, 6);
  });
}

/* -- Submarine: a hull under a surface it never breaks -------------------- */

function paintSubmarine(t: number): string {
  const u = Math.sin(t * 0.3);
  const v = 0.15 + Math.sin(t * 0.45) * 0.25;
  const heading = Math.cos(t * 0.3) >= 0 ? 1 : -1;

  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 90; sample += 1) {
      const surfaceU = (sample / 90) * ASPECT * 2 - ASPECT;
      plot(surfaceU, -0.88 + Math.sin(surfaceU * 2 + t * 1.5) * 0.06, 0.45);
    }
    for (let step = 0; step <= 60; step += 1) {
      const angle = (step / 60) * TAU;
      plot(u + Math.cos(angle) * 0.72, v + Math.sin(angle) * 0.26, 0.8);
    }
    plotSegment(plot, u - 0.16, v - 0.24, u + 0.16, v - 0.24, 0.9, 6);
    plotSegment(plot, u - 0.16, v - 0.24, u - 0.12, v - 0.52, 0.9, 6);
    plotSegment(plot, u + 0.16, v - 0.24, u + 0.12, v - 0.52, 0.9, 6);
    plotSegment(plot, u - 0.12, v - 0.52, u + 0.12, v - 0.52, 0.9, 5);
    plotSegment(plot, u, v - 0.52, u, v - 0.78, 0.6, 5);
    /* The screw sits at whichever end is now the stern. */
    for (let blade = 0; blade < 3; blade += 1) {
      plot(u - heading * 0.78, v + Math.sin(t * 6 + (blade / 3) * TAU) * 0.2, 0.7);
    }
    for (let bubble = 0; bubble < 6; bubble += 1) {
      const climb = (t * 0.5 + hash(bubble * 4.3)) % 1;
      plot(
        u - heading * (0.9 + hash(bubble * 2.7) * 0.5),
        v - climb * 1.6,
        (1 - climb) * 0.6,
      );
    }
  });
}

/* -- Train: an engine and two cars crossing the frame --------------------- */

function paintTrain(t: number): string {
  const travel = ((t * 0.22) % 1) * (ASPECT * 2 + 3.2) - ASPECT - 1.6;
  const wheelSpin = t * 5;

  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.78, ASPECT, 0.78, 0.4, 40);
    for (let tie = 0; tie < 10; tie += 1) {
      /* Ties scroll the other way, which is what gives the train its speed. */
      const u = (tie / 10) * ASPECT * 2 - ASPECT - ((t * 0.44) % 0.336);
      plotSegment(plot, u, 0.78, u, 0.9, 0.2, 4);
    }
    for (let car = 0; car < 3; car += 1) {
      const u = travel - car * 0.95;
      const top = car === 0 ? 0.05 : 0.2;
      plotSegment(plot, u - 0.38, top, u + 0.38, top, 0.85, 10);
      plotSegment(plot, u - 0.38, top, u - 0.38, 0.6, 0.85, 8);
      plotSegment(plot, u + 0.38, top, u + 0.38, 0.6, 0.85, 8);
      plotSegment(plot, u - 0.38, 0.6, u + 0.38, 0.6, 0.85, 10);
      for (const wheel of [-0.22, 0.22]) {
        plot(u + wheel + Math.cos(wheelSpin) * 0.07, 0.7 + Math.sin(wheelSpin) * 0.05, 0.9);
      }
    }
    plotSegment(plot, travel + 0.2, 0.05, travel + 0.2, -0.2, 0.7, 5);
    for (let puff = 0; puff < 7; puff += 1) {
      const age = (t * 0.7 + puff / 7) % 1;
      plot(travel + 0.2 - age * 1.5, -0.28 - age * 0.7, (1 - age) * 0.6);
    }
  });
}

/* -- Bicycle: spokes and cranks tied to the same rotation ----------------- */

function paintBicycle(t: number): string {
  const travel = ((t * 0.2) % 1) * (ASPECT * 2 + 1.6) - ASPECT - 0.8;
  const spin = t * 4.4;
  const rear = travel - 0.52;
  const front = travel + 0.52;
  const hub = 0.42;

  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.86, ASPECT, 0.86, 0.35, 40);
    for (const [center, offset] of [
      [rear, 0],
      [front, 1.1],
    ] as const) {
      for (let step = 0; step <= 40; step += 1) {
        const angle = (step / 40) * TAU;
        plot(center + Math.cos(angle) * 0.42, hub + Math.sin(angle) * 0.28, 0.65);
      }
      for (let spoke = 0; spoke < 6; spoke += 1) {
        const angle = spin + offset + (spoke / 6) * TAU;
        plotSegment(
          plot,
          center,
          hub,
          center + Math.cos(angle) * 0.42,
          hub + Math.sin(angle) * 0.28,
          0.3,
          6,
        );
      }
    }
    plotSegment(plot, rear, hub, travel, hub - 0.1, 0.8, 8);
    plotSegment(plot, travel, hub - 0.1, travel - 0.16, hub - 0.62, 0.8, 8);
    plotSegment(plot, rear, hub, travel - 0.16, hub - 0.62, 0.8, 8);
    plotSegment(plot, travel - 0.16, hub - 0.62, front, hub - 0.5, 0.8, 10);
    plotSegment(plot, front, hub - 0.5, front, hub, 0.8, 8);
    plotSegment(plot, travel, hub - 0.1, front, hub - 0.5, 0.6, 10);
    plotSegment(plot, front - 0.16, hub - 0.62, front + 0.12, hub - 0.62, 0.7, 5);
    /* Pedals stay opposite each other and turn with the wheels. */
    for (const side of [0, Math.PI]) {
      plot(travel + Math.cos(spin + side) * 0.18, hub - 0.1 + Math.sin(spin + side) * 0.12, 0.9);
    }
  });
}

/* -- Chain drive: a small sprocket forced to run faster ------------------- */

function paintChainDrive(t: number): string {
  const spin = t * 1.6;
  const bigU = 1.1;
  const bigR = 0.62;
  const smallU = -1.25;
  const smallR = 0.34;

  return paintPlotted((plot) => {
    for (const [center, radius, teeth, rate] of [
      [bigU, bigR, 14, 1],
      [smallU, smallR, 8, bigR / smallR],
    ] as const) {
      for (let step = 0; step <= 48; step += 1) {
        const angle = (step / 48) * TAU;
        plot(center + Math.cos(angle) * radius * 1.2, Math.sin(angle) * radius * 0.8, 0.3);
      }
      /* Teeth on the small sprocket sweep faster: same chain, less radius. */
      for (let tooth = 0; tooth < teeth; tooth += 1) {
        const angle = spin * rate + (tooth / teeth) * TAU;
        plot(center + Math.cos(angle) * radius * 1.5, Math.sin(angle) * radius, 0.85);
      }
    }
    plotSegment(plot, smallU, -smallR, bigU, -bigR, 0.5, 24);
    plotSegment(plot, smallU, smallR, bigU, bigR, 0.5, 24);
    for (let link = 0; link < 12; link += 1) {
      const f = (link / 12 + spin * 0.12) % 1;
      plot(smallU + (bigU - smallU) * f, -smallR - (bigR - smallR) * f, 0.95);
      plot(bigU - (bigU - smallU) * f, bigR - (bigR - smallR) * f, 0.95);
    }
  });
}

/* -- Scales: a beam settling toward balance, then nudged again ------------ */

function paintScales(t: number): string {
  const since = (t * 0.3) % 3;
  /* Each round starts with a swing that damps out before the next weight. */
  const lift = Math.sin(since * 5.5) * Math.exp(-since * 0.9) * 0.55;

  return paintPlotted((plot) => {
    plotSegment(plot, 0, 0.95, 0, -0.42, 0.6, 18);
    plotSegment(plot, -0.24, 0.95, 0.24, 0.95, 0.6, 8);
    plotSegment(plot, -1.35, -0.42 - lift, 1.35, -0.42 + lift, 0.85, 32);
    for (const side of [-1, 1] as const) {
      const u = side * 1.35;
      const v = -0.42 + side * lift;
      plotSegment(plot, u, v, u - 0.24, v + 0.5, 0.35, 8);
      plotSegment(plot, u, v, u + 0.24, v + 0.5, 0.35, 8);
      plotSegment(plot, u - 0.3, v + 0.5, u + 0.3, v + 0.5, 0.9, 10);
    }
    plot(0, -0.42, 1);
  });
}

/* -- Compass: a needle hunting north and giving up slowly ----------------- */

function paintCompass(t: number): string {
  const settle = (t * 0.24) % 1;
  const angle = -Math.PI / 2 + Math.sin(settle * 22) * Math.exp(-settle * 4) * 1.5;

  return paintPlotted((plot) => {
    for (let step = 0; step <= 90; step += 1) {
      const around = (step / 90) * TAU;
      plot(Math.cos(around) * 1.35, Math.sin(around) * 0.85, 0.5);
    }
    for (let mark = 0; mark < 8; mark += 1) {
      const around = (mark / 8) * TAU;
      plot(Math.cos(around) * 1.16, Math.sin(around) * 0.72, mark % 2 === 0 ? 0.8 : 0.4);
    }
    /* The north half runs brighter, the way a painted needle reads. */
    plotSegment(plot, 0, 0, Math.cos(angle) * 1, Math.sin(angle) * 0.62, 0.95, 14);
    plotSegment(plot, 0, 0, Math.cos(angle + Math.PI) * 0.72, Math.sin(angle + Math.PI) * 0.45, 0.45, 10);
    plot(0, 0, 1);
  });
}

/* -- Candle: a flame that leans, and wax that finds its way down ---------- */

function paintCandle(t: number): string {
  const flicker = Math.sin(t * 6.1) * 0.5 + Math.sin(t * 11.3) * 0.3;
  const lean = flicker * 0.12;
  const height = 0.62 + flicker * 0.1;

  return paintPlotted((plot) => {
    plotSegment(plot, -0.26, 0.95, -0.26, 0.1, 0.6, 12);
    plotSegment(plot, 0.26, 0.95, 0.26, 0.1, 0.6, 12);
    plotSegment(plot, -0.26, 0.1, 0.26, 0.1, 0.6, 8);
    plot(0.26, 0.1 + ((t * 0.2) % 1) * 0.85, 0.7);
    plotSegment(plot, 0, 0.1, lean * 0.4, -0.04, 0.5, 5);
    for (let step = 0; step <= 26; step += 1) {
      const f = step / 26;
      /* Widest a third of the way up, tapering to a point at the tip. */
      const width = Math.sin(f * Math.PI) * 0.2 * (1 - f * 0.5);
      const centerU = lean * f * 1.4;
      const centerV = -0.04 - f * height;
      plot(centerU - width, centerV, 0.4 + f * 0.3);
      plot(centerU + width, centerV, 0.4 + f * 0.3);
      plot(centerU, centerV, 1 - f * 0.25);
    }
  });
}

/* -- Heartbeat: a trace scrolling under a pen ---------------------------- */

/** One PQRST complex, squeezed into the first half of each beat. */
function beatTrace(position: number): number {
  const f = position - Math.floor(position);
  if (f < 0.08) return Math.sin((f / 0.08) * Math.PI) * 0.12;
  if (f < 0.14) return -0.1;
  if (f < 0.2) return ((f - 0.14) / 0.06) * 0.95;
  if (f < 0.26) return 0.95 - ((f - 0.2) / 0.06) * 1.25;
  if (f < 0.32) return -0.3 + ((f - 0.26) / 0.06) * 0.3;
  if (f < 0.5) return Math.sin(((f - 0.32) / 0.18) * Math.PI) * 0.22;
  return 0;
}

function paintHeartbeat(t: number): string {
  const scroll = t * 0.9;
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 220; sample += 1) {
      const u = (sample / 220) * ASPECT * 2 - ASPECT;
      const trace = beatTrace((u + ASPECT) * 0.5 + scroll);
      plot(u, 0.35 - trace * 0.95, 0.45 + Math.abs(trace) * 0.55);
    }
    plot(ASPECT - 0.06, 0.35 - beatTrace(ASPECT + scroll) * 0.95, 1);
  });
}

/* -- Seismograph: quiet paper, then a burst that decays ------------------- */

function seismoTrace(world: number): number {
  /* Blocky by design: the hash is sampled per step, like a real pen stroke. */
  const shake = (hash(Math.floor(world * 9)) - 0.5) * 2;
  return shake * Math.max(0, Math.sin(world * 0.35)) * 0.75;
}

function paintSeismograph(t: number): string {
  const scroll = t * 1.4;
  return paintPlotted((plot) => {
    plotSegment(plot, -ASPECT, 0.92, ASPECT, 0.92, 0.35, 40);
    for (let sample = 0; sample <= 200; sample += 1) {
      const u = (sample / 200) * ASPECT * 2 - ASPECT;
      /* Older ink sits further left; the pen always writes at the edge. */
      const world = scroll - (ASPECT - u) * 1.2;
      plot(u, 0.1 + seismoTrace(world), 0.35 + Math.abs(seismoTrace(world)) * 0.8);
    }
    const pen = 0.1 + seismoTrace(scroll);
    plotSegment(plot, ASPECT - 0.1, pen, ASPECT - 0.1, 0.92, 0.3, 10);
    plot(ASPECT - 0.1, pen, 1);
  });
}

/* -- Seven segment: a counter running on a bench display ------------------ */

/** Segment masks for 0 through 9, bit order a, b, c, d, e, f, g. */
const SEVEN_SEGMENT_DIGITS: readonly number[] = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f,
];

const SEVEN_SEGMENT_ORIGIN = Math.floor((W - 18) / 2);

function segmentLit(mask: number, x: number, y: number): boolean {
  if (y === 0) return (mask & 0x01) !== 0;
  if (y === 3) return (mask & 0x40) !== 0;
  if (y === 6) return (mask & 0x08) !== 0;
  if (y < 3) return x === 0 ? (mask & 0x20) !== 0 : x === 2 && (mask & 0x02) !== 0;
  return x === 0 ? (mask & 0x10) !== 0 : x === 2 && (mask & 0x04) !== 0;
}

function paintSevenSegment(t: number): string {
  const count = Math.floor(t * 8) % 10000;
  return paintGrid((x, y) => {
    const row = y - 1;
    if (row < 0 || row > 6) return 0;
    const column = x - SEVEN_SEGMENT_ORIGIN;
    if (column < 0) return 0;
    const digit = Math.floor(column / 5);
    if (digit > 3) return 0;
    const local = column % 5;
    if (local > 2) return 0;
    const mask = SEVEN_SEGMENT_DIGITS[Math.floor(count / Math.pow(10, 3 - digit)) % 10]!;
    /* Unlit segments stay faintly visible, the way a real display looks. */
    return segmentLit(mask, local, row) ? 1 : 0.08;
  });
}

/* -- Defrag: fragments walked to the front of the disk -------------------- */

function paintDiskDefrag(t: number): string {
  const total = W * H;
  const moved = Math.floor(((t * 0.18) % 1) * total);
  const head = moved + Math.floor((t * 26) % Math.max(1, total - moved));

  return paintGrid((x, y) => {
    const cell = y * W + x;
    /* Everything before the boundary has already been packed solid. */
    if (cell < moved) return 0.9;
    if (cell === head) return 1;
    return hash(cell * 1.7) > 0.55 ? 0.45 : 0.1;
  });
}

/* -- Pachinko: balls taking a fixed path down a fixed board --------------- */

function paintPachinko(t: number): string {
  return paintPlotted((plot) => {
    for (let row = 0; row < 4; row += 1) {
      for (let peg = 0; peg < 6; peg += 1) {
        plot(-1.4 + peg * 0.56 + (row % 2) * 0.28, -0.7 + row * 0.45, 0.3);
      }
    }
    for (let ball = 0; ball < 5; ball += 1) {
      const fall = (t * 0.5 + ball / 5) % 1;
      const v = -1 + fall * 2;
      /* Each bounce always sends a given ball the same way, so the drop
         replays instead of jittering from frame to frame. */
      let u = (hash(ball * 3.1) - 0.5) * 0.6;
      const passed = Math.min(4, Math.max(0, Math.floor((v + 0.7) / 0.45) + 1));
      for (let row = 0; row < passed; row += 1) {
        u += hash(ball * 7.3 + row) > 0.5 ? 0.28 : -0.28;
      }
      plot(u, v, 0.5 + 0.5 * (1 - fall));
    }
  });
}

/* -- Water tank: a level rising and falling under a moving surface -------- */

function paintWaterTank(t: number): string {
  const level = 0.5 + Math.sin(t * 0.5) * 0.42;
  return paintGrid((x, y) => {
    if (x === 0 || x === W - 1 || y === H - 1) return 0.55;
    const surface = (1 - level) * H + Math.sin(x * 0.7 - t * 3) * 0.6;
    if (y < surface - 0.5) return 0.06;
    /* A bright meniscus on top, then shading that deepens down the tank. */
    if (y < surface + 0.5) return 1;
    return 0.4 + (y / H) * 0.35 + Math.sin(x * 1.3 + t * 2) * 0.05;
  });
}

/* ========================================================================
   Fourth collection: light and water fields, plus a workshop of machines,
   rides, and throws. Same contract as everything above: a pure function of
   elapsed seconds returning one rendered frame.
   ===================================================================== */

/* -- Tide pool: a waterline running up the sand and back ------------------ */

const tidePoolField: Field = (u, v, t) => {
  /* The tide crosses the frame horizontally. Ripples keep the edge from
     becoming a rigid divider while a pair of broken highlights shows flow. */
  const line = Math.sin(t * 0.5) * 0.48 + Math.sin(u * 2.8 + t * 1.8) * 0.09;
  const wet = v - line;
  if (wet < 0) {
    const shell = hash2(Math.floor((u + ASPECT) * 3), Math.floor((v + 1) * 4));
    return shell > 0.94 ? 0.42 : 0.035;
  }
  const foam = Math.exp(-wet * wet * 75);
  const ripple = Math.pow(Math.max(0, Math.sin(u * 4.1 - t * 2.2 - wet * 5)), 12);
  return clamp01(0.1 + foam * 0.86 + ripple * 0.38 * clamp01(1 - wet * 0.7));
};

/* -- Steam vent: puffs widening and thinning as they rise ----------------- */

const steamVentField: Field = (u, v, t) => {
  /* v runs down the frame, so 1 is the vent and -1 is the top of the plume. */
  const rise = (v + 1) / 2;
  const puff = Math.sin(v * 4.5 + t * 3.2) * 0.5 + 0.5;
  const spread = 0.22 + (1 - rise) * 0.9;
  const wander = Math.sin(t * 0.9 + (1 - rise) * 2.6) * (1 - rise) * 0.7;
  const core = clamp01(1 - Math.abs(u - wander) / spread);
  const body = core * (0.35 + puff * 0.65) * (0.25 + rise * 0.85);
  return clamp01(body + (v > 0.72 ? 0.5 : 0));
};

/* -- Cavern: rock closing in, lit by a lamp somebody is carrying ---------- */

const cavernField: Field = (u, v, t) => {
  const ceiling = -0.7 + Math.abs(Math.sin(u * 2.3)) * 0.5 + fbm(u * 1.9, 1.4, 2) * 0.3;
  const floor = 0.75 - Math.abs(Math.cos(u * 1.7 + 1.1)) * 0.45;
  const lampU = Math.sin(t * 0.7) * ASPECT * 0.8;
  const lamp = clamp01(1 - Math.hypot(u - lampU, (v - 0.2) * 1.4) / 1.5);
  /* Rock keeps a base tone so the walls read even outside the lamp's reach. */
  const rock = v < ceiling || v > floor;
  return clamp01(rock ? 0.32 + lamp * 0.68 : 0.04 + lamp * 0.5);
};

/* -- Spectrogram: frequency bands scrolling past the read head ------------ */

const spectrogramField: Field = (u, v, t) => {
  /* Time runs right to left. Three narrow voices leave distinct frequency
     ridges instead of filling the whole display with broadband texture. */
  const age = (ASPECT - u) * 0.55 + t * 1.6;
  const low = -0.58 + Math.sin(age * 0.9) * 0.12;
  const mid = 0.02 + Math.sin(age * 1.35 + 1.4) * 0.2;
  const high = 0.58 + Math.sin(age * 1.8 + 3.1) * 0.1;
  const ridge = Math.max(
    Math.exp(-Math.pow((v - low) / 0.1, 2)),
    Math.exp(-Math.pow((v - mid) / 0.08, 2)) * 0.82,
    Math.exp(-Math.pow((v - high) / 0.07, 2)) * 0.65,
  );
  const gate = 0.3 + Math.pow(Math.max(0, Math.sin(age * 2.4)), 3) * 0.7;
  const readHead = Math.exp(-Math.pow((u - ASPECT * 0.78) / 0.055, 2)) * 0.42;
  return clamp01(0.025 + ridge * gate + readHead);
};

/* -- Domain walls: blocks flipping polarity one after another ------------- */

const domainWallField: Field = (u, v, t) => {
  const su = u * 1.6 + 4;
  const sv = v * 2.2 + 3;
  const flip = Math.sin(t * 1.4 + hash2(Math.floor(su), Math.floor(sv)) * TAU);
  const edge = Math.min(su % 1, 1 - (su % 1), sv % 1, 1 - (sv % 1));
  /* Thin dark seams separate the domains, making each polarity flip legible. */
  if (edge < 0.075) return 0.025;
  return flip > 0 ? 0.76 : 0.14;
};

/* -- Rain on glass: drops clinging until they break loose ----------------- */

const rainGlassField: Field = (u, v, t) => {
  /* A soft film over the whole pane, so the beads have something to sit on. */
  let wet = 0.06 + fbm(u * 2.4, v * 2.4, 2) * 0.2;
  for (let drop = 0; drop < 6; drop += 1) {
    const lane = (hash(drop * 3.7) * 2 - 1) * ASPECT * 0.9;
    const across = Math.abs(u - lane);
    if (across > 0.24) continue;
    const speed = 0.35 + hash(drop * 8.1) * 0.5;
    const head = ((t * speed + hash(drop * 5.9)) % 1) * 2.4 - 1.2;
    /* Above the head is the trail it cleared; the head itself is the bead. */
    const along = head - v;
    if (along < -0.14) continue;
    if (across > (along > 0 ? 0.09 : 0.22)) continue;
    wet = Math.max(wet, along <= 0 ? 1 : clamp01(0.75 - along * 0.45));
  }
  return clamp01(wet);
};

/* -- Ember bed: coals breathing under a layer of ash ---------------------- */

const emberBedField: Field = (u, v, t) => {
  const row = Math.floor((v + 1.1) / 0.42);
  const offset = row % 2 === 0 ? 0 : 0.24;
  const column = Math.floor((u + ASPECT + offset) / 0.48);
  const centerU = -ASPECT - offset + (column + 0.5) * 0.48;
  const centerV = -1.1 + (row + 0.5) * 0.42;
  const seed = hash2(column, row);
  const jitterU = (seed - 0.5) * 0.1;
  const jitterV = (hash2(column + 19, row - 7) - 0.5) * 0.07;
  const distance = Math.hypot(
    (u - centerU - jitterU) / 0.25,
    (v - centerV - jitterV) / 0.2,
  );
  if (distance > 1) return 0.035;
  /* Coarse, rounded coals preserve their outline while breathing separately. */
  const breath = Math.sin(t * (1.1 + seed * 0.9) + seed * TAU) * 0.5 + 0.5;
  const rim = clamp01((1 - distance) * 5);
  return clamp01(0.13 + rim * (0.22 + breath * 0.72) * clamp01((v + 1.15) / 1.5));
};

/* -- Moon phase: a terminator crossing a cratered disc -------------------- */

const moonPhaseField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  /* Stars keep the sky from reading as a blank frame. */
  if (radius > 0.92) return hash2(Math.floor(u * 7), Math.floor(v * 7)) > 0.93 ? 0.5 : 0.03;
  const phase = (t * 0.25) % 1;
  /* The terminator is an ellipse whose width tracks the phase. */
  const edge = (Math.cos(phase * TAU) * Math.sqrt(Math.max(0, 0.846 - v * v))) / 0.92;
  const lit = phase < 0.5 ? u > edge : u < edge;
  return clamp01(lit ? 0.75 + fbm(u * 3.4, v * 3.4, 2) * 0.3 : 0.08);
};

/* -- Laser grid: beams sweeping through their own haze -------------------- */

const laserGridField: Field = (u, v, t) => {
  let light = 0.05;
  for (let beam = 0; beam < 4; beam += 1) {
    const angle = t * (0.4 + beam * 0.17) + beam * 1.9;
    /* Distance to a line through the origin, offset so the beams cross. */
    const distance = Math.abs(
      u * Math.cos(angle) + v * Math.sin(angle) - Math.sin(t * 0.8 + beam) * 0.6,
    );
    light = Math.max(light, clamp01(1 - distance * 9) * 0.95);
  }
  return clamp01(light + fbm(u * 2.2 + t * 0.3, v * 2.2, 2) * 0.14);
};

/* -- Pollen: motes on a breeze, the near ones moving fastest -------------- */

const pollenDriftField: Field = (u, v, t) => {
  let bright = 0.04;
  for (let mote = 0; mote < 14; mote += 1) {
    const depth = 0.35 + hash(mote * 4.1) * 0.65;
    const cu = (((hash(mote * 2.3) + t * 0.12 * depth) % 1) * 2 - 1) * ASPECT * 1.1;
    const cv = Math.sin(t * 0.5 * depth + mote) * 0.75;
    /* Squashing v widens each mote vertically so the sparse grid still finds it. */
    const size = 0.13 + depth * 0.14;
    bright = Math.max(bright, clamp01(1 - Math.hypot(u - cu, (v - cv) * 0.55) / size) * depth);
  }
  return bright;
};

/* -- Stained glass: fixed panes, with only the light behind them moving --- */

const stainedGlassField: Field = (u, v, t) => {
  const su = u * 1.5 + 5;
  /* Staggering each column by half a pane keeps the leading from lining up. */
  const sv = v * 2.1 + 3 + Math.floor(su) * 0.5;
  const lead = Math.min(su % 1, 1 - (su % 1), sv % 1, 1 - (sv % 1));
  if (lead < 0.075) return 0.025;
  const tone = hash2(Math.floor(su), Math.floor(sv));
  const sun = clamp01(1 - Math.abs(u - Math.sin(t * 0.6) * ASPECT * 0.9) / 1.6);
  return clamp01(0.12 + tone * 0.5 + sun * 0.6 * (0.4 + tone * 0.6));
};

/* -- Waterfall: a sheet breaking into streaks, with mist at the plunge ---- */

const waterfallField: Field = (u, v, t) => {
  const lip = -0.55;
  const halfWidth = 0.78 + Math.sin(t * 0.45) * 0.05;
  if (v < lip) {
    const river = Math.abs(u) < halfWidth + 0.25;
    return river ? 0.22 + Math.pow(Math.max(0, Math.sin(u * 5 - t * 2)), 8) * 0.35 : 0.025;
  }
  const fall = v - lip;
  if (Math.abs(u) > halfWidth + fall * 0.08) {
    const spray = v > 0.55 && Math.abs(u) < 1.35 && hash2(Math.floor(u * 10), Math.floor((v - t) * 9)) > 0.9;
    return spray ? 0.48 : 0.025;
  }
  /* Each column keeps its own offset, which is what breaks the sheet up. */
  const streak = Math.pow(
    Math.max(0, Math.sin(u * 11 + Math.sin(fall * 5 - t * 7) * 0.6)),
    1.6,
  );
  const mist = clamp01((v - 0.55) * 2.2) * 0.35;
  return clamp01(0.16 + streak * 0.76 + mist);
};

/* -- Plasma arc: a spark climbing two rails until it snaps ---------------- */

const plasmaArcField: Field = (u, v, t) => {
  /* The rails spread as they go up, which is what makes the arc let go. */
  const rail = ASPECT * 0.4 + (v + 1) * 0.22;
  const onRail = clamp01(1 - Math.abs(Math.abs(u) - rail) * 8);
  const climb = (t * 0.8) % 1;
  const height = 1 - climb * 1.9;
  const bend =
    Math.sin(u * 2.6 + t * 7) * 0.08 + (fbm(u * 3 + t * 4, 1.7, 2) - 0.5) * 0.12;
  const arc =
    Math.abs(u) < rail
      ? clamp01(1 - Math.abs(v - height - bend) * 7) * (1 - climb * 0.55)
      : 0;
  return clamp01(onRail * 0.55 + arc);
};

/* -- Mud cracks: plates pulling apart as the ground dries ----------------- */

const mudCrackField: Field = (u, v, t) => {
  const dry = (t * 0.2) % 1;
  const px = ((u / ASPECT + 1) / 2) * 7;
  const py = ((v + 1) / 2) * 4.5;
  const cellX = Math.floor(px);
  const cellY = Math.floor(py);
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const sx = cellX + ox;
      const sy = cellY + oy;
      const pointX = sx + 0.15 + hash2(sx, sy) * 0.7;
      const pointY = sy + 0.15 + hash2(sx + 31, sy - 17) * 0.7;
      const distance = Math.hypot(px - pointX, py - pointY);
      if (distance < nearest) {
        second = nearest;
        nearest = distance;
      } else if (distance < second) {
        second = distance;
      }
    }
  }
  /* Voronoi borders form plates. Their seams widen as the soil dries. */
  const crack = clamp01((0.14 + dry * 0.12 - (second - nearest)) * 12);
  return 0.025 + crack * 0.88;
};

/* -- Fireflies: points drifting, each on its own blink ------------------- */

const fireflyField: Field = (u, v, t) => {
  let glow = 0.03;
  for (let bug = 0; bug < 9; bug += 1) {
    const cu = Math.sin(t * (0.25 + hash(bug * 3.1) * 0.3) + bug * 2.1) * ASPECT * 0.85;
    const cv = Math.cos(t * (0.2 + hash(bug * 7.7) * 0.28) + bug) * 0.75;
    /* A high power on the sine gives a short flash and a long dark gap. */
    const beat = Math.pow(clamp01(Math.sin(t * 1.6 + hash(bug * 5.3) * TAU)), 5);
    glow = Math.max(
      glow,
      clamp01(1 - Math.hypot(u - cu, (v - cv) * 0.55) / 0.34) * (0.15 + beat * 0.85),
    );
  }
  return glow;
};

/* -- Whirlpool: arms winding tighter toward an open drain ---------------- */

const whirlpoolField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v * 1.25);
  const angle = Math.atan2(v * 1.25, u);
  /* Water nearer the drain turns faster, and that shear is what winds the arms. */
  const swirl = angle + 2.2 / Math.max(radius, 0.18) - t * 2.4;
  const arms = Math.sin(swirl * 1.4) * 0.5 + 0.5;
  const throat = clamp01((radius - 0.22) * 5);
  return clamp01(arms * throat * (0.35 + clamp01(1.4 - radius) * 0.65) + 0.05);
};

/* -- Blizzard: three sheets of snow bent by the same gust ----------------- */

const blizzardField: Field = (u, v, t) => {
  let snow = 0.025;
  const span = ASPECT * 2 + 1.2;
  for (let flake = 0; flake < 18; flake += 1) {
    const depth = 0.35 + hash(flake * 4.7) * 0.65;
    const travel = (hash(flake * 2.3) * span + t * (0.65 + depth * 1.3)) % span;
    const headU = -ASPECT - 0.6 + travel;
    const headV = -0.9 + ((hash(flake * 8.9) * 2 + t * 0.18 * depth) % 2);
    /* Each moving point carries a short diagonal trail in the gust. */
    const behind = headU - u;
    if (behind < 0 || behind > 0.48) continue;
    const distance = Math.abs(v - (headV + behind * 0.3));
    if (distance < 0.045 + depth * 0.025) {
      snow = Math.max(snow, (1 - behind / 0.55) * (0.38 + depth * 0.62));
    }
  }
  return snow;
};

/* -- Canyon: strata sliding past under a folded rim ----------------------- */

const canyonField: Field = (u, v, t) => {
  const depth = clamp01((v + 0.8) / 1.8);
  const center = Math.sin(t * 0.32) * 0.25 + Math.sin(v * 2.1 + t * 0.2) * 0.09;
  const gap = 1.3 - depth * 0.85;
  if (v < -0.72 || Math.abs(u - center) < gap) return 0.025;
  /* The two walls hold horizontal strata while the opening snakes between them. */
  const layer = Math.sin(v * 14 + u * 0.7 + t * 0.3) * 0.5 + 0.5;
  const edgeLight = clamp01((Math.abs(u - center) - gap) * 4);
  return clamp01(0.14 + layer * 0.55 + edgeLight * 0.18);
};

/* -- Water wheel: buckets filling under the flume ------------------------- */

function paintWaterWheel(t: number): string {
  const spin = t * 1.1;
  return paintPlotted((plot) => {
    /* The flume pours onto the buckets as they come over the top. */
    for (let drop = 0; drop <= 24; drop += 1) {
      const f = drop / 24;
      plot(-ASPECT + 0.15 + f * 0.9, -0.95 + f * 0.5, 0.5);
    }
    for (let sample = 0; sample <= 90; sample += 1) {
      const angle = (sample / 90) * TAU;
      plot(-0.15 + Math.cos(angle) * 0.85, Math.sin(angle) * 0.85, 0.3);
    }
    for (let bucket = 0; bucket < 8; bucket += 1) {
      const angle = spin + (bucket / 8) * TAU;
      for (let step = 0; step <= 6; step += 1) {
        const reach = 0.55 + (step / 6) * 0.3;
        plot(-0.15 + Math.cos(angle) * reach, Math.sin(angle) * reach, 0.45);
      }
      /* A bucket carries water up the far side and empties on the way down. */
      plot(
        -0.15 + Math.cos(angle) * 0.85,
        Math.sin(angle) * 0.85,
        Math.sin(angle) > 0 ? 1 : 0.35,
      );
    }
    for (let x = 0; x <= 40; x += 1) {
      const u = -ASPECT + (x / 40) * ASPECT * 2;
      plot(u, 0.95 + Math.sin(u * 3 - t * 6) * 0.04, 0.4);
    }
  });
}

/* -- Trebuchet: wind back slow, release fast, reset ----------------------- */

function paintTrebuchet(t: number): string {
  const cycle = (t * 0.4) % 1;
  const swing =
    cycle < 0.6 ? -2.5 + cycle * 0.4 : -2.26 + Math.pow((cycle - 0.6) / 0.4, 0.55) * 3.1;
  const pivotU = -0.4;
  const pivotV = 0.1;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.92, 0.3);
    for (let leg = -1; leg <= 1; leg += 2) {
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(pivotU + leg * 0.45 * f, pivotV + (0.9 - pivotV) * f, 0.45);
      }
    }
    /* One beam through the pivot: long throwing arm, short counterweight end. */
    for (let step = -6; step <= 14; step += 1) {
      const reach = (step / 14) * 1.4;
      plot(pivotU + Math.cos(swing) * reach, pivotV + Math.sin(swing) * reach, 0.7);
    }
    plot(pivotU - Math.cos(swing) * 0.62, pivotV - Math.sin(swing) * 0.62, 1);
    if (cycle > 0.72) {
      const flight = (cycle - 0.72) / 0.28;
      plot(pivotU + 0.6 + flight * 2.6, 0.2 - Math.sin(flight * Math.PI) * 1, 1);
    }
  });
}

/* -- Drawbridge: two leaves lifting to let a boat through ----------------- */

function paintDrawbridge(t: number): string {
  const lift = (Math.sin(t * 0.7) * 0.5 + 0.5) * 1.15;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) {
      const u = -ASPECT + (x / 40) * ASPECT * 2;
      plot(u, 0.85 + Math.sin(u * 2.5 + t * 3) * 0.05, 0.35);
    }
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 14; step += 1) plot(side * 1.05, -0.5 + (step / 14) * 1.4, 0.5);
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(side * (ASPECT - f * (ASPECT - 1.05)), 0.35, 0.45);
      }
      /* Each leaf hinges at its tower and swings up out of the way. */
      for (let step = 0; step <= 16; step += 1) {
        const f = (step / 16) * 0.95;
        plot(side * (1.05 - Math.cos(lift) * f), 0.35 - Math.sin(lift) * f, 0.9);
      }
    }
    const boat = -ASPECT + ((t * 0.18) % 1) * ASPECT * 2;
    plot(boat, 0.78, 0.9);
    plot(boat, 0.58, 0.6);
  });
}

/* -- Elevator: a car working the shaft between lit floors ----------------- */

function paintElevator(t: number): string {
  const car = 3 + Math.sin(t * 0.6) * 2.6;
  const open = Math.abs(Math.sin(t * 0.6)) > 0.94;
  return paintGrid((x, y) => {
    if (x === 9 || x === 18) return 0.55;
    if (x > 9 && x < 18) {
      const top = Math.round(car);
      if (y < top || y > top + 3) return y % 3 === 0 ? 0.2 : 0.05;
      if (y === top || y === top + 3) return 0.85;
      /* The doors part in the middle whenever the car settles at a floor. */
      if (x === 13 || x === 14) return open ? 0.15 : 0.9;
      return 0.45;
    }
    if (y % 3 === 0) return 0.4;
    return Math.abs(y - (car + 1.5)) < 1.6 ? 0.7 : 0.12;
  });
}

/* -- Escalator: treads riding a straight incline -------------------------- */

function paintEscalator(t: number): string {
  const roll = (t * 0.9) % 1;
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 60; sample += 1) {
      const along = sample / 60;
      /* The handrail carries grip marks so it reads as moving, not as a rail. */
      plot(
        -ASPECT + 0.2 + along * (ASPECT * 2 - 0.4),
        0.45 - along * 1.6,
        (sample + Math.floor(roll * 8)) % 6 === 0 ? 0.9 : 0.4,
      );
    }
    for (let step = -1; step < 9; step += 1) {
      const along = (step + roll) / 8;
      const u = -ASPECT + 0.2 + along * (ASPECT * 2 - 0.4);
      const v = 0.85 - along * 1.6;
      for (let cell = 0; cell <= 4; cell += 1) plot(u + (cell / 4) * 0.34, v, 0.95);
      for (let cell = 0; cell <= 3; cell += 1) plot(u, v + (cell / 3) * 0.2, 0.5);
    }
  });
}

/* -- Governor: flyballs rising as the engine picks up ---------------------- */

function paintGovernor(t: number): string {
  const rate = 0.5 + Math.sin(t * 0.45) * 0.45;
  const spin = t * 5;
  const angle = 0.3 + rate * 0.85;
  const pivotV = -0.82;
  const armLength = 0.95;
  const drop = pivotV + Math.cos(angle) * armLength;
  /* The collar rides up the shaft as the balls fly out: that is the output. */
  const collar = pivotV + Math.cos(angle) * armLength * 0.55 + 0.25;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 16; step += 1) plot(0, pivotV + (step / 16) * 1.75, 0.4);
    for (let cell = -2; cell <= 2; cell += 1) plot(cell * 0.13, collar, 0.75);
    for (let ball = 0; ball < 2; ball += 1) {
      const side = ball === 0 ? 1 : -1;
      /* Rotation shows as foreshortening; sin() of the spin stands in for depth. */
      const reach = Math.sin(angle) * armLength * Math.cos(spin) * side;
      const depth = 0.35 + 0.65 * ((Math.sin(spin) * side + 1) / 2);
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(reach * f, pivotV + (drop - pivotV) * f, depth * 0.6);
        plot(reach * (1 - f * 0.55), drop + (collar - drop) * f, depth * 0.35);
      }
      plot(reach, drop, depth);
    }
  });
}

/* -- Lathe: a blank turning down to size behind the tool ------------------ */

function paintLathe(t: number): string {
  const spin = t * 9;
  const cut = ((t * 0.3) % 1) * 2 - 1;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    /* Everything the tool has passed is already turned down, so it is thinner. */
    const radius = u < cut ? 0.34 : 0.5;
    if (Math.abs(v) < radius) return 0.35 + (Math.sin(v * 9 + spin + u * 1.5) * 0.5 + 0.5) * 0.6;
    if (Math.abs(v) < radius + 0.08) return 0.9;
    if (v > 0.62 && Math.abs(u - cut) < 0.08) return 1;
    if (v > 0.86) return 0.3;
    /* Chips thrown off at the cut. */
    if (
      v < -0.5 &&
      Math.abs(u - cut) < 0.5 &&
      hash2(Math.floor(u * 12 - t * 20), Math.floor(v * 8)) > 0.93
    ) {
      return 0.7;
    }
    return 0.05;
  });
}

/* -- Sewing machine: the needle laying a line of stitches ----------------- */

function paintSewingMachine(t: number): string {
  const needle = Math.abs(Math.sin(t * 6));
  const feed = (t * 1.1) % 1;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 1.4, -0.85, 0.55);
    for (let step = 0; step <= 8; step += 1) plot(0.15, -0.85 + (step / 8) * 0.45, 0.5);
    /* The needle bar drops through the fabric once per beat. */
    const tip = -0.4 + needle * 0.62;
    for (let step = 0; step <= 6; step += 1) plot(0.15, -0.4 + (step / 6) * (tip + 0.4), 0.95);
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.28, 0.35);
    /* Stitches already laid down, feeding away to the left. */
    for (let stitch = 0; stitch < 12; stitch += 1) {
      const u = 0.15 - (stitch + feed) * 0.3;
      if (u < -ASPECT) continue;
      plot(u, 0.22, 0.9);
      plot(u + 0.12, 0.22, 0.3);
    }
  });
}

/* -- Dot matrix: a head printing in both directions ----------------------- */

function paintDotMatrix(t: number): string {
  const pass = t * 1.4;
  const line = Math.floor(pass);
  const across = pass - line;
  /* Alternate passes run right to left, the way a real head does. */
  const head = (line % 2 === 0 ? across : 1 - across) * (W - 5) + 2;
  const printed = line % (H - 3);
  return paintGrid((x, y) => {
    if (y === 0) return 0.45;
    if (y === 1) return Math.abs(x - head) < 1.5 ? 1 : 0.1;
    const row = y - 2;
    if (row > printed) return 0.03;
    if (row === printed && (line % 2 === 0 ? x > head : x < head)) return 0.03;
    /* Gaps in the ramp read as the spaces between words. */
    const ink = hash2(x, row + Math.floor(line / (H - 3)) * 31);
    return ink > 0.78 ? 0 : 0.3 + ink * 0.45;
  });
}

/* -- Robot arm: two joints solving for a moving target -------------------- */

function paintRobotArm(t: number): string {
  const targetU = Math.sin(t * 0.6) * 1.2;
  const targetV = 0.55 + Math.cos(t * 0.9) * 0.2;
  const baseV = 0.9;
  const upper = 0.95;
  const fore = 0.85;
  const reach = Math.min(Math.hypot(targetU, targetV - baseV), upper + fore - 0.02);
  /* Law of cosines gives the elbow bend that puts the tool on the target. */
  const bend = Math.acos(
    clamp01((upper * upper + reach * reach - fore * fore) / (2 * upper * reach)),
  );
  const shoulder = Math.atan2(targetV - baseV, targetU) - bend;
  const elbowU = Math.cos(shoulder) * upper;
  const elbowV = baseV + Math.sin(shoulder) * upper;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.95, 0.3);
    for (let step = 0; step <= 12; step += 1) plot(0, baseV - (step / 12) * 0.2, 0.5);
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(elbowU * f, baseV + (elbowV - baseV) * f, 0.6);
      plot(elbowU + (targetU - elbowU) * f, elbowV + (targetV - elbowV) * f, 0.75);
    }
    plot(elbowU, elbowV, 0.95);
    plot(targetU, targetV - 0.12, 1);
    plot(targetU, targetV + 0.12, 1);
  });
}

/* -- Drone: four rotors holding a hover ----------------------------------- */

function paintDrone(t: number): string {
  const bodyU = Math.sin(t * 0.5) * 1.1;
  const bodyV = -0.2 + Math.sin(t * 0.85 + 1.2) * 0.35;
  const blade = t * 22;
  return paintPlotted((plot) => {
    for (let cell = -2; cell <= 2; cell += 1) plot(bodyU + cell * 0.11, bodyV, 0.85);
    for (let arm = 0; arm < 4; arm += 1) {
      const side = arm % 2 === 0 ? 1 : -1;
      const hubU = bodyU + side * 0.62;
      const hubV = bodyV + (arm < 2 ? -0.16 : 0.16);
      for (let step = 0; step <= 6; step += 1) {
        const f = step / 6;
        plot(bodyU + (hubU - bodyU) * f, bodyV + (hubV - bodyV) * f, 0.45);
      }
      /* Rotors read as a blur: the disc brightens wherever a blade is. */
      for (let sample = 0; sample <= 10; sample += 1) {
        const spread = (sample / 10) * 2 - 1;
        const spin = Math.sin(blade * side + spread * 3.4);
        plot(hubU + spread * 0.3, hubV - 0.18, 0.25 + Math.abs(spin) * 0.6);
      }
    }
    for (let x = 0; x <= 40; x += 1) {
      const u = -ASPECT + (x / 40) * ASPECT * 2;
      plot(u, 0.92, 0.2 + (Math.abs(u - bodyU) < 0.5 ? 0.25 : 0));
    }
  });
}

/* -- Zipline: a trolley running a sagging cable --------------------------- */

const ziplineCable = (f: number): number => -0.75 + f * 0.7 + Math.sin(f * Math.PI) * 0.55;

function paintZipline(t: number): string {
  const ride = (t * 0.3) % 1;
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 60; sample += 1) {
      const f = sample / 60;
      plot(-ASPECT + 0.2 + f * (ASPECT * 2 - 0.4), ziplineCable(f), 0.4);
    }
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(-ASPECT + 0.2, ziplineCable(0) + f * (0.95 - ziplineCable(0)), 0.5);
      plot(ASPECT - 0.2, ziplineCable(1) + f * (0.95 - ziplineCable(1)), 0.5);
    }
    const u = -ASPECT + 0.2 + ride * (ASPECT * 2 - 0.4);
    const v = ziplineCable(ride);
    plot(u, v, 1);
    /* The rider hangs below the trolley and swings as it goes. */
    const lean = Math.sin(t * 2.4) * 0.18;
    for (let step = 1; step <= 5; step += 1) {
      const f = step / 5;
      plot(u - lean * f, v + f * 0.45, 0.8);
    }
  });
}

/* -- Swing set: a seat trading height for speed --------------------------- */

function paintSwingSet(t: number): string {
  const swing = Math.sin(t * 1.6) * 0.85;
  const pivotV = -0.85;
  const seatU = Math.sin(swing) * 1.35;
  const seatV = pivotV + Math.cos(swing) * 1.35;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.95, 0.25);
    for (let x = 0; x <= 24; x += 1) plot(-0.9 + (x / 24) * 1.8, pivotV, 0.5);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(side * (0.9 + f * 0.5), pivotV + f * (0.92 - pivotV), 0.45);
      }
    }
    /* Two ropes down to the seat, with the rider leaning into the swing. */
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(seatU * f - 0.06, pivotV + (seatV - pivotV) * f, 0.55);
      plot(seatU * f + 0.06, pivotV + (seatV - pivotV) * f, 0.55);
    }
    plot(seatU, seatV, 1);
    plot(seatU - Math.sin(swing) * 0.2, seatV - 0.2, 0.85);
  });
}

/* -- Pinwheel: gusts spinning it up, then a coast ------------------------- */

function paintPinwheel(t: number): string {
  const gust = 0.4 + Math.pow(clamp01(Math.sin(t * 0.55)), 2) * 1.6;
  const spin = t * 3 * gust;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) plot(0, -0.15 + (step / 14) * 1.1, 0.4);
    for (let vane = 0; vane < 4; vane += 1) {
      const base = spin + (vane / 4) * TAU;
      for (let sample = 0; sample <= 26; sample += 1) {
        const f = sample / 26;
        /* Each vane curls, so its tip runs ahead of its own root. */
        const angle = base + f * 1.1;
        plot(Math.cos(angle) * f * 0.85, -0.15 + Math.sin(angle) * f * 0.85, 0.35 + f * 0.6);
      }
    }
    for (let streak = 0; streak < 3; streak += 1) {
      const head = ((t * gust * 0.5 + streak * 0.33) % 1) * ASPECT * 2.4 - ASPECT * 1.2;
      for (let cell = 0; cell < 4; cell += 1) {
        plot(head - cell * 0.18, -0.75 + streak * 0.55, 0.5 - cell * 0.1);
      }
    }
  });
}

/* -- Ratchet: a wheel stepping round one tooth at a time ------------------ */

function paintRatchet(t: number): string {
  const teeth = 12;
  const index = Math.floor(t * 3);
  /* Each step is quick, then the wheel waits for the next click. */
  const ease = clamp01((t * 3 - index) * 2.4);
  const spin = ((index + ease) / teeth) * TAU;
  return paintPlotted((plot) => {
    for (let tooth = 0; tooth < teeth; tooth += 1) {
      const root = spin + (tooth / teeth) * TAU;
      const tip = spin + ((tooth + 0.62) / teeth) * TAU;
      for (let sample = 0; sample <= 8; sample += 1) {
        const f = sample / 8;
        const a = root + (tip - root) * f;
        plot(Math.cos(a) * (0.45 + f * 0.35), Math.sin(a) * (0.45 + f * 0.35), 0.45 + f * 0.5);
      }
      /* The straight drop back to the root is what stops the pawl. */
      for (let sample = 0; sample <= 5; sample += 1) {
        const radius = 0.8 - (sample / 5) * 0.35;
        plot(Math.cos(tip) * radius, Math.sin(tip) * radius, 0.6);
      }
    }
    const kick = Math.pow(1 - ease, 2) * 0.22;
    for (let sample = 0; sample <= 12; sample += 1) {
      const f = sample / 12;
      plot(0.35 + f * 0.9, -0.95 + f * (0.55 - kick), 0.7);
    }
  });
}

/* -- Fidget spinner: flicked, then winding down --------------------------- */

function paintFidgetSpinner(t: number): string {
  const since = t % 3.4;
  const speed = 8 * Math.exp(-since * 0.75) + 0.6;
  const spin = t * speed;
  const blur = clamp01((speed - 2) / 6);
  return paintPlotted((plot) => {
    for (let lobe = 0; lobe < 3; lobe += 1) {
      const angle = spin + (lobe / 3) * TAU;
      const cu = Math.cos(angle) * 0.62;
      const cv = Math.sin(angle) * 0.62;
      for (let sample = 0; sample <= 20; sample += 1) {
        const a = (sample / 20) * TAU;
        plot(cu + Math.cos(a) * 0.28, cv + Math.sin(a) * 0.28, 0.8);
      }
      for (let step = 0; step <= 6; step += 1) {
        const f = step / 6;
        plot(cu * f, cv * f, 0.4);
      }
      /* A trail behind each lobe, but only while it is still quick. */
      for (let sample = 1; sample <= 6; sample += 1) {
        const a = angle - (sample / 6) * 0.8;
        plot(Math.cos(a) * 0.62, Math.sin(a) * 0.62, blur * (0.6 - sample * 0.08));
      }
    }
    for (let sample = 0; sample <= 14; sample += 1) {
      const a = (sample / 14) * TAU;
      plot(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.9);
    }
  });
}

/* -- Abacus: rods counting up at their own rates -------------------------- */

function paintAbacus(t: number): string {
  const count = Math.floor(t * 3);
  const beads = 9;
  return paintGrid((x, y) => {
    if (x === 0 || x === W - 1) return 0.6;
    /* Each rod counts at its own rate, so the whole frame keeps moving. */
    const digit = Math.floor((count * (y + 2)) / 3) % (beads + 1);
    const slot = x - 1;
    const width = W - 2;
    const counted = slot < digit * 2 && slot % 2 === 0;
    const parked = slot >= width - (beads - digit) * 2 && (width - slot) % 2 === 1;
    return counted || parked ? 0.95 : 0.18;
  });
}

/* -- Bowling: a hooked ball arriving at the pin deck ---------------------- */

function paintBowling(t: number): string {
  const cycle = (t * 0.35) % 1;
  const hit = clamp01((cycle - 0.72) / 0.28);
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 50; sample += 1) {
      const f = sample / 50;
      const u = -ASPECT + f * ASPECT * 2;
      plot(u, -0.95 + f * 0.15, 0.3);
      plot(u, 0.95 - f * 0.15, 0.3);
    }
    /* Ten pins in a triangle, scattered once the ball arrives. */
    for (let pin = 0; pin < 10; pin += 1) {
      const row = Math.floor((Math.sqrt(8 * pin + 1) - 1) / 2);
      const place = pin - (row * (row + 1)) / 2;
      const knock = hit * (0.6 + hash(pin * 3.3) * 0.9);
      plot(
        ASPECT - 0.85 + row * 0.22 + knock * 0.8,
        (place - row / 2) * 0.34 + (hash(pin * 7.1) - 0.5) * knock * 1.6,
        1 - hit * 0.4,
      );
    }
    /* The ball, with the line it leaves on the oil. */
    for (let tail = 0; tail < 5; tail += 1) {
      const f = cycle - tail * 0.035;
      if (f < 0) continue;
      plot(-ASPECT + 0.3 + f * (ASPECT * 2 - 0.9), Math.sin(f * 2.4) * 0.35, 1 - tail * 0.17);
    }
  });
}

/* -- Hoop shot: an arc through the rim, and the net answering ------------- */

function paintHoopShot(t: number): string {
  const cycle = (t * 0.45) % 1;
  const flight = clamp01(cycle / 0.7);
  const hoopU = ASPECT - 0.9;
  const startU = -ASPECT + 0.5;
  const ballU = startU + (hoopU - startU) * flight;
  /* Past the rim the ball drops out of the bottom of the net. */
  const ballV = 0.65 - Math.sin(flight * Math.PI) * 1.35 + (cycle > 0.7 ? (cycle - 0.7) * 4 : 0);
  const sway = cycle > 0.7 ? Math.sin((cycle - 0.7) * 26) * 0.16 * (1 - (cycle - 0.7) / 0.3) : 0;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.95, 0.25);
    for (let step = 0; step <= 12; step += 1) plot(ASPECT - 0.3, -0.85 + (step / 12) * 0.9, 0.55);
    for (let cell = 0; cell <= 5; cell += 1) plot(hoopU + (cell / 5) * 0.55, -0.1, 0.9);
    for (let strand = 0; strand <= 3; strand += 1) {
      for (let step = 0; step <= 5; step += 1) {
        const f = step / 5;
        plot(hoopU + (strand / 3) * 0.55 + sway * f, -0.1 + f * 0.45, 0.4);
      }
    }
    for (let step = 0; step <= 14; step += 1) plot(startU, 0.95 - (step / 14) * 0.4, 0.35);
    plot(ballU, ballV, 1);
    plot(ballU - 0.1, ballV - 0.08, 0.6);
  });
}

/* -- Jump rope: the hop timed to the rope coming under ------------------- */

function paintJumpRope(t: number): string {
  const turn = t * 3.4;
  const hop = Math.max(0, Math.sin(turn - 0.6)) * 0.35;
  const feet = 0.85 - hop;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.95, 0.25);
    /* The rope is a circle seen edge on: an arc that flips over each turn. */
    for (let sample = 0; sample <= 40; sample += 1) {
      const spread = (sample / 40) * 2 - 1;
      const arc = Math.cos(turn) * (1 - spread * spread) * 0.95;
      plot(spread * 1.05, 0.35 - arc, Math.sin(turn) > 0 ? 0.9 : 0.35);
    }
    for (let step = 0; step <= 8; step += 1) plot(0, feet - (step / 8) * 0.75, 0.8);
    plot(0, feet - 0.95, 1);
    plot(-0.42, feet - 0.45, 0.85);
    plot(0.42, feet - 0.45, 0.85);
  });
}

/* -- Flag: cloth waving harder the further it is from the pole ------------ */

function paintFlag(t: number): string {
  return paintGrid((x, y) => {
    if (x < 3) return y === H - 1 ? 0.3 : 0.03;
    if (x === 3) return 0.7;
    const along = (x - 3) / (W - 4);
    /* The wave grows with distance from the pole, the way real cloth behaves. */
    const wave = Math.sin(along * 7 - t * 5) * along * 1.6;
    const top = 1.4 + wave;
    if (y < top || y > top + 4.6) return 0.04;
    const tone = 0.35 + (Math.cos(along * 7 - t * 5) * 0.5 + 0.5) * 0.5;
    const stripe = (y - top) / 4.6;
    return clamp01(tone * (stripe > 0.35 && stripe < 0.65 ? 0.55 : 1));
  });
}

/* -- Sparkler: sparks thrown from a tip that keeps moving ----------------- */

function paintSparkler(t: number): string {
  const handU = Math.sin(t * 0.8) * 0.9;
  const handV = Math.cos(t * 1.1) * 0.45;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(handU - f * 0.35, handV + f * 0.75, 0.35);
    }
    plot(handU, handV, 1);
    /* Sparks fly straight out, sag a little, and burn away inside a second. */
    for (let spark = 0; spark < 26; spark += 1) {
      const life = (t * 1.7 + hash(spark * 4.7)) % 1;
      const angle = hash(spark * 2.3) * TAU;
      const reach = life * (0.4 + hash(spark * 9.1) * 0.9);
      plot(
        handU + Math.cos(angle) * reach,
        handV + Math.sin(angle) * reach + life * life * 0.35,
        clamp01((1 - life) * 1.4) * (0.4 + hash(spark * 5.5) * 0.6),
      );
    }
  });
}

/* -- Volcano: ejecta on ballistic arcs over a running flow ---------------- */

function paintVolcano(t: number): string {
  const surge = Math.pow(clamp01(Math.sin(t * 0.5)), 3);
  return paintPlotted((plot) => {
    for (let sample = 0; sample <= 30; sample += 1) {
      const f = sample / 30;
      plot(-ASPECT + f * (ASPECT - 0.35), 0.95 - f * 1.05, 0.5);
      plot(ASPECT - f * (ASPECT - 0.35), 0.95 - f * 1.05, 0.5);
    }
    for (let rock = 0; rock < 20; rock += 1) {
      const life = (t * 0.7 + hash(rock * 3.9)) % 1;
      /* Thrown harder during a surge, but always on the same parabola. */
      const throwUp = (0.4 + hash(rock * 6.1) * 0.9) * (0.35 + surge);
      plot(
        (hash(rock * 8.3) * 2 - 1) * 1.4 * life,
        -0.1 - throwUp * (life * 2 - life * life * 2.4) * 1.6 + life * life * 1.2,
        clamp01(1 - life * 0.8),
      );
    }
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(0.2 + f * 0.9, -0.05 + f, (Math.sin(f * 9 - t * 5) * 0.5 + 0.5) * 0.6 + 0.35);
    }
  });
}

/* -- Space station: a ring turning around a docked hub ------------------- */

function paintSpaceStation(t: number): string {
  const spin = t * 0.7;
  return paintPlotted((plot) => {
    for (let star = 0; star < 12; star += 1) {
      const u = (((hash(star * 2.7) + t * 0.02) % 1) * 2 - 1) * ASPECT;
      plot(u, (hash(star * 5.1) * 2 - 1) * 0.95, 0.3);
    }
    /* The ring is seen at an angle, so the far half reads dimmer. */
    for (let sample = 0; sample <= 90; sample += 1) {
      const a = (sample / 90) * TAU + spin;
      plot(Math.cos(a) * 1.15, Math.sin(a) * 0.5, 0.25 + ((Math.sin(a) + 1) / 2) * 0.7);
    }
    for (let spoke = 0; spoke < 4; spoke += 1) {
      const a = spin + (spoke / 4) * TAU;
      for (let step = 0; step <= 10; step += 1) {
        const f = step / 10;
        plot(Math.cos(a) * 1.15 * f, Math.sin(a) * 0.5 * f, 0.3 + f * 0.2);
      }
    }
    for (let cell = -1; cell <= 1; cell += 1) plot(cell * 0.12, 0, 0.95);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 2; step <= 6; step += 1) plot(side * step * 0.26, -0.55, 0.55);
    }
  });
}

/* -- Lunar lander: a descent, a touchdown, and a lift away ---------------- */

function paintLunarLander(t: number): string {
  const cycle = (t * 0.22) % 1;
  const height = cycle < 0.7 ? 1 - cycle / 0.7 : (cycle - 0.7) / 0.3;
  const craftU = Math.sin(t * 0.5) * 0.7;
  const craftV = 0.55 - height * 1.35;
  /* The engine only burns while there is height to lose or gain. */
  const burn = height > 0.02 ? 0.5 + Math.abs(Math.sin(t * 9)) * 0.5 : 0;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      const crater = Math.abs(u + 0.9) < 0.4 || Math.abs(u - 1.2) < 0.3 ? 0.12 : 0;
      plot(u, 0.88 + crater, 0.45);
    }
    for (let cell = -2; cell <= 2; cell += 1) plot(craftU + cell * 0.11, craftV, 0.9);
    for (let cell = -1; cell <= 1; cell += 1) plot(craftU + cell * 0.11, craftV - 0.2, 0.7);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 5; step += 1) {
        const f = step / 5;
        plot(craftU + side * (0.22 + f * 0.28), craftV + 0.1 + f * 0.28, 0.5);
      }
    }
    for (let step = 1; step <= 5 && burn > 0; step += 1) {
      const f = step / 5;
      plot(craftU, craftV + 0.2 + f * 0.35, burn * (1 - f * 0.7));
    }
  });
}

/* -- Dolphins: two arcs breaking the surface out of step ------------------ */

function paintDolphin(t: number): string {
  const waterV = 0.35;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, waterV + Math.sin(u * 2.4 + t * 2.6) * 0.07, 0.4);
    }
    for (let animal = 0; animal < 2; animal += 1) {
      const cycle = (t * 0.35 + animal * 0.45) % 1;
      const u = -ASPECT + 0.2 + cycle * (ASPECT * 2 - 0.4);
      /* Out of the water for the top of the sine, shallow under it for the rest. */
      const air = Math.sin(cycle * TAU - 0.4);
      const arc = air > 0 ? air : air * 0.25;
      for (let segment = 0; segment <= 7; segment += 1) {
        const f = segment / 7;
        /* Each segment reads the arc a little earlier, so the body curves. */
        const lagged = Math.sin((cycle - f * 0.019) * TAU - 0.4);
        const body = air > 0 ? Math.max(0, lagged) : arc;
        plot(u - f * 0.55, waterV - body * 0.75 + f * 0.12, 1 - f * 0.5);
      }
      plot(u + 0.12, waterV - arc * 0.75 - 0.08, 0.95);
      if (Math.abs(arc) < 0.18) {
        for (let drop = 0; drop < 4; drop += 1) {
          plot(u + (hash(drop * 3.1) - 0.5) * 0.6, waterV - hash(drop * 7.7) * 0.35, 0.6);
        }
      }
    }
  });
}

/* -- Slinky: a coil arching onto the step below --------------------------- */

function paintSlinky(t: number): string {
  const reach = (t * 0.55) % 1;
  const stair = Math.floor(t * 0.55) % 3;
  return paintPlotted((plot) => {
    for (let step = 0; step < 4; step += 1) {
      const u = -ASPECT + 0.2 + step;
      const v = -0.55 + step * 0.45;
      for (let cell = 0; cell <= 9; cell += 1) plot(u + cell / 9, v, 0.4);
      for (let cell = 0; cell <= 5; cell += 1) plot(u + 1, v + (cell / 5) * 0.45, 0.35);
    }
    /* The leading end reaches for the next step and the rest follows it over. */
    const baseU = -ASPECT + 0.2 + stair;
    const baseV = -0.62 + stair * 0.45;
    for (let ring = 0; ring <= 12; ring += 1) {
      const f = ring / 12;
      const along = f * reach;
      const u = baseU + 0.4 + along;
      const v = baseV + along * 0.45 - Math.sin(f * Math.PI) * reach * 0.55;
      plot(u, v, 0.55 + f * 0.4);
      plot(u, v + 0.16, 0.4);
    }
  });
}

/* -- Marble run: a ball working down a zigzag of ramps -------------------- */

function paintMarbleRun(t: number): string {
  const ramps = 4;
  const cycle = (t * 0.3) % 1;
  const leg = Math.min(ramps - 1, Math.floor(cycle * ramps));
  const along = cycle * ramps - leg;
  return paintPlotted((plot) => {
    for (let ramp = 0; ramp < ramps; ramp += 1) {
      const v = -0.75 + ramp * 0.5;
      /* Alternate ramps run the other way, so the ball switches back at each end. */
      const leftToRight = ramp % 2 === 0;
      for (let sample = 0; sample <= 34; sample += 1) {
        const f = sample / 34;
        plot(
          -ASPECT + 0.25 + (leftToRight ? f : 1 - f) * (ASPECT * 2 - 0.5),
          v + f * 0.22,
          0.45,
        );
      }
    }
    const u =
      -ASPECT + 0.25 + (leg % 2 === 0 ? along : 1 - along) * (ASPECT * 2 - 0.5);
    const v = -0.75 + leg * 0.5 + along * 0.22;
    plot(u, v - 0.14, 1);
    plot(u, v - 0.3, 0.5);
  });
}

/* -- Sundial: a shadow swinging with the sun ------------------------------ */

function paintSundial(t: number): string {
  const day = (t * 0.16) % 1;
  const angle = Math.PI + day * Math.PI;
  /* The shadow is longest early and late, shortest at noon. */
  const length = 0.55 + Math.abs(Math.cos(day * Math.PI)) * 0.9;
  return paintPlotted((plot) => {
    for (let mark = 0; mark <= 12; mark += 1) {
      const a = Math.PI + (mark / 12) * Math.PI;
      plot(Math.cos(a) * 1.35, 0.5 + Math.sin(a) * 0.95, mark % 3 === 0 ? 0.85 : 0.35);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.4 + (x / 30) * 2.8, 0.55, 0.3);
    for (let step = 0; step <= 8; step += 1) plot(0, 0.5 - (step / 8) * 0.5, 0.8);
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(Math.cos(angle) * length * f * 1.4, 0.5 + Math.sin(angle) * length * f, 0.95 - f * 0.55);
    }
  });
}

/* -- Hydraulic press: down fast, hold, then back up slowly ---------------- */

function paintHydraulicPress(t: number): string {
  const cycle = (t * 0.4) % 1;
  const ram =
    cycle < 0.45 ? Math.pow(cycle / 0.45, 1.4) : cycle < 0.6 ? 1 : 1 - (cycle - 0.6) / 0.4;
  const platen = -0.75 + ram * 0.95;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    if (v > 0.82) return 0.55;
    if (v < -0.85) return 0.5;
    if (Math.abs(Math.abs(u) - 1.5) < 0.09) return 0.45;
    if (Math.abs(v - platen) < 0.12 && Math.abs(u) < 1.25) return 0.95;
    if (Math.abs(u) < 0.14 && v < platen) return 0.7;
    /* The block keeps its volume: what it loses in height it gains in width. */
    if (v > 0.82 - (0.55 - ram * 0.4) && Math.abs(u) < 0.45 + ram * 0.5) return 0.35 + ram * 0.4;
    return 0.04;
  });
}

/* -- Anvil: a hammer on its arc, sparks only on the blow ------------------ */

function paintAnvil(t: number): string {
  const swing = Math.sin(t * 2.2);
  const strike = swing > 0.95;
  const angle = -1.5 - swing * 1.1;
  const pivotU = -0.9;
  const pivotV = -0.3;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 16; x += 1) plot(-0.2 + (x / 16) * 1.5, 0.3, 0.9);
    for (let step = 0; step <= 5; step += 1) plot(0.35 + step * 0.06, 0.3 + (step / 5) * 0.45, 0.5);
    for (let x = 0; x <= 12; x += 1) plot(0.1 + (x / 12) * 1, 0.9, 0.6);
    /* The work brightens under the blow and cools between them. */
    for (let x = 0; x <= 6; x += 1) plot(0.2 + (x / 6) * 0.5, 0.2, strike ? 1 : 0.55);
    for (let step = 0; step <= 12; step += 1) {
      const f = (step / 12) * 1.2;
      plot(pivotU + Math.cos(angle) * f, pivotV - Math.sin(angle) * f, 0.55);
    }
    plot(pivotU + Math.cos(angle) * 1.25, pivotV - Math.sin(angle) * 1.25, 1);
    if (strike) {
      for (let spark = 0; spark < 10; spark += 1) {
        const a = -0.3 - hash(spark * 4.1) * 2.4;
        const reach = 0.25 + hash(spark * 8.7) * 0.8;
        plot(0.45 + Math.cos(a) * reach, 0.2 + Math.sin(a) * reach, 0.85);
      }
    }
  });
}

/* -- Pump jack: a beam nodding over its well ------------------------------ */

function paintPumpJack(t: number): string {
  const crank = t * 1.3;
  const tilt = Math.sin(crank) * 0.32;
  const pivotU = 0.1;
  const pivotV = -0.35;
  const headU = pivotU + 1.3;
  const headV = pivotV + tilt * 1.3;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.92, 0.3);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 10; step += 1) {
        const f = step / 10;
        plot(pivotU + side * 0.35 * f, pivotV + f * (0.9 - pivotV), 0.45);
      }
    }
    /* The walking beam nods around the pivot, driven from the crank end. */
    for (let step = -12; step <= 12; step += 1) {
      const f = step / 12;
      plot(pivotU + f * 1.25, pivotV + f * tilt * 1.25, 0.65);
    }
    plot(headU, headV, 0.9);
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(headU, headV + 0.18 + f * (0.75 - tilt * 0.4), 0.7);
    }
    const crankU = pivotU - 1.2 + Math.cos(crank) * 0.3;
    const crankV = 0.45 + Math.sin(crank) * 0.3;
    plot(crankU, crankV, 1);
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(
        crankU + (pivotU - 1.25 - crankU) * f,
        crankV + (pivotV - tilt * 1.25 - crankV) * f,
        0.5,
      );
    }
  });
}

/* ========================================================================
   The fifth collection: sky and surface fields, then a yard of machines,
   rides, and small performances. Same contract as everything above.
   ===================================================================== */

/* -- Solar flare: loops standing off a limb that fills the bottom --------- */

const solarFlareField: Field = (u, v, t) => {
  /* The star sits below the frame, so only its limb and the loops above show. */
  const radius = Math.hypot(u, v + 1.9);
  const angle = Math.atan2(v + 1.9, u);
  const limb = clamp01((1.75 - radius) * 6);
  let loop = 0;
  for (let arch = 0; arch < 3; arch += 1) {
    const foot = -0.6 + arch * 0.6;
    const height = 1.85 + Math.pow(Math.sin(t * 0.5 + arch * 1.7) * 0.5 + 0.5, 2) * 0.9;
    loop = Math.max(
      loop,
      clamp01(1 - Math.abs(radius - height) * 7) *
        clamp01(1 - Math.abs(angle - (Math.PI / 2 + foot * 0.35)) * 2),
    );
  }
  return clamp01(limb * (0.5 + fbm(u * 3 + t * 0.4, v * 3, 2) * 0.55) + loop * 0.9);
};

/* -- Ice floes: plates carried past each other on dark water -------------- */

const iceFloeField: Field = (u, v, t) => {
  const span = ASPECT * 2 + 1.4;
  let ice = 0;
  for (let floe = 0; floe < 7; floe += 1) {
    const cu = -ASPECT - 0.7 + ((hash(floe * 3.7) * span + t * (0.1 + hash(floe) * 0.14)) % span);
    const cv = -0.75 + hash(floe * 9.1) * 1.5 + Math.sin(t * 0.7 + floe) * 0.06;
    const size = 0.3 + hash(floe * 5.3) * 0.35;
    const edge = 1 - Math.hypot((u - cu) / size, (v - cv) / (size * 0.62));
    if (edge > 0) ice = Math.max(ice, 0.45 + clamp01(edge * 3) * 0.5);
  }
  /* Chop on the open water between the plates. */
  return ice > 0 ? ice : 0.06 + Math.pow(Math.max(0, Math.sin(u * 4 - t * 1.6 + v * 2)), 6) * 0.16;
};

/* -- Reed bed: stems rooted still, tips carrying the gust ----------------- */

const reedBedField: Field = (u, v, t) => {
  if (v > 0.92) return 0.5;
  const gust = Math.sin(t * 0.9) * 0.32 + Math.sin(t * 2.1) * 0.1;
  let stem = 0.04;
  for (let reed = 0; reed < 13; reed += 1) {
    const root = -ASPECT + 0.12 + (reed / 12) * (ASPECT * 2 - 0.24);
    const tip = -0.9 + hash(reed * 2.9) * 0.7;
    if (v < tip) continue;
    const rise = clamp01((0.92 - v) / (0.92 - tip));
    /* Only the free end of a stem moves, so the bed bends instead of sliding. */
    const sway = rise * rise * (gust + (hash(reed * 7.3) - 0.5) * 0.25);
    stem = Math.max(stem, clamp01(1 - Math.abs(u - root - sway) * 9) * (0.35 + rise * 0.6));
  }
  return stem;
};

/* -- Radio static: snow with a hold bar rolling through it ---------------- */

const radioStaticField: Field = (u, v, t) => {
  const roll = ((v + 1) / 2 + t * 0.35) % 1;
  const bar = clamp01(1 - Math.abs(roll - 0.5) * 9);
  const frame = Math.floor(t * 12);
  const snow = hash2(Math.floor(u * 14) + frame * 3, Math.floor(v * 9) - frame);
  /* A ghost of a picture survives under the noise, clearest inside the bar. */
  const ghost = clamp01(0.5 - Math.abs(Math.sin(u * 1.6 + t * 0.4)) * 0.5) * 0.5;
  return clamp01(snow * (0.35 + bar * 0.55) + ghost + bar * 0.2);
};

/* -- Phosphor decay: one beam, and the trail it leaves behind ------------- */

const phosphorDecayField: Field = (u, v, t) => {
  let glow = 0.03;
  for (let back = 0; back < 24; back += 1) {
    const past = t - back * 0.035;
    const bu = Math.sin(past * 2.3) * ASPECT * 0.85;
    const bv = Math.sin(past * 3.1 + 0.7) * 0.8;
    /* The oldest samples are dimmest, which is what makes it read as decay. */
    glow = Math.max(
      glow,
      clamp01(1 - Math.hypot(u - bu, (v - bv) * 0.6) / 0.3) * (1 - back / 24),
    );
  }
  return glow;
};

/* -- Bubble chamber: charged tracks curling away from one vertex ---------- */

const bubbleChamberField: Field = (u, v, t) => {
  const burst = Math.floor(t / 3.4);
  const age = t - burst * 3.4;
  let track = Math.hypot(u, v) < 0.14 ? 0.5 : 0.03;
  for (let particle = 0; particle < 5; particle += 1) {
    const heading = hash(burst * 5.9 + particle * 1.7) * TAU;
    const signed = hash(burst * 3.3 + particle * 2.9) - 0.5;
    const radius = 0.35 + Math.abs(signed) * 2.2;
    const side = signed > 0 ? 1 : -1;
    /* Every track is an arc of one circle through the vertex. */
    const cu = -Math.sin(heading) * radius * side;
    const cv = Math.cos(heading) * radius * side;
    const swept =
      (((Math.atan2(v - cv, u - cu) - Math.atan2(-cv, -cu)) * side + TAU * 2) % TAU) * radius;
    if (swept > age * 1.5) continue;
    track = Math.max(
      track,
      clamp01(1 - Math.abs(Math.hypot(u - cu, v - cv) - radius) * 8) * clamp01(1.1 - swept * 0.28),
    );
  }
  return track;
};

/* -- Sunspots: granulation with dark umbrae crossing it ------------------- */

const sunspotField: Field = (u, v, t) => {
  let bright = 0.45 + fbm(u * 4 + t * 0.15, v * 4 - t * 0.1, 3) * 0.55;
  for (let spot = 0; spot < 3; spot += 1) {
    const cu = (((hash(spot * 4.3) + t * 0.05) % 1.6) - 0.8) * ASPECT * 1.3;
    const cv = (hash(spot * 8.7) - 0.5) * 1.4;
    const size = 0.22 + hash(spot * 2.1) * 0.2;
    /* An umbra subtracts rather than adds, so the grain survives around it. */
    bright *= 1 - clamp01(1 - Math.hypot(u - cu, (v - cv) * 0.7) / size) * 0.95;
  }
  return clamp01(bright);
};

/* -- Star trails: arcs turning about an off-centre pole ------------------- */

const starTrailField: Field = (u, v, t) => {
  const pu = -ASPECT * 0.55;
  const pv = -0.55;
  const radius = Math.hypot(u - pu, v - pv);
  const angle = Math.atan2(v - pv, u - pu);
  let trail = 0.03;
  for (let star = 0; star < 12; star += 1) {
    const ring = 0.25 + hash(star * 3.1) * 2.1;
    if (Math.abs(radius - ring) > 0.1) continue;
    /* The arc behind each star fades with age; its head stays bright. */
    const behind = (hash(star * 6.7) * TAU + t * 0.35 - angle + TAU * 2) % TAU;
    trail = Math.max(
      trail,
      clamp01(1 - Math.abs(radius - ring) * 11) * (0.12 + clamp01(1 - behind / 2.2) * 0.85),
    );
  }
  return trail;
};

/* -- Glacier: crevasses bowed downstream by the faster mid-channel ice ---- */

const glacierField: Field = (u, v, t) => {
  const lag = (1 - v * v) * 0.55;
  const along = u / ASPECT + t * 0.12 + lag;
  const crevasse = Math.pow(Math.abs(Math.sin(along * 6.5)), 0.35);
  const wall = clamp01((Math.abs(v) - 0.72) * 5);
  return clamp01(0.2 + (1 - crevasse) * 0.85 * (1 - wall) + wall * 0.28);
};

/* -- Murmuration: a flock riding two loops, each bird offset along them --- */

const murmurationField: Field = (u, v, t) => {
  let birds = 0.02;
  for (let bird = 0; bird < 16; bird += 1) {
    const phase = bird * 0.39;
    const cu = Math.sin(t * 0.9 + phase) * ASPECT * 0.7 + Math.sin(t * 2.3 + phase * 2) * 0.35;
    const cv = Math.cos(t * 0.7 + phase * 1.3) * 0.6 + Math.sin(t * 1.9 + phase) * 0.18;
    birds = Math.max(
      birds,
      clamp01(1 - Math.hypot(u - cu, (v - cv) * 0.55) / 0.26) * (0.5 + hash(bird) * 0.5),
    );
  }
  return birds;
};

/* -- Chladni plate: sand collecting on the nodal lines -------------------- */

const chladniField: Field = (u, v, t) => {
  /* Sweeping the drive walks the plate between modes instead of snapping. */
  const drive = 1.2 + (Math.sin(t * 0.22) * 0.5 + 0.5) * 1.6;
  const other = drive * 0.62 + 1;
  const x = (u / ASPECT + 1) / 2;
  const y = (v + 1) / 2;
  const mode =
    Math.sin(drive * Math.PI * x) * Math.sin(other * Math.PI * y) -
    Math.sin(other * Math.PI * x) * Math.sin(drive * Math.PI * y);
  const shake = 4 + Math.abs(Math.sin(t * 1.3)) * 4;
  return clamp01(1 - Math.abs(mode) * shake) * 0.95 + 0.04;
};

/* -- Target waves: sharp fronts and long recoveries, from three pacemakers - */

const targetWaveField: Field = (u, v, t) => {
  let wave = 0.05;
  for (let source = 0; source < 3; source += 1) {
    const su = (hash(source * 3.1) * 2 - 1) * ASPECT * 0.8;
    const sv = (hash(source * 7.9) * 2 - 1) * 0.7;
    const phase = Math.hypot(u - su, v - sv) * 5.5 - t * (2 + source * 0.4);
    wave = Math.max(wave, Math.pow(clamp01(Math.sin(phase)), 4));
  }
  return wave;
};

/* -- Sunbeams: rays fanning out under a canopy --------------------------- */

const sunbeamField: Field = (u, v, t) => {
  if (v < -0.62) return clamp01(0.35 + fbm(u * 3.4, v * 4 + t * 0.1, 2) * 0.6);
  const angle = Math.atan2(v + 1.4, u - Math.sin(t * 0.25) * ASPECT * 0.5);
  const ray = Math.pow(Math.max(0, Math.sin(angle * 9 + fbm(angle * 3 + t * 0.3, 1.4, 2) * 2)), 3);
  /* Beams widen and fade as they fall away from the gaps in the leaves. */
  return clamp01(ray * clamp01((v + 1.2) / 2) * 0.75 + 0.04);
};

/* -- Dust devil: a column narrow at the ground, flaring as it climbs ------ */

const dustDevilField: Field = (u, v, t) => {
  const climb = clamp01((0.95 - v) / 1.9);
  const width = 0.12 + climb * climb * 0.5;
  const offset = Math.sin(t * 0.35) * ASPECT * 0.5 + Math.sin(climb * 3 + t * 1.1) * 0.2;
  const inside = clamp01(1 - Math.abs(u - offset) / width);
  const grit = hash2(Math.floor((u - offset) * 9), Math.floor(v * 9 - t * 6)) > 0.42 ? 1 : 0.35;
  return clamp01((v > 0.86 ? 0.32 : 0) + inside * grit * (0.35 + climb * 0.6) + 0.03);
};

/* -- Honey: beads necking off a thinning thread -------------------------- */

const honeyDripField: Field = (u, v, t) => {
  const surface = -0.72;
  if (v < surface) return clamp01(0.35 + Math.sin(u * 5 + t * 0.6) * 0.12);
  let honey = 0.03;
  for (let drip = 0; drip < 4; drip += 1) {
    const du = -ASPECT * 0.75 + drip * ASPECT * 0.5;
    const cycle = (t * (0.3 + hash(drip * 2.7) * 0.2) + hash(drip * 5.1)) % 1;
    const head = surface + cycle * cycle * 2.1;
    /* The thread thins as the bead falls, until it is not drawn at all. */
    const thread = v < head ? clamp01(1 - (head - v) * (0.7 + cycle * 3)) : 0;
    const bead = clamp01(1 - Math.hypot((u - du) / 0.22, (v - head) / 0.18));
    honey = Math.max(honey, Math.max(clamp01(1 - Math.abs(u - du) * 14) * thread * 0.8, bead));
  }
  return honey;
};

/* -- Slime mould: a fixed vein network with nutrient pulses running it ---- */

const slimeMouldField: Field = (u, v, t) => {
  const veins = Math.abs(fbm(u * 1.9 + 4, v * 1.9 - 2, 4) - 0.5);
  const flow = Math.sin(u * 3.1 + v * 2.2 - t * 2.6) * 0.5 + 0.5;
  return clamp01(clamp01(1 - veins * 9) * (0.3 + flow * 0.7) + 0.04);
};

/* -- Plasma globe: tendrils wandering from the core to the glass ---------- */

const plasmaGlobeField: Field = (u, v, t) => {
  const radius = Math.hypot(u, v);
  if (radius > 0.98) return 0.04;
  const angle = Math.atan2(v, u);
  let arc = 0;
  for (let tendril = 0; tendril < 5; tendril += 1) {
    const aim = tendril * (TAU / 5) + Math.sin(t * 0.6 + tendril * 2.1) * 0.5;
    const wobble = Math.sin(radius * 7 + t * 5 + tendril) * 0.16 * radius;
    /* Wrap the angle difference so a tendril can cross the seam at pi. */
    const delta = Math.atan2(Math.sin(angle - aim - wobble), Math.cos(angle - aim - wobble));
    arc = Math.max(arc, clamp01(1 - Math.abs(delta) * (5 + radius * 9)));
  }
  const glass = clamp01(1 - Math.abs(radius - 0.95) * 22) * 0.35;
  return clamp01(clamp01(1 - radius * 5) + arc * (0.3 + radius * 0.7) * 0.9 + glass + 0.04);
};

/* -- Tree rings: a new ring laid at the bark each season ------------------ */

const treeRingField: Field = (u, v, t) => {
  const radius = Math.hypot(u * 0.85, v);
  const ring = Math.pow(Math.abs(Math.sin(radius * 7 - t * 0.7)), 0.5);
  return clamp01((radius > 1.1 ? 0.7 : 0) + (1 - ring) * 0.85 + fbm(u * 2.6, v * 2.6, 2) * 0.2);
};

/* -- Wind turbines: two towers, each on its own rate -------------------- */

function paintWindTurbine(t: number): string {
  const towers = [
    [-1, -0.25, 0.75, 1.7],
    [0.95, 0.1, 0.55, 2.3],
  ] as const;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.95, 0.28);
    for (const [baseU, hubV, size, rate] of towers) {
      for (let step = 0; step <= 16; step += 1) {
        plot(baseU, hubV + (step / 16) * (0.95 - hubV), 0.4);
      }
      for (let blade = 0; blade < 3; blade += 1) {
        const angle = t * rate + (blade / 3) * TAU;
        for (let step = 1; step <= 12; step += 1) {
          const reach = (step / 12) * size;
          /* Blades foreshorten as they swing past the tower. */
          plot(baseU + Math.cos(angle) * reach * 0.85, hubV + Math.sin(angle) * reach, 0.3 + reach);
        }
      }
      plot(baseU, hubV, 1);
    }
  });
}

/* -- Pile driver: winch up, drop, and the pile takes another bite -------- */

function paintPileDriver(t: number): string {
  const cycle = (t * 0.5) % 1;
  const pileTop = -0.15 + (Math.floor(t * 0.5) % 6) * 0.1;
  const hammer =
    cycle < 0.7
      ? pileTop - 0.25 - (cycle / 0.7) * 0.85
      : cycle < 0.82
        ? pileTop - 1.1 + ((cycle - 0.7) / 0.12) * 0.85
        : pileTop - 0.25;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.62, 0.3);
    for (let step = 0; step <= 20; step += 1) {
      const v = -1 + (step / 20) * 1.6;
      plot(-0.32, v, 0.45);
      plot(0.32, v, 0.45);
    }
    for (let step = 0; step <= 14; step += 1) plot(-0.32 + (step / 14) * 0.64, -1, 0.5);
    for (let cell = -2; cell <= 2; cell += 1) {
      for (let row = 0; row <= 3; row += 1) plot(cell * 0.11, hammer + row * 0.09, 0.95);
    }
    for (let step = 0; step <= 12; step += 1) {
      plot(0, pileTop + (step / 12) * (0.95 - pileTop), 0.7);
    }
    /* Spoil thrown up for the moment after the blow lands. */
    if (cycle > 0.78 && cycle < 0.9) {
      for (let shard = 0; shard < 6; shard += 1) {
        plot((hash(shard) - 0.5) * 1.2, pileTop - 0.1 - hash(shard * 3.3) * 0.2, 0.8);
      }
    }
  });
}

/* -- Cuckoo clock: hands, pendulum, and a bird on the hour --------------- */

function paintCuckooClock(t: number): string {
  const swing = Math.sin(t * 3) * 0.55;
  const call = t % 6;
  const out = call < 1.2 ? Math.sin((call / 1.2) * Math.PI) : 0;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(-1 + f, -0.95 + f * 0.35, 0.5);
      plot(1 - f, -0.95 + f * 0.35, 0.5);
    }
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(-0.95 + f * 1.9, -0.6, 0.45);
      plot(-0.95 + f * 1.9, 0.45, 0.45);
      plot(-0.95, -0.6 + f * 1.05, 0.45);
      plot(0.95, -0.6 + f * 1.05, 0.45);
    }
    for (let sample = 0; sample <= 40; sample += 1) {
      const angle = (sample / 40) * TAU;
      plot(Math.cos(angle) * 0.42, -0.1 + Math.sin(angle) * 0.42, 0.55);
    }
    /* Minute hand runs, hour hand crawls. */
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(Math.cos(t * 0.9) * 0.3 * f, -0.1 + Math.sin(t * 0.9) * 0.3 * f, 0.8);
      plot(Math.cos(t * 0.12) * 0.36 * f, -0.1 + Math.sin(t * 0.12) * 0.36 * f, 0.6);
    }
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(Math.sin(swing) * 0.7 * f, 0.45 + Math.cos(swing) * 0.45 * f, 0.4);
    }
    plot(Math.sin(swing) * 0.7, 0.45 + Math.cos(swing) * 0.45, 1);
    if (out > 0.01) {
      plot(-0.1 + out * 0.7, -0.75, 1);
      plot(0.02 + out * 0.7, -0.8, 0.8);
    }
  });
}

/* -- Rowboat: catch, drive, feather, and the hull surges with it ---------- */

function paintRowboat(t: number): string {
  const stroke = t * 1.4;
  const hullU = Math.sin(t * 0.25) * 0.5 + Math.sin(stroke) * 0.06;
  const bob = Math.sin(t * 1.1) * 0.06;
  const reach = Math.sin(stroke) * 0.5;
  const lift = Math.max(0, Math.cos(stroke)) * 0.12;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.55 + Math.sin(u * 3 - t * 1.8) * 0.08, 0.3);
    }
    for (let step = 0; step <= 24; step += 1) {
      const f = step / 24;
      plot(hullU - 0.75 + f * 1.5, 0.44 + bob + (1 - Math.pow(f * 2 - 1, 2)) * 0.14, 0.85);
    }
    plot(hullU, 0.3 + bob, 1);
    plot(hullU, 0.18 + bob, 0.7);
    /* Blades bite on the drive and ride clear of the water on the recovery. */
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 10; step += 1) {
        const f = step / 10;
        plot(hullU + reach * f * 1.4 - side * 0.05, 0.28 + bob + f * (0.24 - lift), 0.55);
      }
      plot(hullU + reach * 1.4 - side * 0.05, 0.52 + bob - lift, 0.95);
    }
  });
}

/* -- Cable car: a cabin working a sagging span over a ridge --------------- */

const cableCarSag = (u: number): number => -0.78 + (1 - Math.pow(u / ASPECT, 2)) * 0.42;

function paintCableCar(t: number): string {
  const carU = -ASPECT + 0.25 + ((t * 0.11) % 1) * (ASPECT * 2 - 0.5);
  const carV = cableCarSag(carU);
  const swing = Math.sin(t * 1.3) * 0.13;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      /* Ridgeline below, so the cabin reads as hanging over a drop. */
      plot(u, 0.55 + Math.sin(u * 1.4 + 2) * 0.28 + Math.sin(u * 3.7) * 0.08, 0.3);
      plot(u, cableCarSag(u), 0.45);
    }
    for (const towerU of [-ASPECT + 0.25, ASPECT - 0.25]) {
      for (let step = 0; step <= 14; step += 1) {
        plot(towerU, cableCarSag(towerU) + (step / 14) * 1.2, 0.5);
      }
    }
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(carU + swing * f, carV + f * 0.28, 0.6);
    }
    for (let row = 0; row <= 3; row += 1) {
      for (let cell = -3; cell <= 3; cell += 1) {
        const shell = row === 0 || row === 3 || Math.abs(cell) === 3;
        plot(carU + swing + cell * 0.09, carV + 0.3 + row * 0.09, shell ? 0.95 : 0.45);
      }
    }
  });
}

/* -- Tractor: broken ground behind the plough, smooth ahead of it --------- */

function paintTractor(t: number): string {
  const bodyU = -ASPECT + 0.4 + ((t * 0.2) % 1) * (ASPECT * 2 - 0.8);
  const base = 0.5 + Math.sin(t * 6) * 0.03;
  const wheels = [
    [bodyU - 0.32, 0.26, 1.6],
    [bodyU + 0.28, 0.15, 2.8],
  ] as const;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      const turned = u < bodyU - 0.6;
      plot(u, 0.72, turned ? 0.85 + hash2(Math.floor(u * 9), 3) * 0.15 : 0.3);
    }
    for (let cell = -4; cell <= 2; cell += 1) plot(bodyU + cell * 0.1, base - 0.18, 0.9);
    for (let cell = -2; cell <= 2; cell += 1) plot(bodyU + 0.1 + cell * 0.07, base - 0.34, 0.7);
    for (const [wheelU, radius, rate] of wheels) {
      for (let sample = 0; sample <= 26; sample += 1) {
        const angle = (sample / 26) * TAU;
        plot(wheelU + Math.cos(angle) * radius, base + Math.sin(angle) * radius, 0.75);
      }
      for (let spoke = 0; spoke < 4; spoke += 1) {
        const angle = t * rate + (spoke / 4) * Math.PI;
        for (let step = 0; step <= 5; step += 1) {
          const f = (step / 5) * radius;
          plot(wheelU + Math.cos(angle) * f, base + Math.sin(angle) * f, 0.5);
        }
      }
    }
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(bodyU - 0.55 - f * 0.25, base - 0.05 + f * 0.3, 0.6);
    }
  });
}

/* -- Excavator: dig, curl, swing, dump, one load a cycle ------------------ */

function paintExcavator(t: number): string {
  const cycle = (t * 0.32) % 1;
  const boomAngle = -0.95 + Math.sin(cycle * TAU) * 0.45;
  const stickAngle = boomAngle + 1.5 + Math.cos(cycle * TAU) * 0.5;
  const pivotU = -0.5;
  const pivotV = 0.3;
  const elbowU = pivotU + Math.cos(boomAngle) * 0.95;
  const elbowV = pivotV + Math.sin(boomAngle) * 0.95;
  const bucketU = elbowU + Math.cos(stickAngle) * 0.75;
  const bucketV = elbowV + Math.sin(stickAngle) * 0.75;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.85, 0.3);
    for (let cell = -6; cell <= 2; cell += 1) plot(pivotU + cell * 0.1, 0.72, 0.8);
    for (let cell = -5; cell <= 1; cell += 1) plot(pivotU + cell * 0.1, 0.5, 0.6);
    for (let row = 0; row <= 2; row += 1) {
      for (let cell = -4; cell <= -1; cell += 1) plot(pivotU + cell * 0.1, 0.2 + row * 0.12, 0.55);
    }
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(pivotU + (elbowU - pivotU) * f, pivotV + (elbowV - pivotV) * f, 0.7);
      plot(elbowU + (bucketU - elbowU) * f, elbowV + (bucketV - elbowV) * f, 0.75);
    }
    for (let tooth = -2; tooth <= 2; tooth += 1) plot(bucketU + tooth * 0.08, bucketV + 0.1, 1);
    /* Spoil falls only once the bucket has cleared the trench. */
    if (cycle > 0.55 && cycle < 0.8) {
      for (let grain = 0; grain < 5; grain += 1) {
        plot(bucketU + (hash(grain) - 0.5) * 0.3, bucketV + 0.2 + hash(grain * 3.1) * 0.5, 0.7);
      }
    }
  });
}

/* -- Cement mixer: a helix band wrapping the turning drum ----------------- */

function paintCementMixer(t: number): string {
  const spin = t * 1.9;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.9, 0.3);
    for (let sample = 0; sample <= 60; sample += 1) {
      const angle = (sample / 60) * TAU;
      plot(-0.1 + Math.cos(angle) * 0.85, -0.05 + Math.sin(angle) * 0.6, 0.45);
    }
    for (let sample = 0; sample <= 70; sample += 1) {
      const f = sample / 70;
      const u = -0.9 + f * 1.6;
      /* The band's depth decides its brightness, which is what shows the spin. */
      const depth = (Math.cos(f * 9 - spin) + 1) / 2;
      const across = Math.sqrt(Math.max(0, 1 - Math.pow((u + 0.1) / 0.85, 2)));
      plot(u, -0.05 + Math.sin(f * 9 - spin) * 0.55 * across, 0.25 + depth * 0.75);
    }
    for (let cell = -8; cell <= 8; cell += 1) plot(-0.1 + cell * 0.11, 0.62, 0.6);
    for (const wheelU of [-0.8, 0, 0.75]) {
      for (let sample = 0; sample <= 18; sample += 1) {
        const angle = (sample / 18) * TAU;
        plot(wheelU + Math.cos(angle) * 0.17, 0.78 + Math.sin(angle) * 0.17, 0.7);
      }
      for (let step = 0; step <= 4; step += 1) {
        const f = (step / 4) * 0.17;
        plot(wheelU + Math.cos(t * 2.4) * f, 0.78 + Math.sin(t * 2.4) * f, 0.5);
      }
    }
  });
}

/* -- Printing press: sheets leaving the cylinder with ink on them --------- */

function paintPrintingPress(t: number): string {
  const roll = t * 2.2;
  const feed = (t * 0.5) % 1;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    const drum = Math.hypot(u, v + 0.45);
    if (drum < 0.55) {
      if (Math.abs(drum - 0.5) < 0.08) return 0.9;
      /* Plate marks on the cylinder carry the rotation. */
      return 0.25 + (Math.sin(Math.atan2(v + 0.45, u) * 5 + roll) * 0.5 + 0.5) * 0.55;
    }
    if (v > 0.25 && v < 0.5) {
      const sheet = (u / ASPECT + 1) / 2 + feed;
      if (sheet % 0.45 >= 0.4) return 0.05;
      return hash2(Math.floor(u * 8 - feed * 20), Math.floor(v * 20)) > 0.55 ? 0.85 : 0.3;
    }
    if (v >= 0.5 && v < 0.62) return 0.5;
    return v > 0.82 ? 0.35 : 0.05;
  });
}

/* -- Pen plotter: ink laid down only as far as the pen has travelled ------ */

function paintPenPlotter(t: number): string {
  const draw = (t * 0.35) % 1;
  const path = (f: number): readonly [number, number] => {
    const angle = f * TAU * 2;
    return [Math.cos(angle) * (0.35 + f * 0.75), Math.sin(angle) * (0.25 + f * 0.5)];
  };
  const [penU, penV] = path(draw);
  return paintPlotted((plot) => {
    for (let step = 0; step <= 90; step += 1) {
      const [u, v] = path((step / 90) * draw);
      plot(u, v, 0.55);
    }
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, -0.92, 0.4);
    for (let step = 0; step <= 12; step += 1) {
      plot(penU, -0.92 + (step / 12) * (penV + 0.92), 0.35);
    }
    for (let cell = -2; cell <= 2; cell += 1) plot(penU + cell * 0.08, -0.92, 0.9);
    plot(penU, penV, 1);
  });
}

/* -- Turntable: grooves turning under an arm creeping inward -------------- */

function paintTurntable(t: number): string {
  const spin = t * 2.6;
  const inward = (t * 0.06) % 1;
  const stylusRadius = 0.82 - inward * 0.6;
  const stylusU = Math.cos(0.5) * stylusRadius;
  const stylusV = Math.sin(0.5) * stylusRadius * 0.85;
  const pivotU = ASPECT - 0.3;
  const pivotV = -0.55;
  return paintPlotted((plot) => {
    for (let ring = 1; ring <= 5; ring += 1) {
      const radius = 0.16 * ring;
      for (let sample = 0; sample <= 50; sample += 1) {
        const angle = (sample / 50) * TAU + spin;
        /* One bright mark per groove makes the platter's rotation visible. */
        const mark = Math.pow(Math.max(0, Math.cos(angle + ring)), 8);
        plot(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.85, 0.28 + mark * 0.7);
      }
    }
    for (let step = 0; step <= 18; step += 1) {
      const f = step / 18;
      plot(pivotU + (stylusU - pivotU) * f, pivotV + (stylusV - pivotV) * f, 0.6);
    }
    plot(stylusU, stylusV, 1);
  });
}

/* -- Cassette: one hub emptying into the other, spokes tracking the pack -- */

function paintCassetteReels(t: number): string {
  const play = (t * 0.05) % 1;
  const hubs = [
    [-0.7, 0.42 - play * 0.24],
    [0.7, 0.18 + play * 0.24],
  ] as const;
  return paintPlotted((plot) => {
    for (let cell = 0; cell <= 40; cell += 1) {
      const u = -ASPECT + 0.15 + (cell / 40) * (ASPECT * 2 - 0.3);
      plot(u, -0.85, 0.4);
      plot(u, 0.85, 0.4);
    }
    for (const [hubU, radius] of hubs) {
      for (let sample = 0; sample <= 40; sample += 1) {
        const angle = (sample / 40) * TAU;
        plot(hubU + Math.cos(angle) * radius, Math.sin(angle) * radius, 0.55);
      }
      /* A hub turns faster as its pack of tape gets smaller. */
      for (let spoke = 0; spoke < 3; spoke += 1) {
        const angle = t / Math.max(0.2, radius) + (spoke / 3) * TAU;
        for (let step = 0; step <= 6; step += 1) {
          const f = (step / 6) * radius;
          plot(hubU + Math.cos(angle) * f, Math.sin(angle) * f, 0.75);
        }
      }
    }
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(-0.7 + f * 1.4, 0.55 + Math.sin(f * Math.PI) * 0.08, 0.85);
    }
    for (let step = 0; step <= 4; step += 1) plot(0, 0.62 + (step / 4) * 0.2, 0.9);
  });
}

/* -- Film projector: a chopped beam widening to a screen ------------------ */

function paintFilmProjector(t: number): string {
  const frame = Math.floor(t * 8);
  const gate = Math.abs(Math.sin(t * 8 * Math.PI));
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    if (u < -1.1) return Math.abs(v) < 0.45 ? 0.55 : 0.06;
    if (u > 1.15) {
      if (Math.abs(v) > 0.75) return 0.08;
      return clamp01(0.35 + hash2(Math.floor(u * 6) + frame, Math.floor(v * 6)) * 0.6);
    }
    const spread = 0.18 + ((u + 1.1) / 2.25) * 0.6;
    if (Math.abs(v) > spread) return 0.05;
    /* The shutter chops the beam, which is what makes it read as film. */
    return clamp01(0.3 + (1 - Math.abs(v) / spread) * 0.5 * (0.45 + gate * 0.55));
  });
}

/* -- Loom: the shed opening and closing around a crossing shuttle --------- */

function paintLoom(t: number): string {
  const pass = (t * 0.5) % 1;
  const shuttleU = pass < 0.5 ? -1.35 + pass * 5.4 : 1.35 - (pass - 0.5) * 5.4;
  const shed = Math.cos(pass * TAU * 2) * 0.18;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    /* Cloth already woven collects at the bottom. */
    if (v > 0.45) {
      return (Math.floor((v - 0.45) * 12) + Math.floor((u + ASPECT) * 5)) % 2 === 0 ? 0.85 : 0.35;
    }
    if (Math.abs(v - 0.3) < 0.06 && Math.abs(u - shuttleU) < 0.28) return 1;
    /* Alternate warp threads lift, which is what opens the shed. */
    const thread = Math.round((u + ASPECT) / 0.19);
    const threadU = thread * 0.19 - ASPECT + (thread % 2 === 0 ? shed : -shed);
    return v < 0.25 && Math.abs(u - threadU) < 0.05 ? 0.75 : 0.06;
  });
}

/* -- Potter's wheel: a profile pulled up while the rings run past --------- */

function paintPotterWheel(t: number): string {
  const spin = t * 4;
  const pull = 0.7 + Math.sin(t * 0.5) * 0.25;
  return paintPlotted((plot) => {
    for (let cell = -7; cell <= 7; cell += 1) plot(cell * 0.13, 0.68, 0.5);
    for (let step = 0; step <= 6; step += 1) plot(0, 0.7 + (step / 6) * 0.25, 0.4);
    for (let row = 0; row <= 26; row += 1) {
      const v = 0.62 - (row / 26) * 1.3;
      const rise = clamp01((0.62 - v) / 1.3);
      /* Belly low, neck high; the hands keep changing where the belly sits. */
      const radius = 0.15 + Math.sin(rise * Math.PI * pull) * 0.55 * (0.5 + rise * 0.6);
      for (let sample = 0; sample <= 24; sample += 1) {
        const angle = (sample / 24) * TAU + spin;
        plot(Math.cos(angle) * radius, v, 0.2 + ((Math.cos(angle) + 1) / 2) * 0.6);
      }
      plot(-radius, v, 0.95);
      plot(radius, v, 0.95);
    }
  });
}

/* -- Water clock: the upper bowl emptying a drop at a time ---------------- */

function paintWaterClock(t: number): string {
  const fill = (t * 0.12) % 1;
  const drop = -0.15 + ((t * 1.6) % 1) * 0.9;
  const lowerTop = 0.85 - fill * 0.75;
  return paintGrid((x, y) => {
    const u = fieldU(x);
    const v = fieldV(y);
    if (v < -0.15) {
      const bowl = 0.9 - Math.max(0, v + 0.95) * 0.25;
      if (Math.abs(Math.abs(u) - bowl) < 0.08) return 0.8;
      if (Math.abs(u) < bowl) return v > -0.9 + fill * 0.65 ? 0.55 : 0.05;
      return 0.04;
    }
    if (v > 0.1) {
      if (Math.abs(Math.abs(u) - 0.8) < 0.07) return 0.8;
      if (Math.abs(u) < 0.78) {
        if (v <= lowerTop) return 0.05;
        /* A brighter line at the surface, so the level is easy to read. */
        return v - lowerTop < 0.1 ? 0.95 : 0.5;
      }
    }
    if (Math.abs(u) < 0.07 && Math.abs(v - drop) < 0.09 && drop < lowerTop) return 1;
    return 0.04;
  });
}

/* -- Pinball: bumpers lighting as the ball works the playfield ------------ */

const PINBALL_BUMPERS: ReadonlyArray<readonly [number, number]> = [
  [-0.75, -0.35],
  [0.05, -0.62],
  [0.8, -0.3],
];

function paintPinball(t: number): string {
  const ballU = Math.sin(t * 1.7) * 1.15 + Math.sin(t * 3.1) * 0.2;
  const ballV = -0.65 + Math.abs(Math.sin(t * 1.15)) * 1.35;
  const flip = Math.max(0, Math.sin(t * 4)) * 0.5;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 22; step += 1) {
      const v = -0.95 + (step / 22) * 1.9;
      plot(-1.45, v, 0.4);
      plot(1.45, v, 0.4);
    }
    for (const [bumperU, bumperV] of PINBALL_BUMPERS) {
      /* A bumper only lights while the ball is on it. */
      const hit = clamp01(1 - Math.hypot(ballU - bumperU, ballV - bumperV) / 0.4);
      for (let sample = 0; sample <= 20; sample += 1) {
        const angle = (sample / 20) * TAU;
        plot(bumperU + Math.cos(angle) * 0.22, bumperV + Math.sin(angle) * 0.22, 0.35 + hit * 0.65);
      }
    }
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(side * (0.9 - f * 0.55), 0.8 - f * flip, 0.8);
      }
    }
    plot(ballU, ballV, 1);
    plot(ballU, ballV - 0.16, 0.5);
  });
}

/* -- Pool break: a rack scattering along the lines out of the cue ball ---- */

function paintPoolBreak(t: number): string {
  const cycle = t % 5.2;
  const rackU = 0.5;
  const ease = 1 - Math.pow(1 - clamp01((cycle - 1.4) / 2.8), 2);
  const cueU = cycle < 1.4 ? -1.35 + (cycle / 1.4) * 1.4 : rackU - 0.55 - ease * 0.55;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, -0.92, 0.35);
      plot(u, 0.92, 0.35);
    }
    for (let ball = 0; ball < 10; ball += 1) {
      const row = Math.floor((Math.sqrt(8 * ball + 1) - 1) / 2);
      const homeU = rackU + row * 0.2;
      const homeV = (ball - (row * (row + 1)) / 2 - row / 2) * 0.28;
      /* Each ball leaves along the line from the cue ball through where it sat. */
      const angle = Math.atan2(homeV, homeU + 0.9) + (hash(ball * 3.7) - 0.5) * 0.5;
      plot(
        homeU + Math.cos(angle) * ease * (0.7 + hash(ball) * 0.9),
        homeV + Math.sin(angle) * ease * (0.7 + hash(ball * 2.3) * 0.9),
        0.9,
      );
    }
    plot(cueU, 0, 1);
    plot(cueU - 0.14, 0, 0.5);
  });
}

/* -- Ski jump: inrun, take-off, and a long flight down the hill ----------- */

function paintSkiJump(t: number): string {
  const cycle = (t * 0.32) % 1;
  const inrun = Math.min(1, cycle / 0.42);
  const flight = clamp01((cycle - 0.42) / 0.58);
  const rampU = -ASPECT + 0.2 + inrun * 1.5;
  const rampV = -0.75 + Math.pow(inrun, 1.7) * 0.85;
  const jumperU = rampU + flight * 1.6;
  const jumperV = rampV - Math.sin(flight * 2.2) * 0.55 + flight * flight * 1.1;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 40; step += 1) {
      const f = step / 40;
      plot(-ASPECT + 0.2 + f * 1.5, -0.75 + Math.pow(f, 1.7) * 0.85, 0.5);
      plot(-ASPECT + 1.7 + f * (ASPECT * 2 - 1.9), 0.1 + f * 0.75, 0.35);
    }
    plot(jumperU, jumperV, 1);
    plot(jumperU - 0.12, jumperV + 0.06, 0.7);
    /* Skis flatten out of the tuck once the jumper is in the air. */
    for (let step = 0; step <= 6; step += 1) {
      const f = (step / 6) * 0.35;
      plot(jumperU + f, jumperV + 0.1 - f * (cycle < 0.42 ? 0.4 : 0.25), 0.8);
    }
  });
}

/* -- Surfer: a wave steepening ahead of the crest, rider on the face ------ */

function paintSurfer(t: number): string {
  const crest = ASPECT - ((t * 0.35) % 1.6) * (ASPECT * 1.4);
  /* Long shoulder behind the crest, steep face in front of it. */
  const faceAt = (u: number): number => {
    const rise = u < crest ? clamp01(1 - (crest - u) / 2.2) : clamp01(1 - (u - crest) / 0.7);
    return 0.75 - Math.pow(rise, 2.2) * 1.5;
  };
  return paintPlotted((plot) => {
    for (let x = 0; x <= 60; x += 1) {
      const u = -ASPECT + (x / 60) * ASPECT * 2;
      plot(u, faceAt(u), 0.55);
      plot(u, 0.9, 0.3);
      if (u > crest - 0.2 && u < crest + 0.55) {
        /* The lip throwing forward over the face. */
        plot(u, faceAt(u) - 0.12 - Math.sin((u - crest + 0.2) * 4) * 0.15, 0.95);
      }
    }
    const riderU = crest - 0.55;
    const riderV = faceAt(riderU);
    for (let step = 0; step <= 5; step += 1) {
      plot(riderU - 0.12 + (step / 5) * 0.34, riderV - 0.02, 0.9);
    }
    plot(riderU, riderV - 0.2, 1);
  });
}

/* -- Skate ramp: a half pipe with air off each coping --------------------- */

function paintSkateRamp(t: number): string {
  const swing = Math.sin(t * 1.5);
  const air = Math.max(0, Math.abs(swing) - 0.92) * 6;
  const skaterU = swing * 1.25;
  const skaterV = 0.75 - Math.pow(Math.abs(swing), 2) * 1.3 - air * 0.35;
  const tilt = swing * 0.5;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 60; x += 1) {
      const u = -ASPECT + (x / 60) * ASPECT * 2;
      if (Math.abs(u) > 1.4) continue;
      plot(u, 0.75 - Math.pow(clamp01(Math.abs(u) / 1.35), 2) * 1.35, 0.55);
    }
    for (const side of [-1, 1]) {
      for (let step = 0; step <= 5; step += 1) plot(side * 1.4, -0.6 - (step / 5) * 0.3, 0.4);
    }
    /* Board first, then the rider standing on it. */
    for (let step = 0; step <= 5; step += 1) {
      const f = (step / 5 - 0.5) * 0.34;
      plot(skaterU + f, skaterV + f * tilt, 0.95);
    }
    plot(skaterU, skaterV - 0.18, 1);
    plot(skaterU + tilt * 0.2, skaterV - 0.34, 0.7);
  });
}

/* -- Pogo stick: the spring loading hardest at the bottom of the bounce --- */

function paintPogoStick(t: number): string {
  const hop = Math.abs(Math.sin(t * 2.2));
  const footV = 0.88 - Math.pow(hop, 0.7) * 0.8;
  const squash = hop < 0.12 ? (0.12 - hop) * 1.6 : 0;
  const stick = 0.7 - squash * 0.15;
  const travel = Math.sin(t * 0.4) * 1.1;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.9, 0.3);
    for (let step = 0; step <= 12; step += 1) plot(travel, footV - (step / 12) * stick, 0.6);
    for (let cell = -2; cell <= 2; cell += 1) plot(travel + cell * 0.09, footV - stick * 0.45, 0.8);
    plot(travel, footV - stick - 0.16, 1);
    plot(travel - 0.14, footV - stick + 0.02 + squash * 0.1, 0.7);
    plot(travel + 0.14, footV - stick + 0.02 + squash * 0.1, 0.7);
    plot(travel, footV, 0.9);
  });
}

/* -- Unicycle: pedals turning under a rider who never stops correcting ---- */

function paintUnicycle(t: number): string {
  const u = -ASPECT + 0.3 + ((t * 0.22) % 1) * (ASPECT * 2 - 0.6);
  const wheelV = 0.6;
  const spin = -t * 2.4;
  const lean = Math.sin(t * 1.4) * 0.22;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.85, 0.3);
    for (let sample = 0; sample <= 34; sample += 1) {
      const angle = (sample / 34) * TAU;
      plot(u + Math.cos(angle) * 0.24, wheelV + Math.sin(angle) * 0.24, 0.6);
    }
    for (let spoke = 0; spoke < 4; spoke += 1) {
      const angle = spin + (spoke / 4) * Math.PI;
      for (let step = 0; step <= 5; step += 1) {
        const f = (step / 5) * 0.24;
        plot(u + Math.cos(angle) * f, wheelV + Math.sin(angle) * f, 0.45);
      }
    }
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(u + lean * f * 0.6, wheelV - f * 0.5, 0.7);
    }
    plot(u + lean * 0.75, wheelV - 0.7, 1);
    /* Arms out, working against the lean. */
    for (let step = 0; step <= 5; step += 1) {
      const f = step / 5;
      plot(u + lean * 0.7 - f * 0.4, wheelV - 0.55 - f * 0.18, 0.65);
      plot(u + lean * 0.7 + f * 0.4, wheelV - 0.55 + f * 0.05, 0.65);
    }
    plot(u + Math.cos(spin) * 0.16, wheelV + Math.sin(spin) * 0.16, 0.9);
  });
}

/* -- Tightrope: the rope sagging under whoever is standing on it ---------- */

function paintTightrope(t: number): string {
  const walker = Math.sin(t * 0.32) * 1.2;
  const sway = Math.sin(t * 2.6) * 0.16;
  const ropeAt = (u: number): number =>
    -0.05 + Math.max(0, 1 - Math.abs(u - walker) / 1.6) * 0.3 * clamp01(1.15 - Math.abs(u) / ASPECT);
  return paintPlotted((plot) => {
    for (let x = 0; x <= 60; x += 1) {
      const u = -ASPECT + (x / 60) * ASPECT * 2;
      plot(u, ropeAt(u), 0.5);
    }
    for (const side of [-1, 1]) {
      for (let step = 0; step <= 12; step += 1) plot(side * (ASPECT - 0.1), -0.05 + step / 12, 0.4);
    }
    const v = ropeAt(walker);
    /* The balance pole tips one way while the body leans the other. */
    for (let step = 0; step <= 12; step += 1) {
      const f = (step / 12 - 0.5) * 2;
      plot(walker + f * 1.1, v - 0.45 + f * sway, 0.8);
    }
    plot(walker + sway * 0.3, v - 0.62, 1);
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(walker + sway * 0.3 * (1 - f), v - 0.55 + f * 0.5, 0.85);
    }
  });
}

/* -- Trapeze: a flyer swinging over a net that sags in the middle --------- */

function paintTrapeze(t: number): string {
  const swing = Math.sin(t * 1.4) * 1.1;
  const pivotV = -0.98;
  const barU = Math.sin(swing) * 1.15;
  const barV = pivotV + Math.cos(swing) * 1.15;
  const kick = Math.cos(t * 1.4);
  return paintPlotted((plot) => {
    for (let x = 0; x <= 50; x += 1) {
      const u = -ASPECT + (x / 50) * ASPECT * 2;
      plot(u, 0.78 + (1 - Math.pow(u / ASPECT, 2)) * 0.12, 0.3);
    }
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 6; step += 1) {
        plot(side * (ASPECT - 0.15), 0.78 + (step / 6) * 0.18, 0.3);
      }
    }
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(barU * f - 0.28, pivotV + (barV - pivotV) * f, 0.45);
      plot(barU * f + 0.28, pivotV + (barV - pivotV) * f, 0.45);
    }
    for (let cell = -3; cell <= 3; cell += 1) plot(barU + cell * 0.1, barV, 0.9);
    /* Legs trail the swing, so the flyer reads as hanging rather than falling. */
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(barU + kick * 0.35 * f * f, barV + f * 0.45, 0.85);
    }
    plot(barU + kick * 0.35, barV + 0.5, 1);
  });
}

/* -- Gyroscope: a rotor going edge-on as the axis walks around ----------- */

function paintGyroscope(t: number): string {
  const precess = t * 0.75;
  const centerV = 0.15;
  const minor = 0.16 + Math.abs(Math.sin(precess)) * 0.34;
  const lean = Math.cos(precess) * 0.5;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(lean * 0.35 * (1 - f), 0.95 - f * 0.35, 0.4);
    }
    for (let cell = -3; cell <= 3; cell += 1) plot(cell * 0.13, 0.95, 0.5);
    for (let sample = 0; sample <= 60; sample += 1) {
      const angle = (sample / 60) * TAU;
      /* Near half of the rim is brighter, which is what gives it a front. */
      plot(
        Math.cos(angle) * 0.72 + Math.sin(angle) * minor * lean * 0.4,
        centerV + Math.sin(angle) * minor,
        0.3 + ((Math.sin(angle) + 1) / 2) * 0.5,
      );
    }
    /* One painted mark on the rim, so the spin reads from any angle. */
    const mark = (t * 5.5) % TAU;
    plot(Math.cos(mark) * 0.72, centerV + Math.sin(mark) * minor, 1);
    for (let step = -6; step <= 6; step += 1) {
      const f = step / 6;
      plot(lean * 0.55 * f, centerV - f * 0.62, 0.6);
    }
  });
}

/* -- Orrery: brass arms carrying planets on their own periods ------------- */

function paintOrrery(t: number): string {
  return paintPlotted((plot) => {
    plot(0, 0, 1);
    plot(0.1, 0, 0.7);
    plot(-0.1, 0, 0.7);
    for (let planet = 0; planet < 4; planet += 1) {
      const radius = 0.42 + planet * 0.35;
      for (let sample = 0; sample <= 60; sample += 1) {
        const angle = (sample / 60) * TAU;
        plot(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.55, 0.22);
      }
      /* Outer arms turn slower, the way the gearing in a real one does. */
      const angle = t * (1.6 / Math.pow(radius, 1.5)) + planet * 1.7;
      const planetU = Math.cos(angle) * radius;
      const planetV = Math.sin(angle) * radius * 0.55;
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(planetU * f, planetV * f, 0.3);
      }
      plot(planetU, planetV, 0.95);
      if (planet === 2) {
        plot(planetU + Math.cos(t * 5 + 1) * 0.16, planetV + Math.sin(t * 5 + 1) * 0.1, 0.8);
      }
    }
  });
}

/* -- Telescope: a tube tracking while the sky slides the other way -------- */

function paintTelescope(t: number): string {
  const aim = -0.9 + Math.sin(t * 0.25) * 0.35;
  const pivotU = 0.15;
  const pivotV = 0.3;
  return paintPlotted((plot) => {
    for (let star = 0; star < 16; star += 1) {
      const starU = ((hash(star * 3.1) + t * 0.02) % 1) * ASPECT * 2 - ASPECT;
      plot(starU, -0.95 + hash(star * 7.3) * 1.1, 0.3 + hash(star * 5.7) * 0.5);
    }
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.95, 0.3);
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(pivotU - 0.35 * f, pivotV + f * 0.65, 0.45);
      plot(pivotU + 0.35 * f, pivotV + f * 0.65, 0.45);
    }
    /* Three lines across give the tube some thickness at this size. */
    for (let step = -5; step <= 14; step += 1) {
      const f = step / 14;
      for (let across = -1; across <= 1; across += 1) {
        plot(
          pivotU + Math.cos(aim) * f * 1.35 - Math.sin(aim) * across * 0.1,
          pivotV + Math.sin(aim) * f * 1.35 + Math.cos(aim) * across * 0.1,
          across === 0 ? 0.75 : 0.5,
        );
      }
    }
    plot(pivotU + Math.cos(aim) * 1.35, pivotV + Math.sin(aim) * 1.35, 1);
  });
}

/* -- Weather vane: the arrow chasing a wind that keeps shifting ----------- */

function paintWeatherVane(t: number): string {
  const wind = Math.sin(t * 0.5) * 1.2 + Math.sin(t * 1.7) * 0.25;
  const centerV = -0.1;
  const cos = Math.cos(wind);
  const sin = Math.sin(wind) * 0.45;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) plot(0, centerV + (step / 14) * 1.05, 0.45);
    for (let step = -6; step <= 6; step += 1) {
      const f = step / 6;
      plot(f * 0.75, centerV + 0.45, 0.4);
      plot(0, centerV + 0.45 + f * 0.2, 0.4);
    }
    for (let step = -8; step <= 8; step += 1) {
      const f = step / 8;
      plot(cos * f * 1.15, centerV + sin * f * 1.15, 0.6);
    }
    plot(cos * 1.15, centerV + sin * 1.15, 1);
    plot(cos * 0.95 - sin * 0.2, centerV + sin * 0.95 + cos * 0.12, 0.85);
    plot(cos * 0.95 + sin * 0.2, centerV + sin * 0.95 - cos * 0.12, 0.85);
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(-cos * (0.75 + f * 0.35), centerV - sin * (0.75 + f * 0.35) + (f - 0.5) * 0.3, 0.7);
    }
    /* Gust streaks, so a swing of the arrow reads as wind and not as drift. */
    for (let streak = 0; streak < 3; streak += 1) {
      const head = ((t * 0.6 + streak * 0.3) % 1) * ASPECT * 2 - ASPECT;
      for (let step = 0; step <= 6; step += 1) {
        plot(head - (step / 6) * 0.5, -0.8 + streak * 0.35, 0.35);
      }
    }
  });
}

/* -- Fishing: cast, a float sitting on the chop, then a rise -------------- */

function paintFishingRod(t: number): string {
  const cycle = (t * 0.28) % 1;
  const cast = Math.min(1, cycle / 0.25);
  const reel = cycle > 0.75 ? (cycle - 0.75) / 0.25 : 0;
  const floatU = -0.9 + (cast - reel) * 2.1;
  const waterV = 0.45;
  const bob = Math.sin(t * 3.2) * 0.05 * (1 - reel);
  const handU = -1.5;
  const handV = 0.05;
  const tipU = -0.95;
  const tipV = -0.55 - Math.sin(cycle * TAU) * 0.15;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 50; x += 1) {
      const u = -ASPECT + (x / 50) * ASPECT * 2;
      plot(u, waterV + Math.sin(u * 3.5 - t * 2) * 0.06, 0.3);
    }
    plot(handU, 0.1, 1);
    for (let step = 0; step <= 6; step += 1) plot(handU, 0.18 + (step / 6) * 0.28, 0.7);
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(handU + (tipU - handU) * f, handV + (tipV - handV) * f, 0.6);
    }
    /* The line sags between the rod tip and the float. */
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(
        tipU + (floatU - tipU) * f,
        tipV + (waterV + bob - tipV) * f + Math.sin(f * Math.PI) * 0.12,
        0.4,
      );
    }
    plot(floatU, waterV + bob, 1);
    plot(floatU, waterV + bob - 0.12, 0.7);
    if (cycle > 0.55 && cycle < 0.78) {
      const rise = (cycle - 0.55) / 0.23;
      plot(floatU + 0.12, waterV + 0.4 - rise * 0.35, 0.85);
      plot(floatU + 0.24, waterV + 0.46 - rise * 0.35, 0.5);
    }
  });
}

/* -- Bee dance: a waggle up the middle, looping back either side ---------- */

function paintBeeDance(t: number): string {
  const phase = (t * 0.6) % 1;
  const loop = phase < 0.5 ? 1 : -1;
  const local = (phase % 0.5) / 0.5;
  const waggle = local < 0.45;
  const back = (local - 0.45) / 0.55;
  const beeU = waggle ? Math.sin(t * 26) * 0.09 : Math.sin(back * Math.PI) * 0.62 * loop;
  const beeV = waggle ? 0.45 - (local / 0.45) * 0.9 : -0.45 + (1 - Math.cos(back * Math.PI)) * 0.45;
  return paintPlotted((plot) => {
    for (let row = -2; row <= 2; row += 1) {
      for (let cell = -5; cell <= 5; cell += 1) {
        const cellU = cell * 0.32 + (row % 2 === 0 ? 0 : 0.16);
        for (let sample = 0; sample < 6; sample += 1) {
          const angle = (sample / 6) * TAU;
          plot(cellU + Math.cos(angle) * 0.15, row * 0.42 + Math.sin(angle) * 0.15, 0.22);
        }
      }
    }
    plot(beeU, beeV, 1);
    plot(beeU, beeV + 0.12, 0.75);
    /* Wings blur brightest during the waggle, which is the part that carries. */
    plot(beeU - 0.16, beeV - 0.06, waggle ? 0.9 : 0.5);
    plot(beeU + 0.16, beeV - 0.06, waggle ? 0.9 : 0.5);
  });
}

/* -- Ant trail: two files on one scent line, running opposite ways -------- */

function paintAntTrail(t: number): string {
  const trail = (f: number): readonly [number, number] => [
    -ASPECT + f * ASPECT * 2,
    Math.sin(f * TAU * 1.2 - 0.6) * 0.55,
  ];
  return paintPlotted((plot) => {
    for (let step = 0; step <= 80; step += 1) {
      const [u, v] = trail(step / 80);
      plot(u, v, 0.25);
    }
    for (let ant = 0; ant < 9; ant += 1) {
      const [outU, outV] = trail((t * 0.14 + ant / 9) % 1);
      const [homeU, homeV] = trail(1 - ((t * 0.12 + ant / 9) % 1));
      plot(outU, outV - 0.06, 0.95);
      plot(outU - 0.05, outV - 0.06, 0.5);
      plot(homeU, homeV + 0.1, 0.8);
      plot(homeU + 0.05, homeV + 0.1, 0.45);
    }
    plot(-ASPECT + 0.1, trail(0)[1], 0.9);
    plot(ASPECT - 0.1, trail(1)[1], 0.9);
  });
}

/* ========================================================================
   The sixth collection: deep water and ground fields, then a row of
   vehicles, instruments, and games. Same contract as everything above.
   ===================================================================== */

/* -- Abyssal vent: a black smoker with marine snow falling past it -------- */

const abyssalVentField: Field = (u, v, t) => {
  /* The chimney stands on the floor; the plume above it widens as it cools. */
  const chimney = clamp01(1 - Math.abs(u + 0.4) * 6) * clamp01((v + 0.1) * 3);
  const rise = clamp01((0.9 - v) / 1.8);
  const lean = Math.sin(v * 3 - t * 1.5) * 0.24 * rise;
  const plume =
    clamp01(1 - Math.abs(u + 0.4 - lean) / (0.12 + rise * 0.68)) *
    clamp01(fbm(u * 3, v * 3 - t * 1.7, 3) * 1.4) *
    rise;
  /* Snow falls the other way, which is what sells the depth. */
  const snow = hash2(Math.floor(u * 11), Math.floor(v * 7 - t * 1.3)) > 0.94 ? 0.55 : 0;
  return clamp01(0.04 + chimney * 0.7 + plume + snow);
};

/* -- Kelp forest: blades trailing a current that reverses ----------------- */

const kelpForestField: Field = (u, v, t) => {
  const current = Math.sin(t * 0.6) * 0.42 + Math.sin(t * 1.7) * 0.14;
  let frond = 0.06 + clamp01((v - 0.72) * 4) * 0.55;
  for (let stalk = 0; stalk < 6; stalk += 1) {
    const holdfast = -ASPECT + 0.35 + (stalk / 5) * (ASPECT * 2 - 0.7);
    const lift = clamp01((0.86 - v) / 1.8);
    /* Only the free length swings, so the bed bends instead of sliding. */
    const bend = lift * lift * (current + (hash(stalk * 4.1) - 0.5) * 0.5);
    /* Blades thicken the stem in places rather than breaking it up. */
    const width = 0.06 + Math.abs(Math.sin(v * 5 + t * 1.1 + stalk * 2)) * 0.13;
    frond = Math.max(frond, clamp01(1 - Math.abs(u - holdfast - bend) / width) * 0.95);
  }
  return frond;
};

/* -- Dripstone: a cave section with one drip per column ------------------- */

const stalactiteField: Field = (u, v, t) => {
  const column = Math.round(u * 3.1) / 3.1;
  const ceiling = -0.98 + Math.abs(Math.sin(u * 2.6 + 1.1)) * 0.85;
  const floor = 0.98 - Math.abs(Math.sin(u * 2.1 + 2.4)) * 0.68;
  if (v < ceiling || v > floor) return 0.72;
  const cycle = (t * 0.5 + hash(Math.floor(u * 3.1) * 2.7)) % 1;
  /* A drop accelerates on the way down, then the column starts over. */
  const drop = ceiling + cycle * cycle * (floor - ceiling);
  const bead = clamp01(1 - Math.hypot((u - column) * 3.4, (v - drop) * 2.2));
  return clamp01(0.06 + bead * 0.95);
};

/* -- Iron filings: a comb across the field of two orbiting poles ---------- */

const filingsField: Field = (u, v, t) => {
  const spin = t * 0.5;
  const pu = Math.cos(spin) * 0.8;
  const pv = Math.sin(spin) * 0.42;
  let fu = 0;
  let fv = 0;
  for (const [cu, cv, charge] of [
    [pu, pv, 1],
    [-pu, -pv, -1],
  ] as const) {
    const du = u - cu;
    const dv = v - cv;
    const square = Math.max(0.02, du * du + dv * dv);
    const falloff = square * Math.sqrt(square);
    fu += (charge * du) / falloff;
    fv += (charge * dv) / falloff;
  }
  const along = Math.atan2(fv, fu);
  /* Sampling a comb across the field direction is what draws the lines. */
  const across = u * Math.sin(along) - v * Math.cos(along);
  const strength = clamp01(Math.hypot(fu, fv) * 0.1);
  return clamp01(Math.pow(Math.abs(Math.sin(across * 9)), 3) * (0.3 + strength) + strength * 0.6 + 0.05);
};

/* -- Soap film: interference bands pooling as the film drains ------------- */

const soapFilmField: Field = (u, v, t) => {
  /* Thickness runs out at the top first, so the bands crowd downwards. */
  const thickness =
    (clamp01((v + 1) / 2) + 0.2) * (1.5 - ((t * 0.16) % 1.4)) +
    fbm(u * 2.2, v * 2.2 - t * 0.35, 3) * 0.3;
  const band = Math.sin(thickness * 15) * 0.5 + 0.5;
  const rim = clamp01((Math.hypot(u * 0.75, v) - 0.92) * 5);
  return clamp01(0.05 + band * 0.85 * (1 - rim) + rim * 0.55);
};

/* -- Neon tube: a bent lemniscate with a bad contact per segment ---------- */

const neonTubeField: Field = (u, v, t) => {
  const angle = Math.atan2(v, u);
  const lobe = Math.cos(angle * 2);
  if (lobe <= 0) return 0.04;
  const target = Math.sqrt(lobe) * 1.15;
  const radius = Math.hypot(u, v);
  const offset = Math.abs(radius - target);
  const segment = Math.floor(((angle + Math.PI) / TAU) * 6);
  /* A third of the segments are failing, each at its own rate. */
  const contact =
    hash(segment * 3.7) < 0.34 ? 0.3 + Math.abs(Math.sin(t * 8 + segment * 2)) * 0.7 : 1;
  return clamp01(clamp01(1 - offset * 6) * contact + clamp01(1 - offset * 1.8) * 0.26);
};

/* -- Coral polyps: mouths opening and shutting on their own clocks -------- */

const coralPolypField: Field = (u, v, t) => {
  let reef = 0.08 + clamp01((v - 0.55) * 2.4) * 0.5;
  for (let polyp = 0; polyp < 8; polyp += 1) {
    const cu = (hash(polyp * 2.3) * 2 - 1) * ASPECT * 0.85;
    const cv = (hash(polyp * 5.7) * 2 - 1) * 0.8;
    const open = 0.5 + Math.sin(t * (0.7 + hash(polyp) * 0.9) + polyp) * 0.5;
    const reach = 0.22 + open * 0.34;
    const radius = Math.hypot(u - cu, (v - cv) * 1.5);
    if (radius > reach) continue;
    /* Tentacles read as a rosette rather than a disc. */
    const rosette = Math.pow(Math.abs(Math.cos(Math.atan2(v - cv, u - cu) * 4)), 0.5);
    reef = Math.max(reef, clamp01(1 - radius / reach) * (0.3 + rosette * 0.7));
  }
  return reef;
};

/* -- Jet stream: a meandering core shedding eddies off both edges --------- */

const jetStreamField: Field = (u, v, t) => {
  const meander = Math.sin(u * 1.4 - t * 0.8) * 0.32 + Math.sin(u * 0.6 + t * 0.3) * 0.2;
  const offset = v - meander;
  const core = clamp01(1 - Math.abs(offset) / 0.34);
  const streak = Math.pow(Math.abs(Math.sin(u * 5 - t * 6 + offset * 3)), 2);
  /* Eddies only exist outside the core, where the shear is. */
  const eddy =
    Math.pow(Math.abs(Math.sin(u * 3 - t * 1.6 + Math.sign(offset) * 1.5)), 6) *
    clamp01((Math.abs(offset) - 0.3) * 3) *
    clamp01(1.2 - Math.abs(offset));
  return clamp01(0.05 + core * (0.4 + streak * 0.6) + eddy * 0.55);
};

/* -- Salt flat: a polygon crust going under a sheet of flood water -------- */

const saltFlatField: Field = (u, v, t) => {
  let nearest = 9;
  let second = 9;
  for (let cell = 0; cell < 14; cell += 1) {
    const cu = (hash(cell * 1.7) * 2 - 1) * ASPECT;
    const cv = hash(cell * 4.9) * 2 - 1;
    const distance = Math.hypot(u - cu, v - cv);
    if (distance < nearest) {
      second = nearest;
      nearest = distance;
    } else if (distance < second) {
      second = distance;
    }
  }
  /* Two cells equally close means a border, which is where the salt piles. */
  const ridge = clamp01(1 - (second - nearest) * 6);
  const waterline = 1 - ((t * 0.3) % 2);
  const wet = clamp01((v - waterline) * 4);
  return clamp01(
    0.2 + ridge * 0.75 * (1 - wet * 0.65) + wet * (0.14 + Math.abs(Math.sin(u * 4 + t * 1.4)) * 0.3),
  );
};

/* -- Swamp gas: bubbles swelling as they climb out of the murk ------------ */

const swampGasField: Field = (u, v, t) => {
  const murk = 0.08 + fbm(u * 1.6 + t * 0.12, v * 1.6, 3) * 0.24;
  let bubble = 0;
  for (let vent = 0; vent < 6; vent += 1) {
    const cu = (hash(vent * 3.3) * 2 - 1) * ASPECT * 0.85;
    const cycle = (t * (0.3 + hash(vent) * 0.3) + hash(vent * 7.1)) % 1;
    const cv = 0.95 - cycle * 1.95;
    /* Pressure drops on the way up, so the bubble grows as it climbs. */
    const size = 0.1 + cycle * 0.24;
    const wobble = Math.sin(cycle * 12 + vent) * 0.09;
    const edge = 1 - Math.hypot(u - cu - wobble, v - cv) / size;
    if (edge <= 0) continue;
    /* A bright skin over a dim middle is what makes it read as a bubble. */
    bubble = Math.max(bubble, clamp01(edge * 4) * 0.3 + clamp01(1 - edge * 3.2) * 0.65);
  }
  return clamp01(murk + bubble);
};

/* -- Quicksand: grains on a vortex that stalls towards the rim ------------ */

const quicksandField: Field = (u, v, t) => {
  const radius = Math.hypot(u * 0.8, v);
  const swirl = Math.atan2(v, u * 0.8) + t * (1.9 / (0.3 + radius * 2.6));
  /* Arms wound into the middle carry the motion; the grain is texture on top. */
  const arm = Math.pow(Math.abs(Math.sin(swirl * 1.5 + radius * 4)), 3);
  const grain = hash2(
    Math.floor(Math.cos(swirl) * radius * 10),
    Math.floor(Math.sin(swirl) * radius * 10),
  );
  const pit = clamp01(1 - radius * 0.85);
  return clamp01(0.08 + arm * (0.35 + pit * 0.6) + grain * 0.3 * (0.4 + pit));
};

/* -- Fog bank: a ridge going under weather that rolls across it ----------- */

const fogBankField: Field = (u, v, t) => {
  const ridge = 0.34 + Math.sin(u * 1.3 + 0.8) * 0.24 + Math.sin(u * 3.1) * 0.1;
  /* The ridge is a dark silhouette; the fog above it carries the brightness. */
  const land = v > ridge ? 0.28 : 0;
  const bank = fbm(u * 1.1 - t * 0.34, v * 2.1 + t * 0.09, 4);
  const depth = clamp01((v - ridge + 0.9) * 0.8);
  return clamp01(land + Math.pow(bank, 1.6) * depth * 1.2 + 0.05);
};

/* -- Hail: stones streaking down, each throwing a splash as it lands ------ */

const hailBurstField: Field = (u, v, t) => {
  const ground = 0.86;
  if (v > ground) return 0.45;
  let stone = 0.05 + clamp01(-v - 0.6) * 0.22;
  for (let hail = 0; hail < 16; hail += 1) {
    const cu = (hash(hail * 2.7) * 2 - 1) * ASPECT;
    const fall = (t * (1.1 + hash(hail) * 0.7) + hash(hail * 5.3)) % 1;
    const cv = -1 + fall * (ground + 1);
    stone = Math.max(stone, clamp01(1 - Math.hypot((u - cu) * 2.2, (v - cv) * 0.7) * 5));
    if (fall > 0.93) {
      stone = Math.max(
        stone,
        clamp01(1 - Math.hypot((u - cu) * 0.9, (v - ground) * 2.6) * 2.5) * 0.7,
      );
    }
  }
  return stone;
};

/* -- Tidal bore: one front upstream, with its wave train behind ----------- */

const tidalBoreField: Field = (u, v, t) => {
  const span = ASPECT * 2 + 1.6;
  const front = -ASPECT - 0.6 + ((t * 0.55) % span);
  const behind = front - u;
  /* Water level along the estuary: flat ahead of the front, raised behind it. */
  const level =
    behind < 0
      ? Math.sin(u * 5 + t) * 0.05
      : clamp01(behind * 3) * 0.5 +
        Math.sin(behind * 4.5 - t * 2) * 0.17 * clamp01(1 - behind * 0.3);
  const surface = 0.42 - level;
  const water = v > surface ? 0.32 + clamp01((v - surface) * 1.3) * 0.35 : 0;
  /* The face of the bore is the one bright edge in the frame. */
  const face = clamp01(1 - Math.abs(v - surface) * 5) * (behind > 0 && behind < 0.45 ? 1 : 0.45);
  return clamp01(0.05 + water + face * 0.62);
};

/* -- Magnetosphere: a squashed day side, a drawn-out tail ----------------- */

const magnetosphereField: Field = (u, v, t) => {
  const du = u + ASPECT * 0.35;
  const body = clamp01((0.32 - Math.hypot(du, v)) * 8);
  /* The wind compresses the sunward side and stretches the other one. */
  const shell = Math.hypot(du * (du < 0 ? 1.5 : 0.55), v);
  let line = 0;
  for (let ring = 0; ring < 4; ring += 1) {
    const at = 0.55 + ring * 0.33 + Math.sin(t * 0.8 + ring) * 0.06;
    line = Math.max(line, clamp01(1 - Math.abs(shell - at) * 9));
  }
  const gust = Math.pow(clamp01(Math.sin(u * 3 - t * 4)), 3) * clamp01(du * 1.2);
  const bow = clamp01(1 - Math.abs(shell - 1.85) * 6) * clamp01(-du);
  return clamp01(0.04 + body + line * (0.35 + gust * 0.6) + bow * 0.5);
};

/* -- Bacterial lawn: colonies spreading from fixed seed points ------------ */

const bacterialLawnField: Field = (u, v, t) => {
  let lawn = 0.06 + fbm(u * 5, v * 5, 2) * 0.14;
  for (let colony = 0; colony < 7; colony += 1) {
    const cu = (hash(colony * 1.9) * 2 - 1) * ASPECT * 0.9;
    const cv = (hash(colony * 6.1) * 2 - 1) * 0.85;
    const grown = (t * 0.22 + hash(colony * 3.7)) % 1;
    const edge = grown * (0.55 + hash(colony * 8.3) * 0.6);
    const radius = Math.hypot(u - cu, (v - cv) * 0.95);
    if (radius > edge) continue;
    /* A bright rim over a duller middle is what makes it read as spreading. */
    lawn = Math.max(lawn, 0.3 + clamp01(1 - (edge - radius) * 4) * 0.65);
  }
  return clamp01(lawn);
};

/* -- Cavitation: voids that grow slowly and collapse in a flash ----------- */

const cavitationField: Field = (u, v, t) => {
  let water = 0.06 + Math.abs(Math.sin(u * 2.4 + v * 1.6 - t * 3)) * 0.11;
  for (let bubble = 0; bubble < 5; bubble += 1) {
    const cu = (hash(bubble * 2.1) * 2 - 1) * ASPECT * 0.85;
    const cv = (hash(bubble * 4.7) * 2 - 1) * 0.8;
    const cycle = (t * (0.5 + hash(bubble) * 0.4) + hash(bubble * 9.3)) % 1;
    const size = (cycle < 0.8 ? cycle / 0.8 : 1 - (cycle - 0.8) / 0.2) * 0.45;
    const radius = Math.hypot(u - cu, v - cv);
    const shell = clamp01(1 - Math.abs(radius - size) * 7);
    /* Everything the void gave up comes back at once, right at the end. */
    const flash = cycle > 0.94 ? clamp01(1 - radius * 1.8) : 0;
    water = Math.max(water, Math.max(shell * 0.85, flash));
  }
  return clamp01(water);
};

/* -- Sediment core: strata sliding past a window, grain and all ----------- */

const sedimentCoreField: Field = (u, v, t) => {
  const depth = v * 1.6 + t * 0.32;
  const band = Math.floor(depth * 2.2);
  const coarse = hash(band * 3.1);
  const grain = hash2(Math.floor(u * 13), Math.floor(depth * 26));
  /* Bedding planes are the dark partings between one band and the next. */
  const bedding = clamp01(1 - Math.abs(((depth * 2.2) % 1) - 0.5) * 2.4);
  const wall = clamp01((Math.abs(u) - ASPECT * 0.78) * 5);
  return clamp01((0.2 + coarse * 0.55) * (0.55 + grain * 0.5) * bedding + wall * 0.5 + 0.05);
};

/* -- Paddle steamer: stack smoke astern, wheel turning at the stern ------- */

function paintPaddleSteamer(t: number): string {
  const bob = Math.sin(t * 1.4) * 0.06;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.62 + Math.sin(u * 4 - t * 2.4) * 0.07, 0.3);
    }
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.15 + (x / 26) * 1.95;
      plot(u, 0.46 + bob, 0.75);
      plot(u, 0.16 + bob, 0.6);
    }
    for (let step = 0; step <= 6; step += 1) {
      plot(-1.15, 0.16 + bob + (step / 6) * 0.3, 0.6);
      plot(0.8, 0.16 + bob + (step / 6) * 0.3, 0.6);
    }
    for (let step = 0; step <= 8; step += 1) plot(-0.5, 0.14 + bob - (step / 8) * 0.78, 0.7);
    /* Puffs blow astern and thin out as they go. */
    for (let puff = 0; puff < 7; puff += 1) {
      const age = (t * 0.6 + puff / 7) % 1;
      plot(-0.5 - age * 1.5, -0.64 + bob - age * 0.28, (1 - age) * 0.85);
    }
    const spin = -t * 2.6;
    for (let blade = 0; blade < 8; blade += 1) {
      const angle = spin + (blade / 8) * TAU;
      for (let step = 4; step <= 8; step += 1) {
        const reach = (step / 8) * 0.4;
        plot(1.12 + Math.cos(angle) * reach, 0.34 + bob + Math.sin(angle) * reach, 0.5 + step * 0.06);
      }
    }
  });
}

/* -- Tram: a car crossing under a wire, pole tracking it ------------------ */

function paintTramCar(t: number): string {
  const span = ASPECT * 2 + 2.4;
  const travel = -ASPECT - 1.2 + ((t * 0.34) % 1) * span;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      /* The wire sags between poles and lifts where the pantograph is. */
      plot(u, -0.78 + Math.abs(Math.sin(u * 0.9)) * 0.08 - clamp01(1 - Math.abs(u - travel - 1.05) * 2) * 0.05, 0.32);
      plot(u, 0.94, 0.38);
    }
    for (let post = -1; post <= 1; post += 1) {
      for (let step = 0; step <= 12; step += 1) plot(post * 1.35, -0.76 + (step / 12) * 1.68, 0.2);
    }
    for (let x = 0; x <= 22; x += 1) {
      const u = travel + (x / 22) * 1.5;
      plot(u, 0.72, 0.8);
      plot(u, 0.06, 0.8);
      if (x % 5 === 2) for (let step = 0; step <= 5; step += 1) plot(u, 0.14 + (step / 5) * 0.4, 0.28);
    }
    for (let step = 0; step <= 8; step += 1) {
      plot(travel, 0.06 + (step / 8) * 0.66, 0.8);
      plot(travel + 1.5, 0.06 + (step / 8) * 0.66, 0.8);
    }
    for (let step = 0; step <= 10; step += 1) {
      plot(travel + 0.62 + (step / 10) * 0.43, 0.06 - (step / 10) * 0.84, 0.55);
    }
    plot(travel + 1.05, -0.78, 1);
    for (const wheel of [0.35, 1.15]) {
      const angle = t * 3.4;
      plot(travel + wheel + Math.cos(angle) * 0.11, 0.84 + Math.sin(angle) * 0.11, 0.85);
      plot(travel + wheel, 0.84, 0.5);
    }
  });
}

/* -- Forklift: drive in, raise the pallet, set it back down --------------- */

function paintForklift(t: number): string {
  const cycle = (t * 0.4) % 1;
  const drive = cycle < 0.25 ? -1.4 + (cycle / 0.25) * 1.2 : -0.2;
  /* Raise, hold, lower: the hold is what makes the lift read as deliberate. */
  const lift =
    cycle < 0.3
      ? 0
      : cycle < 0.55
        ? ((cycle - 0.3) / 0.25) * 1.1
        : cycle < 0.8
          ? 1.1
          : 1.1 - ((cycle - 0.8) / 0.2) * 1.1;
  const forkV = 0.74 - lift;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.94, 0.3);
    for (let step = 0; step <= 18; step += 1) {
      const v = 0.78 - (step / 18) * 1.55;
      plot(drive + 0.55, v, 0.5);
      plot(drive + 0.72, v, 0.5);
    }
    for (let x = 0; x <= 14; x += 1) {
      const u = drive - 0.75 + (x / 14) * 1.2;
      plot(u, 0.76, 0.7);
      plot(u, 0.12, 0.7);
    }
    for (let step = 0; step <= 8; step += 1) {
      plot(drive - 0.75, 0.12 + (step / 8) * 0.64, 0.7);
      plot(drive + 0.45, 0.12 + (step / 8) * 0.64, 0.7);
    }
    for (let x = 0; x <= 10; x += 1) plot(drive + 0.72 + (x / 10) * 0.6, forkV, 0.85);
    for (let x = 0; x <= 12; x += 1) {
      const u = drive + 0.76 + (x / 12) * 0.58;
      plot(u, forkV - 0.14, 0.75);
      plot(u, forkV - 0.42, 0.75);
    }
    for (const wheel of [-0.5, 0.2]) {
      const angle = t * 4 + wheel;
      plot(drive + wheel + Math.cos(angle) * 0.11, 0.84 + Math.sin(angle) * 0.11, 0.85);
      plot(drive + wheel, 0.84, 0.5);
    }
  });
}

/* -- Claw machine: track across, drop, close, and lose it on the way up --- */

function paintClawMachine(t: number): string {
  const cycle = (t * 0.28) % 1;
  const carriage = Math.sin(cycle * Math.PI * 1.5) * 1.1;
  const reach = cycle < 0.35 ? 0 : cycle < 0.55 ? (cycle - 0.35) / 0.2 : cycle < 0.85 ? 1 - (cycle - 0.55) / 0.3 : 0;
  const clawV = -0.5 + reach * 1.2;
  /* The grip closes at the bottom and gives way again halfway back up. */
  const grip = cycle > 0.5 && cycle < 0.72 ? 0.3 : 1;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 30; step += 1) {
      const f = step / 30;
      plot(-1.55 + f * 3.1, -0.92, 0.5);
      plot(-1.55 + f * 3.1, 0.94, 0.5);
      plot(-1.55, -0.92 + f * 1.86, 0.5);
      plot(1.55, -0.92 + f * 1.86, 0.5);
    }
    for (let step = 0; step <= 8; step += 1) plot(carriage, -0.9 + (step / 8) * (clawV + 0.9), 0.35);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 5; step += 1) {
        plot(carriage + side * (step / 5) * 0.22 * grip, clawV + (step / 5) * 0.2, 0.9);
      }
    }
    /* Prizes heaped along the floor of the cabinet. */
    for (let prize = 0; prize < 9; prize += 1) {
      const pu = -1.3 + (prize / 8) * 2.6;
      plot(pu, 0.82 - hash(prize * 3.3) * 0.16, 0.7);
      plot(pu + 0.08, 0.86, 0.45);
    }
  });
}

/* -- Vending machine: the coil turns, and the snack finally falls --------- */

function paintVendingMachine(t: number): string {
  const cycle = (t * 0.32) % 1;
  const turn = clamp01(cycle / 0.55);
  /* The snack rides the coil out, tips, and then drops on its own. */
  const dropped = cycle > 0.55 ? Math.pow((cycle - 0.55) / 0.45, 2) : 0;
  const snackU = -0.55 + turn * 0.55;
  const snackV = -0.3 + dropped * 1.15;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 32; step += 1) {
      const f = step / 32;
      plot(-1.2 + f * 2.4, -0.94, 0.55);
      plot(-1.2 + f * 2.4, 0.94, 0.55);
      plot(-1.2, -0.94 + f * 1.88, 0.55);
      plot(1.2, -0.94 + f * 1.88, 0.55);
      plot(-1.2 + f * 2.4, 0.5, 0.4);
    }
    for (let shelf = 0; shelf < 2; shelf += 1) {
      const v = -0.62 + shelf * 0.62;
      for (let x = 0; x <= 20; x += 1) plot(-1.05 + (x / 20) * 2.1, v + 0.08, 0.25);
      /* Coils: a helix seen side on, unwinding as it pushes. */
      for (let step = 0; step <= 40; step += 1) {
        const f = step / 40;
        plot(-1 + f * 1.9, v + Math.sin(f * 26 - t * (shelf === 0 ? 4 : 0)) * 0.07, 0.6);
      }
    }
    for (let x = 0; x <= 8; x += 1) plot(-0.7 + (x / 8) * 1.4, 0.84, 0.4);
    plot(snackU, snackV, 1);
    plot(snackU + 0.12, snackV, 0.8);
    plot(snackU + 0.06, snackV + 0.12, 0.7);
  });
}

/* -- Espresso: two streams into a cup that fills, then steam off the wand - */

function paintEspressoMachine(t: number): string {
  const cycle = (t * 0.22) % 1;
  const pouring = cycle > 0.15 && cycle < 0.8;
  const level = 0.62 - clamp01((cycle - 0.15) / 0.65) * 0.42;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) {
      const u = -ASPECT + (x / 40) * ASPECT * 2;
      plot(u, -0.94, 0.5);
      plot(u, 0.9, 0.35);
    }
    for (let step = 0; step <= 14; step += 1) plot(-1.5, -0.94 + (step / 14) * 0.7, 0.4);
    /* Group head and the portafilter hanging off it. */
    for (let x = 0; x <= 10; x += 1) plot(-0.55 + (x / 10) * 0.6, -0.28, 0.75);
    for (let step = 0; step <= 6; step += 1) plot(-0.6 - (step / 6) * 0.45, -0.28 + (step / 6) * 0.1, 0.6);
    if (pouring) {
      for (let spout = 0; spout < 2; spout += 1) {
        const u = -0.4 + spout * 0.3;
        for (let step = 0; step <= 14; step += 1) {
          const f = step / 14;
          plot(u + Math.sin(t * 12 + step) * 0.015, -0.2 + f * (level + 0.2), 0.55 + f * 0.4);
        }
      }
    }
    /* Cup: walls, base, and the shot standing in it. */
    for (let step = 0; step <= 10; step += 1) {
      plot(-0.62, 0.6 - (step / 10) * 0.24, 0.7);
      plot(-0.08, 0.6 - (step / 10) * 0.24, 0.7);
    }
    for (let x = 0; x <= 10; x += 1) {
      plot(-0.62 + (x / 10) * 0.54, 0.62, 0.8);
      if (level < 0.6) plot(-0.6 + (x / 10) * 0.5, level, 0.95);
    }
    for (let wisp = 0; wisp < 5; wisp += 1) {
      const age = (t * 0.7 + wisp / 5) % 1;
      plot(0.85 + Math.sin(age * 6 + wisp) * 0.16, 0.3 - age * 0.9, (1 - age) * 0.7);
    }
    for (let step = 0; step <= 8; step += 1) plot(0.85, -0.3 + (step / 8) * 0.6, 0.55);
  });
}

/* -- Zoetrope: a drum whose slits show one frame of the figure at a time -- */

function paintZoetrope(t: number): string {
  const spin = t * 1.9;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 70; step += 1) {
      const angle = (step / 70) * TAU;
      plot(Math.cos(angle) * 1.3, -0.32 + Math.sin(angle) * 0.3, 0.32);
      plot(Math.cos(angle) * 1.3, 0.44 + Math.sin(angle) * 0.3, 0.5);
    }
    /* Only the near half of the drum is drawn, so it reads as solid. */
    for (let slit = 0; slit < 12; slit += 1) {
      const angle = spin + (slit / 12) * TAU;
      if (Math.sin(angle) < 0) continue;
      const u = Math.cos(angle) * 1.3;
      for (let step = 0; step <= 8; step += 1) {
        plot(u, -0.3 + Math.sin(angle) * 0.3 + (step / 8) * 0.72, 0.85);
      }
    }
    const frame = Math.floor(spin * 1.9) % 4;
    for (let limb = 0; limb < 5; limb += 1) {
      const reach = 0.16 + ((frame + limb) % 4) * 0.06;
      plot(Math.cos(limb * 1.3) * reach, 0.06 + Math.sin(limb * 1.3) * reach * 0.7, 0.9);
    }
    for (let step = 0; step <= 8; step += 1) plot(0, 0.76 + (step / 8) * 0.2, 0.4);
  });
}

/* -- Bellows: a squeeze on the handle, and the forge takes the air -------- */

function paintBellows(t: number): string {
  const beat = (t * 0.55) % 1;
  /* Fast squeeze, slow recovery, which is how a bellows is actually worked. */
  const squeeze = beat < 0.3 ? beat / 0.3 : 1 - (beat - 0.3) / 0.7;
  const gap = 0.5 - squeeze * 0.34;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 20; x += 1) {
      const u = -1.5 + (x / 20) * 1.4;
      plot(u, -gap, 0.7);
      plot(u, gap, 0.7);
    }
    /* Pleats between the boards, tightening as the boards come together. */
    for (let pleat = 0; pleat <= 6; pleat += 1) {
      const u = -1.45 + (pleat / 6) * 1.3;
      for (let step = 0; step <= 6; step += 1) {
        const f = step / 6;
        plot(u + (pleat % 2 === 0 ? 0.06 : -0.06) * Math.sin(f * Math.PI), -gap + f * gap * 2, 0.4);
      }
    }
    for (let step = 0; step <= 10; step += 1) plot(-0.1 + (step / 10) * 0.6, 0, 0.6);
    /* Coals brighten a moment after the squeeze reaches them. */
    const blast = clamp01(squeeze * 1.4 - 0.2);
    for (let coal = 0; coal < 12; coal += 1) {
      const cu = 0.55 + hash(coal * 2.7) * 0.9;
      const cv = 0.45 + hash(coal * 5.1) * 0.3;
      plot(cu, cv, 0.35 + blast * 0.65 * hash(coal * 8.3));
    }
    for (let spark = 0; spark < 7; spark += 1) {
      const age = (t * 1.3 + spark / 7) % 1;
      plot(0.7 + hash(spark) * 0.8 + age * 0.2, 0.5 - age * 1.3, (1 - age) * blast);
    }
  });
}

/* -- Pipe organ: keys pressed, and the pipes above them speak ------------- */

function paintPipeOrgan(t: number): string {
  return paintPlotted((plot) => {
    const chord = Math.floor(t * 1.1) % 3;
    for (let pipe = 0; pipe < 8; pipe += 1) {
      const u = -1.45 + (pipe / 7) * 2.9;
      const height = 0.34 + ((pipe * 3) % 7) * 0.09;
      const sounding = (pipe + chord) % 3 === 0;
      /* A sounding pipe breathes at its own pitch; the rest stand still. */
      const wind = sounding ? Math.sin(t * (7 + pipe)) * 0.5 + 0.5 : 0;
      for (let step = 0; step <= 14; step += 1) {
        const v = 0.3 - (step / 14) * height * 2;
        plot(u - 0.1, v, 0.22 + wind * 0.5);
        plot(u + 0.1, v, 0.22 + wind * 0.5);
      }
      plot(u, 0.3 - height * 2, 0.5 + wind * 0.5);
      plot(u, 0.24, 0.55 + wind * 0.45);
      /* The key for a sounding pipe sits a touch lower than the rest. */
      for (let x = 0; x <= 3; x += 1) {
        plot(u - 0.12 + (x / 3) * 0.24, 0.62 + (sounding ? 0.1 : 0), 0.45 + wind * 0.55);
      }
    }
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.86, 0.4);
  });
}

/* -- Harp: strings plucked in turn, each ringing down after it ------------ */

function paintHarp(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 24; step += 1) {
      const f = step / 24;
      plot(-1.5 + f * 0.6, 0.9 - f * 1.8, 0.55);
      plot(-1.5 + f * 2.9, 0.9, 0.55);
    }
    const struck = Math.floor(t * 3) % 9;
    for (let string = 0; string < 9; string += 1) {
      const u = -0.85 + (string / 8) * 2.1;
      const top = -0.9 + (string / 8) * 1.15;
      /* Ring-down: loudest right after the pluck, gone before the next one. */
      const age = (t * 3) % 1;
      const ring = string === struck ? (1 - age) * 0.16 : 0;
      for (let step = 0; step <= 16; step += 1) {
        const f = step / 16;
        const swing = Math.sin(f * Math.PI) * ring * Math.sin(t * 40 + string);
        plot(u + swing, top + f * (0.9 - top), 0.35 + (string === struck ? 0.6 : 0.15));
      }
    }
  });
}

/* -- Drum kit: sticks alternating, cymbal still shimmering ---------------- */

function paintDrumKit(t: number): string {
  const beat = (t * 2.4) % 1;
  const hit = Math.floor(t * 2.4) % 4;
  const rebound = Math.pow(beat, 0.5) * 0.5;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 40; x += 1) plot(-ASPECT + (x / 40) * ASPECT * 2, 0.94, 0.35);
    /* Snare and floor tom, each with a head that dishes when struck. */
    for (const [cu, cv, size, index] of [
      [-0.45, 0.35, 0.42, 0],
      [0.75, 0.5, 0.5, 2],
    ] as const) {
      const dish = hit === index ? (1 - beat) * 0.1 : 0;
      for (let step = 0; step <= 24; step += 1) {
        const f = (step / 24) * TAU;
        plot(cu + Math.cos(f) * size, cv + Math.sin(f) * size * 0.32 + dish, 0.6);
      }
      for (let step = 0; step <= 8; step += 1) {
        plot(cu - size, cv + (step / 8) * 0.4, 0.45);
        plot(cu + size, cv + (step / 8) * 0.4, 0.45);
      }
    }
    /* Cymbal: still ringing several beats after it was hit. */
    const wash = Math.abs(Math.sin(t * 9)) * 0.4;
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(-1.2 + f * 0.9, -0.42 + Math.sin(f * Math.PI + t * 6) * 0.06, 0.5 + wash);
    }
    for (let step = 0; step <= 8; step += 1) plot(-0.75, -0.38 + (step / 8) * 0.6, 0.35);
    for (const [tipU, tipV, index] of [
      [-0.45, 0.2, 0],
      [0.75, 0.36, 2],
    ] as const) {
      const raise = hit === index ? rebound : 0.5;
      for (let step = 0; step <= 8; step += 1) {
        plot(tipU + 0.4 - (step / 8) * 0.5, tipV - raise - (step / 8) * 0.2, 0.85);
      }
    }
  });
}

/* -- Xylophone: a mallet bouncing its way along the bars ------------------ */

function paintXylophone(t: number): string {
  const step = t * 2.6;
  const bar = Math.floor(step) % 8;
  const hop = step % 1;
  const malletU = -1.4 + ((bar + hop) / 8) * 2.8;
  /* Arc between bars: highest halfway, landing right on the beat. */
  const malletV = -0.15 - Math.sin(hop * Math.PI) * 0.55;
  return paintPlotted((plot) => {
    for (let index = 0; index < 8; index += 1) {
      const u = -1.4 + (index / 8) * 2.8 + 0.175;
      const width = 0.62 - index * 0.045;
      const struck = index === bar ? (1 - hop) * 0.06 : 0;
      for (let x = 0; x <= 12; x += 1) {
        const across = -0.15 + (x / 12) * 0.3;
        plot(u + across, 0.15 - width * 0.5 + struck, 0.45 + (index === bar ? 0.5 : 0));
        plot(u + across, 0.15 + width * 0.5 + struck, 0.45 + (index === bar ? 0.5 : 0));
      }
      for (let y = 0; y <= 10; y += 1) {
        const along = 0.15 + (-0.5 + y / 10) * width + struck;
        plot(u - 0.15, along, 0.4 + (index === bar ? 0.45 : 0));
        plot(u + 0.15, along, 0.4 + (index === bar ? 0.45 : 0));
      }
    }
    for (let shaft = 0; shaft <= 8; shaft += 1) {
      plot(malletU + (shaft / 8) * 0.45, malletV - (shaft / 8) * 0.35, 0.6);
    }
    plot(malletU, malletV, 1);
    plot(malletU - 0.07, malletV, 0.85);
  });
}

/* -- Music box: a pinned cylinder plucking the teeth of a comb ------------ */

function paintMusicBox(t: number): string {
  const turn = t * 1.1;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 30; step += 1) {
      const f = (step / 30) * TAU;
      plot(-0.6 + Math.cos(f) * 0.55, 0.25 + Math.sin(f) * 0.55, 0.4);
    }
    /* Pins on the near face of the cylinder, sweeping down onto the comb. */
    let plucked = -1;
    for (let pin = 0; pin < 14; pin += 1) {
      const angle = turn * 2 + pin * 1.7;
      const wrapped = ((angle % TAU) + TAU) % TAU;
      if (wrapped > Math.PI) continue;
      const tooth = pin % 7;
      const reach = Math.sin(wrapped);
      plot(-0.6 + Math.cos(wrapped) * 0.55, 0.25 + reach * 0.55, 0.5 + reach * 0.45);
      if (reach > 0.94) plucked = tooth;
    }
    for (let tooth = 0; tooth < 7; tooth += 1) {
      const v = -0.6 + (tooth / 6) * 1.35;
      const flex = tooth === plucked ? Math.sin(t * 45) * 0.07 : 0;
      for (let x = 0; x <= 14; x += 1) {
        const f = x / 14;
        plot(0.35 + f * 1.1, v + flex * f, 0.4 + (tooth === plucked ? 0.55 : 0.1) * f);
      }
    }
    for (let step = 0; step <= 12; step += 1) plot(0.32, -0.62 + (step / 12) * 1.4, 0.5);
  });
}

/* -- Theremin: a hand near the antenna, and the tone that answers it ------ */

function paintTheremin(t: number): string {
  const hand = Math.sin(t * 0.8) * 0.5 + 0.5;
  /* Kept to a few cycles across the frame: any more and it aliases into noise. */
  const cycles = 1.2 + hand * 2.6;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 16; step += 1) plot(1.35, 0.6 - (step / 16) * 1.5, 0.6);
    for (let x = 0; x <= 14; x += 1) plot(-1.5 + (x / 14) * 0.9, 0.6, 0.5);
    for (let x = 0; x <= 20; x += 1) plot(-1.5 + (x / 20) * 2.9, 0.74, 0.45);
    /* The waveform is the instrument's answer, so it takes most of the frame. */
    for (let sample = 0; sample <= 140; sample += 1) {
      const f = sample / 140;
      const u = -1.5 + f * 2.6;
      plot(u, 0.1 + Math.sin(f * cycles * TAU - t * 6) * (0.2 + hand * 0.42) * clamp01(1.4 - f), 0.85);
    }
    const handU = 1.35 - 0.15 - hand * 0.8;
    for (let finger = 0; finger < 4; finger += 1) {
      plot(handU + finger * 0.07, -0.55 + Math.abs(finger - 1.5) * 0.05, 0.95);
    }
    plot(handU - 0.1, -0.42, 0.8);
    /* Rings off the antenna, spaced by how close the hand is. */
    for (let ring = 0; ring < 3; ring += 1) {
      const spread = ((t * 0.9 + ring / 3) % 1) * (0.3 + hand * 0.8);
      for (let step = 0; step <= 18; step += 1) {
        const angle = -Math.PI / 2 + (step / 18) * Math.PI;
        plot(1.35 - Math.cos(angle) * spread, -0.2 + Math.sin(angle) * spread * 1.6, 0.4);
      }
    }
  });
}

/* -- Tuning fork: struck, then the tines close in on being still ---------- */

function paintTuningFork(t: number): string {
  const cycle = (t * 0.5) % 1;
  /* Amplitude decays across the cycle and resets at the next strike. */
  const decay = Math.pow(1 - cycle, 2.2);
  const spread = Math.sin(t * 34) * 0.12 * decay;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) plot(0, 0.95 - (step / 14) * 0.5, 0.6);
    for (let x = 0; x <= 8; x += 1) plot(-0.24 + (x / 8) * 0.48, 0.44, 0.6);
    for (let side = -1; side <= 1; side += 2) {
      for (let step = 0; step <= 18; step += 1) {
        const f = step / 18;
        plot(side * (0.24 + spread * f * f), 0.44 - f * 1.35, 0.55 + f * 0.4);
      }
    }
    /* Fronts leaving the tines, spaced by the note rather than the strike. */
    for (let front = 0; front < 4; front += 1) {
      const out = ((t * 1.5 + front / 4) % 1) * 1.5;
      const level = (1 - out / 1.5) * decay * 0.8;
      for (let step = 0; step <= 20; step += 1) {
        const angle = (step / 20) * TAU;
        plot(Math.cos(angle) * out, -0.25 + Math.sin(angle) * out * 0.8, level);
      }
    }
  });
}

/* -- Dartboard: darts arriving one at a time, then the board is cleared --- */

function paintDartboard(t: number): string {
  const round = Math.floor(t / 4.5);
  const age = t - round * 4.5;
  return paintPlotted((plot) => {
    for (let ring = 1; ring <= 3; ring += 1) {
      const radius = ring * 0.28;
      for (let step = 0; step <= 40; step += 1) {
        const angle = (step / 40) * TAU;
        plot(Math.cos(angle) * radius * 1.6, Math.sin(angle) * radius, ring === 3 ? 0.5 : 0.32);
      }
    }
    for (let wedge = 0; wedge < 10; wedge += 1) {
      const angle = (wedge / 10) * TAU;
      for (let step = 3; step <= 8; step += 1) {
        const f = (step / 8) * 0.84;
        plot(Math.cos(angle) * f * 1.6, Math.sin(angle) * f, 0.28);
      }
    }
    plot(0, 0, 0.9);
    for (let dart = 0; dart < 3; dart += 1) {
      const thrown = age - dart * 1.2;
      if (thrown < 0) continue;
      const flight = clamp01(thrown / 0.5);
      const angle = hash(round * 3.1 + dart * 5.7) * TAU;
      const radius = 0.15 + hash(round * 7.3 + dart) * 0.6;
      const targetU = Math.cos(angle) * radius * 1.6;
      const targetV = Math.sin(angle) * radius;
      /* In flight the dart comes in from the right and shrinks onto the board. */
      const u = targetU + (1 - flight) * 2.4;
      const v = targetV - (1 - flight) * 0.5;
      plot(u, v, 1);
      for (let tail = 1; tail <= 4; tail += 1) plot(u + tail * 0.09, v - tail * 0.02, 0.75 - tail * 0.12);
    }
  });
}

/* -- Foosball: rods spinning as the ball crosses between them ------------- */

function paintFoosball(t: number): string {
  const ballU = Math.sin(t * 1.3) * 1.35;
  const ballV = Math.sin(t * 2.1 + 1) * 0.55;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, -0.9, 0.45);
      plot(u, 0.9, 0.45);
      if (x % 6 === 0) plot(u, 0, 0.16);
    }
    for (let rod = 0; rod < 4; rod += 1) {
      const u = -1.15 + (rod / 3) * 2.3;
      for (let step = 0; step <= 14; step += 1) plot(u, -0.9 + (step / 14) * 1.8, 0.3);
      /* Each rod spins its own way; the men swing through the vertical. */
      const angle = t * (2 + rod * 0.7) * (rod % 2 === 0 ? 1 : -1);
      for (let man = 0; man < 3; man += 1) {
        const v = -0.55 + man * 0.55;
        const kick = Math.sin(angle + man * 0.4);
        for (let leg = 0; leg <= 5; leg += 1) {
          plot(u + kick * (leg / 5) * 0.3, v + (leg / 5) * 0.12, 0.55 + Math.abs(kick) * 0.4);
        }
        plot(u, v - 0.1, 0.8);
      }
    }
    plot(ballU, ballV, 1);
    plot(ballU - 0.08, ballV, 0.7);
  });
}

/* -- Air hockey: a puck off the cushions with the mallets tracking it ----- */

function paintAirHockey(t: number): string {
  /* Triangle waves are what make the puck bounce instead of oscillate. */
  const bounce = (phase: number, limit: number) => {
    const wrapped = phase % 2;
    return (wrapped < 1 ? wrapped : 2 - wrapped) * limit * 2 - limit;
  };
  const puckU = bounce(t * 0.55, 1.25);
  const puckV = bounce(t * 0.83 + 0.4, 0.62);
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, -0.86, 0.5);
      plot(u, 0.86, 0.5);
      if (Math.abs(u) < 0.03) for (let y = 0; y <= 14; y += 1) plot(u, -0.86 + (y / 14) * 1.72, 0.2);
    }
    for (let step = 0; step <= 12; step += 1) {
      const v = -0.4 + (step / 12) * 0.8;
      plot(-1.5, v, 0.6);
      plot(1.5, v, 0.6);
    }
    for (const side of [-1, 1] as const) {
      /* A mallet only chases the puck while the puck is on its half. */
      const chase = Math.sign(puckU) === side ? puckV : puckV * 0.4;
      const u = side * 1.15;
      for (let step = 0; step <= 14; step += 1) {
        const angle = (step / 14) * TAU;
        plot(u + Math.cos(angle) * 0.22, chase + Math.sin(angle) * 0.22, 0.7);
      }
      plot(u, chase, 0.9);
    }
    for (let step = 0; step <= 12; step += 1) {
      const angle = (step / 12) * TAU;
      plot(puckU + Math.cos(angle) * 0.13, puckV + Math.sin(angle) * 0.13, 1);
    }
  });
}

/* -- Roulette: the wheel slows, the ball drops and settles in a pocket ---- */

function paintRouletteWheel(t: number): string {
  const round = Math.floor(t / 6);
  const age = t - round * 6;
  const wheel = t * (1.4 - clamp01(age / 6) * 0.9);
  /* The ball outruns the wheel, falls inwards, then rides along with it. */
  const settled = clamp01((age - 3.4) / 1.2);
  const ballRadius = 1.05 - settled * 0.22;
  const ballAngle = settled < 1 ? -age * (5 - settled * 3.4) : -wheel * 1.02 + round;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 60; step += 1) {
      const angle = (step / 60) * TAU;
      plot(Math.cos(angle) * 1.5, Math.sin(angle) * 0.94, 0.4);
    }
    for (let pocket = 0; pocket < 18; pocket += 1) {
      const angle = wheel + (pocket / 18) * TAU;
      for (let step = 6; step <= 10; step += 1) {
        const f = step / 10;
        plot(Math.cos(angle) * f * 1.35, Math.sin(angle) * f * 0.84, pocket % 2 === 0 ? 0.6 : 0.28);
      }
    }
    for (let step = 0; step <= 30; step += 1) {
      const angle = (step / 30) * TAU;
      plot(Math.cos(angle) * 0.55, Math.sin(angle) * 0.34, 0.5);
    }
    for (let spoke = 0; spoke < 4; spoke += 1) {
      const angle = wheel + (spoke / 4) * TAU;
      for (let step = 0; step <= 6; step += 1) {
        plot(Math.cos(angle) * (step / 6) * 0.5, Math.sin(angle) * (step / 6) * 0.32, 0.55);
      }
    }
    plot(Math.cos(ballAngle) * ballRadius * 1.4, Math.sin(ballAngle) * ballRadius * 0.88, 1);
  });
}

/* -- Dice: two dice tumbling across the felt and coming to rest ----------- */

function paintDiceRoll(t: number): string {
  const round = Math.floor(t / 3.2);
  const age = (t - round * 3.2) / 3.2;
  const roll = clamp01(age / 0.55);
  const pips: ReadonlyArray<readonly (readonly [number, number])[]> = [
    [[0, 0]],
    [
      [-0.13, -0.13],
      [0.13, 0.13],
    ],
    [
      [-0.13, -0.13],
      [0, 0],
      [0.13, 0.13],
    ],
    [
      [-0.13, -0.13],
      [0.13, -0.13],
      [-0.13, 0.13],
      [0.13, 0.13],
    ],
  ];
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.9, 0.3);
    for (let die = 0; die < 2; die += 1) {
      const start = -1.35 + die * 0.3;
      const rest = 0.2 + die * 0.85;
      const u = start + (rest - start) * roll;
      /* Hops that shrink as the die loses its energy. */
      const v = 0.55 - Math.abs(Math.sin(roll * Math.PI * 3.5)) * (1 - roll) * 0.7;
      const spin = roll < 1 ? t * 6 + die : 0;
      for (let step = 0; step <= 24; step += 1) {
        const angle = spin + (step / 24) * TAU;
        const corner = Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
        plot(u + (Math.cos(angle) / corner) * 0.3, v + (Math.sin(angle) / corner) * 0.3, 0.6);
      }
      const face = pips[(round * 2 + die + (roll < 1 ? Math.floor(t * 9) : 0)) % pips.length]!;
      for (const [pu, pv] of face) {
        plot(u + pu * Math.cos(spin) - pv * Math.sin(spin), v + pu * Math.sin(spin) + pv * Math.cos(spin), 1);
      }
    }
  });
}

/* -- Jenga: a block worked out of the stack, and the stack leaning after -- */

function paintJenga(t: number): string {
  const cycle = (t * 0.35) % 1;
  const pull = cycle < 0.6 ? cycle / 0.6 : 1;
  const lean = cycle > 0.6 ? Math.sin((cycle - 0.6) * 18) * (1 - (cycle - 0.6) / 0.4) * 0.09 : 0;
  const loose = 4;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.94, 0.35);
    for (let course = 0; course < 8; course += 1) {
      const v = 0.86 - course * 0.22;
      const tilt = lean * (course / 8);
      /* Alternating courses, drawn as three blocks or one long band. */
      for (let block = 0; block < 3; block += 1) {
        if (course === loose && block === 1) continue;
        const centre = -0.6 + block * 0.6;
        for (let x = 0; x <= 8; x += 1) {
          const u = centre - 0.26 + (x / 8) * 0.52 + tilt;
          plot(u, v, course % 2 === 0 ? 0.75 : 0.45);
          plot(u, v - 0.14, course % 2 === 0 ? 0.55 : 0.3);
        }
      }
    }
    const outU = -0.6 + 0.6 + pull * 1.9;
    const outV = 0.86 - loose * 0.22 + lean * (loose / 8);
    for (let x = 0; x <= 8; x += 1) {
      const u = outU - 0.26 + (x / 8) * 0.52;
      plot(u, outV, 0.95);
      plot(u, outV - 0.14, 0.7);
    }
    /* Two fingers stay on the block the whole way out. */
    plot(outU + 0.34, outV - 0.3, 0.8);
    plot(outU + 0.34, outV + 0.06, 0.8);
  });
}

/* -- Card shuffle: two halves riffled together and squared up ------------- */

function paintCardShuffle(t: number): string {
  const cycle = (t * 0.4) % 1;
  /* Split, riffle, square: each phase gets its own third of the cycle. */
  const split = cycle < 0.3 ? cycle / 0.3 : cycle < 0.75 ? 1 - (cycle - 0.3) / 0.45 : 0;
  const riffle = cycle > 0.3 && cycle < 0.75 ? (cycle - 0.3) / 0.45 : cycle >= 0.75 ? 1 : 0;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.92, 0.3);
    for (let card = 0; card < 16; card += 1) {
      const half = card % 2;
      const index = Math.floor(card / 2);
      const gap = split * (half === 0 ? -0.85 : 0.85);
      /* Cards fall into the merged stack in order, one after another. */
      const merged = clamp01(riffle * 16 - card);
      const u = gap * (1 - merged);
      const v = 0.8 - (merged * card + (1 - merged) * index * 2) * 0.045 - Math.sin(merged * Math.PI) * 0.35;
      for (let x = 0; x <= 10; x += 1) {
        plot(u - 0.42 + (x / 10) * 0.84, v, 0.4 + (half === 0 ? 0.35 : 0.5));
      }
      plot(u - 0.42, v - 0.03, 0.7);
      plot(u + 0.42, v - 0.03, 0.7);
    }
  });
}

/* -- Kendama: the ball swung up and caught in the cup -------------------- */

function paintKendama(t: number): string {
  const cycle = (t * 0.45) % 1;
  /* Swing out, up over the top, and down into the cup, then hang again. */
  const arc = cycle < 0.75 ? cycle / 0.75 : 1;
  const angle = -Math.PI / 2 + arc * TAU;
  const slack = cycle < 0.75 ? 0.62 : 0.62 - (1 - (cycle - 0.75) / 0.25) * 0.02;
  const cupU = Math.sin(t * 0.9) * 0.25;
  const cupV = -0.1;
  const ballU = cupU + Math.cos(angle) * slack * 1.5;
  const ballV = cupV + Math.sin(angle) * slack;
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) plot(cupU, cupV + (step / 14) * 0.85, 0.6);
    for (let x = 0; x <= 10; x += 1) {
      const u = cupU - 0.28 + (x / 10) * 0.56;
      plot(u, cupV, 0.7);
    }
    for (let step = 0; step <= 5; step += 1) {
      plot(cupU - 0.28, cupV - (step / 5) * 0.16, 0.65);
      plot(cupU + 0.28, cupV - (step / 5) * 0.16, 0.65);
    }
    for (let step = 0; step <= 6; step += 1) plot(cupU - 0.34 - (step / 6) * 0.3, cupV + 0.3, 0.55);
    /* The string only draws when it is taut, which reads as the catch. */
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(cupU + (ballU - cupU) * f, cupV + 0.32 + (ballV - cupV - 0.32) * f, 0.25);
    }
    for (let step = 0; step <= 16; step += 1) {
      const around = (step / 16) * TAU;
      plot(ballU + Math.cos(around) * 0.2, ballV + Math.sin(around) * 0.2, 0.9);
    }
    plot(ballU, ballV, 1);
  });
}

/* -- Plough: a share turning furrows that stay behind it ------------------ */

function paintPlough(t: number): string {
  const span = ASPECT * 2 + 1.6;
  const travel = ASPECT + 0.8 - ((t * 0.4) % 1) * span;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      /* Ground behind the share is broken; ahead of it, still flat. */
      const broken = u > travel ? 0 : Math.abs(Math.sin(u * 7)) * 0.12;
      plot(u, 0.45 + broken, u > travel ? 0.35 : 0.65);
      if (u <= travel) plot(u, 0.62 + Math.sin(u * 9) * 0.08, 0.45);
    }
    for (let furrow = 0; furrow < 3; furrow += 1) {
      const v = 0.66 + furrow * 0.12;
      for (let x = 0; x <= 30; x += 1) {
        const u = -ASPECT + (x / 30) * (travel + ASPECT);
        if (u > travel) continue;
        plot(u, v + Math.sin(u * 6 + furrow) * 0.04, 0.3 + furrow * 0.12);
      }
    }
    /* Beam, share, and the wheel that sets the depth. */
    for (let step = 0; step <= 14; step += 1) plot(travel + (step / 14) * 1.05, -0.05 - (step / 14) * 0.25, 0.6);
    for (let step = 0; step <= 8; step += 1) plot(travel, -0.05 + (step / 8) * 0.5, 0.7);
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(travel - f * 0.3, 0.45 - f * 0.06, 0.85);
    }
    const angle = t * 4;
    for (let spoke = 0; spoke < 4; spoke += 1) {
      const a = angle + (spoke / 4) * Math.PI;
      plot(travel + 1.05 + Math.cos(a) * 0.22, 0.22 + Math.sin(a) * 0.22, 0.7);
    }
  });
}

/* -- Combine: a reel feeding the header, grain going up the auger --------- */

function paintCombine(t: number): string {
  const span = ASPECT * 2 + 2;
  const travel = ASPECT + 1 - ((t * 0.22) % 1) * span;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.9, 0.35);
      /* Standing crop ahead of the header, stubble behind it. */
      if (u < travel - 1.1) {
        for (let step = 0; step <= 4; step += 1) plot(u, 0.9 - (step / 4) * 0.55, 0.4);
      } else {
        plot(u, 0.82, 0.3);
      }
    }
    for (let x = 0; x <= 16; x += 1) {
      const u = travel - 0.4 + (x / 16) * 1.35;
      plot(u, 0.1, 0.75);
      plot(u, 0.68, 0.6);
    }
    for (let step = 0; step <= 8; step += 1) {
      plot(travel - 0.4, 0.1 + (step / 8) * 0.58, 0.7);
      plot(travel + 0.95, 0.1 + (step / 8) * 0.58, 0.7);
    }
    /* Reel bats sweeping the crop into the header. */
    const reel = -t * 3;
    for (let bat = 0; bat < 6; bat += 1) {
      const angle = reel + (bat / 6) * TAU;
      plot(travel - 1.05 + Math.cos(angle) * 0.34, 0.42 + Math.sin(angle) * 0.34, 0.85);
    }
    for (let step = 0; step <= 10; step += 1) plot(travel - 1.35 + (step / 10) * 0.95, 0.78, 0.6);
    /* Auger throwing grain out over the tank. */
    for (let step = 0; step <= 12; step += 1) {
      plot(travel + 0.95 + (step / 12) * 0.9, 0.1 - (step / 12) * 0.55, 0.55);
    }
    for (let grain = 0; grain < 6; grain += 1) {
      const age = (t * 1.4 + grain / 6) % 1;
      plot(travel + 1.85 - age * 0.5, -0.45 + age * age * 1.1, 0.8);
    }
    for (const [wu, size] of [
      [travel - 0.1, 0.24],
      [travel + 0.8, 0.15],
    ] as const) {
      const angle = t * 3;
      for (let spoke = 0; spoke < 4; spoke += 1) {
        const a = angle + (spoke / 4) * Math.PI;
        plot(wu + Math.cos(a) * size, 0.78 + Math.sin(a) * size, 0.75);
      }
    }
  });
}

/* -- Gondola: one oar, one stroke, and the wake it leaves ---------------- */

function paintGondola(t: number): string {
  const stroke = (t * 0.7) % 1;
  const glide = Math.sin(t * 0.7) * 0.2;
  const bob = Math.sin(t * 1.4) * 0.05;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.55 + Math.sin(u * 3.5 - t * 1.8) * 0.06, 0.3);
      /* Wake behind the stern, fading with distance. */
      if (u > glide + 0.9) plot(u, 0.55 + Math.sin(u * 8 - t * 5) * 0.09, clamp01(1.6 - (u - glide) * 0.7) * 0.4);
    }
    /* Hull: a long curve rising to a point at each end. */
    for (let step = 0; step <= 40; step += 1) {
      const f = step / 40;
      const u = glide - 1.3 + f * 2.6;
      const curve = Math.pow(Math.abs(f * 2 - 1), 3);
      plot(u, 0.5 + bob - curve * 0.55, 0.75);
      plot(u, 0.5 + bob - curve * 0.3 - 0.1, 0.4);
    }
    /* The gondolier stands aft; the oar sweeps and lifts clear. */
    const rower = glide + 0.75;
    for (let step = 0; step <= 8; step += 1) plot(rower, 0.34 + bob - (step / 8) * 0.55, 0.8);
    plot(rower, -0.3 + bob, 0.95);
    const sweep = Math.sin(stroke * TAU) * 0.55;
    const lift = stroke > 0.5 ? 0.12 : 0;
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(rower - 0.1 + f * (0.95 + sweep), 0.05 + bob + f * (0.5 - lift), 0.65);
    }
  });
}

/* -- Hovercraft: a skirt riding a cushion, throwing spray both ways ------- */

function paintHovercraft(t: number): string {
  const drift = Math.sin(t * 0.55) * 0.9;
  const ride = Math.sin(t * 2.6) * 0.05;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.78 + Math.sin(u * 5 - t * 3) * 0.05, 0.3);
    }
    for (let x = 0; x <= 20; x += 1) {
      const u = drift - 0.95 + (x / 20) * 1.9;
      plot(u, 0.1 + ride, 0.75);
      plot(u, 0.42 + ride, 0.5);
    }
    /* The skirt is a row of lobes, squashed where it meets the water. */
    for (let lobe = 0; lobe < 7; lobe += 1) {
      const u = drift - 0.85 + (lobe / 6) * 1.7;
      for (let step = 0; step <= 10; step += 1) {
        const angle = (step / 10) * Math.PI;
        plot(u + Math.cos(angle) * 0.15, 0.5 + ride + Math.sin(angle) * 0.16, 0.55);
      }
    }
    /* Lift fan behind the cabin. */
    const spin = t * 7;
    for (let blade = 0; blade < 4; blade += 1) {
      const angle = spin + (blade / 4) * TAU;
      for (let step = 2; step <= 6; step += 1) {
        const reach = (step / 6) * 0.35;
        plot(drift + 0.75 + Math.cos(angle) * reach * 0.5, -0.25 + ride + Math.sin(angle) * reach, 0.7);
      }
    }
    for (let step = 0; step <= 8; step += 1) plot(drift + 0.75, 0.1 + ride - (step / 8) * 0.3, 0.5);
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(drift - 0.5 + f * 0.7, 0.1 + ride - f * 0.4, 0.65);
    }
    for (let drop = 0; drop < 12; drop += 1) {
      const side = drop % 2 === 0 ? -1 : 1;
      const age = (t * 1.8 + drop / 12) % 1;
      plot(drift + side * (0.95 + age * 0.8), 0.66 + ride - Math.sin(age * Math.PI) * 0.3, (1 - age) * 0.75);
    }
  });
}

/* -- Rally car: suspension working over a road that keeps coming ---------- */

function paintRallyCar(t: number): string {
  const scroll = t * 1.6;
  const groundAt = (u: number) => 0.62 + Math.sin((u + scroll) * 1.9) * 0.16 + Math.sin((u + scroll) * 4.7) * 0.06;
  const frontV = groundAt(0.55);
  const rearV = groundAt(-0.55);
  /* The body rides the average of the two wheels and pitches between them. */
  const bodyV = (frontV + rearV) / 2 - 0.34;
  const pitch = (frontV - rearV) * 0.5;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 60; x += 1) {
      const u = -ASPECT + (x / 60) * ASPECT * 2;
      plot(u, groundAt(u), 0.5);
      plot(u, groundAt(u) + 0.18, 0.25);
    }
    for (let x = 0; x <= 18; x += 1) {
      const f = x / 18;
      const u = -0.95 + f * 1.9;
      plot(u, bodyV + (f - 0.5) * pitch, 0.8);
      /* Cabin: a shorter, higher line over the middle of the body. */
      if (f > 0.25 && f < 0.8) plot(u, bodyV - 0.3 + (f - 0.5) * pitch, 0.6);
    }
    plot(-0.5, bodyV - 0.3 + pitch * -0.25, 0.6);
    plot(0.6, bodyV - 0.3 + pitch * 0.25, 0.6);
    for (const [wu, wv] of [
      [-0.55, rearV],
      [0.55, frontV],
    ] as const) {
      const angle = -scroll * 2.4;
      for (let spoke = 0; spoke < 5; spoke += 1) {
        const a = angle + (spoke / 5) * TAU;
        plot(wu + Math.cos(a) * 0.2, wv - 0.18 + Math.sin(a) * 0.2, 0.85);
      }
      plot(wu, wv - 0.18, 0.5);
    }
    for (let grit = 0; grit < 9; grit += 1) {
      const age = (t * 2.2 + grit / 9) % 1;
      plot(-0.75 - age * 1.5, rearV - 0.1 - Math.sin(age * Math.PI) * 0.45, (1 - age) * 0.6);
    }
  });
}

/* -- Funicular: two cars on one rope, passing at the loop ---------------- */

function paintFunicular(t: number): string {
  const cycle = (t * 0.22) % 2;
  const along = cycle < 1 ? cycle : 2 - cycle;
  const track = (f: number): readonly [number, number] => [-1.45 + f * 2.9, 0.82 - f * 1.5];
  return paintPlotted((plot) => {
    for (let step = 0; step <= 60; step += 1) {
      const [u, v] = track(step / 60);
      plot(u, v, 0.4);
      plot(u, v + 0.1, 0.2);
      /* Sleepers, spaced so the grade reads even at this size. */
      if (step % 5 === 0) plot(u, v + 0.05, 0.5);
    }
    for (const [f, weight] of [
      [along, 0.9],
      [1 - along, 0.7],
    ] as const) {
      const [u, v] = track(f);
      /* Bodies stay level even though the track does not. */
      for (let x = 0; x <= 8; x += 1) {
        const bu = u - 0.24 + (x / 8) * 0.48;
        plot(bu, v - 0.12, weight);
        plot(bu, v - 0.4, weight * 0.8);
      }
      for (let y = 0; y <= 5; y += 1) {
        plot(u - 0.24, v - 0.12 - (y / 5) * 0.28, weight * 0.85);
        plot(u + 0.24, v - 0.12 - (y / 5) * 0.28, weight * 0.85);
      }
    }
    /* The haul rope between the two cars, over the top pulley. */
    const [au, av] = track(along);
    const [bu, bv] = track(1 - along);
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(au + (bu - au) * f, av - 0.06 + (bv - av) * f, 0.3);
    }
    for (let step = 0; step <= 14; step += 1) {
      const angle = (step / 14) * TAU;
      plot(1.45 + Math.cos(angle) * 0.14, -0.68 + Math.sin(angle) * 0.14, 0.55);
    }
  });
}

/* -- Car wash: a car pulled through brushes that keep turning ------------- */

function paintCarWash(t: number): string {
  const span = ASPECT * 2 + 2.2;
  const travel = -ASPECT - 1.1 + ((t * 0.3) % 1) * span;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.9, 0.4);
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(-1.5, -0.9 + f * 1.8, 0.35);
      plot(1.5, -0.9 + f * 1.8, 0.35);
      plot(-1.5 + f * 3, -0.9, 0.35);
    }
    /* Car body, plus the water sheeting off it once it is under the arch. */
    for (let x = 0; x <= 16; x += 1) {
      const f = x / 16;
      const u = travel - 0.8 + f * 1.6;
      plot(u, 0.7, 0.75);
      if (f > 0.2 && f < 0.85) plot(u, 0.36, 0.55);
    }
    plot(travel - 0.48, 0.52, 0.55);
    plot(travel + 0.56, 0.52, 0.55);
    for (const wheel of [-0.45, 0.5]) {
      const angle = t * 2.2;
      plot(travel + wheel + Math.cos(angle) * 0.13, 0.8 + Math.sin(angle) * 0.13, 0.8);
    }
    for (const [bu, direction] of [
      [-0.65, 1],
      [0.65, -1],
    ] as const) {
      const spin = t * 4 * direction;
      for (let bristle = 0; bristle < 10; bristle += 1) {
        const angle = spin + (bristle / 10) * TAU;
        for (let step = 3; step <= 6; step += 1) {
          const reach = (step / 6) * 0.36;
          plot(bu + Math.cos(angle) * reach, 0.1 + Math.sin(angle) * reach, 0.5 + step * 0.06);
        }
      }
      for (let step = 0; step <= 10; step += 1) plot(bu, -0.85 + (step / 10) * 0.6, 0.3);
    }
    for (let jet = 0; jet < 10; jet += 1) {
      const age = (t * 2.4 + jet / 10) % 1;
      plot(-1.2 + (jet / 9) * 2.4, -0.7 + age * 0.7, (1 - age) * 0.5);
    }
  });
}

/* -- Rivet gun: a line of rivets set one at a time along a plate ---------- */

function paintRivetGun(t: number): string {
  const step = t * 0.9;
  const index = Math.floor(step) % 9;
  const beat = step % 1;
  /* Hammer blows are fast and repeated; the gun only moves between rivets. */
  const hammer = beat < 0.65 ? Math.abs(Math.sin(beat * 34)) * 0.16 : 0.3 + (beat - 0.65) * 0.5;
  const gunU = -1.3 + index * 0.32 + (beat > 0.65 ? (beat - 0.65) / 0.35 : 0) * 0.32;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) {
      const u = -ASPECT + (x / 44) * ASPECT * 2;
      plot(u, 0.5, 0.6);
      plot(u, 0.86, 0.45);
    }
    for (let rivet = 0; rivet < 9; rivet += 1) {
      const u = -1.3 + rivet * 0.32;
      plot(u, 0.68, rivet <= index ? 0.95 : 0.25);
      if (rivet <= index) plot(u, 0.62, 0.6);
    }
    for (let step2 = 0; step2 <= 10; step2 += 1) {
      plot(gunU, 0.38 - hammer - (step2 / 10) * 0.45, 0.75);
    }
    for (let x = 0; x <= 6; x += 1) plot(gunU - 0.12 + (x / 6) * 0.24, 0.44 - hammer, 0.9);
    for (let step2 = 0; step2 <= 8; step2 += 1) {
      plot(gunU + (step2 / 8) * 0.55, -0.07 - hammer - (step2 / 8) * 0.35, 0.55);
    }
    /* Sparks only while the hammer is actually working. */
    if (beat < 0.65) {
      for (let spark = 0; spark < 5; spark += 1) {
        const age = (t * 6 + spark / 5) % 1;
        plot(gunU + (hash(spark) - 0.5) * 1.1 * age, 0.5 - Math.sin(age * Math.PI) * 0.5, (1 - age) * 0.8);
      }
    }
  });
}

/* -- Cherry picker: the boom extends, lifts, and slews back --------------- */

function paintCherryPicker(t: number): string {
  const cycle = (t * 0.24) % 1;
  const raise = Math.sin(cycle * TAU - Math.PI / 2) * 0.5 + 0.5;
  const extend = 0.75 + (Math.sin(cycle * TAU * 2) * 0.5 + 0.5) * 0.9;
  const angle = -0.15 - raise * 0.95;
  const pivotU = -0.95;
  const pivotV = 0.3;
  const tipU = pivotU + Math.cos(angle) * extend * 1.55;
  const tipV = pivotV + Math.sin(angle) * extend;
  return paintPlotted((plot) => {
    for (let x = 0; x <= 44; x += 1) plot(-ASPECT + (x / 44) * ASPECT * 2, 0.94, 0.35);
    for (let x = 0; x <= 14; x += 1) {
      const u = pivotU - 0.55 + (x / 14) * 1.2;
      plot(u, 0.78, 0.7);
      plot(u, 0.42, 0.55);
    }
    /* Outriggers planted, which is what lets the boom go out this far. */
    for (const side of [-1, 1] as const) {
      for (let step = 0; step <= 6; step += 1) {
        plot(pivotU + side * (0.55 + (step / 6) * 0.3), 0.78 + (step / 6) * 0.14, 0.5);
      }
    }
    for (const wheel of [-0.35, 0.35]) {
      plot(pivotU + wheel, 0.86, 0.7);
      plot(pivotU + wheel + 0.09, 0.86, 0.45);
    }
    for (let step = 0; step <= 24; step += 1) {
      const f = step / 24;
      plot(pivotU + (tipU - pivotU) * f, pivotV + (tipV - pivotV) * f, f > 0.5 ? 0.8 : 0.6);
    }
    /* Basket hangs level whatever the boom is doing. */
    for (let x = 0; x <= 6; x += 1) {
      const u = tipU - 0.2 + (x / 6) * 0.4;
      plot(u, tipV + 0.2, 0.85);
      plot(u, tipV - 0.1, 0.5);
    }
    for (let y = 0; y <= 4; y += 1) {
      plot(tipU - 0.2, tipV + 0.2 - (y / 4) * 0.3, 0.8);
      plot(tipU + 0.2, tipV + 0.2 - (y / 4) * 0.3, 0.8);
    }
    plot(tipU, tipV, 0.95);
  });
}

/* ========================================================================
   The seventh collection: high air and restless ground fields, then a
   workshop, a kitchen, and a sports field. Same contract as everything
   above: a pure painter over the shared grid.
   ===================================================================== */

/* -- Thermal column: bubbles of hot air leaving a baked field ------------- */

const thermalColumnField: Field = (u, v, t) => {
  const ground = clamp01((v - 0.72) * 4) * 0.45;
  let lift = 0;
  for (let column = 0; column < 4; column += 1) {
    const cu = -ASPECT + 0.5 + (column / 3) * (ASPECT * 2 - 1);
    /* Each thermal releases on its own clock, then rises and spreads out. */
    const cycle = (t * (0.4 + hash(column * 2.9) * 0.25) + hash(column)) % 1;
    const cv = 0.9 - cycle * 2;
    const width = 0.12 + cycle * 0.5;
    const bubble = clamp01(1 - Math.hypot((u - cu) / width, (v - cv) * 1.6));
    lift = Math.max(lift, bubble * (1 - cycle * 0.55));
  }
  return clamp01(0.05 + ground + lift * 0.9);
};

/* -- Haboob: a wall of dust rolling over clear ground --------------------- */

const haboobField: Field = (u, v, t) => {
  /* The wall marches and wraps, so the scene never runs out of storm. */
  const front = ((t * 0.5) % 3.4) - 1.7;
  const behind = clamp01((front - u) * 1.6);
  const roll = fbm(u * 1.7 - t * 0.8, v * 2.4 + t * 0.2, 4);
  const crest = clamp01(1 - Math.abs(u - front) * 2.2) * clamp01((v + 0.6) * 1.4);
  const clear = clamp01((v - 0.6) * 3) * 0.3;
  return clamp01(0.04 + clear + behind * (0.22 + roll * 0.7) + crest * 0.5);
};

/* -- Noctilucent cloud: thin ripples lit from under the horizon ----------- */

const noctilucentField: Field = (u, v, t) => {
  const horizon = 0.55;
  if (v > horizon) return clamp01(0.24 - (v - horizon) * 0.3);
  const height = clamp01((horizon - v) / 1.5);
  /* Two ripple trains at slightly different angles give the herringbone. */
  const first = Math.sin(u * 6 + v * 3 - t * 1.1);
  const second = Math.sin(u * 4.2 - v * 5 + t * 0.7);
  const sheet = Math.pow(clamp01((first + second) * 0.35 + 0.5), 2);
  return clamp01(0.03 + sheet * height * 1.2);
};

/* -- Airglow: banded emission drifting across the upper air --------------- */

const airglowField: Field = (u, v, t) => {
  const band = Math.sin(v * 5.5 + Math.sin(u * 1.3 + t * 0.4) * 0.8 - t * 0.9);
  const gradient = clamp01((0.9 - v) / 1.8);
  const patch = fbm(u * 0.9 + t * 0.06, v * 0.9, 3);
  return clamp01(
    0.05 + Math.pow(clamp01(band * 0.5 + 0.5), 2.2) * (0.4 + patch * 0.8) * gradient,
  );
};

/* -- Sun pillar: a stack of glints over a low sun -------------------------- */

const sunPillarField: Field = (u, v, t) => {
  const sunU = Math.sin(t * 0.3) * 0.5;
  const horizon = 0.62;
  const shaft = clamp01(1 - Math.abs(u - sunU) * 3.4) * clamp01((horizon - v + 0.2) * 1.2);
  /* The pillar is a column of ice crystals catching light, not a solid beam. */
  const glint = Math.abs(Math.sin(v * 14 + t * 2.6 + hash(Math.floor(v * 7)) * 6));
  const disc = clamp01(1 - Math.hypot((u - sunU) * 1.6, (v - horizon) * 2.4) * 3);
  const ground = v > horizon ? 0.16 : 0;
  return clamp01(0.04 + ground + shaft * (0.25 + glint * 0.7) + disc * 0.9);
};

/* -- Cirrus: fibrous streaks pulled into hooks by the shear --------------- */

const cirrusField: Field = (u, v, t) => {
  /* Higher air runs faster, which is what smears the streaks into hooks. */
  const shear = (0.6 - v) * 0.5;
  const streak = fbm(u * 1.2 - t * (0.3 + shear), v * 4.5, 3);
  const fibre = Math.pow(clamp01(streak * 1.5 - 0.35), 1.4);
  const deck = clamp01((0.75 - v) * 1.1);
  return clamp01(0.04 + fibre * deck * 1.4);
};

/* -- Hydrothermal pool: terraces stepping down under their own steam ------ */

const hydrothermalPoolField: Field = (u, v, t) => {
  const level = (v + 1) * 2.4 + Math.sin(u * 1.7) * 0.5;
  const terrace = Math.floor(level);
  /* The lip of every step holds the brightest rim of mineral. */
  const rim = clamp01(1 - (level - terrace) * 4) * 0.75;
  const pool = 0.16 + Math.abs(Math.sin(u * 3 + terrace * 2 + t * 1.2)) * 0.2;
  const steam =
    clamp01(fbm(u * 2 + t * 0.3, v * 2 - t * 0.9, 3) * 1.6 - 0.55) * clamp01((0.4 - v) * 1.5);
  return clamp01(0.05 + pool + rim + steam * 0.8);
};

/* -- Permafrost: ice wedge polygons heaving open and shut ----------------- */

const permafrostField: Field = (u, v, t) => {
  let nearest = 9;
  let second = 9;
  let owner = 0;
  for (let cell = 0; cell < 11; cell += 1) {
    const cu = (hash(cell * 2.1) * 2 - 1) * ASPECT;
    const cv = hash(cell * 6.3) * 2 - 1;
    const distance = Math.hypot(u - cu, v - cv);
    if (distance < nearest) {
      second = nearest;
      nearest = distance;
      owner = cell;
    } else if (distance < second) {
      second = distance;
    }
  }
  /* Each polygon heaves on its own slow clock, so the wedges open and close. */
  const heave = 0.5 + Math.sin(t * 0.8 + owner * 1.7) * 0.5;
  const wedge = clamp01(1 - (second - nearest) * (10 - heave * 5));
  return clamp01(0.12 + wedge * 0.85 - heave * 0.06);
};

/* -- Peat fire: a burn line creeping down through the ground -------------- */

const peatFireField: Field = (u, v, t) => {
  /* The burn eats downwards; everything above it is spent and dark. */
  const burn = -0.8 + ((t * 0.22) % 1.8);
  const depth = v - burn - Math.sin(u * 2.6 + t * 0.5) * 0.14;
  const glow =
    clamp01(1 - Math.abs(depth) * 3.5) *
    (0.55 + hash2(Math.floor(u * 9), Math.floor(t * 5)) * 0.45);
  const spent = depth < 0 ? 0.08 : 0.28 + fbm(u * 3, v * 3, 2) * 0.2;
  const smoke =
    depth < 0 ? clamp01(fbm(u * 2.4 + t * 0.4, v * 2.4 - t * 1.1, 3) * 1.3 - 0.5) * 0.5 : 0;
  return clamp01(spent + glow + smoke);
};

/* -- Geyser basin: four vents, each on a period of its own ---------------- */

const geyserBasinField: Field = (u, v, t) => {
  let basin =
    0.08 + clamp01((v - 0.5) * 2) * 0.32 + Math.abs(Math.sin(u * 4 + t * 1.3)) * 0.07;
  for (let vent = 0; vent < 4; vent += 1) {
    const cu = -ASPECT + 0.6 + (vent / 3) * (ASPECT * 2 - 1.2);
    const period = 2.4 + hash(vent * 3.1) * 2.6;
    const phase = ((t + hash(vent) * period) % period) / period;
    /* Most of a geyser's cycle is quiet; the jet lives in the first fifth. */
    if (phase > 0.22) continue;
    const eruption = phase / 0.22;
    const reach = 0.5 + Math.sin(eruption * Math.PI) * 1.4;
    const column =
      clamp01(1 - Math.abs(u - cu) / (0.1 + eruption * 0.22)) * clamp01((0.8 - v) / reach);
    basin = Math.max(basin, column * (0.5 + Math.abs(Math.sin(v * 8 - t * 9)) * 0.5));
  }
  return clamp01(basin);
};

/* -- Obsidian flow: glass bands crowding up behind a stalling front ------- */

const obsidianFlowField: Field = (u, v, t) => {
  const front = -1.1 + ((t * 0.3) % 3.2);
  const beyond = clamp01((u - front) * 2);
  const band = Math.sin((u - t * 0.5) * 7 + Math.sin(v * 2.4) * 1.6);
  const crust = Math.pow(clamp01(band * 0.5 + 0.5), 3);
  const crack = clamp01(1 - Math.abs(Math.sin(v * 5 + u * 2 - t * 0.4)) * 6) * 0.7;
  return clamp01((1 - beyond) * (0.12 + crust * 0.55 + crack) + beyond * 0.06);
};

/* -- Rip tide: a gap in the break where the water runs back out ----------- */

const tideRipField: Field = (u, v, t) => {
  const ripU = Math.sin(t * 0.4) * 0.35;
  /* No white water where the water is leaving: that gap is the rip. */
  const gap = clamp01(Math.abs(u - ripU) * 2.4);
  const bar = clamp01(1 - Math.abs(v - 0.1 - Math.sin(u * 2 + t * 0.6) * 0.15) * 3.4);
  const foam = bar * gap * (0.4 + Math.abs(Math.sin(u * 6 - t * 4)) * 0.6);
  const outflow =
    clamp01(1 - Math.abs(u - ripU) * 3.5) *
    clamp01((v + 0.2) * 1.2) *
    (0.2 + Math.abs(Math.sin(v * 6 + t * 3.4)) * 0.35);
  return clamp01(0.1 + Math.sin(v * 4 - t * 2.2) * 0.1 + foam + outflow);
};

/* -- Plankton bloom: light where the water is being sheared --------------- */

const planktonBloomField: Field = (u, v, t) => {
  const wave = Math.sin(u * 2.2 - t * 1.8);
  /* Bioluminescence fires on disturbance, which is the wave's front face. */
  const shear = clamp01(-Math.cos(u * 2.2 - t * 1.8) * 1.4);
  const near = clamp01(1 - Math.abs(v - (0.1 + wave * 0.22)) * 2.6);
  const grain = hash2(Math.floor(u * 12), Math.floor(v * 9 + t * 2)) > 0.72 ? 1 : 0.25;
  return clamp01(0.04 + near * shear * grain * 1.2 + near * 0.12);
};

/* -- Mangrove roots: stilts fanning out of one trunk each ----------------- */

const mangroveRootField: Field = (u, v, t) => {
  let stilt = 0.05;
  for (let root = 0; root < 9; root += 1) {
    const base = (hash(root * 1.9) * 2 - 1) * ASPECT;
    const lean = (hash(root * 5.5) - 0.5) * 1.3;
    /* Roots leave the trunk vertically and fan out, so they cross each other. */
    const along = clamp01((v + 1) / 2);
    const x = base + lean * along * along;
    stilt = Math.max(stilt, clamp01(1 - Math.abs(u - x) * 9) * (0.35 + along * 0.5));
  }
  const waterline = 0.35 + Math.sin(t * 0.5) * 0.28;
  const water = v > waterline ? 0.24 + Math.abs(Math.sin(u * 5 + t * 2.4)) * 0.24 : 0;
  const canopy = clamp01((-0.55 - v) * 2.5) * (0.4 + fbm(u * 3 + t * 0.2, v * 3, 2) * 0.6);
  return clamp01(Math.max(stilt * (v > waterline ? 0.5 : 1), water) + canopy);
};

/* -- Squall line: an anvil leaning ahead of its own rain shaft ------------ */

const squallLineField: Field = (u, v, t) => {
  const line = -1.4 + ((t * 0.45) % 3.6);
  const ahead = u - line;
  const anvil = clamp01(1 - Math.abs(ahead - 0.5) * 1.5) * clamp01((-0.2 - v) * 2.2);
  const cloud =
    clamp01(1 - Math.abs(ahead) * 1.1) *
    clamp01((0.3 - v) * 1.4) *
    (0.4 + fbm(u * 2 - t * 0.5, v * 2, 3) * 0.9);
  /* Rain hangs behind the line only, which is what gives the storm a face. */
  const rain =
    ahead < 0 && ahead > -1.1
      ? clamp01(Math.sin((u * 9 + v * 14 - t * 22) * 0.7) * 0.6 + 0.35) *
        clamp01((v + 0.3) * 1.5) *
        0.55
      : 0;
  const bolt =
    hash(Math.floor(t * 3)) > 0.86
      ? clamp01(1 - Math.abs(u - line + 0.2) * 8) * clamp01((v + 0.4) * 2)
      : 0;
  return clamp01(0.04 + anvil * 0.5 + cloud + rain + bolt);
};

/* -- Crevasse field: ice stretching over a lip in the bedrock ------------- */

const crevasseField: Field = (u, v, t) => {
  /* The sheet slides; cracks only open where it is being stretched. */
  const flow = t * 0.25;
  const strain = clamp01(1 - Math.abs(v - 0.05) * 1.6);
  let ice = 0.55 + fbm(u * 2 + flow, v * 2, 2) * 0.2;
  for (let crack = 0; crack < 7; crack += 1) {
    const seed = hash(crack * 3.7);
    const x = ((u + flow + seed * 4) % 2.2) - 1.1;
    const width = 0.03 + strain * 0.13 * (0.4 + seed * 0.6);
    ice = Math.min(ice, 1 - clamp01(1 - Math.abs(x) / width) * 0.95);
  }
  return clamp01(ice);
};

/* -- Mirage: a false lake shivering under the horizon --------------------- */

const mirageLakeField: Field = (u, v, t) => {
  const horizon = 0.15;
  if (v > horizon) {
    /* Below the horizon the sky is reflected and shivering: that is the lake. */
    const shimmer =
      Math.sin(u * 5 + (v - horizon) * 20 + t * 6) * clamp01(1 - (v - horizon) * 2.5);
    const road = clamp01(1 - Math.abs(u) * (1.2 + (v - horizon) * 3));
    return clamp01(0.24 + shimmer * 0.3 + road * 0.35 * clamp01(1 - (v - horizon) * 3));
  }
  const sun = clamp01(1 - Math.hypot((u - 0.2) * 1.4, (v + 0.5) * 2.2) * 2.4);
  return clamp01(0.05 + clamp01((v + 1) / 1.3) * 0.25 + sun * 0.8);
};

/* -- Alluvial fan: channels wandering across their own spread ------------- */

const alluvialFanField: Field = (u, v, t) => {
  const apexV = -0.9;
  const spread = clamp01((v - apexV) / 1.9);
  const angle = Math.atan2(v - apexV, u * 1.2);
  /* The channels keep switching course, which is what braids a fan. */
  const braid = Math.sin(angle * 9 + Math.sin(spread * 5 - t * 0.7) * 1.4 + t * 0.5);
  const channel = Math.pow(clamp01(braid * 0.5 + 0.5), 5) * spread;
  const wet = clamp01(1 - Math.abs(angle - Math.PI / 2 - Math.sin(t * 0.4) * 0.5) * 2.5) * spread;
  return clamp01(0.06 + channel * 0.75 + wet * 0.35);
};

/* -- Band saw: one blade looping over two wheels -------------------------- */

function paintBandSaw(t: number): string {
  return paintPlotted((plot) => {
    const spin = t * 3;
    /* One continuous blade means both wheels turn the same way. */
    for (const cv of [-0.55, 0.55] as const) {
      for (let step = 0; step < 26; step += 1) {
        const angle = (step / 26) * TAU + spin;
        plot(-0.9 + Math.cos(angle) * 0.34, cv + Math.sin(angle) * 0.34, 0.55);
      }
      plot(-0.9, cv, 0.8);
    }
    for (let y = 0; y <= 20; y += 1) plot(-1.24, -0.55 + (y / 20) * 1.1, 0.45);
    /* Teeth ride down the cutting side, which is where the stock meets it. */
    for (let tooth = 0; tooth < 14; tooth += 1) {
      const f = (tooth / 14 + t * 0.5) % 1;
      plot(-0.56, -0.55 + f * 1.1, 0.5 + (tooth % 2) * 0.45);
    }
    const feed = ((t * 0.4) % 1.8) - 0.9;
    for (let x = 0; x <= 20; x += 1) {
      const u = 0.9 - feed - (x / 20) * 1.2;
      plot(u, -0.14, 0.9);
      plot(u, 0.14, 0.9);
    }
  });
}

/* -- Drill press: a quill plunging and throwing swarf --------------------- */

function paintDrillPress(t: number): string {
  return paintPlotted((plot) => {
    for (let y = 0; y <= 22; y += 1) plot(0.95, -0.9 + (y / 22) * 1.8, 0.5);
    for (let x = 0; x <= 14; x += 1) plot(-0.4 + (x / 14) * 1.35, -0.72, 0.6);
    for (let x = 0; x <= 12; x += 1) plot(-0.15 + (x / 12) * 1.1, 0.85, 0.65);
    const plunge = Math.max(0, Math.sin(t * 1.6));
    const tip = -0.45 + plunge * 1.15;
    for (let y = 0; y <= 10; y += 1) plot(0.3, -0.66 + (y / 10) * (tip + 0.66) * 0.6, 0.7);
    /* The flute twist is the only thing that shows the bit is turning. */
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(0.3 + Math.sin(f * 9 - t * 9) * 0.07, tip - 0.45 + f * 0.45, 0.85);
    }
    plot(0.3, tip, 0.95);
    for (let chip = 0; chip < 6; chip += 1) {
      const reach = ((t * 2 + hash(chip)) % 1) * 0.55;
      const angle = -Math.PI + hash(chip * 2.3) * Math.PI;
      plot(0.3 + Math.cos(angle) * reach * 1.7, tip + Math.sin(angle) * reach, 0.7 - reach * 1.2);
    }
  });
}

/* -- Angle grinder: a disc laying a fan of sparks ------------------------- */

function paintAngleGrinder(t: number): string {
  return paintPlotted((plot) => {
    const contact = -0.2 + Math.sin(t * 1.1) * 0.75;
    for (let x = 0; x <= 24; x += 1) plot(-ASPECT + (x / 24) * ASPECT * 2, 0.2, 0.5);
    for (let x = 0; x <= 12; x += 1) {
      const u = contact + 0.36 + (x / 12) * 0.85;
      plot(u, -0.58, 0.7);
      plot(u, -0.24, 0.7);
    }
    for (let step = 0; step < 22; step += 1) {
      const angle = (step / 22) * TAU;
      plot(
        contact + Math.cos(angle) * 0.34,
        -0.15 + Math.sin(angle) * 0.34,
        0.45 + Math.abs(Math.sin(angle * 6 - t * 12)) * 0.45,
      );
    }
    /* Sparks leave the rim on a tangent, then fall away as they cool. */
    for (let spark = 0; spark < 14; spark += 1) {
      const life = (t * 1.7 + hash(spark * 3.1)) % 1;
      const angle = -2.7 + hash(spark) * 1.5;
      plot(
        contact + Math.cos(angle) * (0.34 + life * 1.6),
        0.18 + Math.sin(angle) * 0.25 * life + life * life * 0.55,
        (1 - life) * 0.9,
      );
    }
  });
}

/* -- Bench vise: one jaw travelling on a turning screw -------------------- */

function paintBenchVise(t: number): string {
  return paintPlotted((plot) => {
    const close = 0.3 + Math.abs(Math.sin(t * 0.8)) * 0.6;
    for (let x = 0; x <= 20; x += 1) plot(-1.35 + (x / 20) * 2.5, 0.6, 0.55);
    /* Only the near jaw travels; the fixed jaw is what the work presses onto. */
    for (let y = 0; y <= 12; y += 1) {
      const v = -0.55 + (y / 12) * 1.05;
      plot(-0.4, v, 0.85);
      plot(close, v, 0.85);
    }
    for (let x = 0; x <= 10; x += 1) {
      const u = -0.4 + (x / 10) * (close + 0.4);
      plot(u, -0.5, 0.45);
      plot(u, 0.42, 0.45);
    }
    /* The thread reads as a helix, so the screw turns instead of sliding. */
    for (let step = 0; step <= 26; step += 1) {
      const f = step / 26;
      plot(close + 0.06 + f * 0.9, -0.06 + Math.sin(f * 14 + t * 4) * 0.08, 0.55);
    }
    for (let y = 0; y <= 8; y += 1) plot(close + 1.0, -0.3 + (y / 8) * 0.5, 0.7);
  });
}

/* -- Soldering iron: a joint wetted, then left to set --------------------- */

function paintSolderingIron(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 1;
    /* In, wet the joint, back out again for the next pad along. */
    const approach = cycle < 0.5 ? 1 - cycle * 2 : (cycle - 0.5) * 2;
    const tipU = -0.15;
    const tipV = -0.12 - approach * 0.7;
    for (let step = 0; step <= 18; step += 1) {
      const f = step / 18;
      plot(tipU - 0.45 - f * 0.95, tipV - 0.3 - f * 0.6, 0.6);
    }
    plot(tipU, tipV, 0.95);
    for (let x = 0; x <= 22; x += 1) plot(-1.4 + (x / 22) * 2.8, 0.55, 0.45);
    for (let pad = 0; pad < 5; pad += 1) {
      const u = -1.1 + pad * 0.55;
      for (let y = 0; y <= 5; y += 1) plot(u, 0.55 - (y / 5) * 0.45, 0.55);
    }
    /* A joint just touched stays bright and molten for a beat afterwards. */
    const molten = approach < 0.15 ? 1 : clamp01(1 - (approach - 0.15) * 3);
    plot(tipU, 0.06, 0.4 + molten * 0.6);
    for (let wisp = 0; wisp < 5; wisp += 1) {
      const rise = (t * 0.8 + hash(wisp * 4.7)) % 1;
      plot(tipU + Math.sin(rise * 6 + wisp) * 0.22, -0.15 - rise * 0.8, molten * (1 - rise) * 0.5);
    }
  });
}

/* -- Oscilloscope: a trace creeping on a loose trigger -------------------- */

function paintOscilloscope(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 26; x += 1) plot(-1.5 + (x / 26) * 3, 0, 0.18);
    for (let y = 0; y <= 18; y += 1) plot(0, -0.85 + (y / 18) * 1.7, 0.18);
    for (let tick = -4; tick <= 4; tick += 1) {
      plot(tick * 0.35, 0.07, 0.22);
      plot(tick * 0.35, -0.07, 0.22);
    }
    /* A trigger that will not lock is what makes the waveform crawl. */
    const drift = Math.sin(t * 0.4) * 0.6 + t * 0.6;
    for (let sample = 0; sample <= 120; sample += 1) {
      const u = -1.5 + (sample / 120) * 3;
      const phase = u * 3.4 + drift;
      const wave = Math.sin(phase) * 0.5 + Math.sin(phase * 3 + t) * 0.18;
      /* The beam is brightest where it dwells: at the turning points. */
      const dwell = 1 - Math.abs(Math.cos(phase)) * 0.55;
      plot(u, wave * 0.75, 0.35 + dwell * 0.6);
    }
  });
}

/* -- Metal detector: a coil that only sings over the find ----------------- */

function paintMetalDetector(t: number): string {
  return paintPlotted((plot) => {
    const sweep = Math.sin(t * 1.2) * 1.05;
    const target = 0.4;
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.78, 0.4);
    for (let step = 0; step <= 18; step += 1) {
      const f = step / 18;
      plot(sweep * (0.35 + f * 0.65), -0.9 + f * 1.35, 0.6);
    }
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * TAU;
      plot(sweep + Math.cos(angle) * 0.3, 0.5 + Math.sin(angle) * 0.13, 0.75);
    }
    plot(target, 0.9, 0.5);
    /* Rings only leave the coil while it is over the buried target. */
    const strength = clamp01(1 - Math.abs(sweep - target) * 1.8);
    for (let ring = 0; ring < 3; ring += 1) {
      const radius = ((t * 2 + ring / 3) % 1) * 0.8;
      const weight = strength * (1 - radius / 0.8) * 0.8;
      for (let step = 0; step < 18; step += 1) {
        const angle = (step / 18) * TAU;
        plot(sweep + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius * 0.5, weight);
      }
    }
  });
}

/* -- Kick scooter: a rider pushing along a flat ---------------------------- */

function paintKickScooter(t: number): string {
  return paintPlotted((plot) => {
    const glide = t * 1.4;
    const kick = Math.max(0, Math.sin(t * 3));
    const base = ((glide % 3.4) - 1.7);
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.82, 0.35);
    for (const offset of [-0.35, 0.4] as const) {
      for (let step = 0; step < 14; step += 1) {
        const angle = (step / 14) * TAU + glide * 3;
        plot(base + offset + Math.cos(angle) * 0.16, 0.64 + Math.sin(angle) * 0.16, 0.6);
      }
    }
    for (let x = 0; x <= 10; x += 1) plot(base - 0.35 + (x / 10) * 0.75, 0.5, 0.7);
    for (let y = 0; y <= 12; y += 1) plot(base + 0.4, 0.5 - (y / 12) * 0.95, 0.65);
    for (let x = 0; x <= 5; x += 1) plot(base + 0.28 + (x / 5) * 0.3, -0.45, 0.7);
    plot(base + 0.3, -0.6, 0.9);
    /* One foot stays on the deck; the free leg swings back to push. */
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(base + 0.3 - f * 0.55 * kick, 0.5 - f * 0.18 * kick, 0.6);
    }
    plot(base + 0.28, 0.48, 0.75);
  });
}

/* -- Paint roller: a wall filling in one wet band at a time --------------- */

function paintPaintRoller(t: number): string {
  return paintPlotted((plot) => {
    const across = -1.35 + ((t * 0.28) % 2.8);
    const roller = Math.sin(t * 2.2) * 0.6;
    /* Everything left of the roller has been covered and is drying. */
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.4 + (x / 26) * 2.8;
      if (u > across) continue;
      for (let y = 0; y <= 8; y += 1) {
        plot(u, -0.8 + (y / 8) * 1.6, 0.28 + Math.abs(Math.sin(u * 7 + y)) * 0.12);
      }
    }
    /* The freshest band is still wet, so it reads brighter than the rest. */
    for (let y = 0; y <= 10; y += 1) plot(across - 0.08, -0.8 + (y / 10) * 1.6, 0.6);
    for (let x = 0; x <= 6; x += 1) plot(across - 0.13 + (x / 6) * 0.26, roller, 0.92);
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(across + 0.16 + f * 0.95, roller - 0.08 - f * 0.5, 0.6);
    }
  });
}

/* -- Coffee grinder: beans in at the top, grounds out the bottom ---------- */

function paintCoffeeGrinder(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(-0.9 + f * 0.62, -0.9 + f * 0.75, 0.6);
      plot(0.9 - f * 0.62, -0.9 + f * 0.75, 0.6);
    }
    /* Beans crowd towards the neck, so the spread narrows as they drop. */
    for (let bean = 0; bean < 9; bean += 1) {
      const fall = (t * 0.6 + hash(bean * 2.7)) % 1;
      plot((hash(bean) * 2 - 1) * 0.6 * (1 - fall), -0.9 + fall * 0.75, 0.75);
    }
    for (let tooth = 0; tooth < 10; tooth += 1) {
      const angle = (tooth / 10) * TAU + t * 5;
      plot(Math.cos(angle) * 0.26, -0.1 + Math.sin(angle) * 0.12, 0.8);
    }
    for (let grain = 0; grain < 16; grain += 1) {
      const fall = (t * 1.3 + hash(grain * 5.3)) % 1;
      plot((hash(grain) * 2 - 1) * 0.3, 0.05 + fall * 0.72, 0.25 + hash(grain * 9.1) * 0.4);
    }
    for (let x = 0; x <= 12; x += 1) plot(-0.5 + (x / 12) * 1, 0.85, 0.7);
  });
}

/* -- Toaster: elements warming, then two slices thrown clear -------------- */

function paintToaster(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.35) % 1;
    /* Heat builds for most of the cycle; the pop is the last beat of it. */
    const pop = cycle > 0.82 ? Math.sin(((cycle - 0.82) / 0.18) * Math.PI) : 0;
    const heat = cycle < 0.82 ? clamp01(cycle / 0.6) : 0;
    for (let x = 0; x <= 20; x += 1) {
      const u = -0.9 + (x / 20) * 1.8;
      plot(u, 0.78, 0.7);
      plot(u, -0.1, 0.6);
    }
    for (let y = 0; y <= 10; y += 1) {
      plot(-0.9, -0.1 + (y / 10) * 0.88, 0.7);
      plot(0.9, -0.1 + (y / 10) * 0.88, 0.7);
    }
    for (let element = 0; element < 4; element += 1) {
      for (let x = 0; x <= 16; x += 1) {
        plot(
          -0.75 + (x / 16) * 1.5,
          0.05 + element * 0.18,
          0.15 + heat * (0.55 + Math.abs(Math.sin(x + t * 6)) * 0.3),
        );
      }
    }
    for (const slot of [-0.4, 0.4] as const) {
      for (let y = 0; y <= 8; y += 1) {
        const v = 0.55 - (y / 8) * 0.5 - pop * 0.95;
        plot(slot - 0.22, v, 0.8);
        plot(slot + 0.22, v, 0.8);
      }
      plot(slot, 0.05 - pop * 0.95, 0.55 + heat * 0.4);
    }
  });
}

/* -- Blender: a funnel pulled into the middle of the jug ------------------ */

function paintBlender(t: number): string {
  return paintPlotted((plot) => {
    for (let y = 0; y <= 16; y += 1) {
      const f = y / 16;
      plot(-0.55 - f * 0.12, -0.75 + f * 1.3, 0.6);
      plot(0.55 + f * 0.12, -0.75 + f * 1.3, 0.6);
    }
    for (let x = 0; x <= 14; x += 1) plot(-0.67 + (x / 14) * 1.34, 0.55, 0.65);
    const spin = t * 7;
    for (let blade = 0; blade < 4; blade += 1) {
      const angle = (blade / 4) * TAU + spin;
      for (let step = 0; step <= 6; step += 1) {
        plot(Math.cos(angle) * (step / 6) * 0.3, 0.42 + Math.sin(angle) * (step / 6) * 0.09, 0.8);
      }
    }
    /* The middle of the surface is dragged down, which is the vortex. */
    for (let sample = 0; sample <= 60; sample += 1) {
      const u = -0.6 + (sample / 60) * 1.2;
      plot(u, -0.15 + (1 - Math.abs(u) / 0.6) * 0.32 + Math.sin(u * 9 + t * 9) * 0.05, 0.7);
    }
    for (let bit = 0; bit < 12; bit += 1) {
      const angle = hash(bit * 3.3) * TAU + spin * (0.6 + hash(bit) * 0.5);
      const radius = 0.12 + hash(bit * 7.7) * 0.4;
      plot(Math.cos(angle) * radius, 0.15 + Math.sin(angle) * radius * 0.4, 0.45);
    }
  });
}

/* -- Popcorn maker: kernels waiting their turn, then leaving --------------- */

function paintPopcornMaker(t: number): string {
  return paintPlotted((plot) => {
    for (let y = 0; y <= 14; y += 1) {
      plot(-0.85, -0.5 + (y / 14) * 1.3, 0.6);
      plot(0.85, -0.5 + (y / 14) * 1.3, 0.6);
    }
    for (let x = 0; x <= 18; x += 1) plot(-0.85 + (x / 18) * 1.7, 0.8, 0.7);
    /* Every kernel keeps its own period, so the pops never fall into step. */
    for (let kernel = 0; kernel < 14; kernel += 1) {
      const period = 1.6 + hash(kernel * 2.9) * 2.4;
      const phase = ((t + hash(kernel) * period) % period) / period;
      const u = (hash(kernel * 5.1) * 2 - 1) * 0.7;
      if (phase < 0.55) {
        plot(u, 0.74 - Math.abs(Math.sin(t * 9 + kernel)) * 0.05, 0.45);
        continue;
      }
      const flight = (phase - 0.55) / 0.45;
      plot(
        u + (hash(kernel * 8.3) - 0.5) * flight * 0.9,
        0.74 - Math.sin(flight * Math.PI) * 1.3,
        0.9,
      );
    }
    for (let ray = 0; ray < 5; ray += 1) {
      plot(-0.6 + ray * 0.3, 0.92, 0.3 + Math.abs(Math.sin(t * 5 + ray)) * 0.5);
    }
  });
}

/* -- Pancake: a dip in the pan, a toss, half a turn ----------------------- */

function paintPancakeFlip(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.55) % 1;
    /* The pan dips before the toss, which is what gives the pancake its lift. */
    const swing = cycle < 0.2 ? Math.sin((cycle / 0.2) * Math.PI) : 0;
    const panV = 0.45 + swing * 0.18;
    for (let x = 0; x <= 14; x += 1) plot(-0.7 + (x / 14) * 1.1, panV, 0.7);
    for (let step = 0; step <= 12; step += 1) {
      plot(0.4 + (step / 12) * 0.9, panV - 0.12 - (step / 12) * 0.18, 0.55);
    }
    const flight = cycle < 0.2 ? 0 : (cycle - 0.2) / 0.8;
    /* Half a turn per toss, so it lands on the face that was up before. */
    const tilt = Math.cos(flight * Math.PI);
    for (let x = 0; x <= 12; x += 1) {
      const f = x / 12 - 0.5;
      plot(-0.15 + f * 0.7, panV - 0.1 - Math.sin(flight * Math.PI) * 1.2 + f * tilt * 0.3, 0.9);
    }
    for (let wisp = 0; wisp < 4; wisp += 1) {
      const rise = (t * 0.9 + hash(wisp * 3.7)) % 1;
      plot(-0.15 + Math.sin(rise * 5 + wisp) * 0.3, panV - 0.2 - rise * 0.7, (1 - rise) * 0.35);
    }
  });
}

/* -- Egg timer: a dial unwinding to a bell -------------------------------- */

function paintEggTimer(t: number): string {
  return paintPlotted((plot) => {
    const phase = (t % 6) / 6;
    for (let step = 0; step < 30; step += 1) {
      const angle = (step / 30) * TAU;
      plot(Math.cos(angle) * 0.62, Math.sin(angle) * 0.62, 0.5);
    }
    for (let mark = 0; mark < 12; mark += 1) {
      const angle = (mark / 12) * TAU - Math.PI / 2;
      plot(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, 0.35);
    }
    /* The hand unwinds back to zero, rings, and is wound again. */
    const wound = phase < 0.9 ? 1 - phase / 0.9 : 0;
    const angle = -Math.PI / 2 + wound * TAU;
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(Math.cos(angle) * f * 0.46, Math.sin(angle) * f * 0.46, 0.85);
    }
    const ringing = phase > 0.9 ? Math.abs(Math.sin(t * 22)) : 0;
    for (let step = 0; step < 12; step += 1) {
      const a = (step / 12) * TAU;
      plot(Math.cos(a) * 0.16, -0.74 + Math.sin(a) * 0.1, 0.4 + ringing * 0.6);
    }
    if (ringing > 0.4) {
      for (let ring = 0; ring < 2; ring += 1) {
        const radius = 0.82 + ring * 0.3;
        for (let step = 0; step < 14; step += 1) {
          const a = -Math.PI / 2 + (step / 14 - 0.5) * 1.6;
          plot(Math.cos(a) * radius, Math.sin(a) * radius, ringing * 0.5);
        }
      }
    }
  });
}

/* -- Teapot: a body tipping on its foot to pour --------------------------- */

function paintTeapot(t: number): string {
  return paintPlotted((plot) => {
    const tip = Math.max(0, Math.sin(t * 0.7));
    const lean = tip * 0.5;
    /* The whole pot pivots, so the spout swings down as it pours. */
    const body = (au: number, av: number) => {
      const c = Math.cos(lean);
      const s = Math.sin(lean);
      return [au * c - av * s - 0.5, au * s + av * c + 0.15] as const;
    };
    for (let step = 0; step < 26; step += 1) {
      const angle = (step / 26) * TAU;
      const [u, v] = body(Math.cos(angle) * 0.42, Math.sin(angle) * 0.34);
      plot(u, v, 0.65);
    }
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      const [u, v] = body(0.4 + f * 0.42, -0.05 - f * 0.3);
      plot(u, v, 0.7);
    }
    const [spoutU, spoutV] = body(0.85, -0.35);
    if (tip > 0.15) {
      for (let step = 0; step <= 24; step += 1) {
        const f = step / 24;
        /* The stream wanders as it falls, which keeps it from reading as a rod. */
        plot(
          spoutU + f * 0.12 + Math.sin(f * 9 + t * 8) * 0.03,
          spoutV + f * (0.7 - spoutV),
          0.4 + tip * 0.5 * (1 - f * 0.4),
        );
      }
    }
    for (let step = 0; step < 18; step += 1) {
      const angle = (step / 18) * TAU;
      plot(0.9 + Math.cos(angle) * 0.3, 0.74 + Math.sin(angle) * 0.12, 0.6);
    }
    for (let wisp = 0; wisp < 4; wisp += 1) {
      const rise = (t * 0.8 + hash(wisp * 2.1)) % 1;
      plot(0.9 + Math.sin(rise * 6 + wisp) * 0.25, 0.6 - rise * 0.9, (1 - rise) * 0.4);
    }
  });
}

/* -- Waffle iron: shut to bake, hinged open to show the grid -------------- */

function paintWaffleIron(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 1;
    const open = cycle < 0.6 ? 0 : Math.sin(((cycle - 0.6) / 0.4) * Math.PI);
    const hinge = -0.95;
    const lidAngle = -open * 1.0;
    for (let x = 0; x <= 18; x += 1) {
      const along = (x / 18) * 1.9;
      plot(hinge + along, 0.4, 0.7);
      plot(hinge + along * Math.cos(lidAngle), 0.12 + along * Math.sin(lidAngle), 0.7);
    }
    /* The grid only reads once the lid is off it. */
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        plot(hinge + 0.2 + column * 0.3, 0.28 - row * 0.11, 0.22 + open * 0.65);
      }
    }
    for (let wisp = 0; wisp < 6; wisp += 1) {
      const rise = (t * 1.1 + hash(wisp * 4.3)) % 1;
      const u = hinge + 0.3 + hash(wisp) * 1.5;
      plot(u + Math.sin(rise * 7 + wisp) * 0.2, 0.1 - rise * 0.9, (1 - rise) * (0.22 + open * 0.5));
    }
    plot(0.98, 0.4, 0.9);
  });
}

/* -- Knife sharpener: a blade drawn heel to tip across a wheel ------------ */

function paintKnifeSharpener(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step < 30; step += 1) {
      const angle = (step / 30) * TAU;
      plot(
        -0.55 + Math.cos(angle) * 0.45,
        0.2 + Math.sin(angle) * 0.45,
        0.45 + Math.abs(Math.sin(angle * 5 + t * 4)) * 0.35,
      );
    }
    /* Draw the length of the edge, then lift and go back for another pass. */
    const stroke = (t * 0.6) % 1;
    const along = stroke < 0.75 ? stroke / 0.75 : 1;
    const lift = stroke < 0.75 ? 0 : (stroke - 0.75) / 0.25;
    const bladeU = -1.05 + along * 1.5;
    const bladeV = -0.32 - lift * 0.5;
    for (let step = 0; step <= 22; step += 1) {
      const f = step / 22;
      plot(bladeU - 0.55 + f * 1.15, bladeV - 0.16 + f * 0.14, 0.5 + f * 0.4);
    }
    if (lift < 0.2) {
      for (let spark = 0; spark < 10; spark += 1) {
        const life = (t * 2.3 + hash(spark * 3.9)) % 1;
        const angle = -2.1 + hash(spark) * 1.3;
        plot(
          -0.55 + Math.cos(angle) * life * 1.3,
          -0.25 + Math.sin(angle) * life * 0.9 + life * life * 0.5,
          (1 - life) * 0.85,
        );
      }
    }
  });
}

/* -- Archery: draw, loose, and the arrow crosses to the boss -------------- */

function paintArchery(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 1;
    const draw = cycle < 0.55 ? cycle / 0.55 : 0;
    const flight = cycle < 0.55 ? -1 : (cycle - 0.55) / 0.45;
    const bowU = -1.3;
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20 - 0.5;
      plot(bowU + Math.cos(f * 2.2) * 0.28, f * 1.5, 0.7);
    }
    /* The string pinches to a point at the nock: that is what shows the draw. */
    const nock = bowU + 0.28 - draw * 0.5;
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(bowU + 0.28 + (nock - bowU - 0.28) * (1 - Math.abs(f * 2 - 1)), -0.75 + f * 1.5, 0.5);
    }
    if (flight < 0) {
      for (let step = 0; step <= 10; step += 1) plot(nock + (step / 10) * 0.7, 0, 0.85);
    } else {
      const tip = nock + 0.7 + flight * 2.6;
      for (let step = 0; step <= 10; step += 1) {
        plot(tip - (step / 10) * 0.7, -Math.sin(flight * Math.PI) * 0.16, 0.85);
      }
    }
    for (let ring = 1; ring <= 3; ring += 1) {
      for (let step = 0; step < 20; step += 1) {
        const angle = (step / 20) * TAU;
        plot(1.35 + Math.cos(angle) * ring * 0.17, Math.sin(angle) * ring * 0.17, 0.25 + (4 - ring) * 0.15);
      }
    }
    if (flight > 0.85) plot(1.35, 0, 0.95);
  });
}

/* -- Curling: a stone slowing, with the sweepers ahead of it -------------- */

function paintCurlingStone(t: number): string {
  return paintPlotted((plot) => {
    const run = (t * 0.35) % 1;
    /* The stone bleeds speed the whole way, and curls as it slows. */
    const travel = 1 - Math.pow(1 - run, 1.8);
    const u = -1.45 + travel * 2.5;
    const v = 0.35 - travel * travel * 0.35;
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.92, 0.2);
    for (let ring = 1; ring <= 3; ring += 1) {
      for (let step = 0; step < 22; step += 1) {
        const angle = (step / 22) * TAU;
        plot(1.15 + Math.cos(angle) * ring * 0.2, Math.sin(angle) * ring * 0.2, 0.22 + (4 - ring) * 0.12);
      }
    }
    for (let step = 0; step < 18; step += 1) {
      const angle = (step / 18) * TAU;
      plot(u + Math.cos(angle) * 0.24, v + Math.sin(angle) * 0.14, 0.85);
    }
    plot(u, v - 0.2, 0.7);
    /* Sweepers work the ice just ahead of the stone, never behind it. */
    for (const lead of [0.45, 0.78] as const) {
      const brush = Math.sin(t * 14 + lead * 9) * 0.14;
      plot(u + lead, v - 0.6, 0.65);
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(u + lead + brush * f, v - 0.55 + f * 0.55, 0.55);
      }
    }
  });
}

/* -- Pole vault: a run-up, a plant, and a swing over the bar -------------- */

function paintPoleVault(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.35) % 1;
    const barU = 0.45;
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.92, 0.3);
    for (let y = 0; y <= 12; y += 1) {
      plot(barU - 0.35, 0.9 - (y / 12) * 1.3, 0.5);
      plot(barU + 0.35, 0.9 - (y / 12) * 1.3, 0.5);
    }
    for (let x = 0; x <= 8; x += 1) plot(barU - 0.35 + (x / 8) * 0.7, -0.4, 0.8);
    if (cycle < 0.45) {
      /* Run-up: the pole tips down as the plant box comes closer. */
      const run = cycle / 0.45;
      const u = -1.5 + run * 1.5;
      plot(u, 0.55, 0.9);
      plot(u, 0.76, 0.7);
      for (let step = 0; step <= 14; step += 1) {
        const f = step / 14;
        plot(u + f * 1.1, 0.5 - (1 - run) * f * 0.7 + run * f * 0.35, 0.6);
      }
      return;
    }
    /* The vault is one arc about the planted tip, so the pole stays straight. */
    const swing = (cycle - 0.45) / 0.55;
    const angle = -Math.PI * 0.85 + swing * Math.PI * 0.95;
    const pivot = barU - 0.15;
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(pivot + Math.cos(angle) * 0.95 * f, 0.9 + Math.sin(angle) * 1.3 * f, 0.5);
    }
    const u = pivot + Math.cos(angle) * 0.95;
    const v = 0.9 + Math.sin(angle) * 1.3;
    plot(u, v, 0.95);
    plot(u + 0.18, v + 0.12, 0.7);
  });
}

/* -- High dive: a bounce, a tuck, and the splash -------------------------- */

function paintHighDive(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 1;
    const water = 0.65;
    for (let x = 0; x <= 10; x += 1) plot(-1.4 + (x / 10) * 0.8, -0.6, 0.6);
    for (let y = 0; y <= 12; y += 1) plot(-1.4, -0.6 + (y / 12) * 1.5, 0.5);
    for (let x = 0; x <= 26; x += 1) {
      const u = -ASPECT + (x / 26) * ASPECT * 2;
      plot(u, water + Math.sin(u * 4 + t * 2) * 0.05, 0.4);
    }
    if (cycle < 0.15) {
      plot(-0.72, -0.7 + Math.sin((cycle / 0.15) * Math.PI) * 0.16, 0.95);
      return;
    }
    const fall = (cycle - 0.15) / 0.85;
    if (fall > 0.82) {
      /* Past the entry the diver is gone and the splash carries the frame. */
      const splash = (fall - 0.82) / 0.18;
      for (let drop = 0; drop < 12; drop += 1) {
        const angle = -Math.PI + (drop / 12) * Math.PI;
        plot(
          -0.1 + Math.cos(angle) * splash * 0.9,
          water - 0.05 + Math.sin(angle) * splash * 0.7 * (1 - splash),
          (1 - splash) * 0.8,
        );
      }
      return;
    }
    const u = -0.72 + fall * 0.62;
    const v = -0.55 + fall * fall * 1.35;
    /* Tuck to spin, open again for the entry: the limbs pull in and out. */
    const reach = 0.3 - Math.sin(clamp01(fall / 0.8) * Math.PI) * 0.2;
    for (let limb = 0; limb < 4; limb += 1) {
      const angle = fall * 9 + (limb / 4) * TAU;
      plot(u + Math.cos(angle) * reach, v + Math.sin(angle) * reach * 0.8, 0.75);
    }
    plot(u, v, 0.95);
  });
}

/* -- Kayak roll: a hull turning over and coming back up ------------------- */

function paintKayakRoll(t: number): string {
  return paintPlotted((plot) => {
    const roll = t * 1.1;
    const water = 0.15;
    for (let x = 0; x <= 26; x += 1) {
      const u = -ASPECT + (x / 26) * ASPECT * 2;
      plot(u, water + Math.sin(u * 3 - t * 2.4) * 0.09, 0.45);
    }
    const lean = Math.sin(roll);
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20 - 0.5;
      plot(f * 1.5, water - 0.1 - Math.cos(f * 2.4) * 0.05 + lean * 0.12, 0.75);
    }
    /* Half the paddle is under water at any time, and the drowned half dims. */
    const paddle = roll + Math.PI / 2;
    for (let step = -10; step <= 10; step += 1) {
      const f = step / 10;
      const v = water - 0.15 + Math.sin(paddle) * f * 0.55;
      plot(Math.cos(paddle) * f * 0.9, v, v > water ? 0.35 : 0.85);
    }
    plot(0, water - 0.15 + lean * 0.2, 0.9);
    for (let foam = 0; foam < 8; foam += 1) {
      const life = (t * 1.4 + hash(foam * 3.1)) % 1;
      plot((hash(foam) * 2 - 1) * 1.2, water - life * 0.15, (1 - life) * 0.4);
    }
  });
}

/* -- Heavy bag: punches on a beat, and the swing between them ------------- */

function paintBoxingBag(t: number): string {
  return paintPlotted((plot) => {
    const beat = (t * 1.1) % 1;
    /* The bag rings and settles between hits rather than swinging steadily. */
    const swing = Math.exp(-beat * 3.4) * Math.sin(beat * 18) * 0.5;
    for (let x = 0; x <= 14; x += 1) plot(-0.3 + (x / 14) * 0.6, -0.95, 0.5);
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(swing * f * 0.6, -0.92 + f * 0.35, 0.45);
    }
    for (let y = 0; y <= 14; y += 1) {
      const f = y / 14;
      const u = swing * (0.6 + f * 0.4);
      const v = -0.55 + f * 1.15;
      plot(u - 0.2, v, 0.75);
      plot(u + 0.2, v, 0.75);
      plot(u, v, 0.35 + Math.abs(swing) * 0.7);
    }
    /* The glove comes in from the right and snaps back after contact. */
    const reach = Math.max(0, Math.sin(beat * TAU)) * 0.7;
    plot(1.2 - reach, -0.15, 0.9);
    plot(1.32 - reach * 0.7, 0.2, 0.8);
    for (let step = 0; step <= 6; step += 1) {
      plot(1.32 - reach + (step / 6) * 0.35, -0.15 + (step / 6) * 0.15, 0.5);
    }
  });
}

/* -- Tennis rally: one bounce per leg, and a racket at each end ----------- */

function paintTennisRally(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.9, 0.3);
    for (let y = 0; y <= 8; y += 1) plot(0, 0.88 - (y / 8) * 0.55, 0.6);
    const rally = t * 0.75;
    const leg = Math.floor(rally);
    const f = rally - leg;
    const direction = leg % 2 === 0 ? 1 : -1;
    const u = direction * (-1.3 + f * 2.6);
    /* The bounce halves the height, so the second hop reads as the lower one. */
    const arc = Math.abs(Math.sin(f * TAU)) * (f < 0.5 ? 1 : 0.55);
    plot(u, 0.74 - arc * 1.1, 0.95);
    for (const side of [-1, 1] as const) {
      const swing = side === direction ? 1 - f : f;
      const pu = side * 1.42;
      plot(pu, 0.58, 0.8);
      for (let step = 0; step <= 8; step += 1) {
        const s = step / 8;
        plot(pu - side * s * 0.45 * swing, 0.55 - s * 0.5 * swing, 0.6);
      }
      for (let step = 0; step < 10; step += 1) {
        const angle = (step / 10) * TAU;
        plot(pu - side * 0.45 * swing + Math.cos(angle) * 0.16, 0.05 + Math.sin(angle) * 0.16, 0.5);
      }
    }
  });
}

/* -- Golf swing: a slow backswing and a fast one down --------------------- */

function paintGolfSwing(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 1;
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.8, 0.35);
    const pivotU = -1.05;
    const pivotV = 0.1;
    /* Most of the cycle is spent going up, which is what makes the strike snap. */
    const angle =
      cycle < 0.7 ? -1.7 - (cycle / 0.7) * 2.6 : -4.3 + ((cycle - 0.7) / 0.3) * 3.5;
    plot(pivotU, pivotV, 0.9);
    plot(pivotU, 0.45, 0.7);
    for (let step = 0; step <= 16; step += 1) {
      const f = step / 16;
      plot(pivotU + Math.cos(angle) * f * 0.95, pivotV + Math.sin(angle) * f * 0.95, 0.55 + f * 0.35);
    }
    if (cycle <= 0.92) {
      plot(-0.15, 0.77, 0.9);
      return;
    }
    /* After contact the ball climbs away and the divot stays where it was. */
    const flight = (cycle - 0.92) / 0.08;
    plot(-0.15 + flight * 2.4, 0.77 - Math.sin(flight * 1.4) * 1.3, 0.95);
    plot(-0.15, 0.78, 0.5);
  });
}

/* -- Kickflip: a deck turning under a rider ------------------------------- */

function paintKickflip(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.6) % 1;
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.85, 0.35);
    const air = Math.sin(cycle * Math.PI);
    const u = -1.2 + cycle * 2.4;
    const v = 0.7 - air * 0.75;
    /* Seen end on, the flip is a segment turning about the direction of travel. */
    const spin = cycle * TAU * 1.5;
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14 - 0.5;
      plot(u + Math.cos(spin) * f * 0.8, v + Math.sin(spin) * f * 0.5, 0.85);
    }
    /* Wheels sit on one face only, so the turn has a readable direction. */
    for (const side of [-0.25, 0.25] as const) {
      plot(
        u + Math.cos(spin) * side - Math.sin(spin) * 0.12,
        v + Math.sin(spin) * side * 0.6 + Math.cos(spin) * 0.12,
        0.6,
      );
    }
    plot(u + 0.05, v - 0.5 - air * 0.05, 0.95);
    plot(u - 0.1, v - 0.28, 0.7);
    plot(u + 0.2, v - 0.28, 0.7);
  });
}

/* -- Hang glider: circling up inside a thermal ---------------------------- */

function paintHangGlider(t: number): string {
  return paintPlotted((plot) => {
    const turn = t * 0.7;
    const u = Math.sin(turn) * 1.15;
    const v = -0.1 + Math.cos(turn) * 0.18 - Math.sin(t * 0.25) * 0.35;
    /* Facing straight at the viewer shows full span; edge on shows almost none. */
    const span = 0.4 + Math.abs(Math.cos(turn)) * 0.6;
    for (let step = -12; step <= 12; step += 1) {
      const f = step / 12;
      plot(u + f * span, v - 0.1 + Math.abs(f) * 0.22, 0.8);
    }
    plot(u, v - 0.1, 0.9);
    for (let step = 0; step <= 6; step += 1) plot(u, v - 0.08 + (step / 6) * 0.24, 0.6);
    plot(u, v + 0.18, 0.95);
    for (let ridge = 0; ridge <= 26; ridge += 1) {
      const ru = -ASPECT + (ridge / 26) * ASPECT * 2;
      plot(ru, 0.75 + Math.sin(ru * 1.4) * 0.12, 0.3);
    }
  });
}

/* -- Zeppelin: a ribbed hull cruising past on its props ------------------- */

function paintZeppelin(t: number): string {
  return paintPlotted((plot) => {
    const cruise = ((t * 0.5) % 4.6) - 2.3;
    const bob = Math.sin(t * 0.9) * 0.08;
    /* Hull is an ellipse; the ribs across it are what give it volume. */
    const halfAt = (f: number) => Math.sqrt(Math.max(0, 1 - Math.pow((f - 0.5) * 2, 2))) * 0.32;
    for (let step = 0; step <= 40; step += 1) {
      const f = step / 40;
      const u = cruise - 0.95 + f * 1.9;
      plot(u, -0.15 + bob - halfAt(f), 0.75);
      plot(u, -0.15 + bob + halfAt(f), 0.75);
    }
    for (let rib = 1; rib < 5; rib += 1) {
      const f = rib / 5;
      for (let y = 0; y <= 8; y += 1) {
        plot(cruise - 0.95 + f * 1.9, -0.15 + bob - halfAt(f) + (y / 8) * halfAt(f) * 2, 0.3);
      }
    }
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(cruise - 0.95 + f * 0.3, -0.15 + bob - 0.1 - (1 - f) * 0.32, 0.55);
      plot(cruise - 0.95 + f * 0.3, -0.15 + bob + 0.1 + (1 - f) * 0.32, 0.55);
    }
    for (let x = 0; x <= 8; x += 1) plot(cruise - 0.2 + (x / 8) * 0.4, 0.3 + bob, 0.85);
    for (const side of [-0.6, 0.6] as const) {
      for (let blade = 0; blade < 2; blade += 1) {
        const angle = t * 9 + blade * Math.PI;
        plot(cruise + side, -0.15 + bob + Math.sin(angle) * 0.24, 0.5 + Math.abs(Math.cos(angle)) * 0.4);
      }
    }
  });
}

/* -- Snowplough: bare road behind the blade, a wave off the front --------- */

function paintSnowplough(t: number): string {
  return paintPlotted((plot) => {
    const drive = ((t * 0.55) % 4.4) - 2.2;
    const road = 0.7;
    for (let x = 0; x <= 26; x += 1) {
      const u = -ASPECT + (x / 26) * ASPECT * 2;
      /* Snow lies ahead of the blade only, so the pass is visible in the frame. */
      plot(u, road + 0.14, u > drive + 0.4 ? 0.5 + Math.abs(Math.sin(u * 6)) * 0.2 : 0.14);
    }
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(drive + 0.35 + f * 0.25, road + 0.15 - f * 0.55, 0.85);
    }
    for (let x = 0; x <= 12; x += 1) plot(drive - 0.6 + (x / 12) * 1.0, road - 0.4, 0.7);
    for (let y = 0; y <= 6; y += 1) plot(drive - 0.6, road - 0.4 + (y / 6) * 0.42, 0.6);
    for (const wheel of [-0.4, 0.25] as const) {
      for (let step = 0; step < 12; step += 1) {
        const angle = (step / 12) * TAU + t * 5;
        plot(drive + wheel + Math.cos(angle) * 0.16, road + Math.sin(angle) * 0.16, 0.55);
      }
    }
    /* Thrown snow arcs off the blade and comes down on the verge. */
    for (let fleck = 0; fleck < 14; fleck += 1) {
      const life = (t * 1.6 + hash(fleck * 2.3)) % 1;
      plot(
        drive + 0.6 + life * 0.95,
        road - 0.15 - Math.sin(life * Math.PI) * 0.8 + life * 0.2,
        (1 - life) * 0.8,
      );
    }
  });
}

/* -- Street sweeper: counter-rotating brushes taking the litter ----------- */

function paintStreetSweeper(t: number): string {
  return paintPlotted((plot) => {
    const drive = ((t * 0.5) % 4.4) - 2.2;
    const road = 0.72;
    for (let x = 0; x <= 26; x += 1) {
      const u = -ASPECT + (x / 26) * ASPECT * 2;
      /* Litter only survives ahead of the machine. */
      plot(u, road + 0.16, u > drive + 0.5 && hash2(Math.floor(u * 9), 3) > 0.55 ? 0.6 : 0.12);
    }
    for (let x = 0; x <= 14; x += 1) plot(drive - 0.7 + (x / 14) * 1.3, road - 0.6, 0.7);
    for (let y = 0; y <= 8; y += 1) {
      plot(drive - 0.7, road - 0.6 + (y / 8) * 0.5, 0.65);
      plot(drive + 0.6, road - 0.6 + (y / 8) * 0.5, 0.65);
    }
    /* The two brushes turn opposite ways, sweeping the line into the middle. */
    for (const [offset, direction] of [
      [0.55, 1],
      [0.15, -1],
    ] as const) {
      for (let bristle = 0; bristle < 8; bristle += 1) {
        const angle = (bristle / 8) * TAU + t * 6 * direction;
        plot(
          drive + offset + Math.cos(angle) * 0.22,
          road + 0.04 + Math.sin(angle) * 0.12,
          0.4 + Math.abs(Math.sin(angle * 2)) * 0.4,
        );
      }
    }
    for (const wheel of [-0.5, 0.35] as const) {
      for (let step = 0; step < 10; step += 1) {
        const angle = (step / 10) * TAU + t * 4;
        plot(drive + wheel + Math.cos(angle) * 0.15, road - 0.1 + Math.sin(angle) * 0.15, 0.55);
      }
    }
    for (let spray = 0; spray < 6; spray += 1) {
      const life = (t * 2 + hash(spray * 5.9)) % 1;
      plot(drive + 0.78 + life * 0.3, road - 0.02 + life * 0.1, (1 - life) * 0.5);
    }
  });
}

/* -- Level crossing: lights, then the barrier, then the train ------------- */

function paintLevelCrossing(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.28) % 1;
    /* The lights start first and stop last: the barrier moves inside them. */
    const warning = cycle > 0.08 && cycle < 0.85;
    const lower = clamp01((cycle - 0.14) * 5) - clamp01((cycle - 0.78) * 5);
    for (let x = 0; x <= 26; x += 1) {
      const u = -ASPECT + (x / 26) * ASPECT * 2;
      plot(u, 0.5, 0.4);
      plot(u, 0.76, 0.4);
    }
    for (let y = 0; y <= 10; y += 1) plot(-1.2, 0.45 - (y / 10) * 0.95, 0.6);
    const arm = -lower * (Math.PI / 2);
    for (let step = 0; step <= 18; step += 1) {
      const f = step / 18;
      plot(-1.2 + Math.cos(arm) * f * 1.15, -0.4 - Math.sin(arm) * f * 1.15, step % 3 === 0 ? 0.9 : 0.6);
    }
    const blink = warning && Math.sin(t * 9) > 0 ? 1 : 0;
    plot(-1.38, -0.55, 0.3 + blink * 0.65);
    plot(-1.02, -0.55, 0.95 - blink * 0.65);
    if (cycle > 0.38 && cycle < 0.72) {
      const nose = -2.6 + ((cycle - 0.38) / 0.34) * 5.2;
      for (let car = 0; car < 4; car += 1) {
        const u = nose - car * 1.05;
        for (let x = 0; x <= 10; x += 1) {
          plot(u - 0.45 + (x / 10) * 0.9, 0.48, 0.8);
          plot(u - 0.45 + (x / 10) * 0.9, 0.74, 0.8);
        }
        for (let y = 0; y <= 4; y += 1) {
          plot(u - 0.45, 0.48 + (y / 4) * 0.26, 0.7);
          plot(u + 0.45, 0.48 + (y / 4) * 0.26, 0.7);
        }
      }
    }
  });
}

/* ========================================================================
   The eighth collection: high air and underground fields, then a
   laboratory, a bakery, a winter station, and the works at a mine and a
   canal. Same contract as everything above: a pure painter over the
   shared grid.
   ===================================================================== */

/* -- Contrail: jet trails spreading out behind their aircraft ------------- */

const contrailField: Field = (u, v, t) => {
  let sky = 0.05 + clamp01((0.9 - v) * 0.09);
  for (let jet = 0; jet < 3; jet += 1) {
    const run = ASPECT * 2 + 2.2;
    const head = -ASPECT - 1.1 + ((t * (0.5 + hash(jet * 3.7) * 0.35) + hash(jet) * run) % run);
    if (u > head) continue;
    const line = -0.55 + jet * 0.52 + u * (hash(jet * 8.1) - 0.5) * 0.35;
    /* The older stretch of a trail has had time to spread and go ragged. */
    const age = clamp01((head - u) / 2.6);
    const core = clamp01(1 - Math.abs(v - line) / (0.07 + age * 0.42));
    const texture = 0.45 + fbm(u * 3 + t * 0.15, v * 6, 2) * 0.75;
    sky = Math.max(sky, core * (1 - age * 0.5) * texture);
  }
  return clamp01(sky);
};

/* -- Virga: rain that gives out before it reaches the ground -------------- */

const virgaField: Field = (u, v, t) => {
  const base = -0.34 + Math.sin(u * 1.4 + t * 0.3) * 0.12;
  const deck = v < base ? 0.3 + fbm(u * 1.6 + t * 0.2, v * 2.2, 3) * 0.55 : 0;
  /* One shaft per column of air, each giving out at a height of its own. */
  const column = Math.floor((u + ASPECT) * 3.4);
  const reach = 0.35 + hash(column * 2.7) * 0.95;
  const fall = (t * 0.85 + hash(column)) % 1;
  const depth = v - base;
  const streak =
    depth > 0
      ? clamp01(1 - Math.abs(depth - fall * reach) * 3.6) * clamp01(1 - depth / reach)
      : 0;
  return clamp01(0.04 + deck + streak * 0.85);
};

/* -- Mammatus: pouches hanging under a spent storm base ------------------- */

const mammatusField: Field = (u, v, t) => {
  const base = -0.12;
  if (v < base) return clamp01(0.42 + fbm(u * 1.2 + t * 0.12, v * 1.7, 3) * 0.4);
  let lobe = 0;
  for (let bag = 0; bag < 7; bag += 1) {
    const cu = -ASPECT + 0.35 + (bag / 6) * (ASPECT * 2 - 0.7);
    /* Every pouch sags and lifts on its own clock, so the row never lines up. */
    const radius = 0.24 + Math.sin(t * 0.9 + bag * 1.3) * 0.08;
    lobe = Math.max(
      lobe,
      clamp01(1 - Math.hypot((u - cu) / radius, (v - base) / (radius * 1.7))),
    );
  }
  return clamp01(0.06 + lobe * 0.88);
};

/* -- Lenticular: lens clouds standing still in a moving wind -------------- */

const lenticularField: Field = (u, v, t) => {
  const ridge = 0.82 - clamp01(1 - Math.abs(u + 0.45) * 0.9) * 1.1;
  if (v > ridge) return clamp01(0.34 + (v - ridge) * 0.3);
  let stack = 0;
  for (let lens = 0; lens < 3; lens += 1) {
    const width = 1.15 - lens * 0.2;
    const taper = clamp01(1 - Math.abs((u + 0.2) / width));
    /* The cloud holds its place while the air pours through it, so only the
       thickness breathes: a lens that drifted would read as an ordinary cloud. */
    const thickness = (0.05 + taper * 0.16) * (0.85 + Math.sin(t * 0.7 + lens * 1.4) * 0.15);
    const cv = -0.62 + lens * 0.32;
    stack = Math.max(stack, clamp01(1 - Math.abs(v - cv) / thickness) * (0.45 + taper * 0.55));
  }
  const flow = fbm(u * 1.4 - t * 0.9, v * 2.6, 2) * 0.18;
  return clamp01(0.05 + flow + stack * 0.85);
};

/* -- Fogbow: a colourless arc standing in drifting fog -------------------- */

const fogbowField: Field = (u, v, t) => {
  const drift = fbm(u * 1.1 + t * 0.35, v * 1.6 - t * 0.12, 3);
  const radius = Math.hypot(u * 0.85, (v + 0.95) * 0.85);
  /* Wide and soft: fog drops are too small to split the light into bands. */
  const bow = clamp01(1 - Math.abs(radius - 1.15) * 3.4);
  const sun = clamp01(1 - Math.hypot(u + 1.1, v - 0.7) * 1.6) * 0.35;
  return clamp01(0.1 + drift * 0.34 + bow * (0.35 + drift * 0.5) + sun);
};

/* -- Sinkhole: ground going down the shaft it just opened ----------------- */

const sinkholeField: Field = (u, v, t) => {
  const radius = Math.hypot(u * 0.8, v);
  const mouth = 0.55 + Math.sin(t * 0.5) * 0.06;
  if (radius < mouth * 0.55) return 0.02;
  /* Rings of ground creep inward, so the collapse reads as ongoing. */
  const ring = Math.sin(radius * 7 - t * 1.6);
  const lip = clamp01(1 - Math.abs(radius - mouth) * 5) * 0.8;
  const slump = clamp01((radius - mouth) * 1.4);
  const grain = fbm(u * 3.4, v * 3.4, 2) * 0.3;
  return clamp01(0.06 + slump * (0.3 + grain) + Math.pow(clamp01(ring), 3) * slump * 0.4 + lip);
};

/* -- Mine seam: a cutter working one bright band of a strata face --------- */

const mineSeamField: Field = (u, v, t) => {
  const bed = (v + 1) * 2.4 + Math.sin(u * 0.8 + 0.4) * 0.4;
  const layer = Math.floor(bed);
  const within = bed - layer;
  const seam = layer === 2;
  /* Hard and soft beds alternate, with a bright parting at every contact. */
  const rock = 0.08 + (layer % 2 === 0 ? 0.06 : 0.2) + hash(layer * 4.3) * 0.1;
  const parting = clamp01(1 - within * 9) * 0.45;
  const head = -ASPECT - 0.4 + ((t * 0.65) % (ASPECT * 2 + 0.9));
  /* The cutter has already taken everything behind the head out of the seam. */
  const cut = seam && u < head ? 0.45 : 0;
  const face = seam ? clamp01(1 - Math.abs(u - head) * 3.5) : 0;
  const spark = face * (0.3 + hash2(Math.floor(v * 14), Math.floor(t * 11)) * 0.7);
  return clamp01(rock + parting + cut + spark * 0.9 + (seam ? 0.16 : 0));
};

/* -- Lava tube: a roofed flow seen through the hole in its roof ----------- */

const lavaTubeField: Field = (u, v, t) => {
  const roof = clamp01(1 - Math.hypot((u - 0.2) * 0.9, (v + 0.15) * 1.5) * 1.3);
  /* Only the skylight shows the flow; the rest is cooled crust over it. */
  const open = clamp01((roof - 0.42) * 6);
  const flow = Math.sin((u - t * 2.4) * 3.2 + Math.sin(v * 3) * 0.8);
  const molten = (0.55 + Math.pow(clamp01(flow * 0.5 + 0.5), 1.6) * 0.45) * open;
  const crust = (1 - open) * (0.1 + fbm(u * 2.6, v * 2.6, 2) * 0.22);
  /* The rim of the hole picks up the glow from below, which is what makes the
     skylight read as a hole rather than a bright patch of rock. */
  const rim = clamp01(roof - 0.3) * 0.16 * (0.6 + Math.sin(t * 3) * 0.4);
  return clamp01(0.04 + crust + molten + rim);
};

/* -- Cave drip: water finding the floor of a dark chamber ----------------- */

const caveDripField: Field = (u, v, t) => {
  const ceiling = clamp01((-0.6 - v) * 3) * 0.4;
  const floor = clamp01((v - 0.62) * 3) * 0.35;
  let water = 0;
  for (let drip = 0; drip < 5; drip += 1) {
    const cu = -ASPECT + 0.5 + (drip / 4) * (ASPECT * 2 - 1);
    const period = 1.4 + hash(drip * 3.3) * 1.3;
    const phase = ((t + hash(drip) * period) % period) / period;
    const stone = clamp01(1 - Math.abs(u - cu) * 5) * clamp01((-0.5 - v) * 2.4) * 0.7;
    const bead = clamp01(1 - Math.hypot((u - cu) * 2.6, v - (-0.7 + phase * 1.5)));
    /* The ring on the floor belongs to the drip that landed, not the one falling. */
    const ring = phase > 0.9 ? clamp01(1 - Math.abs(Math.abs(u - cu) - (phase - 0.9) * 6) * 5) * clamp01((v - 0.55) * 4) : 0;
    water = Math.max(water, Math.max(stone, Math.max(bead * 0.9, ring * 0.7)));
  }
  return clamp01(0.03 + ceiling + floor + water);
};

/* -- Aquifer: a water table breathing up and down through gravel ---------- */

const aquiferField: Field = (u, v, t) => {
  const table = -0.05 + Math.sin(t * 0.5) * 0.4;
  /* Grain sets the pore pattern and stays put; only the water moves. */
  const grain = hash2(Math.floor(u * 5.5), Math.floor(v * 5.5));
  const dry = 0.07 + (grain > 0.62 ? 0.2 : 0.03);
  const wet = clamp01((v - table) * 2.5);
  /* Full pores read solid, with the flow drawing slow lines through them. */
  const flow = 0.42 + Math.sin(u * 3 - t * 1.1 + v * 2) * 0.12 + grain * 0.12;
  const surface = clamp01(1 - Math.abs(v - table) * 6) * 0.5;
  const capillary =
    clamp01(1 - Math.abs(v - table + 0.14) * 5) * 0.22 * (0.5 + Math.sin(u * 7 + t) * 0.5);
  return clamp01(dry * (1 - wet) + wet * flow + surface + capillary);
};

/* -- Geode: a lined cavity turning its facets through the light ----------- */

const geodeField: Field = (u, v, t) => {
  const radius = Math.hypot(u * 0.82, v);
  const shell = clamp01(1 - Math.abs(radius - 0.92) * 3.6) * 0.5;
  if (radius > 1) return clamp01(0.06 + shell);
  const angle = Math.atan2(v, u * 0.82);
  /* Facets are wedges of the cavity wall; each catches the light in turn. */
  const facet = Math.floor((angle / TAU + 0.5) * 14);
  const glint = Math.pow(clamp01(Math.sin(t * 1.3 + facet * 0.9) * 0.5 + 0.5), 3);
  const inward = clamp01((0.95 - radius) * 2.2);
  const crystal = clamp01(1 - Math.abs(radius - (0.86 - hash(facet) * 0.3)) * 5);
  return clamp01(0.05 + shell + crystal * (0.25 + glint * 0.75) * (0.4 + inward * 0.6));
};

/* -- Brine channel: veins of unfrozen salt water inside sea ice ----------- */

const brineChannelField: Field = (u, v, t) => {
  const ice = 0.15 + fbm(u * 1.6, v * 1.6, 2) * 0.13;
  /* The channels are the contour where a smooth field crosses its own middle.
     Keeping that field low frequency is what makes a connected net instead of
     a scatter of unrelated specks. */
  const web = fbm(u * 1.5 + 0.7, v * 1.5 - t * 0.12, 2);
  const vein = clamp01(1 - Math.abs(web - 0.5) * 14);
  const branch = clamp01(1 - Math.abs(fbm(u * 2.6 - t * 0.08, v * 2.6, 2) - 0.5) * 22) * 0.45;
  const drain = clamp01(1 - Math.abs(v - 0.6) * 2) * 0.25;
  return clamp01(ice + vein * 0.65 + branch + drain * (vein + 0.3));
};

/* -- Sastrugi: wind-carved snow ridges under a low sun -------------------- */

const sastrugiField: Field = (u, v, t) => {
  /* Ridges run with the wind and creep slowly downwind. The sun does not move,
     so what travels across the scene is the shading, not the snow. */
  const carve = (du: number) => fbm((u + du) * 0.9 - t * 0.1, v * 2.8, 2);
  const height = Math.pow(clamp01(carve(0) * 1.6 - 0.35), 1.2);
  const ahead = Math.pow(clamp01(carve(0.22) * 1.6 - 0.35), 1.2);
  /* The face turned into the light is bright; the lee side falls away flat. */
  const lit = clamp01(0.5 + (height - ahead) * 7);
  const crest = clamp01(1 - Math.abs(height - 0.55) * 6) * 0.28;
  return clamp01(0.07 + height * 0.25 + lit * height * 0.9 + crest);
};

/* -- Rime ice: feathers building into the wind on a wire ------------------ */

const rimeIceField: Field = (u, v, t) => {
  const wire = 0.15;
  /* Rime only builds on the windward face, so every feather points one way and
     the wire below them stays clear. */
  const grown = 0.55 + Math.abs(Math.sin(t * 0.3)) * 1.1;
  const tooth = Math.floor((u + ASPECT) * 5);
  const length = grown * (0.35 + hash(tooth * 3.1) * 0.65);
  const along = (wire - v) / length;
  /* Feathers lean into the wind as they lengthen, so the comb rakes over. */
  const lean = (wire - v) * 0.22;
  const spine = clamp01(1 - Math.abs(u + lean - ((tooth + 0.5) / 5 - ASPECT)) * 6);
  const feather = along > 0 && along < 1 ? spine * (1 - along * 0.65) : 0;
  const barbs = feather * (0.55 + Math.abs(Math.sin((wire - v) * 20 + tooth)) * 0.45);
  const bar = clamp01(1 - Math.abs(v - wire) * 7) * 0.7;
  const air = 0.05 + fbm(u * 1.5 + t * 0.5, v * 1.5, 2) * 0.12;
  return clamp01(air + bar + barbs * 0.9);
};

/* -- Estuary: braided channels meeting an incoming tide ------------------- */

const estuaryField: Field = (u, v, t) => {
  const tide = Math.sin(t * 0.45) * 0.5;
  const sea = clamp01((u - 0.9 + tide) * 2.2);
  let channel = 0;
  for (let braid = 0; braid < 4; braid += 1) {
    const wander = Math.sin(u * 1.3 + braid * 1.9 + t * 0.25) * 0.42 + (braid - 1.5) * 0.34;
    channel = Math.max(channel, clamp01(1 - Math.abs(v - wander) * 5));
  }
  const flat = 0.12 + fbm(u * 3, v * 3, 2) * 0.2;
  const chop = 0.45 + Math.abs(Math.sin(v * 5 - t * 2.6)) * 0.35;
  return clamp01(flat + channel * (1 - sea) * 0.55 + sea * chop);
};

/* -- Sea stacks: surge running through the gaps between them -------------- */

const seaStackField: Field = (u, v, t) => {
  const waterline = 0.35;
  let rock = 0;
  for (let stack = 0; stack < 3; stack += 1) {
    const cu = -1.1 + stack * 1.1;
    const width = 0.24 + hash(stack * 2.2) * 0.12;
    const top = -0.75 + hash(stack * 5.4) * 0.5;
    if (v > top && Math.abs(u - cu) < width * (0.7 + (v - top) * 0.4)) rock = 0.55 + hash2(Math.floor(u * 8), Math.floor(v * 8)) * 0.35;
  }
  if (rock > 0) return clamp01(rock);
  if (v < waterline) return 0.05 + clamp01((waterline - v) * 0.15);
  /* Surge piles up between the stacks, so the foam is brightest in the gaps. */
  const surge = Math.sin(u * 2.4 - t * 2.2) * 0.5 + 0.5;
  const swash = clamp01(1 - Math.abs(v - (waterline + 0.12 + surge * 0.2)) * 4);
  return clamp01(0.14 + swash * (0.4 + surge * 0.55) + Math.abs(Math.sin(u * 7 - t * 3)) * 0.12);
};

/* -- Wrack line: the tide leaving a line of debris behind it -------------- */

const wrackLineField: Field = (u, v, t) => {
  const reach = 0.5 - ((t * 0.3) % 2) * 0.55;
  const sand = 0.1 + fbm(u * 4, v * 4, 2) * 0.16;
  const wet = clamp01((v - reach) * 2.5) * 0.28;
  /* Debris strands where the water turned, and stays put once the sea drops. */
  const strand = clamp01(1 - Math.abs(v - (reach + 0.08)) * 7);
  const litter = hash2(Math.floor(u * 11), Math.floor(reach * 6)) > 0.45 ? 1 : 0.3;
  const edge = clamp01(1 - Math.abs(v - reach) * 6) * (0.5 + Math.abs(Math.sin(u * 6 - t * 3.2)) * 0.5);
  return clamp01(sand + wet + strand * litter * 0.55 + edge * 0.5);
};

/* -- Sandbar: a bar walking sideways under a steady swell ----------------- */

const sandbarField: Field = (u, v, t) => {
  const crest = 0.15 + Math.sin(u * 1.6 + t * 0.35) * 0.1;
  const bar = clamp01(1 - Math.abs(v - crest) * 3.2);
  /* Waves break where the water shoals, which is the top of the bar. */
  const swell = Math.sin(u * 3 - t * 2.4);
  const breaking = bar * Math.pow(clamp01(swell * 0.5 + 0.5), 1.8);
  const deep = clamp01((crest - v) * 1.6) * 0.16;
  const inshore = clamp01((v - crest) * 1.4) * (0.14 + Math.abs(Math.sin(u * 4 - t * 1.6)) * 0.12);
  return clamp01(0.05 + deep + inshore + bar * 0.22 + breaking * 0.8);
};

/* -- Centrifuge: a rotor spinning up, holding, and coasting down ---------- */

function paintCentrifuge(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.16) % 1;
    /* Spin up, run, brake: the tubes only read as separate arms at the ends. */
    const rate = clamp01(cycle * 6) - clamp01((cycle - 0.72) * 4);
    const angle = t * (2 + rate * 16);
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      plot(Math.cos(a) * 1.15, Math.sin(a) * 0.82, 0.45);
    }
    for (let tube = 0; tube < 6; tube += 1) {
      const a = angle + (tube / 6) * TAU;
      const swing = 0.35 + rate * 0.5;
      for (let along = 0; along <= 6; along += 1) {
        const reach = 0.3 + (along / 6) * 0.55;
        plot(
          Math.cos(a) * reach,
          Math.sin(a) * reach * 0.7 + swing * 0.05,
          0.5 + (along / 6) * (0.5 - rate * 0.3),
        );
      }
    }
    for (let step = 0; step <= 8; step += 1) {
      const a = (step / 8) * TAU;
      plot(Math.cos(a) * 0.16, Math.sin(a) * 0.12, 0.9);
    }
    plot(-1.3, 0.85, rate > 0.5 ? 0.95 : 0.2);
  });
}

/* -- Microscope: focus hunting until the specimen resolves ---------------- */

function paintMicroscope(t: number): string {
  return paintPlotted((plot) => {
    const focus = Math.abs(Math.sin(t * 0.45));
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      plot(Math.cos(a) * 1.02, Math.sin(a) * 0.9, 0.4);
    }
    /* Out of focus the cells are one soft blob; in focus they separate. */
    for (let cell = 0; cell < 7; cell += 1) {
      const cu = (hash(cell * 2.3) * 2 - 1) * 0.7;
      const cv = (hash(cell * 7.1) * 2 - 1) * 0.6;
      const wander = Math.sin(t * 0.8 + cell) * 0.06;
      const radius = 0.1 + (1 - focus) * 0.4;
      for (let ring = 0; ring <= 10; ring += 1) {
        const a = (ring / 10) * TAU;
        plot(
          cu + wander + Math.cos(a) * radius,
          cv + Math.sin(a) * radius * 0.8,
          0.25 + focus * 0.7,
        );
      }
    }
    for (let y = 0; y <= 6; y += 1) plot(1.28, -0.8 + (y / 6) * 1.6, 0.5);
    plot(1.28, -0.8 + focus * 1.6, 0.95);
  });
}

/* -- Pipette: draw, move, and dispense across a plate --------------------- */

function paintPipette(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 4;
    const well = Math.floor((t * 0.4) / 4) % 5;
    const target = -1.1 + well * 0.55;
    const source = -1.4;
    /* Four beats: fill at the reservoir, travel, dispense, travel back. */
    const travelOut = clamp01(cycle - 1);
    const travelBack = clamp01(cycle - 3);
    const tipU = source + (target - source) * (travelOut - travelBack);
    const dipping = cycle < 1 || (cycle > 2 && cycle < 3);
    const tipV = 0.15 + (dipping ? 0.2 : 0);
    /* The barrel fills over the first beat and empties over the third, so the
       column of liquid tracks the plunger rather than snapping full. */
    const charge = cycle < 1 ? cycle : cycle < 2 ? 1 : cycle < 3 ? 1 - (cycle - 2) : 0;
    for (let y = 0; y <= 8; y += 1) plot(tipU, -0.85 + (y / 8) * 0.85, 0.6);
    for (let y = 0; y <= 6; y += 1) plot(tipU, -0.16 - (y / 6) * charge * 0.5, 0.85);
    for (let y = 0; y <= 4; y += 1) {
      const f = y / 4;
      plot(tipU - 0.06 * (1 - f), 0.02 + f * (tipV - 0.02), 0.75);
      plot(tipU + 0.06 * (1 - f), 0.02 + f * (tipV - 0.02), 0.75);
    }
    const plunger = -0.95 + (1 - charge) * 0.22;
    for (let x = 0; x <= 4; x += 1) plot(tipU - 0.1 + (x / 4) * 0.2, plunger, 0.9);
    plot(tipU, -0.2, 0.15 + charge * 0.8);
    if (cycle > 2 && cycle < 3) {
      const bead = (cycle - 2) % 0.5;
      plot(tipU, tipV + bead * 0.5, clamp01(1 - bead * 1.6) * 0.9);
    }
    for (let x = 0; x <= 5; x += 1) {
      const wu = -1.1 + x * 0.55;
      for (let ring = 0; ring <= 8; ring += 1) {
        const a = (ring / 8) * TAU;
        plot(wu + Math.cos(a) * 0.18, 0.62 + Math.sin(a) * 0.14, x <= well ? 0.75 : 0.3);
      }
    }
    for (let x = 0; x <= 8; x += 1) plot(source - 0.18 + (x / 8) * 0.36, 0.55, 0.5);
  });
}

/* -- Bunsen burner: the collar opening from a soft flame to a roaring one -- */

function paintBunsenBurner(t: number): string {
  return paintPlotted((plot) => {
    const air = Math.abs(Math.sin(t * 0.35));
    for (let y = 0; y <= 8; y += 1) plot(0, 0.9 - (y / 8) * 0.7, 0.55);
    for (let x = 0; x <= 8; x += 1) plot(-0.4 + (x / 8) * 0.8, 0.92, 0.6);
    /* More air gives a shorter, harder cone; less gives a long lazy flame. */
    const height = 1.4 - air * 0.5;
    for (let step = 0; step <= 40; step += 1) {
      const f = step / 40;
      const flare = (1 - f) * (0.3 - air * 0.15) * (1 + Math.sin(t * 9 + f * 6) * (0.3 - air * 0.25));
      const cv = 0.2 - f * height;
      plot(-flare, cv, 0.35 + f * 0.4);
      plot(flare, cv, 0.35 + f * 0.4);
    }
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(0, 0.2 - f * height * (0.35 + air * 0.3), 0.6 + air * 0.4);
    }
    const collar = 0.62 - air * 0.1;
    for (let x = 0; x <= 6; x += 1) plot(-0.16 + (x / 6) * 0.32, collar, 0.85);
  });
}

/* -- Magnetic stirrer: a bar chasing the drive under the beaker ----------- */

function paintMagneticStirrer(t: number): string {
  return paintPlotted((plot) => {
    const drive = t * 5.5;
    /* The bar lags the drive and loses it when the plate runs too fast. */
    const slipping = Math.sin(t * 0.4) > 0.6;
    const angle = slipping ? drive * 0.3 + Math.sin(drive) * 0.8 : drive - 0.5;
    for (let y = 0; y <= 9; y += 1) {
      plot(-0.75, -0.7 + (y / 9) * 1.5, 0.6);
      plot(0.75, -0.7 + (y / 9) * 1.5, 0.6);
    }
    for (let x = 0; x <= 10; x += 1) plot(-0.75 + (x / 10) * 1.5, 0.8, 0.7);
    /* The vortex dips deeper the faster the bar is actually turning. */
    const bite = slipping ? 0.25 : 0.6;
    for (let x = 0; x <= 20; x += 1) {
      const f = x / 20;
      const u = -0.72 + f * 1.44;
      plot(u, -0.42 + Math.pow(Math.abs(u) / 0.72, 2) * -0.3 * bite + 0.3 * bite, 0.55);
    }
    for (let step = -6; step <= 6; step += 1) {
      const f = step / 6;
      plot(Math.cos(angle) * f * 0.4, 0.6 + Math.sin(angle) * f * 0.28, 0.9);
    }
    for (let x = 0; x <= 12; x += 1) plot(-0.95 + (x / 12) * 1.9, 1.0, 0.45);
  });
}

/* -- Vacuum pump: a pumped bell jar and the gauge that reports it ---------- */

function paintVacuumPump(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.22) % 1;
    /* Pull down slowly, then vent: the needle falls and snaps back. */
    const pressure = cycle < 0.8 ? 1 - cycle / 0.8 : (cycle - 0.8) / 0.2;
    for (let step = 0; step <= 22; step += 1) {
      const a = Math.PI + (step / 22) * Math.PI;
      plot(-0.55 + Math.cos(a) * 0.55, 0.35 + Math.sin(a) * 0.75, 0.6);
    }
    for (let x = 0; x <= 10; x += 1) plot(-1.1 + (x / 10) * 1.1, 0.82, 0.7);
    for (let mote = 0; mote < 9; mote += 1) {
      const speed = 0.6 + hash(mote * 3.1) * 1.2;
      const mu = -1 + ((hash(mote) + t * speed * pressure) % 1) * 0.9;
      const mv = -0.3 + ((hash(mote * 7.7) + t * speed * 0.7 * pressure) % 1) * 1.1;
      plot(mu, mv, 0.25 + pressure * 0.6);
    }
    for (let x = 0; x <= 8; x += 1) plot(-0.55 + (x / 8) * 1.25, 0.84 - (x / 8) * 0.02, 0.5);
    for (let step = 0; step <= 16; step += 1) {
      const a = (step / 16) * TAU;
      plot(0.95 + Math.cos(a) * 0.35, 0.1 + Math.sin(a) * 0.28, 0.5);
    }
    const needle = Math.PI * (0.85 + pressure * 1.3);
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(0.95 + Math.cos(needle) * f * 0.3, 0.1 + Math.sin(needle) * f * 0.24, 0.95);
    }
  });
}

/* -- Fume hood: the sash coming down and the draught taking the smoke ----- */

function paintFumeHood(t: number): string {
  return paintPlotted((plot) => {
    const sash = 0.5 + Math.sin(t * 0.5) * 0.5;
    for (let x = 0; x <= 24; x += 1) {
      const u = -1.3 + (x / 24) * 2.6;
      plot(u, -0.95, 0.6);
      plot(u, 0.85, 0.6);
    }
    for (let y = 0; y <= 12; y += 1) {
      plot(-1.3, -0.95 + (y / 12) * 1.8, 0.6);
      plot(1.3, -0.95 + (y / 12) * 1.8, 0.6);
    }
    const lip = -0.9 + (1 - sash) * 1.2;
    for (let x = 0; x <= 24; x += 1) plot(-1.3 + (x / 24) * 2.6, lip, 0.9);
    /* A lower sash pulls harder, so the fume leans towards the gap. */
    const pull = 0.3 + (1 - sash) * 1.4;
    for (let puff = 0; puff < 10; puff += 1) {
      const life = (t * 0.6 + hash(puff * 4.3)) % 1;
      const rise = 0.7 - life * 1.2;
      plot(
        -0.2 + Math.sin(life * 5 + puff) * 0.25 + life * pull * 0.5,
        rise,
        (1 - life) * 0.75,
      );
    }
    for (let step = 0; step <= 10; step += 1) {
      const a = (step / 10) * TAU;
      plot(-0.2 + Math.cos(a) * 0.2, 0.72 + Math.sin(a) * 0.12, 0.7);
    }
  });
}

/* -- Autoclave: pressure climbing, holding, and blowing off --------------- */

function paintAutoclave(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.14) % 1;
    const heat = cycle < 0.35 ? cycle / 0.35 : cycle < 0.75 ? 1 : 1 - (cycle - 0.75) / 0.25;
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      plot(-0.35 + Math.cos(a) * 0.85, Math.sin(a) * 0.72, 0.55);
    }
    /* The door dogs turn to locked as soon as the vessel takes pressure. */
    for (let dog = 0; dog < 6; dog += 1) {
      const a = (dog / 6) * TAU + heat * 0.5;
      plot(-0.35 + Math.cos(a) * 0.62, Math.sin(a) * 0.52, 0.45 + heat * 0.5);
    }
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * TAU;
      plot(-0.35 + Math.cos(a) * 0.28, Math.sin(a) * 0.22, 0.35 + heat * 0.55);
    }
    for (let y = 0; y <= 5; y += 1) plot(0.72, -0.5 + (y / 5) * 0.35, 0.6);
    if (cycle > 0.75) {
      const blow = (cycle - 0.75) / 0.25;
      for (let jet = 0; jet < 8; jet += 1) {
        const f = (jet / 8 + blow) % 1;
        plot(0.72 + f * 0.7, -0.5 - f * 0.5 + Math.sin(f * 8) * 0.08, (1 - f) * 0.9);
      }
    }
    for (let x = 0; x <= 12; x += 1) plot(-1.3 + (x / 12) * 1.9, 0.9, 0.4 + heat * 0.35);
  });
}

/* -- Chromatograph: a sample band separating as it runs up the plate ------ */

function paintChromatograph(t: number): string {
  return paintPlotted((plot) => {
    const run = (t * 0.3) % 1;
    for (let y = 0; y <= 12; y += 1) {
      plot(-1.15, -0.85 + (y / 12) * 1.7, 0.45);
      plot(1.15, -0.85 + (y / 12) * 1.7, 0.45);
    }
    for (let x = 0; x <= 22; x += 1) plot(-1.15 + (x / 22) * 2.3, 0.85, 0.55);
    /* Each component travels at a rate of its own, so one band becomes four. */
    for (let band = 0; band < 4; band += 1) {
      const rate = 0.45 + band * 0.18;
      const cv = 0.72 - run * 1.5 * rate;
      const spread = 0.04 + run * 0.09;
      for (let x = 0; x <= 18; x += 1) {
        const u = -1 + (x / 18) * 2;
        for (let s = -2; s <= 2; s += 1) {
          plot(u, cv + s * spread, (1 - Math.abs(s) / 3) * (0.4 + (1 - band * 0.15) * 0.5));
        }
      }
    }
    const front = 0.72 - run * 1.5;
    for (let x = 0; x <= 22; x += 1) plot(-1.15 + (x / 22) * 2.3, front - 0.1, 0.7);
  });
}

/* -- Geiger counter: a needle and a train of clicks over background ------- */

function paintGeigerCounter(t: number): string {
  return paintPlotted((plot) => {
    /* Activity rises as the probe nears the source, so the clicks bunch up. */
    const near = 0.5 + Math.sin(t * 0.5) * 0.5;
    const rate = 1.5 + near * 9;
    for (let step = 0; step <= 24; step += 1) {
      const a = Math.PI * (1 + step / 24);
      plot(-0.5 + Math.cos(a) * 0.75, 0.5 + Math.sin(a) * 0.6, 0.5);
    }
    const swing = Math.PI * (1.12 + near * 0.76 + Math.sin(t * 13) * 0.04);
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(-0.5 + Math.cos(swing) * f * 0.68, 0.5 + Math.sin(swing) * f * 0.54, 0.9);
    }
    for (let x = 0; x <= 12; x += 1) plot(-1.3 + (x / 12) * 1.6, 0.88, 0.55);
    for (let tick = 0; tick < 14; tick += 1) {
      const age = (t * rate - tick) % 14;
      if (age < 0 || age > 6) continue;
      plot(0.5 + age * 0.16, 0.2 - Math.sin(age) * 0.35, clamp01(1 - age / 6) * 0.85);
    }
    for (let y = 0; y <= 6; y += 1) plot(0.45, -0.6 + (y / 6) * 1.4, 0.4);
    plot(1.25, -0.55 + near * 0.4, 0.8);
  });
}

/* -- Dough mixer: a hook folding a mass around a bowl -------------------- */

function paintDoughMixer(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 24; step += 1) {
      const a = Math.PI * (step / 24);
      plot(Math.cos(a) * 1.05, 0.25 + Math.sin(a) * 0.65, 0.55);
    }
    /* Planetary action: the hook turns on its own axis while it orbits. */
    const orbit = t * 2.2;
    const spin = -t * 5;
    const hu = Math.cos(orbit) * 0.42;
    const hv = 0.4 + Math.sin(orbit) * 0.25;
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      const a = spin + f * 4;
      plot(hu + Math.cos(a) * f * 0.28, hv + f * 0.3 + Math.sin(a) * f * 0.12, 0.5 + f * 0.45);
    }
    for (let y = 0; y <= 8; y += 1) plot(hu, hv - 0.1 - (y / 8) * 0.75, 0.6);
    for (let x = 0; x <= 10; x += 1) plot(-0.5 + (x / 10) * 1.1, -0.85, 0.6);
    /* The mass climbs the hook and drops back: that is the fold. */
    for (let lump = 0; lump < 9; lump += 1) {
      const a = orbit * 0.6 + (lump / 9) * TAU;
      const climb = 0.5 + Math.sin(orbit * 2 + lump) * 0.5;
      plot(Math.cos(a) * 0.7, 0.62 - climb * 0.22 + Math.sin(a) * 0.16, 0.45 + climb * 0.4);
    }
  });
}

/* -- Rolling pin: dough spreading a little wider on every pass ------------ */

function paintRollingPin(t: number): string {
  return paintPlotted((plot) => {
    const pass = t * 0.9;
    const sweep = Math.sin(pass);
    const pin = sweep * 0.85;
    /* Each pass leaves the sheet wider and thinner than it found it. */
    const worked = clamp01(pass / 14);
    const halfWidth = 0.75 + worked * 0.5;
    const thickness = 0.26 - worked * 0.12;
    for (let x = 0; x <= 26; x += 1) {
      const u = -halfWidth + (x / 26) * halfWidth * 2;
      const taper = clamp01(1 - Math.abs(u / halfWidth));
      const squash = clamp01(1 - Math.abs(u - pin) * 1.6) * 0.35;
      const top = 0.62 - thickness * (0.4 + taper * 0.6) * (1 - squash);
      for (let y = 0; y <= 4; y += 1) plot(u, top + (y / 4) * (0.62 - top), 0.45 + taper * 0.4);
    }
    for (let x = 0; x <= 18; x += 1) plot(pin - 0.55 + (x / 18) * 1.1, 0.22, 0.85);
    for (let x = 0; x <= 18; x += 1) plot(pin - 0.55 + (x / 18) * 1.1, 0.4, 0.85);
    for (const handle of [-0.7, 0.7] as const) plot(pin + handle, 0.31, 0.7);
    for (let x = 0; x <= 26; x += 1) plot(-1.35 + (x / 26) * 2.7, 0.72, 0.5);
    for (let dust = 0; dust < 7; dust += 1) {
      const life = (t * 1.6 + hash(dust * 5.1)) % 1;
      plot(pin + (hash(dust) - 0.5) * 1.2, 0.2 - life * 0.5, (1 - life) * 0.4);
    }
  });
}

/* -- Bread oven: loaves rising and colouring behind the door -------------- */

function paintBreadOven(t: number): string {
  return paintPlotted((plot) => {
    const bake = (t * 0.1) % 1;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.3 + (x / 26) * 2.6;
      plot(u, -0.9, 0.6);
      plot(u, 0.9, 0.6);
    }
    for (let y = 0; y <= 12; y += 1) {
      plot(-1.3, -0.9 + (y / 12) * 1.8, 0.6);
      plot(1.3, -0.9 + (y / 12) * 1.8, 0.6);
    }
    /* Oven spring first, then colour: the loaves stop growing and start browning. */
    const spring = clamp01(bake * 3);
    const colour = clamp01((bake - 0.35) * 1.6);
    for (let shelf = 0; shelf < 2; shelf += 1) {
      const sv = -0.15 + shelf * 0.65;
      for (let x = 0; x <= 24; x += 1) plot(-1.15 + (x / 24) * 2.3, sv + 0.16, 0.45);
      for (let loaf = 0; loaf < 3; loaf += 1) {
        const cu = -0.8 + loaf * 0.8;
        for (let step = 0; step <= 16; step += 1) {
          const a = Math.PI + (step / 16) * Math.PI;
          plot(
            cu + Math.cos(a) * 0.3,
            sv + 0.15 + Math.sin(a) * (0.1 + spring * 0.16),
            0.35 + colour * 0.6,
          );
        }
        const slash = clamp01((spring - 0.3) * 2);
        plot(cu, sv + 0.02 - slash * 0.06, 0.3 + slash * 0.5);
      }
    }
    const glow = 0.35 + Math.sin(t * 2.2) * 0.1;
    for (let x = 0; x <= 20; x += 1) plot(-1.05 + (x / 20) * 2.1, 0.78, glow);
  });
}

/* -- Icing pipe: a bead of icing laid down in a running loop -------------- */

function paintIcingPipe(t: number): string {
  return paintPlotted((plot) => {
    const head = t * 1.6;
    const path = (s: number) => [Math.sin(s * 1.3) * 0.95, Math.sin(s * 2.1 + 0.6) * 0.55] as const;
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      plot(Math.cos(a) * 1.15, 0.15 + Math.sin(a) * 0.78, 0.4);
    }
    /* The bead stays where it was laid, so the trail is the last few seconds. */
    for (let back = 0; back <= 40; back += 1) {
      const s = head - back * 0.06;
      if (s < 0) break;
      const [pu, pv] = path(s);
      plot(pu, pv + 0.15, 0.35 + clamp01(1 - back / 40) * 0.55);
    }
    const [hu, hv] = path(head);
    for (let y = 0; y <= 8; y += 1) {
      const f = y / 8;
      plot(hu + f * 0.12, hv + 0.1 - 0.35 - f * 0.55, 0.55 + f * 0.35);
    }
    plot(hu, hv + 0.05, 0.95);
    for (let squeeze = 0; squeeze < 3; squeeze += 1) {
      plot(hu + 0.14 + squeeze * 0.05, hv - 0.5, 0.4 + Math.abs(Math.sin(t * 6 + squeeze)) * 0.4);
    }
  });
}

/* -- Whisk: a bowl of cream stiffening under the beaters ------------------ */

function paintWhisk(t: number): string {
  return paintPlotted((plot) => {
    const stiff = clamp01(((t * 0.25) % 1.6) / 1.2);
    for (let step = 0; step <= 24; step += 1) {
      const a = Math.PI * (step / 24);
      plot(Math.cos(a) * 1.0, 0.3 + Math.sin(a) * 0.6, 0.55);
    }
    const spin = t * 7;
    for (let wire = 0; wire < 5; wire += 1) {
      const phase = spin + (wire / 5) * TAU;
      for (let step = 0; step <= 10; step += 1) {
        const f = step / 10;
        const bow = Math.sin(f * Math.PI) * 0.3;
        plot(Math.cos(phase) * bow, -0.35 + f * 0.75, 0.4 + Math.abs(Math.cos(phase)) * 0.5);
      }
    }
    for (let y = 0; y <= 6; y += 1) plot(0, -0.9 + (y / 6) * 0.55, 0.7);
    /* Loose cream splashes; stiff cream holds a peak instead. */
    const surface = 0.55 - stiff * 0.12;
    for (let x = 0; x <= 20; x += 1) {
      const u = -0.8 + (x / 20) * 1.6;
      const ripple = Math.sin(u * 6 - t * 9) * (1 - stiff) * 0.09;
      const peak = clamp01(1 - Math.abs(u) * 3) * stiff * 0.3;
      plot(u, surface + ripple - peak, 0.5 + stiff * 0.45);
    }
    for (let drop = 0; drop < 5; drop += 1) {
      if (stiff > 0.6) break;
      const life = (t * 2.4 + hash(drop * 3.7)) % 1;
      plot((hash(drop) - 0.5) * 1.8, 0.3 - Math.sin(life * Math.PI) * 0.7, (1 - life) * 0.5);
    }
  });
}

/* -- Pasta extruder: dough forced through a die and cut to length --------- */

function paintPastaExtruder(t: number): string {
  return paintPlotted((plot) => {
    const feed = t * 0.7;
    for (let y = 0; y <= 10; y += 1) {
      plot(-1.3, -0.5 + (y / 10) * 1.0, 0.55);
      plot(-0.2, -0.5 + (y / 10) * 1.0, 0.55);
    }
    for (let x = 0; x <= 12; x += 1) {
      plot(-1.3 + (x / 12) * 1.1, -0.5, 0.55);
      plot(-1.3 + (x / 12) * 1.1, 0.5, 0.55);
    }
    /* The auger turns, so the dough in the barrel reads as being pushed. */
    for (let flight = 0; flight < 7; flight += 1) {
      const fu = -1.2 + ((flight / 7 + feed * 0.5) % 1) * 0.95;
      for (let y = 0; y <= 5; y += 1) {
        plot(fu, -0.4 + (y / 5) * 0.8, 0.35 + Math.abs(Math.sin(fu * 4 + t * 3)) * 0.4);
      }
    }
    for (let y = 0; y <= 6; y += 1) plot(-0.14, -0.3 + (y / 6) * 0.6, 0.85);
    /* Strands leave the die at a steady rate and are cut when long enough. */
    const cutLength = 1.5;
    for (let strand = 0; strand < 5; strand += 1) {
      const grown = (feed * 1.3 + strand * 0.13) % 1;
      const sv = -0.28 + strand * 0.14;
      for (let x = 0; x <= 20; x += 1) {
        const f = x / 20;
        if (f > grown) break;
        plot(-0.1 + f * cutLength, sv + Math.sin(f * 6 + strand) * 0.05, 0.5 + f * 0.4);
      }
    }
    const blade = 0.5 + Math.sin(t * 4) * 0.5;
    for (let y = 0; y <= 6; y += 1) plot(-0.02, -0.45 + (y / 6) * 0.9 * blade, 0.9);
  });
}

/* -- Dishwasher: a spray arm turning under a rack ------------------------- */

function paintDishwasher(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.3 + (x / 26) * 2.6;
      plot(u, -0.95, 0.55);
      plot(u, 0.9, 0.55);
    }
    for (let y = 0; y <= 12; y += 1) {
      plot(-1.3, -0.95 + (y / 12) * 1.85, 0.55);
      plot(1.3, -0.95 + (y / 12) * 1.85, 0.55);
    }
    for (let plate = 0; plate < 6; plate += 1) {
      const pu = -1.0 + plate * 0.4;
      for (let y = 0; y <= 6; y += 1) plot(pu, -0.75 + (y / 6) * 0.6, 0.6);
    }
    const angle = t * 3.4;
    for (let arm = 0; arm < 2; arm += 1) {
      const a = angle + arm * Math.PI;
      for (let step = 0; step <= 10; step += 1) {
        const f = step / 10;
        plot(Math.cos(a) * f * 0.9, 0.6 + Math.sin(a) * f * 0.14, 0.5 + f * 0.4);
      }
      /* Jets leave the arm tip and keep the direction they were thrown at. */
      for (let jet = 0; jet < 4; jet += 1) {
        const life = (t * 2 + jet * 0.25 + arm * 0.5) % 1;
        const throwAngle = a - life * 0.8;
        plot(
          Math.cos(throwAngle) * (0.9 + life * 0.3),
          0.6 + Math.sin(throwAngle) * 0.14 - life * 1.1,
          (1 - life) * 0.8,
        );
      }
    }
    plot(1.15, -0.85, Math.sin(t * 3) > 0 ? 0.95 : 0.25);
  });
}

/* -- Ice resurfacer: a flooded lane laid down behind the machine ---------- */

function paintIceResurfacer(t: number): string {
  return paintPlotted((plot) => {
    const lap = (t * 0.22) % 1;
    const lane = Math.floor((t * 0.22) % 3);
    const laneV = -0.62 + lane * 0.62;
    const drive = -1.4 + lap * 2.9;
    /* Fresh ice is smooth; the lanes not yet cut keep their scored texture. */
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      for (let row = 0; row < 3; row += 1) {
        const rv = -0.62 + row * 0.62;
        const cut = row < lane || (row === lane && u < drive);
        for (let band = -1; band <= 1; band += 1) {
          const scored = hash2(Math.floor(u * 9), row * 3 + band) > 0.6;
          plot(u, rv + band * 0.16, cut ? 0.5 : 0.14 + (scored ? 0.3 : 0));
        }
      }
    }
    for (let x = 0; x <= 10; x += 1) plot(drive - 0.45 + (x / 10) * 0.9, laneV - 0.28, 0.75);
    for (let x = 0; x <= 10; x += 1) plot(drive - 0.45 + (x / 10) * 0.9, laneV - 0.02, 0.75);
    for (let y = 0; y <= 5; y += 1) {
      plot(drive - 0.45, laneV - 0.28 + (y / 5) * 0.26, 0.7);
      plot(drive + 0.45, laneV - 0.28 + (y / 5) * 0.26, 0.7);
    }
    for (const wheel of [-0.3, 0.3] as const) {
      for (let step = 0; step < 8; step += 1) {
        const a = (step / 8) * TAU + t * 5;
        plot(drive + wheel + Math.cos(a) * 0.12, laneV + 0.02 + Math.sin(a) * 0.1, 0.6);
      }
    }
    for (let snow = 0; snow < 6; snow += 1) {
      const life = (t * 3 + hash(snow * 4.9)) % 1;
      plot(drive + 0.5 + life * 0.4, laneV - 0.3 - life * 0.35, (1 - life) * 0.55);
    }
  });
}

/* -- Snow cannon: a fan gun laying a cone of snow down a slope ------------ */

function paintSnowCannon(t: number): string {
  return paintPlotted((plot) => {
    const aim = Math.sin(t * 0.35) * 0.5;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      /* The pile grows where the gun has been pointing, so it tracks the aim. */
      const depth = 0.16 + clamp01(1 - Math.abs(u - aim * 1.4) * 0.9) * 0.28;
      for (let y = 0; y <= 3; y += 1) plot(u, 0.92 - (y / 3) * depth, 0.35 + (y / 3) * 0.4);
    }
    for (let y = 0; y <= 8; y += 1) plot(-1.15, 0.85 - (y / 8) * 0.7, 0.6);
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * TAU;
      plot(-1.15 + Math.cos(a) * 0.18, 0.12 + Math.sin(a) * 0.14, 0.75);
    }
    for (let flake = 0; flake < 22; flake += 1) {
      const life = (t * 0.85 + hash(flake * 2.7)) % 1;
      const spread = (hash(flake * 6.1) - 0.5) * life * 0.8;
      const reach = -1.15 + life * 2.4;
      /* Ballistic out of the barrel, then it stops being a jet and just falls. */
      const fall = 0.12 - Math.sin(life * Math.PI) * 0.7 + life * life * 0.9;
      plot(reach + spread * 0.4, fall + spread, (1 - life * 0.6) * 0.7);
    }
  });
}

/* -- Toboggan: a run taken banked turn by banked turn --------------------- */

function paintToboggan(t: number): string {
  return paintPlotted((plot) => {
    const run = (t * 0.45) % 1;
    const track = (s: number) => Math.sin(s * 5.5) * 0.55 + Math.sin(s * 2.1) * 0.25;
    for (let x = 0; x <= 26; x += 1) {
      const s = x / 26;
      const u = -1.35 + s * 2.7;
      plot(u, track(s) - 0.22, 0.4);
      plot(u, track(s) + 0.22, 0.4);
    }
    const su = -1.35 + run * 2.7;
    const sv = track(run);
    /* Lean into the turn: the harder the track bends, the harder the sled tips. */
    const bend = (track(run + 0.02) - track(run - 0.02)) * 6;
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8 - 0.5;
      plot(su + f * 0.42, sv + f * bend * 0.12, 0.85);
    }
    plot(su - 0.05, sv - 0.16 - Math.abs(bend) * 0.04, 0.95);
    for (let spray = 0; spray < 6; spray += 1) {
      const life = (t * 3.5 + hash(spray * 5.3)) % 1;
      plot(su - 0.25 - life * 0.5, sv + bend * 0.1 + (hash(spray) - 0.5) * life, (1 - life) * 0.5);
    }
  });
}

/* -- Ice core drill: a barrel going down and a core coming up ------------- */

function paintIceCoreDrill(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.13) % 1;
    /* Down slowly under load, up fast with the core, then log it and repeat. */
    const depth = cycle < 0.55 ? cycle / 0.55 : cycle < 0.8 ? 1 - (cycle - 0.55) / 0.25 : 0;
    const bore = -0.75 + depth * 1.5;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, -0.75, 0.5);
      if (Math.abs(u + 0.55) > 0.16) {
        for (let y = 0; y <= 5; y += 1) plot(u, -0.7 + (y / 5) * 1.6, 0.14 + hash2(Math.floor(u * 6), y) * 0.16);
      }
    }
    for (let y = 0; y <= 10; y += 1) plot(-0.55 - 0.16, -0.7 + (y / 10) * 1.55, 0.45);
    for (let y = 0; y <= 10; y += 1) plot(-0.55 + 0.16, -0.7 + (y / 10) * 1.55, 0.45);
    for (let y = 0; y <= 8; y += 1) plot(-0.55, bore - (y / 8) * 0.6, 0.7);
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      const a = t * 8 + f * 5;
      plot(-0.55 + Math.cos(a) * 0.14, bore - 0.02 - f * 0.35, 0.5 + f * 0.45);
    }
    for (let y = 0; y <= 9; y += 1) plot(-0.55, -0.95 + (y / 9) * 0.2, 0.55);
    /* Logged cores stack on the bench, one band per metre of depth. */
    const logged = Math.floor((t * 0.13) % 5);
    for (let core = 0; core < logged; core += 1) {
      const cu = 0.35 + core * 0.28;
      for (let y = 0; y <= 6; y += 1) plot(cu, -0.1 + (y / 6) * 0.7, 0.4 + ((y + core) % 2) * 0.45);
    }
  });
}

/* -- Weather balloon: a sonde climbing until the envelope bursts ---------- */

function paintWeatherBalloon(t: number): string {
  return paintPlotted((plot) => {
    const flight = (t * 0.16) % 1;
    for (let x = 0; x <= 26; x += 1) plot(-1.35 + (x / 26) * 2.7, 0.94, 0.35);
    if (flight < 0.82) {
      const climb = flight / 0.82;
      const bv = 0.85 - climb * 1.7;
      /* Thinner air lets the envelope swell, which is what finally bursts it. */
      const radius = 0.2 + climb * 0.22;
      const sway = Math.sin(t * 1.3) * 0.12 * climb;
      for (let step = 0; step <= 20; step += 1) {
        const a = (step / 20) * TAU;
        plot(sway + Math.cos(a) * radius, bv + Math.sin(a) * radius * 1.15, 0.4 + climb * 0.5);
      }
      for (let y = 0; y <= 6; y += 1) plot(sway * 0.7, bv + radius * 1.2 + (y / 6) * 0.35, 0.5);
      plot(sway * 0.6, bv + radius * 1.2 + 0.42, 0.9);
      plot(sway * 0.6 - 0.08, bv + radius * 1.2 + 0.5, 0.7);
    } else {
      const after = (flight - 0.82) / 0.18;
      for (let shred = 0; shred < 10; shred += 1) {
        const a = (shred / 10) * TAU;
        plot(Math.cos(a) * after * 1.1, -0.85 + Math.sin(a) * after * 0.6, (1 - after) * 0.8);
      }
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(Math.sin(after * 6) * 0.2, -0.85 + after * 1.6 + f * 0.3, 0.55 + f * 0.35);
      }
    }
  });
}

/* -- Dog sled: a team hitting its stride on a long straight -------------- */

function paintDogSled(t: number): string {
  return paintPlotted((plot) => {
    const snow = 0.6;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, snow + 0.3, 0.3 + (hash2(Math.floor(u * 7 - t * 3), 1) > 0.7 ? 0.2 : 0));
    }
    const lead = 0.9;
    for (let dog = 0; dog < 4; dog += 1) {
      const du = lead - dog * 0.5;
      /* The team gallops out of phase, so the line ripples front to back. */
      const stride = t * 6 - dog * 0.7;
      const lift = Math.abs(Math.sin(stride)) * 0.1;
      for (let x = 0; x <= 5; x += 1) plot(du - 0.16 + (x / 5) * 0.32, snow - 0.12 - lift, 0.75);
      plot(du + 0.2, snow - 0.18 - lift, 0.85);
      plot(du - 0.18 + Math.cos(stride) * 0.1, snow + Math.abs(Math.sin(stride)) * 0.06, 0.55);
      plot(du + 0.14 + Math.cos(stride + 2) * 0.1, snow + Math.abs(Math.sin(stride + 2)) * 0.06, 0.55);
      plot(du - 0.34, snow - 0.1, 0.35);
    }
    const sledU = -1.05;
    for (let x = 0; x <= 8; x += 1) plot(sledU - 0.3 + (x / 8) * 0.6, snow + 0.06, 0.7);
    for (let y = 0; y <= 6; y += 1) plot(sledU - 0.3, snow + 0.06 - (y / 6) * 0.45, 0.6);
    plot(sledU - 0.3, snow - 0.55, 0.9);
    plot(sledU - 0.3, snow - 0.42, 0.9);
    for (let spray = 0; spray < 5; spray += 1) {
      const life = (t * 3 + hash(spray * 4.1)) % 1;
      plot(sledU - 0.4 - life * 0.5, snow + 0.1 - life * 0.25, (1 - life) * 0.45);
    }
  });
}

/* -- Ski tow: a rope tow hauling riders up and running empty back --------- */

function paintSkiTow(t: number): string {
  return paintPlotted((plot) => {
    const slope = (u: number) => 0.6 - (u + 1.35) * 0.35;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, slope(u), 0.4);
      plot(u, slope(u) + 0.16, 0.2);
    }
    for (let y = 0; y <= 8; y += 1) {
      plot(-1.1, slope(-1.1) - (y / 8) * 0.75, 0.55);
      plot(1.1, slope(1.1) - (y / 8) * 0.75, 0.55);
    }
    for (let x = 0; x <= 24; x += 1) {
      const u = -1.1 + (x / 24) * 2.2;
      plot(u, slope(u) - 0.75, 0.45);
      plot(u, slope(u) - 0.62, 0.45);
    }
    /* Riders hang from the loaded side; the return side runs empty. */
    for (let rider = 0; rider < 4; rider += 1) {
      const along = (t * 0.16 + rider * 0.25) % 1;
      const u = -1.05 + along * 2.1;
      const hang = slope(u) - 0.75;
      for (let y = 0; y <= 5; y += 1) plot(u, hang + (y / 5) * 0.6, 0.5);
      plot(u, hang + 0.68, 0.9);
      plot(u - 0.02, hang + 0.78, 0.8);
      for (let x = 0; x <= 4; x += 1) plot(u - 0.12 + (x / 4) * 0.24, slope(u) - 0.02, 0.7);
    }
    for (let grip = 0; grip < 5; grip += 1) {
      const along = (t * 0.16 + grip * 0.2 + 0.5) % 1;
      plot(1.1 - along * 2.2, slope(1.1 - along * 2.2) - 0.62, 0.65);
    }
  });
}

/* -- Mine cart: a loaded cart running out and coming back empty ----------- */

function paintMineCart(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.2) % 2;
    const outbound = cycle < 1;
    const along = outbound ? cycle : 1 - (cycle - 1);
    const rail = (u: number) => 0.45 + Math.sin(u * 1.2) * 0.12;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, rail(u), 0.5);
      if (x % 3 === 0) for (let y = 0; y <= 3; y += 1) plot(u, rail(u) + (y / 3) * 0.16, 0.35);
    }
    const cu = -1.2 + along * 2.4;
    const cv = rail(cu);
    for (let x = 0; x <= 8; x += 1) plot(cu - 0.3 + (x / 8) * 0.6, cv - 0.4, 0.7);
    for (let y = 0; y <= 5; y += 1) {
      plot(cu - 0.3, cv - 0.4 + (y / 5) * 0.32, 0.7);
      plot(cu + 0.3, cv - 0.4 + (y / 5) * 0.32, 0.7);
    }
    /* Loaded on the way out, empty on the way back: that is the whole trip. */
    if (outbound) {
      for (let ore = 0; ore < 7; ore += 1) {
        plot(cu - 0.24 + (ore / 6) * 0.48, cv - 0.46 - hash(ore * 3.3) * 0.1, 0.85);
      }
    }
    for (const wheel of [-0.18, 0.18] as const) {
      for (let step = 0; step < 8; step += 1) {
        const a = (step / 8) * TAU + along * 18 * (outbound ? 1 : -1);
        plot(cu + wheel + Math.cos(a) * 0.1, cv - 0.06 + Math.sin(a) * 0.08, 0.6);
      }
    }
    for (let lamp = 0; lamp < 3; lamp += 1) {
      const lu = -0.9 + lamp * 0.9;
      plot(lu, rail(lu) - 0.85, 0.35 + Math.abs(Math.sin(t * 2 + lamp)) * 0.5);
    }
  });
}

/* -- Pit head: the winding wheel taking a cage down and back up ----------- */

function paintPitHeadWheel(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.12) % 1;
    /* The wheel only turns while the cage is moving, and reverses with it. */
    const moving = cycle < 0.4 || (cycle > 0.6 && cycle < 1);
    const descent = cycle < 0.4 ? cycle / 0.4 : cycle < 0.6 ? 1 : 1 - (cycle - 0.6) / 0.4;
    const spin = (cycle < 0.4 ? cycle : cycle > 0.6 ? -(cycle - 0.6) : 0) * 40;
    const hub = -0.75;
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      plot(hub + Math.cos(a) * 0.5, -0.42 + Math.sin(a) * 0.42, 0.55);
    }
    for (let spoke = 0; spoke < 6; spoke += 1) {
      const a = spin + (spoke / 6) * TAU;
      for (let step = 0; step <= 5; step += 1) {
        const f = step / 5;
        plot(hub + Math.cos(a) * f * 0.48, -0.42 + Math.sin(a) * f * 0.4, 0.45 + f * 0.35);
      }
    }
    for (let y = 0; y <= 10; y += 1) {
      plot(hub - 0.62, -0.35 + (y / 10) * 1.25, 0.5);
      plot(hub + 0.62, -0.35 + (y / 10) * 1.25, 0.5);
    }
    for (let x = 0; x <= 20; x += 1) plot(-1.35 + (x / 20) * 2.7, 0.9, 0.45);
    const shaft = 0.72;
    for (let y = 0; y <= 8; y += 1) plot(shaft, -0.4 + (y / 8) * 1.3, 0.3);
    const cageV = -0.35 + descent * 1.15;
    for (let y = 0; y <= 6; y += 1) plot(shaft, -0.8 + (y / 6) * (cageV + 0.8), 0.4);
    for (let x = 0; x <= 5; x += 1) plot(shaft - 0.18 + (x / 5) * 0.36, cageV, 0.85);
    for (let y = 0; y <= 3; y += 1) {
      plot(shaft - 0.18, cageV + (y / 3) * 0.24, 0.75);
      plot(shaft + 0.18, cageV + (y / 3) * 0.24, 0.75);
    }
    plot(hub, -1.0, moving ? 0.95 : 0.25);
  });
}

/* -- Ore crusher: jaws taking rock down to gravel ------------------------- */

function paintOreCrusher(t: number): string {
  return paintPlotted((plot) => {
    const stroke = Math.sin(t * 4);
    const gap = 0.22 + stroke * 0.14;
    for (let y = 0; y <= 10; y += 1) {
      const f = y / 10;
      plot(-0.85 + f * 0.55 - gap, -0.85 + f * 1.2, 0.65);
      plot(0.85 - f * 0.55 + gap, -0.85 + f * 1.2, 0.65);
    }
    /* Feed sits above the jaws, gravel leaves below them. */
    for (let rock = 0; rock < 6; rock += 1) {
      const fall = (t * 0.6 + hash(rock * 2.9)) % 1;
      const size = 0.1 + hash(rock * 5.3) * 0.08;
      const ru = (hash(rock * 7.1) - 0.5) * 0.9;
      const rv = -0.9 + fall * 0.85;
      for (let step = 0; step < 6; step += 1) {
        const a = (step / 6) * TAU + rock;
        plot(ru + Math.cos(a) * size, rv + Math.sin(a) * size * 0.8, 0.7);
      }
    }
    for (let bit = 0; bit < 12; bit += 1) {
      const fall = (t * 1.3 + hash(bit * 3.7)) % 1;
      plot((hash(bit * 9.1) - 0.5) * 0.7, 0.36 + fall * 0.55, (1 - fall) * 0.8);
    }
    for (let x = 0; x <= 22; x += 1) plot(-1.3 + (x / 22) * 2.6, 0.94, 0.35);
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * TAU + t * 4;
      plot(-1.15 + Math.cos(a) * 0.22, -0.4 + Math.sin(a) * 0.18, 0.5);
    }
    for (let x = 0; x <= 6; x += 1) plot(-1.15 + (x / 6) * 0.35, -0.4 + stroke * 0.06, 0.6);
  });
}

/* -- Bucket wheel: buckets taking a bite and dropping it on the belt ------ */

function paintBucketWheel(t: number): string {
  return paintPlotted((plot) => {
    const spin = t * 1.6;
    const hub = 0.62;
    const hubV = -0.15;
    for (let bucket = 0; bucket < 8; bucket += 1) {
      const a = spin + (bucket / 8) * TAU;
      const bu = hub + Math.cos(a) * 0.62;
      const bv = hubV + Math.sin(a) * 0.52;
      /* A bucket carries between the face and the top, and is empty after. */
      const carrying = Math.sin(a) < 0.2 && Math.cos(a) > -0.3;
      for (let step = 0; step < 6; step += 1) {
        const c = (step / 6) * TAU;
        plot(bu + Math.cos(c) * 0.11, bv + Math.sin(c) * 0.09, carrying ? 0.9 : 0.5);
      }
    }
    for (let step = 0; step <= 24; step += 1) {
      const a = (step / 24) * TAU;
      plot(hub + Math.cos(a) * 0.44, hubV + Math.sin(a) * 0.37, 0.35);
    }
    for (let step = 0; step <= 14; step += 1) {
      const f = step / 14;
      plot(hub - f * 1.7, hubV - f * 0.28, 0.5);
    }
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      if (u > 1.05) continue;
      plot(u, 0.72, 0.4);
    }
    /* The load on the belt runs away from the wheel at a steady rate. */
    for (let lump = 0; lump < 9; lump += 1) {
      const along = (t * 0.5 + lump / 9) % 1;
      plot(1.0 - along * 2.3, 0.64, 0.75);
    }
    for (let y = 0; y <= 8; y += 1) plot(1.28, 0.9 - (y / 8) * 1.4, 0.4);
  });
}

/* -- Lock gate: a boat lifted from one level to the next ------------------ */

function paintLockGate(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.11) % 1;
    /* Fill the chamber, open the gate, take the boat out, close and drain. */
    const fill = cycle < 0.45 ? cycle / 0.45 : cycle < 0.85 ? 1 : 1 - (cycle - 0.85) / 0.15;
    const gateOpen = cycle > 0.5 && cycle < 0.85 ? clamp01((cycle - 0.5) * 6) : 0;
    const level = 0.55 - fill * 0.7;
    for (let y = 0; y <= 10; y += 1) {
      plot(-0.55, -0.6 + (y / 10) * 1.5, 0.6);
      plot(0.9, -0.6 + (y / 10) * 1.5, 0.6);
    }
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, 0.9, 0.45);
      if (u < -0.55) plot(u, 0.5, 0.35 + Math.abs(Math.sin(u * 5 - t * 2)) * 0.3);
      if (u > 0.9) plot(u, -0.2, 0.35 + Math.abs(Math.sin(u * 5 - t * 2)) * 0.3);
    }
    for (let x = 0; x <= 12; x += 1) {
      const u = -0.5 + (x / 12) * 1.35;
      plot(u, level, 0.5 + Math.abs(Math.sin(u * 6 - t * 3)) * 0.35);
    }
    /* The gate swings back into the wall rather than lifting out of the way. */
    for (let y = 0; y <= 6; y += 1) {
      const f = y / 6;
      plot(0.9 - gateOpen * f * 0.3, -0.2 + f * (level + 0.2), 0.8);
    }
    const boatU = cycle > 0.6 ? -0.1 + (cycle - 0.6) * 3.6 : -0.1;
    for (let x = 0; x <= 8; x += 1) plot(boatU - 0.28 + (x / 8) * 0.56, level - 0.06, 0.85);
    plot(boatU, level - 0.24, 0.7);
    for (let bubble = 0; bubble < 6; bubble += 1) {
      if (fill >= 1) break;
      const life = (t * 1.5 + hash(bubble * 4.7)) % 1;
      plot(-0.4 + hash(bubble) * 1.1, 0.85 - life * (0.85 - level), (1 - life) * 0.5);
    }
  });
}

/* -- Swing bridge: a span turning out of the way and back ---------------- */

function paintSwingBridge(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.13) % 1;
    /* Open, hold for the boat, close: the span turns about its middle pier. */
    const open = cycle < 0.3 ? cycle / 0.3 : cycle < 0.7 ? 1 : 1 - (cycle - 0.7) / 0.3;
    const angle = open * Math.PI * 0.5;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, 0.62, 0.3 + Math.abs(Math.sin(u * 4 - t * 2.2)) * 0.25);
      if (Math.abs(u) > 0.95) plot(u, 0.1, 0.6);
    }
    for (let step = -18; step <= 18; step += 1) {
      const f = step / 18;
      plot(Math.cos(angle) * f * 0.95, 0.1 + Math.sin(angle) * f * 0.32, 0.8);
      plot(Math.cos(angle) * f * 0.95 - Math.sin(angle) * 0.06, 0.1 + Math.sin(angle) * f * 0.32 + Math.cos(angle) * 0.06, 0.5);
    }
    for (let y = 0; y <= 6; y += 1) plot(0, 0.1 + (y / 6) * 0.5, 0.7);
    for (let step = 0; step <= 10; step += 1) {
      const a = (step / 10) * TAU;
      plot(Math.cos(a) * 0.14, 0.34 + Math.sin(a) * 0.1, 0.55);
    }
    if (open > 0.85) {
      const boatU = -1.3 + (((t * 0.13) % 1) - 0.3) * 4.2;
      for (let x = 0; x <= 8; x += 1) plot(boatU - 0.3 + (x / 8) * 0.6, 0.56, 0.9);
      for (let y = 0; y <= 4; y += 1) plot(boatU, 0.56 - (y / 4) * 0.4, 0.7);
    }
  });
}

/* -- Fish ladder: fish working their way up a stepped weir --------------- */

function paintFishLadder(t: number): string {
  return paintPlotted((plot) => {
    const steps = 5;
    for (let step = 0; step < steps; step += 1) {
      const su = -1.2 + (step / steps) * 2.5;
      const sv = 0.75 - (step / steps) * 1.25;
      for (let x = 0; x <= 8; x += 1) plot(su + (x / 8) * 0.5, sv, 0.55);
      for (let y = 0; y <= 5; y += 1) plot(su + 0.5, sv - (y / 5) * 0.28, 0.5);
      /* Water spills over every lip, which is what the fish swim against. */
      for (let drop = 0; drop < 4; drop += 1) {
        const life = (t * 2 + drop * 0.25 + step * 0.3) % 1;
        plot(su + 0.5 + life * 0.1, sv - 0.28 + life * 0.3, (1 - life) * 0.6);
      }
    }
    for (let fish = 0; fish < 3; fish += 1) {
      const along = (t * 0.22 + fish * 0.33) % 1;
      const rung = along * steps;
      const held = rung - Math.floor(rung);
      const su = -1.2 + (Math.floor(rung) / steps) * 2.5;
      const sv = 0.75 - (Math.floor(rung) / steps) * 1.25;
      /* A fish holds in the pool, then makes one hard run at the next lip. */
      const leap = held > 0.6 ? (held - 0.6) / 0.4 : 0;
      const fu = su + 0.15 + held * 0.2 + leap * 0.35;
      const fv = sv - 0.12 - Math.sin(leap * Math.PI) * 0.35;
      for (let body = 0; body <= 4; body += 1) {
        plot(fu - (body / 4) * 0.22, fv + Math.sin(t * 12 + body) * 0.03 * (0.3 + leap), 0.9 - body * 0.1);
      }
    }
  });
}

/* -- Rope ferry: a punt pulled across on a fixed line -------------------- */

function paintRopeFerry(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.16) % 2;
    const along = cycle < 1 ? cycle : 2 - cycle;
    const eased = 0.5 - Math.cos(along * Math.PI) * 0.5;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.35 + (x / 26) * 2.7;
      plot(u, 0.45 + Math.sin(u * 3 - t * 1.6) * 0.06, 0.35);
      plot(u, 0.75 + Math.sin(u * 4 + t * 1.2) * 0.05, 0.25);
    }
    for (let y = 0; y <= 6; y += 1) {
      plot(-1.25, 0.4 - (y / 6) * 0.55, 0.55);
      plot(1.25, 0.4 - (y / 6) * 0.55, 0.55);
    }
    /* The line sags towards whichever side the punt has reached. */
    for (let x = 0; x <= 24; x += 1) {
      const f = x / 24;
      const u = -1.25 + f * 2.5;
      const sag = Math.sin(f * Math.PI) * 0.12 * (0.6 + Math.abs(f - eased) * 0.8);
      plot(u, -0.15 + sag, 0.45);
    }
    const pu = -1.25 + eased * 2.5;
    for (let x = 0; x <= 9; x += 1) plot(pu - 0.35 + (x / 9) * 0.7, 0.42, 0.85);
    for (const end of [-0.35, 0.35] as const) {
      for (let y = 0; y <= 3; y += 1) plot(pu + end, 0.42 - (y / 3) * 0.16, 0.7);
    }
    for (let y = 0; y <= 6; y += 1) plot(pu + 0.1, 0.26 - (y / 6) * 0.4, 0.6);
    plot(pu + 0.1, -0.16, 0.9);
    for (let wake = 0; wake < 5; wake += 1) {
      const life = (t * 1.8 + hash(wake * 3.9)) % 1;
      const back = cycle < 1 ? -1 : 1;
      plot(pu + back * (0.4 + life * 0.5), 0.5 + life * 0.08, (1 - life) * 0.45);
    }
  });
}

/* ========================================================================
   The ninth collection: fields from small living things, then a
   glassworks, a foundry, a dairy, a vineyard, and a night market. Same
   contract as everything above: a pure painter over the shared grid.
   ===================================================================== */

/* -- Pond skater: dimples riding on the surface film ---------------------- */

const pondSkaterField: Field = (u, v, t) => {
  let surface = 0.08 + fbm(u * 1.1 + t * 0.12, v * 1.4, 2) * 0.16;
  for (let skater = 0; skater < 3; skater += 1) {
    const period = 1.6 + hash(skater * 4.1) * 1.1;
    const phase = ((t + hash(skater) * period) % period) / period;
    /* A stroke, then a long glide: the pond is never all motion at once. */
    const glide = phase < 0.25 ? phase * 4 : 1;
    const su = -1.3 + hash(skater * 2.3) * 0.5 + glide * 1.8;
    const sv = -0.58 + skater * 0.56;
    for (let leg = 0; leg < 4; leg += 1) {
      const spread = leg < 2 ? -0.3 : 0.3;
      const reach = (leg % 2 === 0 ? -1 : 1) * (0.22 + (1 - glide) * 0.18);
      /* Each foot dents the film without breaking through it. */
      const dip = clamp01(1 - Math.hypot((u - su - reach) * 3.2, (v - sv - spread) * 3.6));
      surface = Math.max(surface, dip * 0.8);
    }
    const ring = clamp01(1 - Math.abs(Math.hypot(u - su, (v - sv) * 1.4) - phase * 1.5) * 5);
    surface = Math.max(surface, ring * (1 - phase) * 0.5);
  }
  return clamp01(surface);
};

/* -- Dew web: beads gathering on a web and running down it ---------------- */

const dewWebField: Field = (u, v, t) => {
  const sway = Math.sin(t * 0.8) * 0.14;
  const su = u * 0.62 - sway * (1 - Math.abs(v));
  const radius = Math.hypot(su, v);
  if (radius > 1.05) return 0.04;
  const angle = Math.atan2(v, su);
  /* Six radials with one spiral wound across them: any more and the web
     turns back into noise at this size. */
  const spoke = clamp01(1 - Math.abs(Math.sin(angle * 3)) * 8) * clamp01((1.05 - radius) * 3);
  const turn = (angle / TAU + 0.5 + radius * 1.6) % 1;
  const spiral =
    clamp01(1 - Math.abs(turn - 0.5) * 16) * clamp01((1.05 - radius) * 2.6) * clamp01(radius * 5);
  let bead = 0;
  for (let drop = 0; drop < 5; drop += 1) {
    /* A bead gathers on a radial, then lets go and slides out along it. */
    const life = (t * 0.5 + hash(drop)) % 1;
    const along = 0.2 + life * 0.8;
    const arm = Math.floor(hash(drop * 3.7) * 6) * (Math.PI / 3);
    bead = Math.max(
      bead,
      clamp01(1 - Math.hypot((su - Math.cos(arm) * along) * 5, (v - Math.sin(arm) * along) * 5)) *
        (0.5 + life * 0.5),
    );
  }
  return clamp01(0.05 + spoke * 0.45 + spiral * 0.55 + bead * 0.95);
};

/* -- Spore print: spores letting go of the gills and drifting ------------- */

const sporePrintField: Field = (u, v, t) => {
  const cap = clamp01(1 - Math.hypot(u * 0.75, (v + 0.72) * 2.6)) * 0.7;
  /* Gills are a fixed comb under the cap; the fall below them is not. */
  const gill = v > -0.78 && v < -0.5 ? clamp01(1 - Math.abs(Math.sin(u * 9)) * 3) * 0.55 : 0;
  const column = Math.floor((u + ASPECT) * 4.2);
  const drift = Math.sin(t * 0.6 + column) * 0.18;
  const fall = ((t * 0.5 + hash(column)) % 1) * 1.9;
  const dust =
    clamp01(1 - Math.abs(v + 0.5 - fall) * 2.4) *
    clamp01(1 - Math.abs(u - (column / 4.2 - ASPECT) - drift) * 5) *
    clamp01((v + 0.45) * 3);
  /* What lands stays: the print builds up as an even band on the paper. */
  const paper = clamp01((v - 0.72) * 5) * (0.3 + clamp01(1 - Math.abs(u) * 0.8) * 0.5);
  return clamp01(0.06 + cap + gill + dust * 0.8 + paper);
};

/* -- Moss cushion: cushions taking up water and swelling ------------------ */

const mossCushionField: Field = (u, v, t) => {
  /* A wet front crosses the stone, and each cushion opens as it arrives. */
  const front = -ASPECT - 0.4 + ((t * 0.9) % (ASPECT * 2 + 1.6));
  let moss = 0.07 + fbm(u * 2.4, v * 2.4, 2) * 0.14;
  for (let cushion = 0; cushion < 7; cushion += 1) {
    const cu = -1.4 + hash(cushion * 2.9) * 2.8;
    const cv = -0.7 + hash(cushion * 5.1) * 1.4;
    const wet = clamp01((front - cu) * 1.4) * clamp01(1 - (front - cu - 1.6) * 0.9);
    /* Even between soakings a cushion is never quite still: it works its
       leaves in and out as it holds on to what water it has. */
    const breath = Math.sin(t * 0.8 + cushion * 1.7) * 0.05;
    const size = 0.3 + hash(cushion) * 0.22 + wet * 0.16 + breath;
    const body = clamp01(1 - Math.hypot((u - cu) / size, (v - cv) / (size * 0.8)));
    const nap = 0.55 + fbm(u * 7 + cushion, v * 7, 2) * 0.6;
    moss = Math.max(moss, Math.pow(body, 0.7) * nap * (0.4 + wet * 0.6));
  }
  return clamp01(moss);
};

/* -- Lichen crust: colonies creeping outward over rock -------------------- */

const lichenCrustField: Field = (u, v, t) => {
  const rock = 0.08 + fbm(u * 3.2, v * 3.2, 2) * 0.1;
  let crust = 0;
  for (let colony = 0; colony < 5; colony += 1) {
    const cu = -1.35 + hash(colony * 3.3) * 2.7;
    const cv = -0.75 + hash(colony * 7.7) * 1.5;
    /* Growth is slow and only outward, so the rim is the living edge. */
    const grown = 0.2 + ((t * 0.09 + hash(colony) * 0.55) % 0.55);
    const ragged = grown * (0.7 + fbm(Math.atan2(v - cv, u - cu) * 2 + colony, 0.5, 2) * 0.6);
    const radius = Math.hypot((u - cu) * 0.85, v - cv);
    if (radius > ragged) continue;
    const rim = clamp01(1 - (ragged - radius) * 6);
    const inner = 0.14 + fbm(u * 5 + colony * 2, v * 5, 2) * 0.24;
    crust = Math.max(crust, inner + rim * 0.45);
  }
  /* Bare rock between the colonies, never rock plus colony: a crust sits on
     the stone rather than adding to it. */
  return clamp01(Math.max(rock, crust));
};

/* -- Root hair: a tip pushing down and putting out hairs ------------------ */

const rootHairField: Field = (u, v, t) => {
  const soil = 0.07 + hash2(Math.floor(u * 6), Math.floor(v * 6)) * 0.14;
  let root = 0;
  for (let strand = 0; strand < 3; strand += 1) {
    const base = -1.05 + strand * 1.05;
    /* The tip advances, then the hairs behind it catch up and fill in. */
    const tip = -0.9 + ((t * 0.32 + hash(strand) * 1.9) % 1.9);
    const lean = Math.sin(v * 2.2 + strand * 2.1) * 0.22;
    const axis = base + lean;
    if (v > tip) continue;
    const shaft = clamp01(1 - Math.abs(u - axis) * 7) * 0.8;
    const age = clamp01((tip - v) * 1.2);
    /* Hairs are short, dense, and only on the older stretch of the root. */
    const hair =
      clamp01(1 - (Math.abs(u - axis) - 0.06) * 3.6) *
      Math.abs(Math.sin((v - tip) * 26 + u * 4)) *
      age *
      0.55;
    const cap = clamp01(1 - Math.hypot((u - axis) * 5, (v - tip) * 5)) * 0.9;
    root = Math.max(root, Math.max(shaft, Math.max(hair, cap)));
  }
  return clamp01(soil + root);
};

/* -- Barnacle cirri: feeding fans sweeping the water ---------------------- */

const barnacleCirriField: Field = (u, v, t) => {
  const water = 0.07 + fbm(u * 1.6 - t * 0.4, v * 1.6, 2) * 0.14;
  let shell = 0;
  for (let animal = 0; animal < 4; animal += 1) {
    const cu = -1.25 + animal * 0.85;
    const size = 0.16 + hash(animal * 2.7) * 0.08;
    /* A cone widening towards the rock, with the aperture at its top. */
    const width = size * clamp01((v - 0.34) * 2.2);
    const cone = width > 0.01 ? clamp01(1 - Math.abs(u - cu) / width) * 0.6 : 0;
    const beat = (t * (1.4 + hash(animal) * 0.9) + hash(animal * 5.5)) % 1;
    const out = beat < 0.45 ? Math.sin((beat / 0.45) * Math.PI) : 0;
    /* The fan opens above the aperture, combs the water, and folds away. */
    const reach = 0.12 + out * 0.42;
    const rays = Math.abs(Math.sin(Math.atan2(0.34 - v, u - cu) * 4));
    const fan =
      v < 0.34
        ? clamp01(1 - Math.abs(Math.hypot((u - cu) * 0.9, v - 0.34) - reach) * 5) *
          out *
          (0.35 + rays * 0.65)
        : 0;
    shell = Math.max(shell, Math.max(cone, fan * 0.95));
  }
  return clamp01(water + shell);
};

/* -- Glow worm: threads hung in the dark, lights running along the roof --- */

const glowWormField: Field = (u, v, t) => {
  let cave = 0.04 + clamp01((-0.66 - v) * 2.4) * 0.16;
  for (let worm = 0; worm < 7; worm += 1) {
    const cu = -ASPECT + 0.4 + (worm / 6) * (ASPECT * 2 - 0.8);
    const head = -0.74 + hash(worm * 3.1) * 0.24;
    const drop = 0.7 + hash(worm * 5.7) * 0.9;
    const swayed = cu + Math.sin(t * 0.5 + worm) * 0.09 * clamp01((v - head) * 1.2);
    /* Lights come on in a slow wave down the roof, not all together. */
    const lit = Math.pow(clamp01(Math.sin(t * 0.9 - worm * 0.8) * 0.5 + 0.5), 1.6);
    /* A snare shows by the beads strung along it, not by the line itself. */
    const along =
      clamp01(1 - Math.abs(u - swayed) * 7) *
      clamp01((v - head) * 3) *
      clamp01((head + drop - v) * 3);
    const beads = 0.35 + Math.pow(Math.abs(Math.sin((v - head) * 15 + worm)), 4) * 0.65;
    const glow = clamp01(1 - Math.hypot((u - swayed) * 2.4, (v - head) * 3.2)) * (0.12 + lit * 0.5);
    const body = clamp01(1 - Math.hypot((u - swayed) * 6, (v - head) * 7)) * (0.3 + lit * 0.7);
    cave = Math.max(cave, Math.max(along * beads * (0.35 + lit * 0.5), Math.max(glow, body)));
  }
  return clamp01(cave);
};

/* -- Cicada chorus: one side calling and the other answering -------------- */

const cicadaChorusField: Field = (u, v, t) => {
  const cycle = (t * 0.32) % 2;
  /* One tree leads for a cycle, then the far tree takes it up. */
  const lead = cycle < 1 ? -1 : 1;
  const strength = Math.sin((cycle % 1) * Math.PI);
  const source = lead * 1.4;
  const distance = Math.hypot((u - source) * 0.8, v * 0.8);
  const wave = Math.sin(distance * 5 - t * 9);
  const call = Math.pow(clamp01(wave * 0.5 + 0.5), 2) * clamp01(1 - distance * 0.45) * strength;
  /* The insects themselves are a fixed scatter along the branches. */
  const branch = clamp01(1 - Math.abs(v + 0.55 - Math.sin(u * 1.1) * 0.25) * 4) * 0.35;
  const body = clamp01(1 - Math.abs(Math.sin(u * 7)) * 5) * branch * (0.5 + strength * 0.5);
  return clamp01(0.06 + branch * 0.5 + call * 0.8 + body);
};

/* -- Bee swarm: a knot of bees drifting with a core that holds ------------ */

const beeSwarmField: Field = (u, v, t) => {
  const cu = Math.sin(t * 0.35) * 0.8;
  const cv = Math.sin(t * 0.5 + 1.1) * 0.35;
  const radius = Math.hypot((u - cu) * 0.8, v - cv);
  /* Density falls off from the cluster, so the swarm reads as one body. */
  const cluster = Math.pow(clamp01(1 - radius * 1.1), 1.6);
  /* Individuals are the grain: fast, and only visible where the swarm is.
     Kept under full brightness so the cluster still reads as one body. */
  const churn = hash2(Math.floor(u * 9 + t * 5), Math.floor(v * 9 - t * 3));
  const bees = churn > 1 - cluster * 0.8 ? 0.42 + churn * 0.3 : 0;
  /* A few scouts break away and circle back on their own. */
  let scout = 0;
  for (let flier = 0; flier < 4; flier += 1) {
    const a = t * (1.6 + hash(flier) * 1.4) + flier * 1.7;
    scout = Math.max(
      scout,
      clamp01(1 - Math.hypot((u - cu - Math.cos(a) * 1.2) * 4, (v - cv - Math.sin(a) * 0.6) * 4)) * 0.7,
    );
  }
  return clamp01(0.05 + cluster * 0.32 + bees + scout);
};

/* -- Snail trail: fresh slime shining and older slime drying out ---------- */

const snailTrailField: Field = (u, v, t) => {
  const stone = 0.08 + fbm(u * 2.8, v * 2.8, 2) * 0.1;
  const travel = (t * 0.28) % 1;
  const path = (x: number) => Math.sin(x * 1.6 + 0.6) * 0.42;
  const head = -ASPECT - 0.3 + travel * (ASPECT * 2 + 0.6);
  const onPath = clamp01(1 - Math.abs(v - path(u)) * 4.5);
  /* Everything behind the animal is trail, and it dulls as it dries. */
  const age = clamp01((head - u) / 2.4);
  const trail = u < head ? onPath * (0.65 - age * 0.42) * (0.7 + Math.sin(u * 12) * 0.3) : 0;
  const body =
    clamp01(1 - Math.hypot((u - head) * 2.6, (v - path(head)) * 3.4)) * 0.85;
  const shell = clamp01(1 - Math.abs(Math.hypot((u - head + 0.16) * 3.4, (v - path(head) + 0.1) * 3.4) - 0.4) * 3.4) * 0.9;
  const horns = clamp01(1 - Math.hypot((u - head - 0.26) * 6, (v - path(head) + 0.16) * 6)) * 0.7;
  return clamp01(stone + trail + body + shell + horns);
};

/* -- Wing scale: overlapping scales catching the light as a wing tilts ----- */

const wingScaleField: Field = (u, v, t) => {
  const tilt = Math.sin(t * 0.9);
  /* Rows are offset like roof tiles, which is what makes it read as scales.
     Any finer than this and the tiling comes out as static. */
  const row = Math.floor((v + 1) * 2);
  const offset = (row % 2) * 0.5;
  const cell = (u + ASPECT) * 1.8 + offset;
  const column = Math.floor(cell);
  const within = cell - column;
  const shape = clamp01(1 - Math.abs(within - 0.5) * 2) * clamp01(1 - Math.abs((v + 1) * 2 - row - 0.5) * 1.6);
  /* Each scale answers the tilt from its own angle, so the flash sweeps. */
  const facing = Math.cos((column - row * 0.4) * 0.5 - tilt * 2.4);
  const flash = Math.pow(clamp01(facing), 4);
  const vein = clamp01(1 - Math.abs(v - Math.sin(u * 0.9) * 0.4) * 8) * 0.4;
  return clamp01(0.07 + shape * (0.18 + flash * 0.8) + vein);
};

/* -- Krill swarm: a layer rising at dusk and sinking again ---------------- */

const krillSwarmField: Field = (u, v, t) => {
  const depth = -0.15 + Math.sin(t * 0.4) * 0.62;
  const thickness = 0.24 + Math.abs(Math.sin(t * 0.4)) * 0.14;
  const layer = clamp01(1 - Math.abs(v - depth) / thickness);
  /* The swarm is dense enough to read as a solid band, with a ragged top. */
  const ragged = fbm(u * 2.2 + t * 0.5, v * 3, 2);
  const band = Math.pow(layer, 0.8) * (0.45 + ragged * 0.55);
  const grain = hash2(Math.floor(u * 11 - t * 4), Math.floor(v * 11)) > 0.55 ? 0.35 : 0;
  const light = clamp01((0.2 - v) * 0.5) * 0.14;
  return clamp01(0.05 + light + band * (0.75 + grain));
};

/* -- Tadpole shoal: a shoal turning as one in a shallow pool -------------- */

const tadpoleShoalField: Field = (u, v, t) => {
  const cycle = (t * 0.42) % 2;
  /* The whole shoal commits to one end, waits, then swings to the other. */
  const swing = cycle < 1 ? cycle : 2 - cycle;
  const eased = swing * swing * (3 - 2 * swing);
  const cu = -0.95 + eased * 1.9;
  const heading = cycle < 1 ? 1 : -1;
  let shoal = 0;
  for (let fish = 0; fish < 10; fish += 1) {
    const su = cu + (hash(fish * 2.1) - 0.5) * 1.1;
    const sv = -0.45 + hash(fish * 6.3) * 0.9;
    const wag = Math.sin(t * 7 + fish * 1.4) * 0.06;
    const head = clamp01(1 - Math.hypot((u - su) * 5, (v - sv) * 6));
    const tail =
      clamp01(1 - Math.hypot((u - su + heading * 0.2) * 4.5, (v - sv - wag) * 7)) * 0.6;
    shoal = Math.max(shoal, Math.max(head * 0.95, tail));
  }
  const silt = 0.07 + fbm(u * 2 + t * 0.15, v * 2, 2) * 0.13;
  return clamp01(silt + shoal);
};

/* -- Ant raft: a floating raft of ants churning at its edge ---------------- */

const antRaftField: Field = (u, v, t) => {
  const drift = Math.sin(t * 0.3) * 0.5;
  const radius = Math.hypot((u - drift) * 0.75, v);
  const edge = 0.72 + Math.sin(Math.atan2(v, (u - drift) * 0.75) * 5 + t * 0.9) * 0.07;
  const water = 0.07 + Math.abs(Math.sin(v * 7 - t * 2.4)) * 0.12;
  if (radius > edge) {
    /* A few swimmers work their way back to the raft rather than drifting off. */
    const stray = hash2(Math.floor(u * 8 - t * 2), Math.floor(v * 8)) > 0.94 ? 0.5 : 0;
    return clamp01(water + stray * clamp01(1 - (radius - edge) * 2));
  }
  /* Inside the raft the bodies hardly move; the rim never stops rotating. */
  const churn = clamp01((radius - edge + 0.28) * 4);
  const body = hash2(Math.floor(u * 12 + churn * t * 6), Math.floor(v * 12)) > 0.42 ? 0.85 : 0.35;
  return clamp01(0.2 + body * (0.6 + churn * 0.4));
};

/* -- Glass blower: a gather turning on the pipe and blown out -------------- */

function paintGlassBlower(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 2;
    /* Blow, then turn and let it settle, then blow again. */
    const blow = cycle < 1 ? Math.sin(cycle * Math.PI) : 0;
    const size = 0.32 + blow * 0.3 + (cycle < 1 ? 0 : 0.14);
    const spin = t * 2.2;
    for (let x = 0; x <= 16; x += 1) plot(-1.5 + (x / 16) * 0.95, 0.1, 0.55);
    /* The gather sags away from the pipe as it turns, never a clean sphere. */
    for (let step = 0; step <= 34; step += 1) {
      const a = (step / 34) * TAU;
      const sag = 0.08 * Math.sin(a) * Math.sin(a);
      plot(
        -0.15 + Math.cos(a) * size * 1.15,
        0.1 + Math.sin(a) * size + sag,
        0.45 + Math.pow(clamp01(Math.cos(a - spin) * 0.5 + 0.5), 3) * 0.55,
      );
    }
    for (let step = 0; step <= 10; step += 1) {
      const a = (step / 10) * TAU;
      plot(-0.15 + Math.cos(a) * size * 0.5, 0.1 + Math.sin(a) * size * 0.42, 0.9 - blow * 0.3);
    }
    /* Breath goes down the pipe only while he is actually blowing. */
    if (blow > 0.05) {
      for (let puff = 0; puff < 5; puff += 1) {
        const along = ((t * 3 + puff * 0.2) % 1);
        plot(-1.45 + along * 1.2, 0.1, blow * (1 - along) * 0.9);
      }
    }
    for (let y = 0; y <= 5; y += 1) plot(1.35, 0.9 - (y / 5) * 0.5, 0.5);
  });
}

/* -- Float glass: a ribbon drawn out thin over the tin bath --------------- */

function paintFloatGlass(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 60; x += 1) {
      const f = x / 60;
      const u = -ASPECT + f * ASPECT * 2;
      /* The ribbon narrows as the rollers pull it along and it cools. */
      const half = 0.5 - f * 0.28;
      const wobble = Math.sin(f * 7 - t * 3) * 0.05 * (1 - f);
      plot(u, -half + wobble, 0.4 + (1 - f) * 0.5);
      plot(u, half - wobble, 0.4 + (1 - f) * 0.5);
      /* Heat still in the glass shows as a glow that fades downstream. */
      plot(u, wobble * 0.4, clamp01(0.85 - f * 0.8));
    }
    for (let roller = 0; roller < 5; roller += 1) {
      const ru = -1.3 + roller * 0.7;
      const a = t * 3.4 + roller;
      for (let side = -1; side <= 1; side += 2) {
        for (let step = 0; step <= 8; step += 1) {
          const ra = (step / 8) * TAU;
          plot(ru + Math.cos(ra) * 0.14, side * 0.62 + Math.sin(ra) * 0.12, 0.5);
        }
        plot(ru + Math.cos(a) * 0.1, side * 0.62 + Math.sin(a) * 0.09, 0.95);
      }
    }
  });
}

/* -- Annealing lehr: panes creeping through a cooling tunnel -------------- */

function paintAnnealingLehr(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) {
      plot(-ASPECT + (x / 30) * ASPECT * 2, -0.85, 0.45);
      plot(-ASPECT + (x / 30) * ASPECT * 2, 0.85, 0.45);
    }
    const run = ASPECT * 2 + 1.2;
    for (let pane = 0; pane < 4; pane += 1) {
      const u = -ASPECT - 0.6 + ((t * 0.55 + pane * (run / 4)) % run);
      /* A pane enters glowing and leaves cold, which is the whole job. */
      const heat = clamp01(1 - (u + ASPECT + 0.6) / run * 1.15);
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(u - 0.3 + f * 0.6, -0.45, 0.3 + heat * 0.7);
        plot(u - 0.3 + f * 0.6, 0.35, 0.3 + heat * 0.7);
      }
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(u - 0.3, -0.45 + f * 0.8, 0.3 + heat * 0.7);
        plot(u + 0.3, -0.45 + f * 0.8, 0.3 + heat * 0.7);
      }
      plot(u, -0.05, 0.15 + heat * 0.85);
    }
    for (let roller = 0; roller <= 9; roller += 1) {
      const ru = -1.5 + roller * 0.34;
      plot(ru, 0.62 + Math.sin(t * 4 + roller) * 0.05, 0.6);
    }
  });
}

/* -- Glass cane: a rod drawn out and twisted between two hands ------------ */

function paintGlassCane(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.26) % 1;
    /* Pull it out, let it go slack, pull again: the stripes tighten each time. */
    const pull = Math.sin(cycle * Math.PI);
    const reach = 0.7 + pull * 0.85;
    const thickness = 0.24 - pull * 0.15;
    for (let x = 0; x <= 48; x += 1) {
      const f = x / 48;
      const u = -reach + f * reach * 2;
      const taper = thickness * (0.55 + Math.sin(f * Math.PI) * 0.45);
      plot(u, -taper, 0.5);
      plot(u, taper, 0.5);
      /* Two stripes wound round the rod: their pitch is the twist. */
      for (let stripe = 0; stripe < 2; stripe += 1) {
        const a = f * (7 + pull * 9) - t * 3 + stripe * Math.PI;
        plot(u, Math.sin(a) * taper * 0.8, 0.35 + Math.pow(clamp01(Math.cos(a)), 2) * 0.65);
      }
    }
    for (const side of [-1, 1] as const) {
      for (let y = 0; y <= 6; y += 1) plot(side * (reach + 0.16), -0.3 + (y / 6) * 0.6, 0.7);
      for (let x = 0; x <= 4; x += 1) plot(side * (reach + 0.16) + side * (x / 4) * 0.24, 0, 0.75);
    }
  });
}

/* -- Bottle mould: the mould closing, the blow, and the bottle out -------- */

function paintBottleMould(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.35) % 4;
    /* Four beats: close, blow, open, eject. */
    const shut = cycle < 1 ? cycle : cycle < 2.4 ? 1 : cycle < 3 ? 1 - (cycle - 2.4) / 0.6 : 0;
    const blown = clamp01((cycle - 1) * 2.5);
    const gap = 0.72 - shut * 0.44;
    for (const side of [-1, 1] as const) {
      for (let y = 0; y <= 14; y += 1) {
        plot(side * gap, -0.8 + (y / 14) * 1.6, 0.6);
        plot(side * (gap + 0.24), -0.8 + (y / 14) * 1.6, 0.45);
      }
      for (let x = 0; x <= 4; x += 1) {
        plot(side * (gap + (x / 4) * 0.24), -0.8, 0.5);
        plot(side * (gap + (x / 4) * 0.24), 0.8, 0.5);
      }
    }
    const lift = cycle > 3 ? (cycle - 3) * 1.4 : 0;
    const width = 0.16 + blown * 0.32 * shut;
    for (let y = 0; y <= 16; y += 1) {
      const f = y / 16;
      const cv = 0.7 - f * 1.3 - lift;
      /* Shoulder in at the top: without it the blank never becomes a bottle. */
      const w = f > 0.75 ? width * (1 - (f - 0.75) * 3.2) : width;
      plot(-w, cv, 0.55 + blown * 0.4);
      plot(w, cv, 0.55 + blown * 0.4);
    }
    for (let x = 0; x <= 5; x += 1) plot(-0.1 + (x / 5) * 0.2, -0.62 - lift, 0.9);
    if (cycle > 1 && cycle < 2.4) {
      for (let puff = 0; puff < 4; puff += 1) {
        const along = (t * 4 + puff * 0.25) % 1;
        plot(0, -0.95 + along * 0.3, (1 - along) * 0.9);
      }
    }
  });
}

/* -- Marver: rolling a gather flat on the steel table --------------------- */

function paintGlassMarver(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 2;
    const stroke = cycle < 1 ? cycle : 2 - cycle;
    const eased = stroke * stroke * (3 - 2 * stroke);
    const cu = -1.05 + eased * 2.1;
    /* Each pass across the steel takes a little more of the roundness out. */
    const flat = 0.2 + Math.abs(Math.sin(t * 0.5)) * 0.3;
    for (let x = 0; x <= 34; x += 1) plot(-ASPECT + (x / 34) * ASPECT * 2, 0.62, 0.5);
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      plot(
        cu + Math.cos(a) * (0.34 + flat * 0.16),
        0.34 + Math.sin(a) * 0.34 * (1 - flat),
        0.55 + Math.pow(clamp01(Math.sin(a + t * 4)), 2) * 0.45,
      );
    }
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * TAU;
      plot(cu + Math.cos(a) * 0.14, 0.34 + Math.sin(a) * 0.13 * (1 - flat), 1);
    }
    for (let x = 0; x <= 14; x += 1) plot(cu - (x / 14) * 1.3, 0.34 - (x / 14) * 0.5, 0.5);
    /* Heat comes off the steel where the gather has just been. */
    for (let wisp = 0; wisp < 4; wisp += 1) {
      const life = (t * 1.4 + hash(wisp)) % 1;
      plot(cu - 0.4 + hash(wisp * 3.1) * 0.8, 0.6 - life * 0.5, (1 - life) * 0.4);
    }
  });
}

/* -- Glass shears: trimming the lip while the piece keeps turning --------- */

function paintGlassShears(t: number): string {
  return paintPlotted((plot) => {
    const spin = t * 1.8;
    const bite = Math.pow(clamp01(Math.sin(t * 1.2)), 3);
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      /* The piece is a cup: bright rim, dimmer wall, turning the whole time. */
      plot(Math.cos(a) * 0.62, 0.15 + Math.sin(a) * 0.2, 0.5 + Math.pow(clamp01(Math.cos(a - spin) * 0.5 + 0.5), 2) * 0.5);
    }
    for (let step = 0; step <= 20; step += 1) {
      const f = step / 20;
      plot(-0.62 + f * 0.1, 0.15 + f * 0.6, 0.45);
      plot(0.62 - f * 0.1, 0.15 + f * 0.6, 0.45);
    }
    for (let x = 0; x <= 10; x += 1) plot(-0.5 + (x / 10) * 1, 0.78, 0.55);
    const open = 0.34 - bite * 0.3;
    for (const side of [-1, 1] as const) {
      for (let step = 0; step <= 14; step += 1) {
        const f = step / 14;
        plot(-0.05 + f * 0.75, -0.62 + side * open * (1 - f) + f * 0.62, 0.7);
      }
    }
    /* The trimmed ring drops away once the blades have gone right through. */
    if (bite > 0.9) {
      const drop = ((t * 2) % 1);
      for (let step = 0; step <= 10; step += 1) {
        const a = (step / 10) * Math.PI;
        plot(Math.cos(a) * 0.34, 0.35 + drop * 0.6 + Math.sin(a) * 0.06, (1 - drop) * 0.8);
      }
    }
  });
}

/* -- Crucible: a melt tipped out and the pot swinging back ---------------- */

function paintCrucible(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.28) % 2;
    /* Tip over, hold at the pour, come back upright. */
    const tip = cycle < 0.7 ? cycle / 0.7 : cycle < 1.3 ? 1 : clamp01(1 - (cycle - 1.3) / 0.7);
    const angle = tip * 1.1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rim = (x: number, y: number) => [x * cos - y * sin, x * sin + y * cos] as const;
    for (let step = 0; step <= 26; step += 1) {
      const f = step / 26;
      const [x, y] = rim(-0.5 + f, -0.4);
      plot(x - 0.3, y + 0.1, 0.6);
      const [bx, by] = rim(-0.4 + f * 0.8, 0.42);
      plot(bx - 0.3, by + 0.1, 0.6);
    }
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      for (const side of [-1, 1] as const) {
        const [x, y] = rim(side * (0.5 - f * 0.1), -0.4 + f * 0.82);
        plot(x - 0.3, y + 0.1, 0.55);
      }
    }
    /* The melt keeps its own level however far the pot is tipped. */
    for (let x = 0; x <= 16; x += 1) {
      const f = x / 16;
      const [mx, my] = rim(-0.45 + f * 0.9, -0.22 + tip * 0.5);
      plot(mx - 0.3, my + 0.1 + Math.sin(f * 6 + t * 5) * 0.03, 0.9);
    }
    if (tip > 0.6) {
      const [lx, ly] = rim(0.5, -0.4);
      for (let drop = 0; drop <= 14; drop += 1) {
        const f = drop / 14;
        plot(lx - 0.3 + f * 0.3, ly + 0.1 + f * (0.85 - ly), 1 - f * 0.3);
      }
      for (let x = 0; x <= 8; x += 1) plot(0.5 + (x / 8) * 0.5, 0.88, 0.85);
    }
  });
}

/* -- Ladle pour: a ladle running the line and filling each mould ---------- */

function paintLadlePour(t: number): string {
  return paintPlotted((plot) => {
    const stride = 1.6;
    const cycle = (t * 0.42) % stride;
    const station = Math.floor((t * 0.42) / stride) % 4;
    const travel = clamp01(cycle / 0.7);
    const pouring = cycle > 0.8 && cycle < 1.4;
    const from = -1.2 + ((station + 3) % 4) * 0.8;
    const to = -1.2 + station * 0.8;
    const cu = from + (to - from) * (travel * travel * (3 - 2 * travel));
    for (let x = 0; x <= 34; x += 1) plot(-ASPECT + (x / 34) * ASPECT * 2, -0.88, 0.4);
    for (let y = 0; y <= 6; y += 1) plot(cu, -0.85 + (y / 6) * 0.4, 0.5);
    for (let step = 0; step <= 18; step += 1) {
      const a = Math.PI * (step / 18);
      plot(cu + Math.cos(a) * 0.3, -0.4 + Math.sin(a) * 0.26, 0.7);
    }
    for (let x = 0; x <= 8; x += 1) plot(cu - 0.3 + (x / 8) * 0.6, -0.4, 0.85);
    if (pouring) {
      for (let step = 0; step <= 16; step += 1) {
        const f = step / 16;
        plot(cu + 0.3 + f * 0.1, -0.34 + f * 0.86, 1 - f * 0.25);
      }
    }
    /* Moulds already filled keep their heat and dim from the far end back. */
    for (let mould = 0; mould < 4; mould += 1) {
      const mu = -1.2 + mould * 0.8 + 0.34;
      const filled = mould <= station;
      const heat = filled ? clamp01(1 - (station - mould) * 0.3) : 0;
      for (let x = 0; x <= 8; x += 1) plot(mu - 0.28 + (x / 8) * 0.56, 0.82, 0.5);
      for (let y = 0; y <= 5; y += 1) {
        plot(mu - 0.28, 0.5 + (y / 5) * 0.32, 0.5);
        plot(mu + 0.28, 0.5 + (y / 5) * 0.32, 0.5);
      }
      for (let x = 0; x <= 6; x += 1) plot(mu - 0.22 + (x / 6) * 0.44, 0.62, 0.15 + heat * 0.85);
    }
  });
}

/* -- Sand mould: ramming the sand and drawing the pattern out ------------- */

function paintSandMould(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.32) % 3;
    /* Ram it down three times, then lift the pattern clear of the box. */
    const ramming = cycle < 2;
    const beat = (cycle % 0.66) / 0.66;
    const ram = ramming ? Math.abs(Math.sin(beat * Math.PI)) : 0;
    const lift = cycle > 2 ? (cycle - 2) * 1.3 : 0;
    for (let x = 0; x <= 24; x += 1) {
      plot(-1.1 + (x / 24) * 2.2, 0.86, 0.55);
      plot(-1.1 + (x / 24) * 2.2, -0.02, 0.35);
    }
    for (let y = 0; y <= 8; y += 1) {
      plot(-1.1, -0.02 + (y / 8) * 0.88, 0.55);
      plot(1.1, -0.02 + (y / 8) * 0.88, 0.55);
    }
    /* The packed sand settles a little further with every blow. */
    const packed = 0.06 + clamp01(cycle / 2) * 0.14;
    for (let x = 0; x <= 22; x += 1) {
      const u = -1.05 + (x / 22) * 2.1;
      plot(u, packed + Math.sin(u * 7 + t) * 0.02 + ram * 0.03, 0.45);
    }
    for (let x = 0; x <= 10; x += 1) plot(-0.5 + (x / 10) * 1, 0.2 - lift, 0.7);
    for (let y = 0; y <= 5; y += 1) {
      plot(-0.5, 0.2 - lift + (y / 5) * 0.3, 0.7);
      plot(0.5, 0.2 - lift + (y / 5) * 0.3, 0.7);
    }
    if (ramming) {
      const head = -0.72 + ram * 0.5;
      for (let y = 0; y <= 7; y += 1) plot(0.1, -0.92 + (y / 7) * (head + 0.92), 0.6);
      for (let x = 0; x <= 6; x += 1) plot(-0.08 + (x / 6) * 0.36, head, 0.95);
      if (ram > 0.9) {
        for (let puff = 0; puff < 3; puff += 1) {
          plot(0.1 + (hash(puff) - 0.5) * 0.6, head - 0.12 - hash(puff * 3.1) * 0.2, 0.5);
        }
      }
    }
  });
}

/* -- Ingot roll: a bloom squeezed thinner and longer each pass ------------ */

function paintIngotRoll(t: number): string {
  return paintPlotted((plot) => {
    const passes = 3;
    const cycle = (t * 0.36) % passes;
    const pass = Math.floor(cycle);
    const along = cycle - pass;
    /* Every pass through the stand takes another bite out of the thickness. */
    const before = 0.42 - pass * 0.1;
    const after = before - 0.1;
    const direction = pass % 2 === 0 ? 1 : -1;
    const nose = direction * (-1.5 + along * 3);
    for (const side of [-1, 1] as const) {
      const a = t * 5 * direction;
      for (let step = 0; step <= 12; step += 1) {
        const ra = (step / 12) * TAU;
        plot(Math.cos(ra) * 0.26, side * (before + 0.3) + Math.sin(ra) * 0.22, 0.5);
      }
      plot(Math.cos(a) * 0.2, side * (before + 0.3) + Math.sin(a) * 0.16, 0.95);
    }
    for (let x = 0; x <= 46; x += 1) {
      const u = -ASPECT + (x / 46) * ASPECT * 2;
      const rolled = direction > 0 ? u < nose && u > nose - 2.2 : u > nose && u < nose + 2.2;
      if (!rolled) continue;
      /* Past the rolls the bar is thin; ahead of them it is still the bloom. */
      const squeezed = direction > 0 ? u < 0 : u > 0;
      const half = squeezed ? after : before;
      const heat = 0.55 + Math.abs(Math.sin(u * 3 - t * 4)) * 0.45;
      plot(u, -half, heat);
      plot(u, half, heat);
      plot(u, 0, heat * 0.85);
    }
  });
}

/* -- Quench bath: hot steel dropped in and the bath boiling over it ------- */

function paintQuenchBath(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 2;
    /* Down, held under while it boils, then back up cold. */
    const down = cycle < 0.5 ? cycle * 2 : cycle < 1.4 ? 1 : clamp01(1 - (cycle - 1.4) * 1.7);
    const depth = -0.7 + down * 1.1;
    const submerged = down > 0.6;
    const heat = clamp01(1 - Math.max(0, cycle - 0.5) * 0.9);
    for (let x = 0; x <= 30; x += 1) {
      const u = -1.3 + (x / 30) * 2.6;
      plot(u, 0.18 + Math.sin(u * 5 + t * 6) * 0.04 * (submerged ? 2.5 : 1), 0.5);
    }
    for (let y = 0; y <= 8; y += 1) {
      plot(-1.3, 0.18 + (y / 8) * 0.72, 0.5);
      plot(1.3, 0.18 + (y / 8) * 0.72, 0.5);
    }
    for (let x = 0; x <= 24; x += 1) plot(-1.3 + (x / 24) * 2.6, 0.9, 0.5);
    for (let y = 0; y <= 5; y += 1) plot(0, -0.95 + (y / 5) * (depth + 0.95), 0.45);
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(-0.24 + f * 0.48, depth, 0.25 + heat * 0.75);
      plot(-0.24 + f * 0.48, depth + 0.24, 0.25 + heat * 0.75);
    }
    if (submerged) {
      /* The bath boils hardest right at the steel and calms further out. */
      for (let bubble = 0; bubble < 14; bubble += 1) {
        const bu = (hash(bubble * 2.3) - 0.5) * 1.6;
        const rise = (t * 1.6 + hash(bubble)) % 1;
        const near = clamp01(1 - Math.abs(bu) * 1.2);
        plot(bu, depth + 0.2 - rise * (depth + 0.05), (0.3 + near * 0.7) * (1 - rise * 0.4));
      }
      for (let steam = 0; steam < 5; steam += 1) {
        const life = (t * 0.9 + hash(steam * 5.1)) % 1;
        plot((hash(steam) - 0.5) * 1.4, 0.14 - life * 0.9, (1 - life) * 0.55);
      }
    }
  });
}

/* -- Power hammer: a bar beaten flatter under a treadle hammer ------------ */

function paintPowerHammer(t: number): string {
  return paintPlotted((plot) => {
    const beat = (t * 2.4) % 1;
    /* Fast down, slow back up: the recoil is what makes it read as a hammer. */
    const fall = beat < 0.28 ? Math.pow(beat / 0.28, 2) : 1 - (beat - 0.28) / 0.72;
    const head = -0.72 + fall * 0.62;
    const struck = beat < 0.34;
    /* The bar spreads a little further with each blow, and creeps left. */
    const worked = ((t * 0.24) % 1);
    const spread = 0.16 + worked * 0.24;
    for (let x = 0; x <= 24; x += 1) plot(-1.35 + (x / 24) * 2.7, 0.62, 0.55);
    for (let y = 0; y <= 5; y += 1) {
      plot(-0.55, 0.62 + (y / 5) * 0.3, 0.45);
      plot(0.55, 0.62 + (y / 5) * 0.3, 0.45);
    }
    for (let x = 0; x <= 20; x += 1) {
      const u = -1.2 + (x / 20) * 2;
      const under = clamp01(1 - Math.abs(u + 0.3 - worked * 0.6) * 1.6);
      const half = 0.06 + under * spread * 0.5;
      const heat = clamp01(0.9 - Math.abs(u) * 0.5);
      plot(u, 0.5 - half, 0.3 + heat * 0.7);
      plot(u, 0.5 + half, 0.3 + heat * 0.7);
    }
    for (let y = 0; y <= 6; y += 1) plot(-0.3 + worked * 0.6, -0.95 + (y / 6) * (head + 0.95), 0.5);
    for (let x = 0; x <= 8; x += 1) {
      const u = -0.3 + worked * 0.6 - 0.22 + (x / 8) * 0.44;
      plot(u, head, 0.9);
      plot(u, head - 0.24, 0.7);
    }
    if (struck) {
      for (let spark = 0; spark < 7; spark += 1) {
        const a = Math.PI + hash(spark) * Math.PI;
        const reach = (0.2 + hash(spark * 3.3) * 0.5) * (1 - beat / 0.34);
        plot(-0.3 + worked * 0.6 + Math.cos(a) * reach * 2, 0.5 + Math.sin(a) * reach, 0.95);
      }
    }
  });
}

/* -- Wire draw: wire pulled through a die and wound onto a block ---------- */

function paintWireDraw(t: number): string {
  return paintPlotted((plot) => {
    const pull = t * 1.4;
    for (let x = 0; x <= 40; x += 1) {
      const f = x / 40;
      const u = -ASPECT + f * (ASPECT + 0.2);
      /* Thick on the way in, thin on the way out: the die is the pinch. */
      plot(u, -0.06 + Math.sin(u * 3 + pull * 3) * 0.02, 0.55);
      plot(u, 0.06 + Math.sin(u * 3 + pull * 3) * 0.02, 0.55);
    }
    for (let y = 0; y <= 8; y += 1) {
      const f = y / 8;
      plot(0.2, -0.45 + f * 0.9, 0.75);
      plot(0.34, -0.45 + f * 0.9, 0.75);
      plot(0.27, -0.45 + f * 0.9, f > 0.4 && f < 0.6 ? 0 : 0.6);
    }
    for (let x = 0; x <= 20; x += 1) {
      const u = 0.34 + (x / 20) * 0.7;
      plot(u, 0.01, 0.85);
    }
    /* The wire comes off the die and stacks up in turns on the block. */
    for (let turn = 0; turn < 7; turn += 1) {
      const a = pull * 2 + turn * 0.9;
      const level = 0.42 - turn * 0.12;
      for (let step = 0; step <= 16; step += 1) {
        const ra = (step / 16) * TAU;
        plot(1.12 + Math.cos(ra) * 0.42, level * 0.5 + Math.sin(ra) * 0.3, 0.4);
      }
      plot(1.12 + Math.cos(a) * 0.42, level * 0.5 + Math.sin(a) * 0.3, 0.95);
    }
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(-1.5, -0.5 + f, 0.5);
    }
  });
}

/* -- Milk churn: a rocking churn with the butter finally breaking ---------- */

function paintMilkChurn(t: number): string {
  return paintPlotted((plot) => {
    const rock = Math.sin(t * 2.2);
    /* Cream for most of the cycle, then it breaks and the grains gather. */
    const worked = (t * 0.14) % 1;
    const broken = clamp01((worked - 0.62) * 4);
    const tilt = rock * 0.16;
    for (let y = 0; y <= 12; y += 1) {
      const f = y / 12;
      plot(-0.85 - tilt * f, 0.8 - f * 1.4, 0.6);
      plot(0.85 - tilt * f, 0.8 - f * 1.4, 0.6);
    }
    for (let x = 0; x <= 14; x += 1) {
      plot(-0.85 + (x / 14) * 1.7, 0.8, 0.6);
      plot(-0.85 - tilt + (x / 14) * 1.7, -0.6, 0.6);
    }
    /* The cream keeps a level surface, so the slope tracks the rocking. */
    for (let x = 0; x <= 18; x += 1) {
      const f = x / 18;
      const u = -0.8 + f * 1.6;
      plot(u, 0.1 + rock * 0.18 * (f - 0.5) * 2 + Math.sin(f * 8 + t * 6) * 0.03, 0.8);
    }
    for (let grain = 0; grain < 9; grain += 1) {
      const gu = (hash(grain * 2.7) - 0.5) * 1.4;
      const gv = 0.24 + hash(grain * 5.3) * 0.4;
      const gathered = broken * 0.4;
      plot(gu * (1 - gathered), gv + rock * 0.05, broken * 0.95);
    }
    for (let x = 0; x <= 5; x += 1) plot(0.85 - tilt + (x / 5) * 0.4, -0.4, 0.7);
  });
}

/* -- Cheese press: the screw coming down and the whey running out ---------- */

function paintCheesePress(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.18) % 1;
    /* One long press: the screw turns steadily and the curd gives slowly. */
    const pressed = cycle;
    const turn = t * 3;
    for (let y = 0; y <= 14; y += 1) {
      const f = y / 14;
      plot(-1.2, -0.9 + f * 1.8, 0.5);
      plot(1.2, -0.9 + f * 1.8, 0.5);
    }
    for (let x = 0; x <= 22; x += 1) plot(-1.2 + (x / 22) * 2.4, -0.9, 0.5);
    for (let y = 0; y <= 8; y += 1) {
      const f = y / 8;
      /* The thread on the screw is what shows that it is actually turning. */
      plot(Math.sin(turn + f * 6) * 0.1, -0.85 + f * (0.55 + pressed * 0.3), 0.75);
    }
    const platen = -0.3 + pressed * 0.32;
    for (let x = 0; x <= 12; x += 1) plot(-0.62 + (x / 12) * 1.24, platen, 0.85);
    const height = 0.5 - pressed * 0.2;
    for (let x = 0; x <= 12; x += 1) {
      const u = -0.62 + (x / 12) * 1.24;
      plot(u, platen + 0.06, 0.6);
      plot(u, platen + height, 0.6);
    }
    for (let y = 0; y <= 6; y += 1) {
      const f = y / 6;
      plot(-0.62, platen + 0.06 + f * (height - 0.06), 0.6);
      plot(0.62, platen + 0.06 + f * (height - 0.06), 0.6);
    }
    /* Whey runs faster the harder it is pressed, and pools in the tray. */
    for (let drop = 0; drop < 6; drop += 1) {
      const life = (t * (0.9 + pressed * 1.6) + hash(drop)) % 1;
      const du = -0.55 + hash(drop * 3.7) * 1.1;
      plot(du, platen + height + life * (0.85 - platen - height), (1 - life * 0.4) * 0.8);
    }
    for (let x = 0; x <= 20; x += 1) plot(-1.1 + (x / 20) * 2.2, 0.88 - pressed * 0.04, 0.65);
  });
}

/* -- Cream separator: a bowl running up to speed and splitting the milk ---- */

function paintCreamSeparator(t: number): string {
  return paintPlotted((plot) => {
    const speed = clamp01(((t * 0.2) % 1) * 3);
    const spin = t * (1 + speed * 9);
    for (let step = 0; step <= 28; step += 1) {
      const a = (step / 28) * TAU;
      plot(Math.cos(a) * 0.62, -0.1 + Math.sin(a) * 0.44, 0.5);
    }
    /* Discs inside the bowl: they blur into one band as it comes up to speed. */
    for (let disc = 0; disc < 5; disc += 1) {
      const f = disc / 4;
      const level = -0.42 + f * 0.62;
      for (let x = 0; x <= 10; x += 1) {
        const u = -0.5 + (x / 10) * 1;
        plot(u, level + Math.sin(spin + disc) * 0.02 * (1 - speed), 0.35 + speed * 0.35);
      }
    }
    for (let y = 0; y <= 6; y += 1) plot(0, -0.95 + (y / 6) * 0.5, 0.5);
    for (let x = 0; x <= 6; x += 1) plot(-0.24 + (x / 6) * 0.48, -0.95, 0.6);
    /* Two spouts, and only the light stream climbs to the upper one. */
    for (let x = 0; x <= 10; x += 1) {
      plot(0.62 + (x / 10) * 0.5, -0.32, 0.55);
      plot(-0.62 - (x / 10) * 0.5, 0.16, 0.55);
    }
    for (let drop = 0; drop < 5; drop += 1) {
      const life = (t * 1.8 + hash(drop)) % 1;
      plot(1.12, -0.3 + life * 0.9, speed * (1 - life * 0.3) * 0.95);
      plot(-1.12, 0.18 + life * 0.7, speed * (1 - life * 0.3) * 0.8);
    }
    plot(0, -0.1, 0.4 + speed * 0.6);
  });
}

/* -- Egg grader: eggs rolling along and dropping by size ------------------ */

function paintEggGrader(t: number): string {
  return paintPlotted((plot) => {
    const run = ASPECT * 2 + 1;
    for (let x = 0; x <= 34; x += 1) plot(-ASPECT + (x / 34) * ASPECT * 2, -0.1, 0.45);
    /* Three chutes, each with a wider gap than the last. */
    for (let chute = 0; chute < 3; chute += 1) {
      const cu = -0.75 + chute * 0.75;
      for (let y = 0; y <= 7; y += 1) {
        plot(cu - 0.22, -0.05 + (y / 7) * 0.85, 0.4);
        plot(cu + 0.22, -0.05 + (y / 7) * 0.85, 0.4);
      }
    }
    for (let egg = 0; egg < 5; egg += 1) {
      const size = 0.5 + hash(egg * 3.1) * 0.5;
      const along = (t * 0.5 + egg / 5) % 1;
      const u = -ASPECT - 0.4 + along * run;
      /* The egg falls at the first gap wide enough to take it. */
      const gate = size < 0.7 ? -0.75 : size < 0.85 ? 0 : 0.75;
      const dropping = u > gate;
      const fall = dropping ? clamp01((u - gate) * 1.6) : 0;
      const eu = dropping ? gate : u;
      const ev = -0.2 - size * 0.1 + fall * fall * 1.1;
      for (let step = 0; step <= 12; step += 1) {
        const a = (step / 12) * TAU;
        plot(eu + Math.cos(a) * 0.16 * size, ev + Math.sin(a) * 0.13 * size, 0.75);
      }
      plot(eu, ev, 0.35);
    }
    for (let roller = 0; roller <= 10; roller += 1) {
      plot(-1.5 + roller * 0.3, -0.02 + Math.sin(t * 5 + roller) * 0.04, 0.6);
    }
  });
}

/* -- Hay baler: a swathe taken in and bales dropped behind ---------------- */

function paintHayBaler(t: number): string {
  return paintPlotted((plot) => {
    const roll = t * 3;
    const cycle = (t * 0.3) % 1;
    /* The chamber fills, then the tailgate opens and the bale rolls out. */
    const full = clamp01(cycle * 1.6);
    const dumping = cycle > 0.78;
    const gate = dumping ? (cycle - 0.78) * 4 : 0;
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 2, 0.88, 0.4);
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      const open = a > Math.PI * 0.2 && a < Math.PI * 1.1 ? gate * 0.5 : 0;
      plot(-0.1 + Math.cos(a) * (0.58 + open), 0.2 + Math.sin(a) * 0.5, 0.5);
    }
    for (let ring = 1; ring <= 3; ring += 1) {
      const radius = (ring / 3) * 0.46 * full;
      for (let step = 0; step <= 18; step += 1) {
        const a = (step / 18) * TAU + roll;
        plot(-0.1 + Math.cos(a) * radius * 1.15, 0.24 + Math.sin(a) * radius, 0.4 + full * 0.5);
      }
    }
    /* The pickup keeps sweeping the ground up into the throat. */
    for (let tine = 0; tine < 5; tine += 1) {
      const a = roll * 0.8 + (tine / 5) * TAU;
      plot(-0.85 + Math.cos(a) * 0.2, 0.66 + Math.sin(a) * 0.16, 0.85);
    }
    for (let wisp = 0; wisp < 4; wisp += 1) {
      const life = (t * 1.2 + hash(wisp)) % 1;
      plot(-1.3 + life * 0.5, 0.8 - life * 0.14, (1 - life) * 0.6);
    }
    if (dumping) {
      for (let step = 0; step <= 16; step += 1) {
        const a = (step / 16) * TAU + roll;
        plot(0.6 + gate * 0.6 + Math.cos(a) * 0.5, 0.52 + Math.sin(a) * 0.42, 0.6);
      }
    }
  });
}

/* -- Sheep shears: the clipper stroking and the fleece peeling back ------- */

function paintSheepShears(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.2) % 1;
    /* Long strokes down the flank; the fleece opens behind each one. */
    const stroke = (t * 0.8) % 1;
    const cu = -0.95 + stroke * 1.5;
    const cleared = cycle;
    for (let step = 0; step <= 40; step += 1) {
      const a = (step / 40) * TAU;
      plot(Math.cos(a) * 1.1, 0.15 + Math.sin(a) * 0.62, 0.4);
    }
    for (let tuft = 0; tuft < 26; tuft += 1) {
      const tu = -1.05 + (tuft / 25) * 2.1;
      if (tu < -1 + cleared * 2) continue;
      const height = 0.42 - Math.abs(tu) * 0.14;
      for (let step = 0; step <= 5; step += 1) {
        const f = step / 5;
        plot(tu + Math.sin(f * 5 + tuft) * 0.05, -0.3 - f * height * 0.5, 0.5 + f * 0.35);
      }
    }
    /* The cut fleece stays in one piece and folds off to the near side. */
    for (let step = 0; step <= 22; step += 1) {
      const f = step / 22;
      const fu = -1.05 + f * (cleared * 2);
      plot(fu, 0.72 + Math.sin(f * 6 + t) * 0.07, 0.7);
      plot(fu, 0.88, 0.45);
    }
    for (let y = 0; y <= 5; y += 1) plot(cu + 0.28, -0.85 + (y / 5) * 0.5, 0.55);
    const chatter = Math.sin(t * 26) * 0.03;
    for (let x = 0; x <= 8; x += 1) {
      plot(cu - 0.16 + (x / 8) * 0.32, -0.34 + chatter, 0.9);
      plot(cu - 0.16 + (x / 8) * 0.32, -0.26 - chatter, 0.75);
    }
  });
}

/* -- Honey extractor: frames spun and honey thrown to the wall ------------ */

function paintHoneyExtractor(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.12) % 1;
    /* Wind it up, let it run, and it coasts down as the frames empty. */
    const rate = clamp01(cycle * 5) - clamp01((cycle - 0.7) * 3);
    const spin = t * (1.5 + rate * 12);
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      plot(Math.cos(a) * 1.15, Math.sin(a) * 0.8, 0.5);
    }
    for (let frame = 0; frame < 4; frame += 1) {
      const a = spin + (frame / 4) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      /* A frame edge-on all but disappears, which is what sells the spin. */
      const face = Math.abs(cos);
      for (let step = 0; step <= 10; step += 1) {
        const f = (step / 10) * 2 - 1;
        plot(cos * f * 0.8 - sin * 0.02, sin * f * 0.56, 0.3 + face * 0.6);
      }
    }
    for (let fling = 0; fling < 8; fling += 1) {
      const a = spin * 0.6 + fling * 0.9;
      const out = 0.5 + ((t * 2 + hash(fling)) % 1) * 0.7;
      plot(Math.cos(a) * out * 1.15, Math.sin(a) * out * 0.8, rate * 0.9);
    }
    /* What has been flung off runs down the wall and out of the tap. */
    const pooled = clamp01(cycle * 1.4);
    for (let x = 0; x <= 18; x += 1) {
      const u = -0.9 + (x / 18) * 1.8;
      plot(u, 0.74 - pooled * 0.1, 0.75);
    }
    if (cycle > 0.75) {
      const flow = (t * 1.6) % 1;
      plot(1.2, 0.6 + flow * 0.35, (1 - flow) * 0.9);
    }
  });
}

/* -- Grape press: the basket screwed down and the juice running out ------- */

function paintGrapePress(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.22) % 1;
    const turn = t * 2.6;
    /* The cake compacts fast at first, then gives up very little. */
    const pressed = Math.pow(cycle, 0.6);
    for (let step = 0; step <= 24; step += 1) {
      const a = Math.PI * (step / 24);
      plot(Math.cos(a) * 0.9, 0.72 - Math.sin(a) * 0.05, 0.5);
    }
    for (let stave = 0; stave <= 10; stave += 1) {
      const u = -0.9 + (stave / 10) * 1.8;
      for (let y = 0; y <= 8; y += 1) plot(u, -0.1 + (y / 8) * 0.82, stave % 2 === 0 ? 0.55 : 0.3);
    }
    for (let x = 0; x <= 18; x += 1) {
      plot(-0.9 + (x / 18) * 1.8, 0.16, 0.5);
      plot(-0.9 + (x / 18) * 1.8, 0.62, 0.5);
    }
    const platen = -0.2 + pressed * 0.5;
    for (let x = 0; x <= 16; x += 1) plot(-0.82 + (x / 16) * 1.64, platen, 0.85);
    for (let y = 0; y <= 10; y += 1) {
      const f = y / 10;
      plot(Math.sin(turn + f * 7) * 0.09, -0.92 + f * (platen + 0.92), 0.7);
    }
    for (let arm = 0; arm < 2; arm += 1) {
      const a = turn + arm * Math.PI;
      for (let step = 0; step <= 6; step += 1) {
        const f = (step / 6) * 0.55;
        plot(Math.cos(a) * f, -0.92 + Math.sin(a) * f * 0.4, 0.75);
      }
    }
    /* Juice runs while it is being pressed and slows as the cake gives out. */
    for (let run = 0; run < 6; run += 1) {
      const life = (t * (1.4 - pressed * 0.7) + hash(run)) % 1;
      const ru = -0.85 + hash(run * 3.3) * 1.7;
      plot(ru, 0.6 + life * 0.3, (1 - pressed * 0.5) * (1 - life * 0.3) * 0.85);
    }
    for (let x = 0; x <= 22; x += 1) plot(-1.15 + (x / 22) * 2.3, 0.92, 0.6);
  });
}

/* -- Barrel roll: a barrel run down the stillage on its rims -------------- */

function paintBarrelRoll(t: number): string {
  return paintPlotted((plot) => {
    const run = (t * 0.34) % 1;
    const cu = -1.45 + run * 2.9;
    /* Rolling, so the hoops turn at the rate the barrel actually travels. */
    const roll = -run * 8.5;
    for (let x = 0; x <= 34; x += 1) plot(-ASPECT + (x / 34) * ASPECT * 2, 0.72, 0.45);
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      /* A barrel is fattest at its middle: the belly makes the silhouette. */
      const belly = 1 + Math.abs(Math.cos(a)) * 0.12;
      plot(cu + Math.cos(a) * 0.5 * belly, 0.3 + Math.sin(a) * 0.4 * belly, 0.55);
    }
    for (let hoop = -1; hoop <= 1; hoop += 1) {
      for (let step = 0; step <= 14; step += 1) {
        const a = (step / 14) * TAU + roll;
        plot(cu + hoop * 0.24 + Math.cos(a) * 0.12, 0.3 + Math.sin(a) * 0.42, 0.85);
      }
    }
    for (let stave = 0; stave < 5; stave += 1) {
      const a = roll + (stave / 5) * TAU;
      for (let x = 0; x <= 6; x += 1) {
        plot(cu - 0.4 + (x / 6) * 0.8, 0.3 + Math.sin(a) * 0.4, 0.3 + Math.pow(clamp01(Math.cos(a)), 2) * 0.5);
      }
    }
    for (let dust = 0; dust < 4; dust += 1) {
      const life = (t * 2 + hash(dust)) % 1;
      plot(cu - 0.5 - life * 0.4, 0.7 - life * 0.1, (1 - life) * 0.5);
    }
  });
}

/* -- Corker: a lever driving a cork down into the neck -------------------- */

function paintCorker(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 2;
    /* Lever down, cork in, lever back up and a fresh bottle slides in. */
    const drive = cycle < 0.8 ? cycle / 0.8 : cycle < 1.2 ? 1 : clamp01(1 - (cycle - 1.2) / 0.8);
    const slide = cycle > 1.6 ? (cycle - 1.6) / 0.4 : 0;
    const bu = slide * 0.9;
    for (let y = 0; y <= 10; y += 1) {
      const f = y / 10;
      plot(-0.42 + bu, 0.9 - f * 0.7, 0.6);
      plot(0.42 + bu, 0.9 - f * 0.7, 0.6);
    }
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(-0.42 + bu + f * 0.28, 0.2 - f * 0.32, 0.6);
      plot(0.42 + bu - f * 0.28, 0.2 - f * 0.32, 0.6);
    }
    for (let y = 0; y <= 6; y += 1) {
      const f = y / 6;
      plot(-0.14 + bu, -0.12 - f * 0.3, 0.6);
      plot(0.14 + bu, -0.12 - f * 0.3, 0.6);
    }
    /* The cork goes from above the neck to flush with it, and stays. */
    const cork = -0.62 + drive * 0.38;
    for (let x = 0; x <= 5; x += 1) {
      const u = -0.11 + bu + (x / 5) * 0.22;
      plot(u, cork, 0.9);
      plot(u, cork + 0.14, 0.9);
    }
    const ram = -1 + drive * 0.34;
    for (let y = 0; y <= 4; y += 1) plot(bu, ram - (y / 4) * 0.3, 0.7);
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(bu + f * 1.2, ram - 0.3 - f * (0.5 - drive * 0.75), 0.65);
    }
    for (let x = 0; x <= 26; x += 1) plot(-ASPECT + (x / 26) * ASPECT * 2, 0.94, 0.4);
  });
}

/* -- Bottling line: bottles filling one after another under the taps ------ */

function paintBottlingLine(t: number): string {
  return paintPlotted((plot) => {
    const stride = 1.4;
    const cycle = (t * 0.55) % stride;
    /* Index along, fill, index along: the line stops for every fill. */
    const shift = clamp01(cycle / 0.45);
    const eased = shift * shift * (3 - 2 * shift);
    const filling = cycle > 0.5;
    const fill = filling ? clamp01((cycle - 0.5) / 0.8) : 0;
    for (let x = 0; x <= 34; x += 1) plot(-ASPECT + (x / 34) * ASPECT * 2, 0.88, 0.45);
    for (let tap = 0; tap < 3; tap += 1) {
      const tu = -0.7 + tap * 0.7;
      for (let y = 0; y <= 4; y += 1) plot(tu, -0.95 + (y / 4) * 0.3, 0.55);
      for (let x = 0; x <= 4; x += 1) plot(tu - 0.1 + (x / 4) * 0.2, -0.62, 0.7);
    }
    for (let x = 0; x <= 24; x += 1) plot(-1.5 + (x / 24) * 3, -0.72, 0.35);
    for (let bottle = 0; bottle < 5; bottle += 1) {
      const bu = -1.6 + bottle * 0.7 + eased * 0.7;
      const under = Math.abs(bu + 0.7 - Math.round((bu + 0.7) / 0.7) * 0.7) < 0.1;
      const level = bu < -0.75 ? 1 : under && filling ? fill : bu > -0.05 ? 1 : 0;
      for (let y = 0; y <= 9; y += 1) {
        const f = y / 9;
        plot(bu - 0.16, 0.82 - f * 0.72, 0.6);
        plot(bu + 0.16, 0.82 - f * 0.72, 0.6);
      }
      for (let y = 0; y <= 3; y += 1) plot(bu, 0.1 - (y / 3) * 0.24, 0.6);
      for (let y = 0; y <= 8; y += 1) {
        const f = y / 8;
        plot(bu, 0.82 - f * 0.66 * level, level > 0 ? 0.85 : 0);
      }
      if (under && filling && fill < 1) {
        plot(bu, -0.5 + ((t * 6) % 1) * 0.4, 0.95);
      }
    }
  });
}

/* -- Tea pour: a long pour from a high spout into a small cup ------------- */

function paintTeaPour(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.24) % 1;
    /* Raise the pot, pour high and thin, lower it, and the cup keeps it. */
    const height = cycle < 0.25 ? cycle * 4 : cycle < 0.75 ? 1 : clamp01(1 - (cycle - 0.75) * 4);
    const pouring = cycle > 0.2 && cycle < 0.8;
    const tilt = pouring ? 0.5 : 0;
    const pv = -0.3 - height * 0.55;
    for (let step = 0; step <= 20; step += 1) {
      const a = Math.PI * 0.15 + (step / 20) * Math.PI * 1.7;
      plot(-0.75 + Math.cos(a) * 0.38, pv + Math.sin(a) * 0.3 + tilt * 0.1, 0.6);
    }
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      /* The spout swings down as the pot is tipped, and the stream follows. */
      plot(-0.4 + f * 0.42, pv - 0.16 + f * (0.24 + tilt * 0.24), 0.7);
    }
    for (let step = 0; step <= 8; step += 1) {
      const a = Math.PI * (step / 8);
      plot(-1.12 + Math.cos(a) * 0.24, pv + Math.sin(a) * 0.22, 0.5);
    }
    if (pouring) {
      for (let step = 0; step <= 26; step += 1) {
        const f = step / 26;
        const u = 0.02 + Math.sin(t * 4) * 0.02 * f;
        plot(u, pv + 0.1 + f * (0.62 - pv - 0.1), 0.9 - f * 0.2);
      }
    }
    const level = pouring ? clamp01((cycle - 0.2) / 0.6) : cycle < 0.2 ? 0 : 1;
    for (let step = 0; step <= 20; step += 1) {
      const a = Math.PI * (step / 20);
      plot(Math.cos(a) * 0.34, 0.86 - Math.sin(a) * 0.24, 0.55);
    }
    for (let x = 0; x <= 10; x += 1) {
      plot(-0.34 + (x / 10) * 0.68, 0.62, 0.5);
      plot(-0.3 + (x / 10) * 0.6, 0.82 - level * 0.18, level > 0.02 ? 0.85 : 0);
    }
    for (let steam = 0; steam < 3; steam += 1) {
      const life = (t * 0.8 + hash(steam)) % 1;
      plot(Math.sin(life * 5 + steam) * 0.12, 0.55 - life * 0.5, (1 - life) * level * 0.5);
    }
  });
}

/* -- Coffee siphon: water climbing to the top and falling back brewed ----- */

function paintCoffeeSiphon(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.16) % 1;
    /* Heat, rise, brew, cut the flame, and the brew is drawn back down. */
    const rise = clamp01((cycle - 0.15) * 4);
    const drawn = clamp01((cycle - 0.7) * 3.5);
    const upper = rise - drawn;
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      plot(Math.cos(a) * 0.55, 0.5 + Math.sin(a) * 0.36, 0.5);
      plot(Math.cos(a) * 0.42, -0.5 + Math.sin(a) * 0.34, 0.5);
    }
    for (let y = 0; y <= 6; y += 1) plot(0, -0.16 + (y / 6) * 0.3, 0.6);
    /* The lower bulb empties by exactly as much as the upper one fills. */
    for (let x = 0; x <= 14; x += 1) {
      const f = x / 14;
      const half = Math.sin(Math.acos(Math.abs(f * 2 - 1)));
      plot((f * 2 - 1) * 0.5 * half, 0.78 - (1 - upper) * 0.28, upper > 0.02 ? 0 : 0.8);
    }
    for (let x = 0; x <= 14; x += 1) {
      const f = x / 14;
      plot((f * 2 - 1) * 0.38, -0.72 + (1 - upper) * 0.4, 0.85);
    }
    for (let x = 0; x <= 12; x += 1) {
      const f = x / 12;
      plot((f * 2 - 1) * 0.5, 0.82 - upper * 0.5, upper > 0.05 ? 0.85 : 0);
    }
    if (upper > 0.4 && drawn < 0.05) {
      for (let bubble = 0; bubble < 6; bubble += 1) {
        const life = (t * 2 + hash(bubble)) % 1;
        plot((hash(bubble * 3.1) - 0.5) * 0.7, 0.86 - life * 0.4, (1 - life) * 0.7);
      }
    }
    const flame = cycle < 0.72 ? 0.6 + Math.sin(t * 12) * 0.4 : 0;
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(-0.1 + f * 0.2, 0.98 - f * 0.14, flame);
    }
  });
}

/* -- Cocktail shaker: shaken hard, then opened and strained --------------- */

function paintCocktailShaker(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.32) % 2;
    const shaking = cycle < 1.2;
    const shake = shaking ? Math.sin(t * 16) : 0;
    const pour = clamp01((cycle - 1.4) * 2.5);
    const cu = shake * 0.24;
    const lean = shake * 0.2;
    const drop = pour * 0.5;
    for (let y = 0; y <= 12; y += 1) {
      const f = y / 12;
      plot(cu - 0.34 + lean * (1 - f) + (pour ? drop * f : 0), -0.7 + drop + f * 1.1, 0.6);
      plot(cu + 0.34 + lean * (1 - f) + (pour ? drop * f : 0), -0.7 + drop + f * 1.1, 0.6);
    }
    for (let x = 0; x <= 10; x += 1) {
      plot(cu - 0.34 + lean + (x / 10) * 0.68, -0.7 + drop, 0.7);
      plot(cu - 0.34 + (x / 10) * 0.68, 0.4 + drop, 0.6);
    }
    if (shaking) {
      /* The ice is what makes a shaker read as shaken rather than just moved. */
      for (let cube = 0; cube < 5; cube += 1) {
        const a = t * 9 + cube * 1.3;
        plot(cu + Math.sin(a) * 0.22, -0.3 + Math.cos(a * 1.3) * 0.4, 0.9);
      }
    } else if (pour > 0) {
      for (let step = 0; step <= 14; step += 1) {
        const f = step / 14;
        plot(cu + 0.34 + drop + f * 0.5, -0.16 + drop + f * 0.7, 0.9);
      }
    }
    for (let step = 0; step <= 18; step += 1) {
      const f = step / 18;
      plot(0.9 + (f - 0.5) * 0.7, 0.44 + Math.abs(f - 0.5) * 0.5, 0.55);
    }
    for (let y = 0; y <= 4; y += 1) plot(0.9, 0.7 + (y / 4) * 0.24, 0.5);
    const level = pour * 0.3;
    for (let x = 0; x <= 8; x += 1) plot(0.9 - level * 1.1 + (x / 8) * level * 2.2, 0.68 - level * 0.8, level > 0.02 ? 0.85 : 0);
  });
}

/* -- Noodle pull: dough folded and pulled, doubling every time ------------ */

function paintNoodlePull(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 2;
    /* Pull it out, fold it back, and the strand count doubles each round. */
    const pulling = cycle < 1;
    const stretch = pulling ? Math.sin(cycle * Math.PI) : 0;
    const rounds = Math.floor((t * 0.25) % 4);
    const strands = Math.min(12, 1 << rounds);
    const reach = 0.55 + stretch * 0.9;
    for (const side of [-1, 1] as const) {
      for (let y = 0; y <= 5; y += 1) plot(side * (reach + 0.2), -0.5 + (y / 5) * 0.45, 0.7);
      for (let x = 0; x <= 4; x += 1) plot(side * (reach + 0.2) - side * (x / 4) * 0.2, -0.5, 0.75);
    }
    for (let strand = 0; strand < strands; strand += 1) {
      const spread = strands === 1 ? 0 : (strand / (strands - 1) - 0.5) * 0.5;
      for (let x = 0; x <= 30; x += 1) {
        const f = x / 30;
        const u = -reach + f * reach * 2;
        /* Slack in the middle, and it takes up as the pull comes on. */
        const sag = Math.sin(f * Math.PI) * (0.42 - stretch * 0.3) + spread;
        plot(u, -0.35 + sag, 0.45 + (1 - stretch) * 0.4);
      }
    }
    if (!pulling) {
      const fold = (cycle - 1);
      for (let x = 0; x <= 12; x += 1) {
        const f = x / 12;
        plot(-reach + f * reach * (2 - fold * 1.4), -0.32 + Math.sin(f * Math.PI) * 0.45, 0.8);
      }
    }
    for (let x = 0; x <= 26; x += 1) plot(-1.4 + (x / 26) * 2.8, 0.85, 0.45);
    for (let flour = 0; flour < 5; flour += 1) {
      const life = (t * 1.6 + hash(flour)) % 1;
      plot((hash(flour * 3.7) - 0.5) * 2, 0.4 + life * 0.4, (1 - life) * 0.4 * stretch);
    }
  });
}

/* -- Wok toss: the contents thrown up and caught again -------------------- */

function paintWokToss(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 1.1) % 1;
    /* Pull back, flick up, catch: the wok leads the food by a beat. */
    const flick = cycle < 0.25 ? -Math.sin(cycle * 4 * Math.PI) * 0.5 : 0;
    const airborne = cycle > 0.2 && cycle < 0.85;
    const flight = clamp01((cycle - 0.2) / 0.65);
    const arc = Math.sin(flight * Math.PI);
    for (let step = 0; step <= 24; step += 1) {
      const a = Math.PI * (step / 24);
      plot(Math.cos(a) * 0.7 + flick * 0.3, 0.45 - Math.sin(a) * 0.34 + flick * 0.2, 0.6);
    }
    for (let x = 0; x <= 12; x += 1) plot(0.7 + (x / 12) * 0.7 + flick * 0.3, 0.45 + flick * 0.2 - (x / 12) * 0.12, 0.55);
    for (let piece = 0; piece < 9; piece += 1) {
      const spread = (hash(piece * 2.9) - 0.5) * 0.9;
      if (airborne) {
        /* In the air the pile opens out and tumbles before it comes back. */
        const own = 0.8 + hash(piece) * 0.4;
        plot(spread * (1 + arc * 1.4), 0.3 - arc * own * 0.9 + flick * 0.2, 0.85);
      } else {
        plot(spread + flick * 0.3, 0.34 + hash(piece * 5.1) * 0.08 + flick * 0.2, 0.8);
      }
    }
    /* Flame licks up the side only when the wok has just been tipped. */
    const licking = cycle < 0.3 ? 1 : 0;
    for (let flame = 0; flame < 5; flame += 1) {
      const f = flame / 4;
      plot(-0.7 + f * 1.4, 0.72 + Math.sin(t * 20 + flame) * 0.06, licking * (0.4 + hash(flame) * 0.6));
    }
    for (let steam = 0; steam < 4; steam += 1) {
      const life = (t * 1.4 + hash(steam * 3.3)) % 1;
      plot((hash(steam) - 0.5) * 1.2, 0.2 - life * 1, (1 - life) * 0.45);
    }
  });
}

/* -- Skewer grill: skewers turned over the coals -------------------------- */

function paintSkewerGrill(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) {
      const u = -1.4 + (x / 30) * 2.8;
      /* The bed breathes: coals brighten where the draught is working. */
      const glow = 0.35 + Math.pow(clamp01(Math.sin(u * 3 + t * 1.6) * 0.5 + 0.5), 2) * 0.6;
      plot(u, 0.78, glow);
      plot(u, 0.9, glow * 0.7);
    }
    for (let skewer = 0; skewer < 4; skewer += 1) {
      const sv = 0.1 + skewer * 0.16;
      /* Each skewer is turned a quarter at a time, on its own beat. */
      const turn = Math.floor(t * 0.8 + skewer * 0.4) * (Math.PI / 2);
      for (let x = 0; x <= 22; x += 1) {
        const u = -1.25 + (x / 22) * 2.5;
        plot(u, sv, 0.45);
      }
      for (let piece = 0; piece < 4; piece += 1) {
        const pu = -0.85 + piece * 0.56;
        const face = Math.cos(turn + piece * 0.3);
        const done = 0.4 + Math.pow(clamp01(face), 2) * 0.55;
        for (let step = 0; step <= 10; step += 1) {
          const a = (step / 10) * TAU;
          plot(pu + Math.cos(a) * 0.18, sv + Math.sin(a) * 0.1, done);
        }
      }
    }
    for (let smoke = 0; smoke < 6; smoke += 1) {
      const life = (t * 0.8 + hash(smoke)) % 1;
      const su = -1 + hash(smoke * 3.1) * 2;
      plot(su + Math.sin(life * 5 + smoke) * 0.16, 0.7 - life * 1.5, (1 - life) * 0.5);
    }
  });
}

/* -- Lantern string: lanterns lighting along the line and swaying --------- */

function paintLanternString(t: number): string {
  return paintPlotted((plot) => {
    const wind = Math.sin(t * 0.9);
    for (let x = 0; x <= 40; x += 1) {
      const f = x / 40;
      const u = -ASPECT + f * ASPECT * 2;
      plot(u, -0.75 + Math.sin(f * Math.PI) * 0.3 + wind * 0.06 * Math.sin(f * Math.PI), 0.5);
    }
    for (let lantern = 0; lantern < 5; lantern += 1) {
      const f = (lantern + 0.5) / 5;
      const u = -ASPECT + f * ASPECT * 2 + wind * 0.12 * Math.sin(f * Math.PI);
      const hang = -0.75 + Math.sin(f * Math.PI) * 0.3 + 0.42;
      /* The lights run down the string rather than blinking together. */
      const lit = Math.pow(clamp01(Math.sin(t * 2.2 - lantern * 0.9) * 0.5 + 0.5), 1.6);
      const bright = 0.3 + lit * 0.7;
      for (let step = 0; step <= 16; step += 1) {
        const a = (step / 16) * TAU;
        plot(u + Math.cos(a) * 0.2, hang + Math.sin(a) * 0.26, bright);
      }
      plot(u, hang, bright);
      /* A tassel under each one, and only the lit ones throw a tassel worth
         seeing. */
      for (let y = 0; y <= 3; y += 1) plot(u, hang + 0.28 + (y / 3) * 0.2, bright * 0.5);
    }
  });
}

/* -- Shaved ice: a block shaved into a cone and syrup poured over --------- */

function paintShavedIce(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.2) % 1;
    const shaving = cycle < 0.65;
    const heap = clamp01(cycle / 0.65);
    const blade = Math.sin(t * 7) * 0.3;
    for (let step = 0; step <= 22; step += 1) {
      const a = Math.PI * (step / 22);
      plot(0.05 + Math.cos(a) * 0.42, 0.86 - Math.sin(a) * 0.16, 0.55);
    }
    for (let y = 0; y <= 5; y += 1) {
      plot(-0.37, 0.86 - (y / 5) * 0.3, 0.55);
      plot(0.47, 0.86 - (y / 5) * 0.3, 0.55);
    }
    /* The heap grows as a cone, so its outline is a pair of leaning lines. */
    const height = heap * 0.75;
    for (let x = 0; x <= 20; x += 1) {
      const f = x / 20;
      const u = -0.34 + f * 0.78;
      const top = 0.56 - height * (1 - Math.abs(f - 0.5) * 2);
      plot(u, top, 0.75);
      for (let y = 0; y <= 4; y += 1) plot(u, top + (y / 4) * (0.56 - top), 0.35 + hash2(x, y) * 0.4);
    }
    if (shaving) {
      for (let y = 0; y <= 6; y += 1) plot(0.05 + blade * 0.2, -0.9 + (y / 6) * 0.5, 0.6);
      for (let x = 0; x <= 8; x += 1) plot(-0.2 + blade * 0.2 + (x / 8) * 0.5, -0.4, 0.85);
      for (let flake = 0; flake < 7; flake += 1) {
        const life = (t * 2.4 + hash(flake)) % 1;
        plot(0.05 + (hash(flake * 3.3) - 0.5) * 0.7, -0.34 + life * 0.85, (1 - life * 0.4) * 0.8);
      }
    } else {
      /* Syrup goes on last and soaks down through the heap. */
      const soak = (cycle - 0.65) / 0.35;
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(0.05, -0.5 + f * (1.06 - height), 0.9);
      }
      for (let x = 0; x <= 12; x += 1) {
        const f = x / 12;
        plot(-0.3 + f * 0.7, 0.56 - height * (1 - Math.abs(f - 0.5) * 2) + soak * 0.3, 0.95);
      }
    }
  });
}

/* -- Candy floss: sugar caught on a stick and built up ------------------- */

function paintCandyFloss(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.22) % 1;
    const spin = t * 6;
    /* The head keeps spinning; the stick turns slowly and collects. */
    const size = 0.1 + cycle * 0.55;
    for (let step = 0; step <= 26; step += 1) {
      const a = (step / 26) * TAU;
      plot(Math.cos(a) * 0.95, 0.6 + Math.sin(a) * 0.32, 0.45);
    }
    for (let x = 0; x <= 10; x += 1) plot(-0.3 + (x / 10) * 0.6, 0.42, 0.7);
    for (let jet = 0; jet < 10; jet += 1) {
      const a = spin + (jet / 10) * TAU;
      const reach = 0.3 + ((t * 2 + hash(jet)) % 1) * 0.6;
      plot(Math.cos(a) * reach, 0.5 + Math.sin(a) * reach * 0.45, clamp01(1 - reach) * 0.7);
    }
    const stickTurn = t * 2.4;
    for (let y = 0; y <= 8; y += 1) plot(0.05, 0.3 + (y / 8) * 0.6, 0.6);
    /* The floss winds on in threads rather than appearing as a blob. */
    for (let thread = 0; thread < 14; thread += 1) {
      const a = stickTurn + thread * 0.9;
      const r = size * (0.5 + hash(thread) * 0.5);
      plot(0.05 + Math.cos(a) * r * 1.5, 0.05 + Math.sin(a) * r, 0.4 + hash(thread * 3.1) * 0.5);
    }
    for (let step = 0; step <= 18; step += 1) {
      const a = (step / 18) * TAU;
      plot(0.05 + Math.cos(a) * size * 1.5, 0.05 + Math.sin(a) * size, 0.55);
    }
  });
}

/* -- Dumpling steamer: stacked baskets, and the top one lifted ------------ */

function paintDumplingSteamer(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 1;
    /* Steam for most of the cycle, then the lid comes off and it billows. */
    const lifting = cycle > 0.55;
    const lift = lifting ? Math.sin(((cycle - 0.55) / 0.45) * Math.PI) : 0;
    for (let basket = 0; basket < 3; basket += 1) {
      const bv = 0.72 - basket * 0.38;
      for (let x = 0; x <= 24; x += 1) {
        const u = -0.95 + (x / 24) * 1.9;
        plot(u, bv, 0.6);
        plot(u, bv - 0.28, 0.45);
      }
      for (let y = 0; y <= 4; y += 1) {
        plot(-0.95, bv - (y / 4) * 0.28, 0.55);
        plot(0.95, bv - (y / 4) * 0.28, 0.55);
      }
    }
    const lidV = -0.5 - lift * 0.5;
    for (let step = 0; step <= 22; step += 1) {
      const a = Math.PI * (step / 22);
      plot(Math.cos(a) * 0.98, lidV - Math.sin(a) * 0.2, 0.6);
    }
    if (lift > 0.2) {
      /* With the lid off you can see what is in the top basket. */
      for (let dumpling = 0; dumpling < 4; dumpling += 1) {
        const du = -0.55 + dumpling * 0.37;
        for (let step = 0; step <= 10; step += 1) {
          const a = Math.PI * (step / 10);
          plot(du + Math.cos(a) * 0.16, -0.36 - Math.sin(a) * 0.12, 0.85);
        }
      }
    }
    for (let puff = 0; puff < 10; puff += 1) {
      const life = (t * (1 + lift * 1.6) + hash(puff)) % 1;
      const pu = (hash(puff * 3.9) - 0.5) * (0.8 + lift * 1.8) * (0.4 + life);
      plot(pu, lidV - 0.1 - life * 0.5, (1 - life * 0.7) * (0.5 + lift * 0.5));
    }
    for (let x = 0; x <= 20; x += 1) plot(-1.2 + (x / 20) * 2.4, 0.92, 0.4);
  });
}

/* ========================================================================
   The tenth collection: fields from ink, paper and materials under strain,
   then a print shop, a tailor's, a garage, a fairground, and a theatre.
   Same contract as everything above: a pure painter over the shared grid.
   ===================================================================== */

/* -- Halftone: a fixed dot screen with a tone wave passing under it ------- */

const halftoneField: Field = (u, v, t) => {
  /* The screen never moves and the tone does, which is what makes this read
     as a halftone rather than as a field of pulsing dots. A screen this
     coarse is as fine as a character grid can hold: any more dots across and
     each one falls below one cell and the whole thing comes out as static. */
  const tone = clamp01(0.5 + Math.sin(u * 1.1 - t * 1.4) * 0.5 + Math.sin(v * 1.7 + t * 0.6) * 0.22);
  const cellU = u * 1.5 - Math.floor(u * 1.5) - 0.5;
  const cellV = v * 1.5 - Math.floor(v * 1.5) - 0.5;
  const dot = clamp01((0.18 + tone * 0.55 - Math.hypot(cellU, cellV)) * 3.4);
  return clamp01(0.06 + dot * 0.94);
};

/* -- Darkroom: a print surfacing in the developer tray -------------------- */

const darkroomField: Field = (u, v, t) => {
  const cycle = (t * 0.22) % 1;
  const developed = clamp01(cycle * 2.2);
  const su = u + Math.sin(t * 1.6) * 0.05;
  if (Math.abs(su) > 1.34 || Math.abs(v) > 0.82) {
    /* Outside the sheet is only the tray, rocking. */
    return clamp01(0.05 + Math.abs(Math.sin((u + v) * 6 - t * 2)) * 0.08);
  }
  /* A lit subject over a dark ground, which is all the sheet has to be for
     the order it comes up in to read. */
  const image = clamp01(
    0.22 +
      clamp01(1 - Math.hypot((su + 0.3) * 1.4, (v + 0.15) * 1.7)) * 0.72 +
      clamp01((v - 0.3) * 2.2) * 0.3 +
      Math.sin(su * 4 + v) * 0.08,
  );
  /* Shadows come up first and the highlights last, as they do in a tray, and
     nothing ever goes darker than the density it is printed at. */
  const density = clamp01(1 - image);
  const surfaced = density * clamp01((density - (1 - developed)) * 4 + developed * 0.35);
  const grain = hash2(Math.floor(su * 14), Math.floor(v * 14)) * 0.12;
  return clamp01(0.08 + surfaced * 0.85 + grain * developed);
};

/* -- Capillary: dye wicking up a paper strip ------------------------------ */

const capillaryField: Field = (u, v, t) => {
  const strip = clamp01(1 - (Math.abs(u) - 0.9) * 4);
  if (strip <= 0) return 0.04;
  /* The front climbs as the root of time, then a fresh strip goes in. */
  const cycle = (t * 0.3) % 1;
  const fibre = fbm(u * 6, v * 2.2, 2);
  /* Fibres pull at their own rates, so the front is ragged, never a line. */
  const front = 0.95 - Math.sqrt(cycle) * 1.85 + (fibre - 0.5) * 0.16;
  const wet = clamp01((v - front) * 3.4) * (0.35 + fibre * 0.4);
  const band = clamp01(1 - Math.abs(v - front) * 5) * 0.5;
  return clamp01(0.06 + strip * (wet + band));
};

/* -- Foam head: cells draining, coarsening, and popping ------------------- */

const foamHeadField: Field = (u, v, t) => {
  const settle = (t * 0.25) % 1;
  const surface = -0.88 + settle * 0.62;
  if (v < surface - 0.06) {
    return clamp01(0.05 + hash2(Math.floor(u * 9), Math.floor(v * 9)) * 0.06);
  }
  /* The head sinks as it drains and the cells left behind get coarser. */
  const coarse = 3.4 + settle * 2.2;
  let edge = 0;
  for (let cell = 0; cell < 14; cell += 1) {
    const life = (t * 0.5 + hash(cell)) % 1;
    const cu = -1.5 + hash(cell * 3.7) * 3;
    const cv = surface + 0.08 + hash(cell * 5.3) * (0.9 - settle * 0.3);
    const size = (0.1 + hash(cell * 7.1) * 0.16) * (1 + life * 0.5);
    /* A cell is its wall: the film shows, the gas inside it does not. */
    const radius = Math.hypot((u - cu) * 0.9, v - cv) / size;
    edge = Math.max(edge, clamp01(1 - Math.abs(radius - 1) * coarse) * (1 - life * 0.6));
  }
  /* Under the head, single bubbles run up out of the liquid to feed it. */
  let rising = 0;
  for (let bubble = 0; bubble < 8; bubble += 1) {
    const life = (t * 0.6 + hash(bubble * 2.1)) % 1;
    const bu = -1.4 + hash(bubble * 4.3) * 2.8;
    rising = Math.max(
      rising,
      clamp01(1 - Math.hypot((u - bu) * 9, (v - 0.95 + life * (0.95 - surface)) * 11)) * 0.6,
    );
  }
  return clamp01(0.08 + clamp01((v - surface) * 1.4) * 0.28 + rising + edge * 0.9);
};

/* -- Rust bloom: rust creeping out from pits in a steel sheet ------------- */

const rustBloomField: Field = (u, v, t) => {
  const steel = 0.1 + hash2(Math.floor(u * 7), Math.floor(v * 7)) * 0.08;
  let rust = 0;
  for (let pit = 0; pit < 6; pit += 1) {
    const pu = -1.4 + hash(pit * 2.7) * 2.8;
    const pv = -0.8 + hash(pit * 6.1) * 1.6;
    /* Each pit runs its own nine seconds of growth, then the sheet is new. */
    const age = (t + hash(pit * 9.3) * 9) % 9;
    const reach = clamp01(age * 0.16) * (0.5 + hash(pit) * 0.5);
    const ragged = reach * (0.65 + fbm(Math.atan2(v - pv, u - pu) * 2.4 + pit, age * 0.05, 2) * 0.7);
    const radius = Math.hypot((u - pu) * 0.85, v - pv);
    if (radius > ragged) continue;
    const scale = 0.4 + fbm(u * 6 + pit * 3, v * 6, 2) * 0.55;
    rust = Math.max(rust, scale + clamp01(1 - (ragged - radius) * 5) * 0.35);
  }
  /* Bare steel or rust, never both: the scale sits on the sheet. */
  return clamp01(Math.max(steel, rust));
};

/* -- Craquelure: a glaze crazing into islands as it cools ----------------- */

const craquelureField: Field = (u, v, t) => {
  /* The crazing arrives as a front out of one corner, and never heals. */
  const front = ((t * 0.35) % 3.4) * 1.3;
  const glaze = 0.4 + fbm(u * 1.6, v * 1.6, 2) * 0.18;
  const distance = Math.hypot(u + 1.6, v + 1);
  if (distance > front) return clamp01(glaze);
  let crack = 0;
  for (let seed = 0; seed < 6; seed += 1) {
    /* One line per seed at its own angle, so the islands stay islands rather
       than turning into a stripe pattern. */
    const dir = hash(seed * 3.1) * Math.PI;
    const across = u * Math.cos(dir) + v * Math.sin(dir) - (hash(seed * 5.9) - 0.5) * 2.4;
    const wobble = Math.sin((v * Math.cos(dir) - u * Math.sin(dir)) * 3 + seed) * 0.08;
    crack = Math.max(
      crack,
      clamp01(1 - Math.abs(across + wobble) * 9) * clamp01((front - distance) * 2),
    );
  }
  return clamp01(glaze * (1 - crack * 0.9));
};

/* -- Dendrite: plating branching out from the cathode edge ---------------- */

const dendriteField: Field = (u, v, t) => {
  const bath = 0.06 + fbm(u * 2 + t * 0.2, v * 2, 2) * 0.1;
  /* The cathode is the strip the growth starts from, not the whole bath. */
  let metal = clamp01(1 - Math.abs(u + 1.5) * 6) * 0.65;
  for (let branch = 0; branch < 5; branch += 1) {
    /* A trunk creeps out into the bath; side arms only grow behind its tip. */
    const reach = ((t * 0.4 + hash(branch) * 2.6) % 2.6) * 1.3;
    const along = u + 1.5;
    if (along < 0 || along > reach) continue;
    const axis = -0.72 + branch * 0.36 + Math.sin(along * 3.4 + branch * 2.2) * 0.1;
    const trunk = clamp01(1 - Math.abs(v - axis) * 9);
    const arms =
      clamp01(1 - Math.abs(((along * 6) % 1) - 0.5) * 6) *
      clamp01(1 - (Math.abs(v - axis) - 0.05) * 9) *
      clamp01((reach - along) * 2) *
      0.75;
    metal = Math.max(metal, Math.max(trunk, arms));
  }
  return clamp01(bath + metal);
};

/* -- Boil: bubbles nucleating on the base and leaving it ------------------ */

const boilField: Field = (u, v, t) => {
  const heat = clamp01((v - 0.4) * 3) * (0.2 + Math.abs(Math.sin(t * 3 + u * 4)) * 0.25);
  let water = 0.1 + fbm(u * 2.2, v * 2.2 - t * 0.5, 2) * 0.14;
  for (let site = 0; site < 11; site += 1) {
    const su = -1.5 + hash(site * 2.3) * 3;
    const life = (t * (0.5 + hash(site * 4.7) * 0.8) + hash(site)) % 1;
    /* A bubble grows on its site, lets go, then runs for the surface. */
    const grow = Math.min(life / 0.35, 1);
    const rise = life > 0.35 ? (life - 0.35) / 0.65 : 0;
    const size = 0.06 + grow * 0.11 + rise * 0.05;
    const wobble = Math.sin(t * 6 + site) * rise * 0.08;
    const radius = Math.hypot((u - su - wobble) / size, (v - 0.86 + rise * 1.7) / (size * 1.1));
    water = Math.max(water, clamp01(1 - Math.abs(radius - 1) * 2.4) * 0.9);
  }
  return clamp01(water + heat * 0.4);
};

/* -- Chalkboard: chalk laid down and taken off again in sweeps ------------ */

const chalkboardField: Field = (u, v, t) => {
  const cycle = (t * 0.2) % 1;
  const written = clamp01(cycle * 2.6);
  const wipe = cycle > 0.62 ? (cycle - 0.62) / 0.38 : 0;
  const column = (u + ASPECT) / (ASPECT * 2);
  let chalk = 0;
  for (let line = 0; line < 3; line += 1) {
    /* Lines fill left to right, and the next one only starts once the one
       above it is most of the way across. */
    const filled = clamp01((written - line * 0.28) * 3.2);
    if (column > filled) continue;
    const stroke = Math.abs(Math.sin(u * 11 + line * 2.4 + Math.sin(u * 4) * 2));
    const lv = -0.5 + line * 0.5 + Math.sin(u * 5 + line) * 0.06;
    chalk = Math.max(chalk, clamp01(1 - Math.abs(v - lv) * 7) * (0.35 + stroke * 0.6));
  }
  /* The cloth takes the chalk off and leaves an arc of smear behind it. */
  const arc = Math.abs(Math.hypot((u + 1.4 - wipe * 3) * 0.7, v * 0.5) - 0.3);
  const cleaned = wipe > 0 ? clamp01(1 - arc * 1.6) : 0;
  return clamp01(0.07 + chalk * (1 - cleaned) + cleaned * 0.22);
};

/* -- Watermark: a mark showing as the sheet is turned to the light -------- */

const watermarkField: Field = (u, v, t) => {
  const tilt = Math.sin(t * 0.7);
  /* The sheet is even; what moves is where the light rakes across it. */
  const rake = clamp01(1 - Math.abs(u - tilt * 1.3) * 0.6);
  const laid = 0.42 + Math.abs(Math.sin(v * 16)) * 0.05 + Math.abs(Math.sin(u * 3.4)) * 0.04;
  const ring = clamp01(1 - Math.abs(Math.hypot((u + tilt * 0.1) * 0.8, v) - 0.42) * 3.2);
  const bar = clamp01(1 - Math.abs(v) * 6) * clamp01(1 - Math.abs(u) * 1.4);
  /* Thin paper passes more light, so the mark only reads under the rake. */
  const shown = (ring * 0.6 + bar * 0.4) * Math.pow(rake, 2);
  return clamp01(laid * (0.55 + rake * 0.35) + shown * 0.5);
};

/* -- Smog layer: a lid of smog banding over a city at first light --------- */

const smogLayerField: Field = (u, v, t) => {
  const lid = -0.1 + Math.sin(t * 0.3) * 0.12;
  const depth = clamp01((v - lid) * 1.8);
  /* Under the lid the air is stirred; above it, it is clean and still. */
  const haze = depth * (0.3 + fbm(u * 1.4 + t * 0.25, v * 2.6 - t * 0.1, 3) * 0.5);
  const roof = 0.3 + hash(Math.floor(u * 3.1)) * 0.45;
  const block = v > 0.9 - roof && Math.abs(u * 3.1) % 1 > 0.12 ? 0.7 : 0;
  const sun = clamp01(1 - Math.hypot((u + 1.15) * 0.8, (v - lid + 0.55) * 1.1) * 2.4);
  return clamp01(0.05 + haze + block * (0.4 + depth * 0.5) + sun * 0.55);
};

/* -- Bioluminescent wake: a hull lighting the water it disturbs ----------- */

const bioluminWakeField: Field = (u, v, t) => {
  const bow = -ASPECT - 0.5 + ((t * 0.75) % (ASPECT * 2 + 1.4));
  const behind = bow - u;
  if (behind < 0) return clamp01(0.04 + fbm(u * 2, v * 2 + t * 0.2, 2) * 0.07);
  /* The V opens with distance and the light in it dies as it is left. */
  const arm = clamp01(1 - Math.abs(Math.abs(v) - (0.1 + behind * 0.3)) * 5);
  const churn = hash2(Math.floor(u * 8 - t), Math.floor(v * 8 + t * 0.5));
  const glow = arm * (0.35 + churn * 0.65) * clamp01(1 - behind * 0.4);
  const hull = clamp01(1 - Math.hypot((u - bow) * 3.4, v * 2.6)) * 0.5;
  return clamp01(0.05 + glow + hull);
};

/* -- Zodiacal light: a cone of dust light leaning over as night turns ----- */

const zodiacalLightField: Field = (u, v, t) => {
  const turn = (t * 0.14) % 1;
  const along = clamp01((0.9 - v) / 1.7);
  /* The cone leans further over as the night goes on, and dims with it. */
  const axis = (-0.5 + turn) * along * 1.5;
  const cone = clamp01(1 - Math.abs(u - axis) / (0.75 * (1 - along * 0.7) + 0.12));
  const fade = Math.pow(1 - along, 1.4) * (1 - turn * 0.55);
  let stars = 0;
  for (let star = 0; star < 9; star += 1) {
    const su = -1.55 + hash(star * 3.3) * 3.1;
    const sv = -0.9 + hash(star * 7.1) * 1.5;
    const twinkle = 0.5 + Math.sin(t * 2.4 + star * 1.9) * 0.5;
    stars = Math.max(
      stars,
      clamp01(1 - Math.hypot((u - su) * 7, (v - sv) * 8)) * (0.4 + twinkle * 0.5),
    );
  }
  return clamp01(0.04 + cone * fade * 0.75 + stars + clamp01((v - 0.9) * 4) * 0.3);
};

/* -- Gravitational lens: a source smeared into an arc by a passing mass --- */

const gravLensField: Field = (u, v, t) => {
  const mu = -1.6 + ((t * 0.35) % 3.2);
  const du = (u - mu) * 0.85;
  const radius = Math.hypot(du, v);
  /* Close in, the deflection is strong enough to close the arc into a ring. */
  const strength = 0.34 / Math.max(radius, 0.12);
  const bent = Math.atan2(v, du) + strength * 0.9;
  const arc = Math.pow(clamp01(Math.cos(bent) * 0.5 + 0.5), 1.6);
  const ring =
    clamp01(1 - Math.abs(radius - 0.55) * 4) * (0.25 + arc * 0.75) * clamp01(strength * 1.4);
  const sky = 0.05 + hash2(Math.floor(u * 5), Math.floor(v * 5)) * 0.08;
  return clamp01(sky + ring * 0.9 + clamp01(1 - radius * 5) * 0.5);
};

/* -- Tokamak: a plasma ring pinched and heated in its chamber ------------- */

const tokamakField: Field = (u, v, t) => {
  const major = Math.hypot(u * 0.72, v);
  const wall = Math.abs(major - 0.88);
  const chamber = clamp01(1 - wall * 5) * 0.32;
  /* The field squeezes the ring, and the squeeze is what heats it. */
  const pinch = 0.5 + Math.sin(t * 1.6) * 0.5;
  const plasma = clamp01(1 - Math.abs(major - 0.5) / (0.3 - pinch * 0.12));
  const angle = Math.atan2(v, u * 0.72);
  /* Current runs round the torus, so the bright patch travels with it. */
  const flow = 0.55 + Math.sin(angle * 3 - t * 5) * 0.45;
  const hot = Math.pow(plasma, 0.7) * (0.35 + flow * 0.4 + pinch * 0.3);
  const coil = clamp01(1 - Math.abs(Math.sin(angle * 6)) * 6) * clamp01(1 - wall * 3) * 0.4;
  return clamp01(0.05 + chamber + coil + hot);
};

/* -- Linotype: matrices dropping into a line and the slug cast ------------ */

function paintLinotype(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.45) % 3;
    /* Set the line, cast it, then send the matrices back up to the magazine. */
    const setting = Math.min(cycle, 1);
    const casting = cycle > 1 && cycle < 1.8 ? (cycle - 1) / 0.8 : 0;
    const returning = cycle > 2 ? cycle - 2 : 0;
    for (let x = 0; x <= 24; x += 1) plot(-1.5 + (x / 24) * 3, -0.9, 0.4);
    const placed = Math.floor(setting * 12);
    for (let mat = 0; mat < 12; mat += 1) {
      const mu = -1.35 + mat * 0.22;
      /* The magazine the matrices drop out of, one channel per letter. */
      for (let y = 0; y <= 3; y += 1) plot(mu, -0.88 + (y / 3) * 0.32, 0.3);
      if (mat < placed) {
        for (let y = 0; y <= 3; y += 1) plot(mu, 0.1 + (y / 3) * 0.3, 0.75);
      } else if (mat === placed) {
        /* Only one matrix is ever in flight down the assembler. */
        plot(mu, -0.7 + ((setting * 12) % 1) * 0.8, 0.95);
      }
    }
    for (let y = 0; y <= 6; y += 1) plot(1.4, -0.6 + (y / 6) * 1.2, 0.45);
    if (casting > 0) {
      for (let x = 0; x <= 14; x += 1) {
        plot(-1.3 + (x / 14) * 2.6, 0.62, 0.5 + Math.sin(casting * Math.PI) * 0.5);
      }
      for (let drip = 0; drip < 3; drip += 1) plot(-0.8 + drip * 0.8, 0.62 + casting * 0.2, casting * 0.8);
    }
    if (returning > 0) {
      for (let mat = 0; mat < 6; mat += 1) plot(-1.2 + mat * 0.4, 0.25 - returning * 1.1, 0.6);
    }
  });
}

/* -- Screen print: a squeegee pulling ink through the mesh ---------------- */

function paintScreenPrint(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.5) % 2;
    const pull = Math.min(cycle, 1);
    const lift = cycle < 1 ? 0 : cycle - 1;
    for (let x = 0; x <= 30; x += 1) {
      const u = -1.45 + (x / 30) * 2.9;
      plot(u, -0.75, 0.45);
      plot(u, 0.8, 0.45);
    }
    for (let y = 0; y <= 10; y += 1) {
      plot(-1.45, -0.75 + (y / 10) * 1.55, 0.45);
      plot(1.45, -0.75 + (y / 10) * 1.55, 0.45);
    }
    /* Ink exists only behind the blade, and only inside the stencil. */
    const edge = -1.35 + pull * 2.7;
    for (let x = 0; x <= 40; x += 1) {
      const u = -1.35 + (x / 40) * 2.7;
      if (u > edge) continue;
      for (let y = 0; y <= 8; y += 1) {
        const v = -0.55 + (y / 8) * 1.1;
        if (Math.hypot(u * 0.8, v) < 0.62 || Math.abs(v) < 0.12) plot(u, v, 0.9 - lift * 0.3);
      }
    }
    for (let y = 0; y <= 8; y += 1) plot(edge, -0.7 + (y / 8) * 1.4 - lift * 0.6, 1);
    for (let x = 0; x <= 6; x += 1) plot(edge - 0.24 + (x / 6) * 0.48, -0.72 - lift * 0.6, 0.7);
  });
}

/* -- Guillotine: a blade dropping through a stack of paper ---------------- */

function paintGuillotine(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 2;
    /* Clamp, cut, lift, and push the trimmed stack clear. */
    const drop = cycle < 0.8 ? Math.pow(cycle / 0.8, 2) : cycle < 1.2 ? 1 : 1 - (cycle - 1.2) / 0.8;
    const shove = cycle > 1.2 ? (cycle - 1.2) / 0.8 : 0;
    for (let sheet = 0; sheet < 7; sheet += 1) {
      const sv = 0.72 - sheet * 0.09;
      for (let x = 0; x <= 22; x += 1) {
        const u = -1.3 + (x / 22) * 2.3;
        /* Everything right of the blade line is the offcut, and it moves. */
        if (u > 0.35 && drop > 0.8) plot(u + shove * 0.5, sv, 0.55);
        else plot(u, sv, 0.6);
      }
    }
    const bladeV = -0.85 + drop * 1.35;
    for (let x = 0; x <= 20; x += 1) {
      const f = x / 20;
      plot(-0.55 + f * 1.8, bladeV - f * 0.14, 0.9);
      plot(-0.55 + f * 1.8, bladeV - f * 0.14 - 0.16, 0.6);
    }
    for (let y = 0; y <= 8; y += 1) {
      plot(-1.45, -0.9 + (y / 8) * 1.8, 0.4);
      plot(1.45, -0.9 + (y / 8) * 1.8, 0.4);
    }
    const clampV = -0.5 + Math.min(drop * 2, 1) * 0.9;
    for (let x = 0; x <= 8; x += 1) plot(-1.05 + (x / 8) * 0.8, clampV, 0.75);
  });
}

/* -- Folding machine: sheets creased in half as they pass the rollers ----- */

function paintFoldingMachine(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 2, 0.86, 0.4);
    /* A pile waits at the feed end and the top sheet is drawn off it. */
    for (let sheet = 0; sheet < 5; sheet += 1) {
      for (let x = 0; x <= 8; x += 1) plot(-1.5 + (x / 8) * 0.7, -0.8 + sheet * 0.09, 0.45);
    }
    for (let y = 0; y <= 8; y += 1) plot(-1.15 + (y / 8) * 0.55, -0.34 + (y / 8) * 0.44, 0.35);
    for (let roller = 0; roller < 3; roller += 1) {
      const ru = -0.4 + roller * 0.42;
      const a = t * 4 + roller;
      for (let step = 0; step <= 10; step += 1) {
        const ra = (step / 10) * TAU;
        plot(ru + Math.cos(ra) * 0.16, 0.34 + Math.sin(ra) * 0.15, 0.45);
      }
      plot(ru + Math.cos(a) * 0.11, 0.34 + Math.sin(a) * 0.1, 0.9);
    }
    for (let sheet = 0; sheet < 3; sheet += 1) {
      const along = ((t * 0.6 + sheet / 3) % 1) * 3.6 - 1.8;
      /* A sheet arrives flat, is creased at the rollers, and leaves folded. */
      const fold = clamp01((along + 0.1) * 1.6);
      const half = 0.42 * (1 - fold * 0.5);
      for (let x = 0; x <= 14; x += 1) {
        const f = x / 14;
        plot(along - half + f * half * 2, 0.1 - fold * 0.12 * Math.sin(f * Math.PI), 0.8);
        if (fold > 0.05) plot(along - half + f * half * 2, 0.1 + fold * 0.16, 0.5 + fold * 0.4);
      }
      plot(along + half, 0.1, 0.95);
    }
  });
}

/* -- Saddle stitcher: staples driven into a spine ------------------------- */

function paintSaddleStitcher(t: number): string {
  return paintPlotted((plot) => {
    /* The book rides the saddle and the heads come down on it in turn. */
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.4 + (x / 26) * 2.8;
      plot(u, 0.84 - Math.abs(u) * 0.12, 0.4);
    }
    for (let x = 0; x <= 20; x += 1) {
      const u = -1.2 + (x / 20) * 2.4;
      plot(u, 0.58 + Math.abs(u) * 0.1, 0.65);
      plot(u, 0.44 + Math.abs(u) * 0.1, 0.5);
    }
    for (let head = 0; head < 2; head += 1) {
      const hu = -0.5 + head;
      const beat = (t * 0.9 + head * 0.5) % 1;
      const strike = beat < 0.4 ? Math.pow(beat / 0.4, 2) : 1 - (beat - 0.4) / 0.6;
      const hv = -0.88 + strike * 1.16;
      for (let y = 0; y <= 7; y += 1) plot(hu, hv - 0.7 + (y / 7) * 0.7, 0.6);
      for (let x = 0; x <= 4; x += 1) plot(hu - 0.14 + (x / 4) * 0.28, hv, 0.9);
      /* A staple stays behind once the head has been all the way down. */
      if (beat > 0.4) for (let x = 0; x <= 3; x += 1) plot(hu - 0.1 + (x / 3) * 0.2, 0.48, 1);
    }
  });
}

/* -- Ink fountain: rollers splitting a film of ink between them ----------- */

function paintInkFountain(t: number): string {
  return paintPlotted((plot) => {
    const spin = t * 3;
    for (let roller = 0; roller < 3; roller += 1) {
      const ru = -0.9 + roller * 0.9;
      const rv = -0.25 + (roller % 2) * 0.5;
      const size = 0.34 - roller * 0.04;
      for (let step = 0; step <= 26; step += 1) {
        const a = (step / 26) * TAU;
        /* Ink carried round shows as a bright patch that never stops moving. */
        const carried = Math.pow(clamp01(Math.cos(a - spin * (roller % 2 ? -1 : 1))), 2);
        plot(ru + Math.cos(a) * size * 1.1, rv + Math.sin(a) * size, 0.35 + carried * 0.6);
      }
    }
    /* Where two rollers meet the film splits into threads. */
    for (let nip = 0; nip < 2; nip += 1) {
      const nu = -0.45 + nip * 0.9;
      for (let thread = 0; thread < 5; thread += 1) {
        const f = thread / 4;
        const stretch = 0.5 + Math.sin(t * 6 + thread * 1.3 + nip) * 0.5;
        plot(nu + (f - 0.5) * 0.16, 0.02 + (f - 0.5) * 0.5 * stretch, 0.4 + stretch * 0.5);
      }
    }
    for (let x = 0; x <= 20; x += 1) plot(-1.5 + (x / 20) * 3, 0.85, 0.45);
    for (let drop = 0; drop < 3; drop += 1) {
      const life = (t * 0.8 + drop / 3) % 1;
      plot(-0.9 + drop * 0.9, 0.2 + life * 0.6, (1 - life) * 0.7);
    }
  });
}

/* -- Paper reel: a web unwinding off a reel that is running down ---------- */

function paintPaperReel(t: number): string {
  return paintPlotted((plot) => {
    /* The reel loses diameter as it runs, so it has to turn faster to keep
       the web at the same speed. */
    const size = 0.62 - ((t * 0.12) % 1) * 0.34;
    const spin = t * (1.6 / size);
    for (let step = 0; step <= 34; step += 1) {
      const a = (step / 34) * TAU;
      plot(-1 + Math.cos(a) * size * 1.05, -0.05 + Math.sin(a) * size, 0.4);
    }
    for (let spoke = 0; spoke < 4; spoke += 1) {
      const a = spin + (spoke / 4) * TAU;
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(-1 + Math.cos(a) * size * f * 1.05, -0.05 + Math.sin(a) * size * f, 0.7);
      }
    }
    /* The web is under tension, so it hangs in a shallow catenary. */
    const sag = 0.2 + Math.sin(t * 1.4) * 0.16;
    for (let x = 0; x <= 34; x += 1) {
      const f = x / 34;
      plot(-1 + size * 1.05 + f * (2.4 - size), -0.05 + size + Math.sin(f * Math.PI) * sag, 0.75);
    }
    for (let y = 0; y <= 6; y += 1) plot(1.42, -0.5 + (y / 6) * 1.1, 0.45);
  });
}

/* -- Pinking shears: a zigzag cut running along the cloth ----------------- */

function paintPinkingShears(t: number): string {
  return paintPlotted((plot) => {
    const cut = -1.4 + ((t * 0.35) % 1) * 2.9;
    for (let x = 0; x <= 40; x += 1) {
      const u = -1.45 + (x / 40) * 2.9;
      /* Ahead of the shears the edge is straight; behind them it is pinked. */
      const edge = u < cut ? -0.3 + (Math.abs(((u * 7) % 1) - 0.5) - 0.25) * 0.32 : -0.3;
      plot(u, edge, u < cut ? 0.85 : 0.55);
      for (let y = 0; y <= 8; y += 1) plot(u, edge + 0.08 + (y / 8) * 0.86, 0.3);
      plot(u, 0.9, 0.4);
    }
    const bite = (Math.sin(t * 9) * 0.5 + 0.5) * 0.3;
    for (const side of [-1, 1] as const) {
      for (let step = 0; step <= 12; step += 1) {
        const f = step / 12;
        plot(cut - f * 0.9, -0.3 + side * (0.06 + bite) * (0.3 + f), 0.9);
      }
      for (let step = 0; step <= 8; step += 1) {
        plot(cut - 0.9 - (step / 8) * 0.35, -0.3 + side * (0.28 + bite * 0.4), 0.6);
      }
    }
  });
}

/* -- Buttonhole: a bar tack working its way round a slot ------------------ */

function paintButtonhole(t: number): string {
  return paintPlotted((plot) => {
    const worked = (t * 0.28) % 1;
    for (let x = 0; x <= 30; x += 1) {
      const u = -1.5 + (x / 30) * 3;
      plot(u, -0.85, 0.3);
      plot(u, 0.85, 0.3);
    }
    /* The slot is fixed; what travels is the stitch going round it. */
    const outline = (f: number): readonly [number, number] => {
      const a = f * TAU;
      return [Math.cos(a) * 0.55, Math.sin(a) * 0.22];
    };
    for (let step = 0; step <= 46; step += 1) {
      const [su, sv] = outline(step / 46);
      plot(su, sv, 0.35);
    }
    for (let step = 0; step <= 46; step += 1) {
      const f = step / 46;
      if (f > worked) break;
      const [su, sv] = outline(f);
      plot(su * 1.16, sv + Math.sign(sv || 1) * 0.16, worked - f < 0.08 ? 0.95 : 0.55);
    }
    const [nu, nv] = outline(worked);
    const stab = Math.abs(Math.sin(t * 12));
    for (let y = 0; y <= 6; y += 1) plot(nu, nv - 0.9 + (y / 6) * (0.7 + stab * 0.18), 0.75);
    plot(nu, nv - 0.16 + stab * 0.14, 1);
  });
}

/* -- Steam press: the head down on the cloth and a burst let go ----------- */

function paintSteamPress(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 2;
    const down = cycle < 0.7 ? cycle / 0.7 : cycle < 1.2 ? 1 : clamp01(1 - (cycle - 1.2) / 0.8);
    const burst = cycle > 0.7 && cycle < 1.2 ? 1 - (cycle - 0.7) / 0.5 : 0;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.3 + (x / 26) * 2.6;
      plot(u, 0.6, 0.55);
      /* The cloth flattens under the head instead of staying rumpled. */
      plot(u, 0.44 - Math.sin(u * 6 + 1) * 0.07 * (1 - down), 0.7);
    }
    const headV = -0.6 + down * 0.9;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.3 + (x / 26) * 2.6;
      plot(u, headV, 0.8);
      plot(u, headV - 0.16, 0.5);
    }
    /* The frame the head hangs off runs the full height of the machine. */
    for (let y = 0; y <= 14; y += 1) plot(-1.42, -0.92 + (y / 14) * 1.72, 0.45);
    for (let x = 0; x <= 10; x += 1) plot(-1.42 + (x / 10) * 0.9, -0.92, 0.4);
    for (let jet = 0; jet < 9; jet += 1) {
      const life = (t * 2.4 + hash(jet)) % 1;
      const side = jet % 2 === 0 ? -1 : 1;
      plot(side * (1 + life * 0.5), headV + 0.1 - life * 0.4, burst * (1 - life) * 0.9);
    }
  });
}

/* -- Tape measure: a tape drawn out and let go to snap back --------------- */

function paintTapeMeasure(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 1;
    /* Drawn out steadily, then released: the return is over in a moment. */
    const out = cycle < 0.75 ? cycle / 0.75 : 1 - Math.pow((cycle - 0.75) / 0.25, 0.55);
    const reach = -1.2 + out * 2.6;
    for (let step = 0; step <= 20; step += 1) {
      const a = (step / 20) * TAU;
      plot(-1.25 + Math.cos(a) * 0.3, -0.05 + Math.sin(a) * 0.28, 0.45);
    }
    for (let spoke = 0; spoke < 3; spoke += 1) {
      const a = -out * 9 + (spoke / 3) * TAU;
      plot(-1.25 + Math.cos(a) * 0.18, -0.05 + Math.sin(a) * 0.17, 0.85);
    }
    for (let x = 0; x <= 44; x += 1) {
      const f = x / 44;
      const u = -1.2 + f * (reach + 1.2);
      /* A tape that is out a long way loses its curl and starts to droop. */
      const droop = Math.pow(f, 2.2) * out * 0.5;
      plot(u, -0.2 + droop, 0.8);
      if (((u + 1.2) * 6) % 1 < 0.18) plot(u, -0.32 + droop, 0.6);
    }
    for (let y = 0; y <= 4; y += 1) plot(reach, -0.34 + out * 0.5 + (y / 4) * 0.24, 0.95);
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.88, 0.4);
  });
}

/* -- Zip: a slider closing the teeth one pair at a time ------------------- */

function paintZipPull(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 2;
    const slider = -1.35 + (cycle < 1 ? cycle : 2 - cycle) * 2.7;
    for (let tooth = 0; tooth < 22; tooth += 1) {
      const u = -1.35 + (tooth / 21) * 2.7;
      /* Behind the slider the two sides interlock; ahead they fall apart. */
      const gap = 0.06 + clamp01((u - slider) * 1.4) * 0.42 + (tooth % 2) * 0.05;
      plot(u, -gap, 0.85);
      plot(u, gap, 0.85);
      for (let y = 0; y <= 4; y += 1) {
        plot(u, -gap - 0.12 - (y / 4) * 0.55, 0.3);
        plot(u, gap + 0.12 + (y / 4) * 0.55, 0.3);
      }
    }
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * TAU;
      plot(slider + Math.cos(a) * 0.16, Math.sin(a) * 0.2, 0.95);
    }
    const swing = Math.sin(t * 5) * 0.25;
    for (let y = 0; y <= 5; y += 1) {
      plot(slider + Math.sin(swing) * (y / 5) * 0.4, 0.2 + (y / 5) * 0.4, 0.7);
    }
  });
}

/* -- Dress form: a form turning with cloth pinned round it ---------------- */

function paintDressForm(t: number): string {
  return paintPlotted((plot) => {
    const turn = t * 0.9;
    /* Wide at the shoulder, in at the waist, out again at the hip: that is
       all it takes for the outline to read as a torso. */
    const widthAt = (f: number) => 0.45 + Math.cos(f * TAU) * 0.12 + f * 0.05;
    for (let y = 0; y <= 26; y += 1) {
      const f = y / 26;
      const v = -0.75 + f * 1.5;
      const width = widthAt(f);
      for (const side of [-1, 1] as const) {
        plot(side * width, v, 0.4 + clamp01(Math.cos(turn + (side > 0 ? 0 : Math.PI))) * 0.4);
      }
      /* One seam wraps the form, and it is the seam that shows the turn. */
      const a = turn + f * 1.4;
      plot(Math.sin(a) * width, v, 0.45 + Math.pow(clamp01(Math.cos(a)), 2) * 0.55);
    }
    for (let y = 0; y <= 5; y += 1) plot(0, 0.75 + (y / 5) * 0.18, 0.5);
    for (let x = 0; x <= 8; x += 1) plot(-0.24 + (x / 8) * 0.48, 0.93, 0.55);
    for (let pin = 0; pin < 5; pin += 1) {
      const f = 0.15 + pin * 0.17;
      const a = turn + f * 1.4 + 0.5;
      plot(Math.sin(a) * widthAt(f), -0.75 + f * 1.5, 0.4 + Math.pow(clamp01(Math.cos(a)), 3) * 0.6);
    }
  });
}

/* -- Car lift: a car taken up on a two-post lift -------------------------- */

function paintCarLift(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.25) % 2;
    const raise = cycle < 1 ? cycle : 2 - cycle;
    const lift = raise * raise * (3 - 2 * raise) * 0.9;
    for (const side of [-1, 1] as const) {
      for (let y = 0; y <= 12; y += 1) plot(side * 1.3, 0.9 - (y / 12) * 1.8, 0.4);
      for (let x = 0; x <= 6; x += 1) plot(side * (1.3 - (x / 6) * 0.5), 0.55 - lift, 0.6);
    }
    const bodyV = 0.4 - lift;
    for (let x = 0; x <= 30; x += 1) {
      const f = x / 30;
      /* A roof that dips at both ends, so it reads as a car and not a box. */
      plot(-1.05 + f * 2.1, bodyV, 0.8);
      if (f > 0.2 && f < 0.8) plot(-1.05 + f * 2.1, bodyV - 0.3 - Math.sin(f * Math.PI) * 0.22, 0.7);
    }
    for (const wheel of [-0.62, 0.62] as const) {
      for (let step = 0; step <= 12; step += 1) {
        const a = (step / 12) * TAU;
        plot(wheel + Math.cos(a) * 0.2, bodyV + 0.16 + Math.sin(a) * 0.18, 0.6);
      }
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.92, 0.35);
    /* Somebody is under there as soon as there is room to be. */
    if (lift > 0.45) {
      const wave = Math.sin(t * 6) * 0.1;
      for (let y = 0; y <= 4; y += 1) plot(0.1 + wave * (y / 4), 0.9 - (y / 4) * 0.4, 0.7);
    }
  });
}

/* -- Tyre change: nuts off, the wheel swapped, nuts back on --------------- */

function paintTyreChange(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 3;
    const loosen = Math.min(cycle, 1);
    const swap = cycle > 1 ? Math.min(cycle - 1, 1) : 0;
    const tighten = cycle > 2 ? cycle - 2 : 0;
    for (let step = 0; step <= 14; step += 1) {
      const a = (step / 14) * TAU;
      plot(-0.5 + Math.cos(a) * 0.16, Math.sin(a) * 0.15, 0.6);
    }
    for (let nut = 0; nut < 5; nut += 1) {
      const a = (nut / 5) * TAU + t * 0.4;
      /* Nuts come off one at a time and go into the tray below. */
      const off = clamp01(loosen * 5 - nut) * (1 - tighten);
      plot(-0.5 + Math.cos(a) * 0.32 - off * 0.2, Math.sin(a) * 0.3 + off * 0.9, 0.9 - off * 0.3);
    }
    /* The old wheel rolls out to the right as the new one comes in. */
    for (const [wu, weight] of [[-0.5 + swap * 2.2, 0.55], [1.6 - swap * 2.1, 0.85]] as const) {
      for (let step = 0; step <= 20; step += 1) {
        const a = (step / 20) * TAU;
        plot(wu + Math.cos(a) * 0.42, Math.sin(a) * 0.4, weight);
        plot(wu + Math.cos(a) * 0.24, Math.sin(a) * 0.23, weight * 0.7);
      }
      for (let spoke = 0; spoke < 4; spoke += 1) {
        const a = (wu + 0.5) * 4 + (spoke / 4) * TAU;
        plot(wu + Math.cos(a) * 0.32, Math.sin(a) * 0.3, weight);
      }
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.86, 0.35);
    const working = loosen < 1 || tighten > 0;
    for (let x = 0; x <= 6; x += 1) {
      plot(-1.35 + (x / 6) * 0.5, 0.3 - (working ? Math.abs(Math.sin(t * 8)) * 0.1 : 0), 0.7);
    }
  });
}

/* -- Wheel balancer: a wheel spun up and left to find its heavy spot ------ */

function paintWheelBalancer(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 2;
    const coast = cycle < 1 ? 1 : clamp01(1 - (cycle - 1) * 1.6);
    const angle = t * 9 * (0.3 + coast * 0.7) + Math.sin(cycle) * 0.4;
    for (let step = 0; step <= 30; step += 1) {
      const a = (step / 30) * TAU;
      plot(Math.cos(a) * 0.78, Math.sin(a) * 0.74, 0.45);
      plot(Math.cos(a) * 0.3, Math.sin(a) * 0.28, 0.4);
    }
    for (let spoke = 0; spoke < 5; spoke += 1) {
      const a = angle + (spoke / 5) * TAU;
      for (let step = 2; step <= 8; step += 1) {
        const f = step / 8;
        /* Spokes wash out while it is spinning and sharpen as it slows. */
        plot(Math.cos(a) * 0.78 * f, Math.sin(a) * 0.74 * f, 0.35 + (1 - coast) * 0.4);
      }
    }
    /* The heavy spot is marked, and the weight goes on opposite it. */
    const heavy = angle + 0.6;
    plot(Math.cos(heavy) * 0.7, Math.sin(heavy) * 0.66, 1);
    plot(Math.cos(heavy + Math.PI) * 0.7, Math.sin(heavy + Math.PI) * 0.66, 0.55 + (1 - coast) * 0.45);
    for (let y = 0; y <= 8; y += 1) plot(-1.5, -0.8 + (y / 8) * 1.6, 0.4);
    for (let x = 0; x <= 5; x += 1) plot(-1.5 + (x / 5) * 0.55, 0, 0.5);
    for (let bar = 0; bar < 6; bar += 1) {
      const height = clamp01((1 - coast) * 1.4 - bar * 0.12);
      plot(1.15 + bar * 0.07, 0.8 - height * 0.5, 0.3 + height * 0.7);
    }
  });
}

/* -- Engine hoist: an engine lifted out of the bay on a chain ------------- */

function paintEngineHoist(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.22) % 2;
    const up = cycle < 1 ? cycle : 2 - cycle;
    const hook = 0.35 - up * up * (3 - 2 * up) * 1;
    /* The load swings while it is moving and settles when it stops. */
    const swing = Math.sin(t * 2.2) * 0.16 * Math.sin(up * Math.PI);
    for (let x = 0; x <= 22; x += 1) plot(-1.35 + (x / 22) * 2.4, -0.88, 0.45);
    for (let y = 0; y <= 12; y += 1) {
      plot(-1.35 + (y / 12) * 0.3, -0.88 + (y / 12) * 1.76, 0.4);
      plot(1.05 - (y / 12) * 0.3, -0.88 + (y / 12) * 1.76, 0.4);
    }
    for (let link = 0; link <= 10; link += 1) {
      const f = link / 10;
      plot(0.2 + swing * f, -0.85 + f * (hook + 0.85), link % 2 === 0 ? 0.75 : 0.45);
    }
    const eu = 0.2 + swing;
    for (let x = 0; x <= 12; x += 1) {
      const f = x / 12;
      plot(eu - 0.34 + f * 0.68, hook, 0.85);
      plot(eu - 0.34 + f * 0.68, hook + 0.42, 0.7);
    }
    for (let y = 0; y <= 6; y += 1) {
      plot(eu - 0.34, hook + (y / 6) * 0.42, 0.7);
      plot(eu + 0.34, hook + (y / 6) * 0.42, 0.7);
    }
    for (let pipe = 0; pipe < 3; pipe += 1) {
      plot(eu - 0.2 + pipe * 0.2, hook - 0.16 - Math.abs(Math.sin(t + pipe)) * 0.06, 0.6);
    }
    /* The bay it came out of stays open underneath it. */
    for (let x = 0; x <= 16; x += 1) plot(-1 + (x / 16), 0.7, 0.5);
  });
}

/* -- Oil drain: the plug out and the sump running into a pan -------------- */

function paintOilDrain(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.16) % 1;
    /* A hard stream first, then a thread, and finally only drips. */
    const flow = clamp01(1 - cycle * 1.5);
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.3 + (x / 26) * 2.6;
      plot(u, -0.6, 0.55);
      plot(u, -0.36 + Math.abs(u) * 0.06, 0.4);
    }
    if (flow > 0.15) {
      for (let step = 0; step <= 18; step += 1) {
        const f = step / 18;
        const spread = f * f * (1 - flow) * 0.3;
        plot(0.1 + Math.sin(t * 9 + f * 6) * 0.03 + spread, -0.34 + f, 0.5 + flow * 0.5);
      }
    } else {
      const life = (t * 1.6) % 1;
      plot(0.1, -0.3 + life * 0.9, 1 - life * 0.4);
    }
    /* The pan fills at the same rate the stream falls off. */
    const level = 0.72 - Math.min(cycle * 0.34, 0.3);
    for (let x = 0; x <= 20; x += 1) {
      const u = -0.6 + (x / 20) * 1.4;
      plot(u, 0.78, 0.5);
      plot(u, level + Math.sin(u * 7 + t * 5) * 0.02, 0.85);
    }
    for (let y = 0; y <= 4; y += 1) {
      plot(-0.62, 0.78 - (y / 4) * 0.24, 0.5);
      plot(0.78, 0.78 - (y / 4) * 0.24, 0.5);
    }
    plot(-0.5, -0.28 + Math.min(cycle * 4, 1) * 0.9, 0.8);
  });
}

/* -- Spray booth: a gun laying paint in overlapping passes ---------------- */

function paintSprayBooth(t: number): string {
  return paintPlotted((plot) => {
    const pass = (t * 0.45) % 2;
    const outbound = pass < 1;
    const gu = -1.25 + (outbound ? pass : 2 - pass) * 2.5;
    const row = Math.floor(((t * 0.45) % 8) / 2);
    const gv = -0.62 + row * 0.42;
    for (let x = 0; x <= 26; x += 1) {
      const u = -1.2 + (x / 26) * 2.4;
      plot(u, -0.86, 0.4);
      plot(u, 0.88, 0.4);
      /* Coverage builds behind the gun, band by band down the panel. */
      for (let band = 0; band <= row; band += 1) {
        if (band < row || (outbound ? u < gu : u > gu)) plot(u, -0.62 + band * 0.42, 0.55);
      }
    }
    for (let y = 0; y <= 10; y += 1) {
      plot(-1.2, -0.86 + (y / 10) * 1.74, 0.4);
      plot(1.2, -0.86 + (y / 10) * 1.74, 0.4);
    }
    for (let drop = 0; drop < 16; drop += 1) {
      const f = hash(drop);
      plot(gu + (hash(drop * 3.1) - 0.5) * 0.5 * f, gv - 0.34 + f * 0.34, 0.4 + (1 - f) * 0.6);
    }
    for (let y = 0; y <= 5; y += 1) plot(gu, gv - 0.9 + (y / 5) * 0.5, 0.7);
    plot(gu, gv - 0.36, 1);
  });
}

/* -- Jump start: the leads on, a spark, and the engine catching ----------- */

function paintJumpStart(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 3;
    const cranking = cycle > 1 && cycle < 2;
    for (const side of [-1, 1] as const) {
      for (let y = 0; y <= 8; y += 1) plot(side * 1.15, -0.1 + (y / 8) * 0.7, 0.5);
      for (let x = 0; x <= 8; x += 1) plot(side * 1.15 - 0.28 + (x / 8) * 0.56, -0.1, 0.55);
      for (let post = 0; post < 2; post += 1) plot(side * 1.15 - 0.16 + post * 0.32, -0.22, 0.75);
    }
    /* The leads never hang quite still, and they shiver hard once the starter
       is pulling current through them. */
    for (let lead = 0; lead < 2; lead += 1) {
      for (let x = 0; x <= 26; x += 1) {
        const f = x / 26;
        const shiver = Math.sin(t * (cranking ? 30 : 2.2) + f * 12) * (cranking ? 0.03 : 0.015);
        plot(-1 + f * 2, lead * 0.16 - 0.4 + Math.sin(f * Math.PI) * 0.34 + shiver, lead === 0 ? 0.7 : 0.45);
      }
    }
    if (cycle > 0.8 && cycle < 1.1) {
      for (let spark = 0; spark < 6; spark += 1) {
        const a = hash(spark + Math.floor(t * 20)) * TAU;
        plot(-1 + Math.cos(a) * 0.2, -0.2 + Math.sin(a) * 0.18, 1);
      }
    }
    const revs = cycle >= 2 ? 1 : cranking ? 0.35 : 0;
    for (let step = 0; step <= 16; step += 1) {
      const a = (step / 16) * TAU;
      plot(Math.cos(a) * 0.3, 0.6 + Math.sin(a) * 0.26, 0.4);
    }
    const needle = -2.2 + revs * 2.4 + (cranking ? Math.sin(t * 18) * 0.4 : 0);
    for (let step = 0; step <= 6; step += 1) {
      const f = step / 6;
      plot(Math.cos(needle) * 0.26 * f, 0.6 + Math.sin(needle) * 0.24 * f, 0.9);
    }
  });
}

/* -- Waltzer: cars spinning free on a rolling floor ----------------------- */

function paintWaltzer(t: number): string {
  return paintPlotted((plot) => {
    const carry = t * 0.9;
    for (let step = 0; step <= 40; step += 1) {
      const a = (step / 40) * TAU;
      /* The track is a ring that rises and falls, and the cars follow it. */
      plot(Math.cos(a) * 1.25, Math.sin(a) * 0.52 + Math.sin(a * 3) * 0.12, 0.35);
    }
    for (let car = 0; car < 5; car += 1) {
      const a = carry + (car / 5) * TAU;
      const cu = Math.cos(a) * 1.25;
      const cv = Math.sin(a) * 0.52 + Math.sin(a * 3) * 0.12;
      const near = 0.45 + clamp01(Math.sin(a) * 0.5 + 0.5) * 0.5;
      for (let step = 0; step <= 10; step += 1) {
        const ca = (step / 10) * TAU;
        plot(cu + Math.cos(ca) * 0.2, cv + Math.sin(ca) * 0.18, near * 0.7);
      }
      /* Each car also spins on its own pin, hardest where the track drops. */
      const own = t * (2.4 + car) + Math.sin(a * 3) * 3;
      plot(cu + Math.cos(own) * 0.13, cv + Math.sin(own) * 0.12, near);
    }
  });
}

/* -- Swing boat: a boat pushed higher on every pass ----------------------- */

function paintSwingBoat(t: number): string {
  return paintPlotted((plot) => {
    /* The arc builds over a run of passes, then the ride is brought down. */
    const angle = Math.sin(t * 1.7) * (0.35 + Math.abs(Math.sin(t * 0.12)) * 1.05);
    const pivotV = -0.82;
    for (let y = 0; y <= 8; y += 1) {
      plot(-0.5 - (y / 8) * 0.7, 0.9 - (y / 8) * 1.7, 0.4);
      plot(0.5 + (y / 8) * 0.7, 0.9 - (y / 8) * 1.7, 0.4);
    }
    const bu = Math.sin(angle) * 1.35;
    const bv = pivotV + Math.cos(angle) * 1.35;
    for (let step = 0; step <= 12; step += 1) {
      const f = step / 12;
      plot(bu * f, pivotV + (bv - pivotV) * f, 0.5);
    }
    for (let x = 0; x <= 12; x += 1) {
      const f = x / 12 - 0.5;
      const ru = bu + f * 0.62 * Math.cos(angle);
      const rv = bv - f * 0.62 * Math.sin(angle);
      plot(ru, rv, 0.85);
      plot(ru - Math.sin(angle) * 0.18, rv - Math.cos(angle) * 0.18, 0.6);
    }
    for (let rider = 0; rider < 2; rider += 1) {
      const f = -0.2 + rider * 0.4;
      plot(
        bu + f * 0.62 * Math.cos(angle) + Math.sin(angle) * 0.22,
        bv - f * 0.62 * Math.sin(angle) - Math.cos(angle) * 0.22,
        0.95,
      );
    }
  });
}

/* -- Helter skelter: a mat spiralling down the outside of the tower ------- */

function paintHelterSkelter(t: number): string {
  return paintPlotted((plot) => {
    /* The slide is a helix; only its front half faces us, so the back of
       each turn stays dim and the shape reads as round. */
    for (let step = 0; step <= 120; step += 1) {
      const f = step / 120;
      const a = f * 8 - t * 0.4;
      plot(
        Math.cos(a) * (0.18 + f * 0.72),
        -0.85 + f * 1.7 - Math.sin(a) * 0.06,
        0.25 + clamp01(Math.sin(a)) * 0.4,
      );
    }
    for (let y = 0; y <= 16; y += 1) plot(0, -0.9 + (y / 16) * 1.75, 0.35);
    for (let flag = 0; flag < 3; flag += 1) plot(Math.sin(t * 2 + flag) * 0.14, -0.95 + flag * 0.05, 0.7);
    const ride = (t * 0.35) % 1;
    const ra = ride * 8 - t * 0.4;
    const ru = Math.cos(ra) * (0.18 + ride * 0.72);
    const rv = -0.85 + ride * 1.7 - Math.sin(ra) * 0.06;
    plot(ru, rv, 0.4 + clamp01(Math.sin(ra)) * 0.6);
    plot(ru, rv - 0.14, 0.35 + clamp01(Math.sin(ra)) * 0.55);
  });
}

/* -- Coconut shy: balls thrown at coconuts on their posts ----------------- */

function paintCoconutShy(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.88, 0.35);
    const attempt = (t * 0.55) % 1;
    const target = Math.floor((t * 0.55) % 5);
    for (let post = 0; post < 5; post += 1) {
      const pu = -1.1 + post * 0.55;
      for (let y = 0; y <= 10; y += 1) plot(pu, 0.85 - (y / 10) * 1.05, 0.45);
      /* A hit coconut leaves its post and is not back until its turn again. */
      const hit = post === target && attempt > 0.55;
      const knock = hit ? (attempt - 0.55) / 0.45 : 0;
      for (let step = 0; step <= 8; step += 1) {
        const a = (step / 8) * TAU;
        plot(
          pu + knock * 0.7 + Math.cos(a) * 0.13,
          -0.3 + knock * knock * 1.1 + Math.sin(a) * 0.12,
          hit ? 0.6 : 0.8,
        );
      }
    }
    if (attempt < 0.6) {
      const f = attempt / 0.6;
      plot(-1.45 + f * (2.55 + target * 0.55), 0.45 - Math.sin(f * Math.PI) * 0.9, 1);
    }
    for (let y = 0; y <= 8; y += 1) plot(-1.45, 0.88 - (y / 8) * 1.1, 0.5);
  });
}

/* -- Hook a duck: ducks going round and a hook dipping for one ------------ */

function paintHookADuck(t: number): string {
  return paintPlotted((plot) => {
    for (let step = 0; step <= 40; step += 1) {
      const a = (step / 40) * TAU;
      plot(Math.cos(a) * 1.2, 0.35 + Math.sin(a) * 0.42, 0.3);
    }
    const cycle = (t * 0.4) % 1;
    /* The hook dips once a cycle, and lifts whichever duck is under it. */
    const dip = cycle < 0.5 ? Math.sin(cycle * 2 * Math.PI) : 0;
    const lifted = cycle > 0.5 ? (cycle - 0.5) / 0.5 : 0;
    for (let duck = 0; duck < 6; duck += 1) {
      const a = t * 0.7 + (duck / 6) * TAU;
      const bob = Math.sin(t * 3 + duck) * 0.03;
      const du = Math.cos(a) * 1.2 * (duck === 0 ? 1 - lifted : 1) + (duck === 0 ? 0.9 * lifted : 0);
      const dv = 0.35 + Math.sin(a) * 0.42 - (duck === 0 ? lifted * 1.1 : 0) + bob;
      plot(du, dv, 0.85);
      plot(du + 0.1, dv - 0.09, 0.7);
      plot(du - 0.12, dv + 0.02, 0.5);
    }
    const hv = -0.9 + dip;
    for (let y = 0; y <= 8; y += 1) plot(0.9, -0.95 + (y / 8) * (hv + 0.95), 0.55);
    plot(0.9, hv, 0.95);
    plot(0.82, hv + 0.06, 0.8);
  });
}

/* -- Strength tester: the puck sent up the tower at the bell -------------- */

function paintStrengthTester(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.4) % 2;
    /* Wind up, strike, and the puck carries as far as the blow was worth. */
    const power = 0.45 + hash(Math.floor((t * 0.4) / 2)) * 0.6;
    const flight = cycle < 1 ? Math.sin(cycle * Math.PI) * power : 0;
    for (let y = 0; y <= 18; y += 1) {
      const v = 0.9 - (y / 18) * 1.8;
      plot(0.55, v, 0.4);
      plot(0.95, v, 0.4);
      if (y % 3 === 0) plot(0.75, v, 0.3);
    }
    for (let x = 0; x <= 6; x += 1) plot(0.55 + (x / 6) * 0.4, 0.82 - flight * 1.7, 0.95);
    /* The bell only rings if the puck actually gets all the way to it. */
    const rung = flight > 0.94;
    for (let step = 0; step <= 12; step += 1) {
      const a = (step / 12) * Math.PI;
      plot(0.75 + Math.cos(a) * 0.22, -0.86 + Math.sin(a) * 0.12, rung ? 1 : 0.5);
    }
    if (rung) {
      for (let ring = 0; ring < 4; ring += 1) {
        const spread = 0.3 + ring * 0.16;
        plot(0.75 - spread, -0.86 - 0.06 * ring, 0.8 - ring * 0.15);
        plot(0.75 + spread, -0.86 - 0.06 * ring, 0.8 - ring * 0.15);
      }
    }
    const swing = cycle < 1 ? Math.sin(cycle * Math.PI * 0.9 - 1.2) : -0.9;
    for (let step = 0; step <= 10; step += 1) {
      const f = step / 10;
      plot(-0.7 + Math.cos(swing) * f * 0.9, 0.55 - Math.sin(swing) * f * 0.9, 0.6);
    }
    for (let x = 0; x <= 8; x += 1) {
      plot(-0.9 + Math.cos(swing) * 0.9 + (x / 8) * 0.3, 0.55 - Math.sin(swing) * 0.9, 0.85);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.9, 0.35);
  });
}

/* -- Ghost train: a car pushing through the doors into the dark ----------- */

function paintGhostTrain(t: number): string {
  return paintPlotted((plot) => {
    const cu = -1.5 + ((t * 0.32) % 1) * 3.1;
    /* Two sets of doors: one to go in by, one to come back out of. */
    for (const door of [-0.55, 0.75] as const) {
      const open = clamp01(1 - Math.abs(cu - door) * 3.2);
      for (let y = 0; y <= 10; y += 1) {
        const v = 0.75 - (y / 10) * 1.4;
        plot(door - 0.3 - open * 0.28, v, 0.55);
        plot(door + 0.3 + open * 0.28, v, 0.55);
      }
      for (let x = 0; x <= 6; x += 1) plot(door - 0.3 + (x / 6) * 0.6, -0.65, 0.45);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.8, 0.4);
    for (let x = 0; x <= 12; x += 1) {
      const f = x / 12;
      plot(cu - 0.3 + f * 0.6, 0.6, 0.85);
      plot(cu - 0.3 + f * 0.6, 0.24, 0.7);
    }
    for (let y = 0; y <= 4; y += 1) {
      plot(cu - 0.3, 0.24 + (y / 4) * 0.36, 0.7);
      plot(cu + 0.3, 0.24 + (y / 4) * 0.36, 0.7);
    }
    plot(cu + 0.34, 0.42, 1);
    /* Something leans out of the dark whenever the car is between doors. */
    if (cu > -0.2 && cu < 0.5) {
      const lean = Math.sin(t * 5) * 0.1;
      for (let y = 0; y <= 5; y += 1) plot(0.15 + lean, -0.5 + (y / 5) * 0.5, 0.6 + Math.abs(lean) * 3);
      plot(0.15 + lean, -0.58, 0.95);
    }
  });
}

/* -- Teacups: cups turning on saucers on a turning floor ------------------ */

function paintTeacups(t: number): string {
  return paintPlotted((plot) => {
    const floor = t * 0.55;
    for (let step = 0; step <= 40; step += 1) {
      const a = (step / 40) * TAU;
      plot(Math.cos(a) * 1.35, Math.sin(a) * 0.6, 0.3);
    }
    for (let saucer = 0; saucer < 3; saucer += 1) {
      const a = floor + (saucer / 3) * TAU;
      const su = Math.cos(a) * 0.85;
      const sv = Math.sin(a) * 0.38;
      const near = clamp01(Math.sin(a) * 0.5 + 0.5);
      for (let step = 0; step <= 16; step += 1) {
        const sa = (step / 16) * TAU;
        plot(su + Math.cos(sa) * 0.42, sv + Math.sin(sa) * 0.19, 0.25 + near * 0.25);
      }
      /* Each saucer turns against the floor, and each cup again on that. */
      for (let cup = 0; cup < 2; cup += 1) {
        const ca = -floor * 1.8 + saucer * 2 + cup * Math.PI;
        const cu = su + Math.cos(ca) * 0.26;
        const cv = sv + Math.sin(ca) * 0.12;
        for (let step = 0; step <= 8; step += 1) {
          const ba = (step / 8) * TAU;
          plot(cu + Math.cos(ba) * 0.14, cv + Math.sin(ba) * 0.1, 0.35 + near * 0.4);
        }
        const spin = t * 2.6 + saucer + cup;
        plot(cu + Math.cos(spin) * 0.16, cv + Math.sin(spin) * 0.11, 0.5 + near * 0.5);
      }
    }
  });
}

/* -- Stage curtain: the house tabs going out and coming back in ----------- */

function paintStageCurtain(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.24) % 2;
    const open = cycle < 1 ? cycle : 2 - cycle;
    const eased = open * open * (3 - 2 * open);
    for (let x = 0; x <= 32; x += 1) plot(-1.6 + (x / 32) * 3.2, -0.92, 0.5);
    for (const side of [-1, 1] as const) {
      const edge = side * (0.05 + eased * 1.5);
      for (let fold = 0; fold < 6; fold += 1) {
        const f = fold / 5;
        const fu = edge - side * f * (1.6 - eased * 1.3);
        for (let y = 0; y <= 12; y += 1) {
          const v = -0.88 + (y / 12) * 1.8;
          /* Folds gather as the curtain draws back, so it never looks flat. */
          const sway = Math.sin(v * 2.4 + fold * 1.7 + t * 0.8) * 0.05 * (1 - eased);
          plot(fu + sway, v, fold === 0 ? 0.75 : 0.55);
        }
      }
      plot(edge, 0.9, 0.6);
    }
    /* What is behind the tabs only reads once there is a gap to see it. */
    if (eased > 0.25) {
      const light = (eased - 0.25) / 0.75;
      for (let step = 0; step <= 14; step += 1) {
        const a = (step / 14) * TAU;
        plot(Math.cos(a) * 0.36, 0.35 + Math.sin(a) * 0.3, light * 0.7);
      }
      for (let y = 0; y <= 5; y += 1) plot(0, 0.65 + (y / 5) * 0.24, light * 0.6);
    }
  });
}

/* -- Spotlight rig: beams hunting for a mark and holding it --------------- */

function paintSpotlightRig(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, -0.92, 0.45);
    const marks = [-0.7, 0.1, 0.9] as const;
    for (let lamp = 0; lamp < 3; lamp += 1) {
      const lu = -1 + lamp;
      /* Each lamp crosses to its next mark, then sits on it for a while. */
      const phase = (t * 0.3 + lamp / 3) % 1;
      const index = Math.floor(phase * 3) % 3;
      const from = marks[(index + 2) % 3]!;
      const target = marks[index]!;
      const blend = clamp01(((phase * 3) % 1) * 2);
      const hit = from + (target - from) * (blend * blend * (3 - 2 * blend));
      for (let y = 0; y <= 5; y += 1) plot(lu, -0.9 + (y / 5) * 0.22, 0.6);
      for (let step = 0; step <= 24; step += 1) {
        const f = step / 24;
        for (const side of [-1, 1] as const) {
          plot(lu + (hit - lu) * f + side * f * 0.24, -0.68 + f * 1.5, 0.3 + (1 - f) * 0.35);
        }
      }
      for (let step = 0; step <= 10; step += 1) {
        const a = (step / 10) * TAU;
        plot(hit + Math.cos(a) * 0.28, 0.82 + Math.sin(a) * 0.09, 0.8);
      }
    }
  });
}

/* -- Trap door: a figure rising through the stage floor ------------------- */

function paintTrapDoor(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.3) % 2;
    const openness = cycle < 0.3 ? cycle / 0.3 : cycle < 1.5 ? 1 : clamp01(1 - (cycle - 1.5) / 0.5);
    const rise = cycle > 0.3 && cycle < 1.5 ? Math.sin(((cycle - 0.3) / 1.2) * Math.PI) : 0;
    /* Masking legs each side and a cloth behind: without them the stage is
       just a line across an empty frame. */
    for (let y = 0; y <= 14; y += 1) {
      const v = -0.92 + (y / 14) * 1.34;
      plot(-1.5 + Math.sin(v * 3) * 0.04, v, 0.45);
      plot(1.5 - Math.sin(v * 3) * 0.04, v, 0.45);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, -0.92, 0.4);
    for (let x = 0; x <= 32; x += 1) {
      const u = -1.6 + (x / 32) * 3.2;
      if (Math.abs(u) < 0.42 * openness) continue;
      plot(u, 0.42, 0.5);
    }
    for (const side of [-1, 1] as const) {
      for (let step = 0; step <= 8; step += 1) {
        const f = step / 8;
        plot(
          side * 0.42 + side * Math.cos(openness * 1.2) * f * 0.42,
          0.42 - Math.sin(openness * 1.2) * f * 0.42,
          0.6,
        );
      }
    }
    /* Smoke comes up through the opening whether anybody does or not. */
    for (let puff = 0; puff < 7; puff += 1) {
      const life = (t * 0.9 + hash(puff)) % 1;
      plot((hash(puff * 3.3) - 0.5) * 0.8 * (0.3 + life), 0.42 - life * 1.2, openness * (1 - life) * 0.5);
    }
    if (rise > 0.02) {
      for (let y = 0; y <= 6; y += 1) plot(0, 0.42 - rise * 1.1 * (y / 6), 0.7);
      plot(0, 0.42 - rise * 1.1 - 0.14, 0.95);
      for (let x = 0; x <= 4; x += 1) plot(-0.2 + (x / 4) * 0.4, 0.52 - rise * 1.1, 0.6);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.9, 0.3);
  });
}

/* -- Fly tower: scenery flown in and out on its lines --------------------- */

function paintFlyTower(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 32; x += 1) plot(-1.6 + (x / 32) * 3.2, -0.94, 0.45);
    for (let bar = 0; bar < 3; bar += 1) {
      /* Three bars on their own cues, so the stage is never all in or out. */
      const phase = (t * 0.22 + bar / 3) % 1;
      const inFlight = phase < 0.5 ? phase / 0.5 : 1 - (phase - 0.5) / 0.5;
      const v = -0.78 + inFlight * inFlight * (3 - 2 * inFlight) * 1.5;
      for (let line = 0; line < 3; line += 1) {
        const lu = -0.9 + bar * 0.05 + line * 0.9;
        for (let y = 0; y <= 10; y += 1) plot(lu, -0.92 + (y / 10) * (v + 0.92), 0.35);
      }
      for (let x = 0; x <= 24; x += 1) plot(-1.05 + (x / 24) * 2.1, v, 0.7);
      for (let x = 0; x <= 20; x += 1) {
        const f = x / 20;
        plot(-1 + f * 2, v + 0.34 + Math.sin(f * 9 + bar * 2) * 0.06, 0.4 + bar * 0.15);
      }
    }
  });
}

/* -- Revolve: the stage turning the next scene into view ------------------ */

function paintRevolveStage(t: number): string {
  return paintPlotted((plot) => {
    const turn = t * 0.5;
    for (let step = 0; step <= 44; step += 1) {
      const a = (step / 44) * TAU;
      plot(Math.cos(a) * 1.3, Math.sin(a) * 0.6, 0.3);
    }
    /* A wall across the disc is what hides one scene from the other, so half
       the set is always turning out of sight behind it. */
    for (let step = 0; step <= 22; step += 1) {
      const f = step / 22 - 0.5;
      const wu = Math.cos(turn) * f * 2.6;
      const wv = Math.sin(turn) * f * 1.2;
      for (let y = 0; y <= 5; y += 1) plot(wu, wv - (y / 5) * 0.55, 0.55);
    }
    for (let prop = 0; prop < 4; prop += 1) {
      const a = turn + (prop / 4) * TAU;
      const pu = Math.cos(a) * 0.8;
      const pv = Math.sin(a) * 0.36;
      const near = clamp01(Math.sin(a) * 0.5 + 0.5);
      const height = 0.25 + (prop % 2) * 0.3;
      for (let y = 0; y <= 6; y += 1) plot(pu, pv - (y / 6) * height, 0.25 + near * 0.7);
      plot(pu, pv - height - 0.08, 0.3 + near * 0.7);
    }
  });
}

/* -- Marionette: a figure walked on its strings --------------------------- */

function paintPuppetStrings(t: number): string {
  return paintPlotted((plot) => {
    const step = Math.sin(t * 2.4);
    const bar = Math.sin(t * 2.4 + 0.6) * 0.18;
    const bodyV = -0.05 + Math.abs(Math.cos(t * 2.4)) * 0.08;
    for (let x = 0; x <= 12; x += 1) plot(-0.4 + (x / 12) * 0.8, -0.85 + bar * 0.4, 0.6);
    /* Head, two hands and two feet: the control bar leads all five. */
    const joints: ReadonlyArray<readonly [number, number]> = [
      [0, bodyV - 0.3],
      [-0.3, bodyV - 0.05 + step * 0.1],
      [0.3, bodyV - 0.05 - step * 0.1],
      [-0.22, bodyV + 0.5 + step * 0.16],
      [0.22, bodyV + 0.5 - step * 0.16],
    ];
    for (const [ju, jv] of joints) {
      for (let y = 0; y <= 8; y += 1) {
        const f = y / 8;
        plot(ju * (0.4 + f * 0.6), -0.82 + bar * 0.4 + f * (jv + 0.82), 0.3);
      }
      plot(ju, jv, 0.9);
    }
    for (let y = 0; y <= 8; y += 1) plot(0, bodyV - 0.3 + (y / 8) * 0.55, 0.7);
    for (let x = 0; x <= 6; x += 1) plot((x / 6 - 0.5) * 0.6, bodyV - 0.02, 0.6);
    for (let x = 0; x <= 30; x += 1) plot(-1.5 + (x / 30) * 3, 0.88, 0.35);
  });
}

/* -- Orchestra pit: bows moving as one under a beating stick -------------- */

function paintOrchestraPit(t: number): string {
  return paintPlotted((plot) => {
    /* Four to the bar: the stick marks each one and the strings answer. */
    const beat = (t * 1.6) % 4;
    const swing = Math.sin(beat * Math.PI * 0.5);
    const drop = Math.abs(Math.sin(beat * Math.PI));
    for (let x = 0; x <= 32; x += 1) plot(-1.6 + (x / 32) * 3.2, 0.5, 0.45);
    for (let y = 0; y <= 5; y += 1) plot(0, 0.5 + (y / 5) * 0.4, 0.5);
    plot(0, 0.38, 0.8);
    for (let step = 0; step <= 8; step += 1) {
      const f = step / 8;
      plot(swing * f * 0.5, 0.3 - drop * 0.3 * f - f * 0.2, 0.95);
    }
    for (let player = 0; player < 5; player += 1) {
      const pu = -1.25 + player * 0.62;
      const phase = swing * (player % 2 === 0 ? 1 : -1);
      for (let y = 0; y <= 4; y += 1) plot(pu, 0.5 - (y / 4) * 0.3, 0.5);
      plot(pu, 0.14, 0.7);
      /* Every bow in a section moves the same way at the same time. */
      for (let s = 0; s <= 8; s += 1) {
        const f = s / 8 - 0.5;
        plot(pu + f * 0.42 + phase * 0.16, 0.24 + f * 0.16 - phase * 0.05, 0.85);
      }
      plot(pu, -0.05, 0.4 + drop * 0.4);
    }
  });
}

/* ========================================================================
   The eleventh collection: fields from the sky and the sea at the edge of
   sight and from life under a microscope, then an airport apron, a
   watchmaker's bench, a machine hall, a recycling plant, and a fishing quay.
   Same contract as everything above: a pure painter over the shared grid.
   ===================================================================== */

/* -- Tephra fall: ash leaving a leaning column and settling ---------------- */

const tephraFallField: Field = (u, v, t) => {
  /* The column leans downwind, so the fall is always heaviest to one side of
     it rather than spread evenly over the frame. */
  const drift = Math.sin(t * 0.25) * 0.5;
  const column = clamp01(1 - Math.abs(u + 1.2 - drift * (1 - v) * 0.4) * 1.1);
  const fall = fbm(u * 1.6 + drift * 0.6, v * 1.1 + t * 0.9, 3);
  const airborne = clamp01(0.15 + column * 0.55) * clamp01(fall * 1.8 - 0.4);
  /* Ash that has landed stays landed, and the bed is deepest under the column. */
  const bed = clamp01((v - (0.74 - column * 0.2 - ((t * 0.1) % 1) * 0.05)) * 6);
  return clamp01(0.05 + airborne * 0.9 + bed * 0.55);
};

/* -- Mach diamonds: shock cells standing in an exhaust plume --------------- */

const machDiamondField: Field = (u, v, t) => {
  /* The cells stand still in the flow and only the turbulence between them
     travels, which is the whole difference between this and a moving stripe. */
  const along = (u + ASPECT) / (ASPECT * 2);
  const spread = 0.14 + along * 0.52;
  const core = clamp01(1 - Math.abs(v) / spread);
  if (core <= 0) return clamp01(0.04 + fbm(u * 3 - t * 2.4, v * 3, 2) * 0.09);
  const node = Math.abs(Math.sin((along * 5.5 + 0.2) * Math.PI));
  /* Cells weaken downstream as the plume gives up its pressure. */
  const shock = Math.pow(1 - node, 3) * clamp01(1 - along * 0.85);
  const churn = fbm(u * 2.4 - t * 3.4, v * 4.2, 2);
  return clamp01(0.09 + core * (0.32 + shock * 0.8) * (0.55 + churn * 0.65));
};

/* -- Vortex rings: smoke rings climbing and fattening ---------------------- */

const vortexRingField: Field = (u, v, t) => {
  let smoke = 0.05 + fbm(u * 1.4, v * 1.4 + t * 0.3, 2) * 0.1;
  for (let ring = 0; ring < 3; ring += 1) {
    const life = (t * 0.35 + ring / 3) % 1;
    /* A ring widens and thickens as it climbs, and fades doing it, so the one
       nearest the top is always the faintest. */
    const height = 0.95 - life * 1.9;
    const radius = 0.24 + life * 0.85;
    const thickness = 0.09 + life * 0.15;
    const across = Math.abs(Math.abs(u) - radius);
    const core = clamp01(1 - Math.hypot(across / thickness, (v - height) / (thickness * 1.6)));
    smoke = Math.max(smoke, core * (1 - life * 0.7));
  }
  return clamp01(smoke);
};

/* -- Sun glitter: the sun's path broken up over a swell -------------------- */

const sunGlitterField: Field = (u, v, t) => {
  /* The path narrows towards the horizon because the waves up there are seen
     at a glancing angle. That taper is the shape people recognise. */
  const horizon = -0.42;
  if (v < horizon) return clamp01(0.14 + (horizon - v) * 0.28);
  const near = (v - horizon) / (1 - horizon);
  const path = clamp01(1 - Math.abs(u) / (0.2 + near * 1.15));
  const facet = fbm(u * 5, v * 9 - t * 2.2, 2) + Math.sin(v * 20 - t * 4.5) * 0.16;
  return clamp01(0.09 + near * 0.1 + clamp01((facet - 0.5) * 6) * path * 0.95);
};

/* -- St Elmo's fire: corona standing on the mastheads ---------------------- */

const stElmoField: Field = (u, v, t) => {
  const air = 0.06 + fbm(u * 2 + t * 0.3, v * 2, 2) * 0.07;
  let rig = 0;
  let corona = 0;
  for (let mast = 0; mast < 3; mast += 1) {
    const foot = -1.15 + mast * 1.15;
    const tip = -0.72 + mast * 0.18;
    /* The ship rolls, so the masts lean together rather than apart. */
    const lean = Math.sin(t * 0.9 + mast * 0.4) * 0.09;
    const axis = foot + lean * (0.9 - v);
    if (v > tip) rig = Math.max(rig, clamp01(1 - Math.abs(u - axis) * 7) * 0.4);
    /* A brush discharge sits on the point and breathes; it is a corona, not a
       spark, so nothing here is allowed to flicker off. */
    const breath = 0.5 + Math.sin(t * 3.1 + mast * 2.2) * 0.5;
    corona = Math.max(
      corona,
      clamp01(1 - Math.hypot((u - axis) * 2.6, (v - tip) * 2.8)) * (0.4 + breath * 0.6),
    );
  }
  const yard = clamp01(1 - Math.abs(v - 0.15) * 11) * clamp01(1 - Math.abs(u) * 0.55) * 0.32;
  return clamp01(air + rig + yard + corona * 0.9);
};

/* -- Green flash: the last rim of a sun going under ------------------------ */

const greenFlashField: Field = (u, v, t) => {
  const horizon = 0.15;
  const sunset = (t % 7) / 7;
  const centre = horizon - 0.6 + sunset * 1.05;
  const sunk = clamp01((centre - horizon + 0.5) / 0.5);
  const disc = clamp01((0.5 - Math.hypot(u * 1.05, (v - centre) * 1.15)) * 4);
  /* Only the top rim is left at the end, and it is brightest as it goes. */
  const rim = clamp01(1 - Math.abs(v - (centre - 0.48)) * 14) * clamp01((sunk - 0.82) * 6);
  if (v < horizon) {
    return clamp01(0.05 + (horizon - v) * 0.14 + disc * (1 - sunk * 0.25) + rim * 0.95);
  }
  const sea = 0.12 + Math.abs(Math.sin(v * 10 + u * 1.6 - t * 1.8)) * 0.15;
  /* The reflected path shortens as the disc sinks and goes out with it. */
  const path = clamp01(1 - Math.abs(u) * 2.6) * (1 - sunk) * 0.35;
  return clamp01(sea + path);
};

/* -- Thermocline: two bodies of water that refuse to mix ------------------- */

const thermoclineField: Field = (u, v, t) => {
  /* Internal waves travel along the boundary far more slowly than anything on
     the surface would, which is why the top half looks busy and the rest does
     not. */
  const boundary = -0.05 + Math.sin(u * 1.5 - t * 0.7) * 0.22 + Math.sin(u * 3.1 + t * 0.4) * 0.08;
  const sheet = clamp01(1 - Math.abs(v - boundary) * 7);
  const body =
    v < boundary
      ? 0.1 + fbm(u * 2.6, v * 3.4 - t * 1.1, 2) * 0.45
      : 0.3 + fbm(u * 1.2 + t * 0.12, v * 1.2, 2) * 0.3;
  return clamp01(body + sheet * 0.4);
};

/* -- Siphonophore: a colony pumping on one nerve --------------------------- */

const siphonophoreField: Field = (u, v, t) => {
  const water = 0.05 + fbm(u * 1.6, v * 1.6 - t * 0.25, 2) * 0.07;
  /* One command runs down the whole animal, so the swimming bells at the top
     fire before the feeding units below them do. */
  const sway = Math.sin(v * 1.8 + t * 0.9) * 0.28;
  const axis = u - sway;
  const pulse = 0.5 + Math.sin(t * 2.4 - (v + 1) * 2.6) * 0.5;
  const stem = clamp01(1 - Math.abs(axis) * 5) * clamp01((v + 0.75) * 2);
  const bell = clamp01(1 - Math.hypot(axis * 1.7, (v + 0.72) * 2) / (0.3 + pulse * 0.1));
  const units =
    clamp01(1 - Math.abs(Math.abs(axis) - 0.16) * 9) *
    clamp01(1 - Math.abs(((v * 5) % 1) - 0.5) * 3) *
    clamp01((v + 0.3) * 2);
  return clamp01(water + stem * 0.35 + units * (0.4 + pulse * 0.5) + bell * 0.9);
};

/* -- Nacre: interference bands moving with the tilt of a shell ------------- */

const nacreField: Field = (u, v, t) => {
  /* The bands belong to the stack of platelets, not to time: they only move
     because the shell is being turned in the light. */
  const tilt = Math.sin(t * 0.5) * 0.6 + Math.sin(t * 0.23) * 0.25;
  const growth = Math.hypot((u + 0.9) * 0.7, (v + 0.5) * 1.1);
  const ridge = fbm(growth * 3.2, Math.atan2(v + 0.5, u + 0.9) * 1.4, 2);
  const band = 0.5 + Math.sin(growth * 7 + ridge * 2.4 + tilt * 3) * 0.5;
  const inside = clamp01((1.7 - growth) * 1.6);
  return clamp01(0.06 + inside * (0.22 + Math.pow(band, 2.2) * 0.72));
};

/* -- Chromatophores: skin cells answering a wave of command ---------------- */

const chromatophoreField: Field = (u, v, t) => {
  /* Each sac is opened by its own muscle, so the wave passing over the skin
     arrives at every cell in turn and none of them open by halves. */
  const cellU = Math.floor(u * 4.5);
  const cellV = Math.floor(v * 4.5);
  const centreU = (cellU + 0.5) / 4.5;
  const centreV = (cellV + 0.5) / 4.5;
  const wave = 0.5 + Math.sin(centreU * 2.2 + centreV * 1.4 - t * 2.6) * 0.5;
  const own = hash2(cellU, cellV);
  const open = clamp01(wave * 1.5 - 0.25) * (0.45 + own * 0.55);
  const radius = Math.hypot((u - centreU) * 4.5, (v - centreV) * 4.5);
  return clamp01(0.07 + clamp01((open * 0.85 - radius) * 3.5) * 0.9);
};

/* -- Diatoms: striated shells drifting across a slide --------------------- */

const diatomField: Field = (u, v, t) => {
  const water = 0.05 + fbm(u * 2 + t * 0.15, v * 2, 2) * 0.06;
  let shell = 0;
  for (let cell = 0; cell < 5; cell += 1) {
    /* They drift and turn at their own rates. The striae run across the
       frustule, which is what tells one from a bubble. */
    const drift = t * (0.1 + hash(cell) * 0.12);
    const cu = ((hash(cell * 3.1) + drift) % 1) * 3.6 - 1.8;
    const cv = -0.8 + hash(cell * 7.7) * 1.6 + Math.sin(t * 0.6 + cell) * 0.08;
    const angle = t * (0.2 + hash(cell * 5.5) * 0.25) + cell;
    const dx = (u - cu) * Math.cos(angle) + (v - cv) * Math.sin(angle);
    const dy = (v - cv) * Math.cos(angle) - (u - cu) * Math.sin(angle);
    const inside = 1 - Math.hypot(dx / (0.42 + hash(cell * 9.3) * 0.2), dy / 0.15);
    if (inside <= 0) continue;
    const striae = 0.55 + Math.sin(dx * 30) * 0.45;
    shell = Math.max(shell, clamp01(inside * 3) * (0.3 + striae * 0.5) + clamp01(1 - inside * 6) * 0.4);
  }
  return clamp01(water + shell);
};

/* -- Mitosis: one cell coming apart in the right order --------------------- */

const mitosisField: Field = (u, v, t) => {
  const cycle = (t * 0.16) % 1;
  /* Line up, pull apart, pinch in. The membrane is never allowed to close
     before the chromatin has cleared the middle. */
  const lined = clamp01(cycle / 0.3);
  const pull = clamp01((cycle - 0.35) / 0.3);
  const pinch = clamp01((cycle - 0.55) / 0.45);
  const split = pull * 0.6;
  const body = Math.min(
    Math.hypot((u + split) * 1.1, v * 1.3),
    Math.hypot((u - split) * 1.1, v * 1.3),
  );
  const membrane = clamp01(1 - Math.abs(body - 0.6) * 6);
  const cytoplasm = clamp01((0.6 - body) * 2.4) * 0.28;
  const waist =
    clamp01(1 - Math.abs(v) * 2.2) * clamp01(1 - Math.abs(u) / (0.7 * (1 - pinch * 0.95) + 0.02));
  let chromatin = 0;
  for (let pair = 0; pair < 4; pair += 1) {
    const cv = -0.42 + pair * 0.28;
    const scatter = (1 - lined) * (hash(pair) - 0.5) * 1.6;
    for (let side = 0; side < 2; side += 1) {
      const cu = scatter + (side === 0 ? -split : split);
      chromatin = Math.max(chromatin, clamp01(1 - Math.hypot((u - cu) * 5.5, (v - cv) * 4.5)));
    }
  }
  return clamp01(0.06 + Math.max(cytoplasm, waist * 0.24 * (1 - pinch)) + membrane * 0.55 + chromatin * 0.9);
};

/* -- Cilia: a row beating one beat out of step with its neighbour ---------- */

const ciliaField: Field = (u, v, t) => {
  const base = 0.76;
  if (v > base + 0.08) return clamp01(0.34 + Math.sin(u * 8) * 0.06);
  let hair = 0;
  for (let i = 0; i < 16; i += 1) {
    /* Every cilium beats a fraction later than the one beside it, and that
       lag is the only reason the row carries a wave rather than flapping. */
    const stroke = Math.sin(t * 3.4 - i * 0.55);
    const height = 0.3 + clamp01(stroke + 0.4) * 0.22;
    const reach = (base - v) / height;
    if (reach < 0 || reach > 1) continue;
    /* Straight on the power stroke, curled back on the recovery. */
    const bend = stroke * 0.34 * reach * reach;
    const hu = -1.6 + (i / 15) * 3.2;
    hair = Math.max(hair, clamp01(1 - Math.abs(u - hu - bend) * 9) * (0.45 + clamp01(stroke) * 0.5));
  }
  const flow = clamp01(1 - Math.abs(v + 0.45) * 2) * (0.1 + Math.abs(Math.sin(u * 2 - t * 2.4)) * 0.2);
  return clamp01(0.05 + hair + flow);
};

/* -- Stomata: guard cells bowing a pore open ------------------------------ */

const stomataField: Field = (u, v, t) => {
  const leaf = 0.12 + fbm(u * 2.2, v * 2.2, 2) * 0.12;
  let pore = 0;
  for (let i = 0; i < 5; i += 1) {
    const pu = -1.3 + (i % 3) * 1.3 + (i > 2 ? 0.65 : 0);
    const pv = i > 2 ? 0.42 : -0.42;
    const dx = (u - pu) / 0.46;
    if (Math.abs(dx) > 1) continue;
    /* Turgid guard cells bow apart, so the opening is a lens: widest in the
       middle and shut at both ends, never a rectangle. */
    const open = clamp01(0.5 + Math.sin(t * 0.8 + i * 1.7) * 0.7);
    const lens = Math.sqrt(1 - dx * dx);
    const gap = lens * (0.1 + open * 0.5);
    const dy = (v - pv) / 0.34;
    if (Math.abs(dy) < gap) return clamp01(0.03 + leaf * 0.12);
    pore = Math.max(pore, clamp01(1 - Math.abs(Math.abs(dy) - (gap + 0.42)) * 3.2) * lens * 0.9);
  }
  return clamp01(leaf + pore);
};

/* -- Brownian motion: grains knocked about by what cannot be seen ---------- */

const brownianField: Field = (u, v, t) => {
  const water = 0.05 + fbm(u * 3, v * 3, 2) * 0.05;
  let grain = 0;
  for (let i = 0; i < 7; i += 1) {
    let gu = -1.3 + hash(i * 1.7) * 2.6;
    let gv = -0.7 + hash(i * 4.1) * 1.4;
    /* The knocks come at no one rate, so the walk is built from several
       wobbles that never line back up into a circle. */
    for (let knock = 1; knock <= 3; knock += 1) {
      const rate = 0.7 * knock + hash(i * knock * 3.3) * 1.4;
      gu += Math.sin(t * rate + hash(i + knock) * TAU) * (0.18 / knock);
      gv += Math.cos(t * rate * 1.13 + hash(i * 2 + knock) * TAU) * (0.13 / knock);
    }
    grain = Math.max(grain, clamp01(1 - Math.hypot((u - gu) * 4.4, (v - gv) * 5.2)));
  }
  return clamp01(water + grain * 0.95);
};

/* -- Pushback tug: aircraft and tug reversing together -------------------- */

function paintPushbackTug(t: number): string {
  return paintPlotted((plot) => {
    const travel = ((t * 0.28) % 1) * 3.4 - 1.7;
    const bounce = Math.sin(t * 5) * 0.025;
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 2, 0.82, 0.35);
    /* The nose wheel, towbar and tug stay locked together during the push. */
    for (let x = 0; x <= 12; x += 1) plot(travel - 0.48 + (x / 12) * 0.86, 0.5 + bounce, 0.75);
    for (let y = 0; y <= 5; y += 1) plot(travel - 0.48, 0.5 + (y / 5) * 0.24 + bounce, 0.55);
    for (let wheel = 0; wheel < 2; wheel += 1) {
      const wu = travel - 0.28 + wheel * 0.5;
      for (let a = 0; a <= 10; a += 1) {
        const angle = (a / 10) * TAU;
        plot(wu + Math.cos(angle) * 0.1, 0.76 + Math.sin(angle) * 0.1, 0.8);
      }
    }
    for (let s = 0; s <= 8; s += 1) plot(travel + 0.38 + (s / 8) * 0.55, 0.59 - (s / 8) * 0.09, 0.55);
    plot(travel + 0.94, 0.57, 0.95);
    /* A clipped aircraft nose gives the towbar a readable destination. */
    for (let a = 0; a <= 15; a += 1) {
      const angle = Math.PI * 0.55 + (a / 15) * Math.PI * 0.9;
      plot(travel + 1.38 + Math.cos(angle) * 0.48, 0.05 + Math.sin(angle) * 0.58, 0.5);
    }
    for (let y = 0; y <= 4; y += 1) plot(travel + 0.94, 0.35 + (y / 4) * 0.25, 0.65);
    plot(travel - 0.16, 0.36 + bounce, 0.55 + Math.abs(Math.sin(t * 4)) * 0.45);
  });
}

/* -- Jet bridge: telescoping sections meeting an aircraft door ------------ */

function paintJetBridge(t: number): string {
  return paintPlotted((plot) => {
    const extend = 0.5 + Math.sin(t * 0.65) * 0.5;
    const end = 0.2 + extend * 0.95;
    /* Terminal wall and aircraft door are fixed while the bridge moves. */
    for (let y = 0; y <= 12; y += 1) plot(-1.55, -0.9 + (y / 12) * 1.8, 0.45);
    for (let y = 0; y <= 6; y += 1) {
      plot(1.35, -0.5 + (y / 6) * 0.75, 0.55);
      plot(1.12, -0.5 + (y / 6) * 0.75, 0.45);
    }
    for (let x = 0; x <= 28; x += 1) {
      const u = -1.48 + (x / 28) * (end + 1.48);
      const droop = Math.pow((u + 1.48) / (end + 1.48), 2) * 0.12;
      plot(u, -0.42 + droop, 0.72);
      plot(u, 0.08 + droop, 0.58);
      if (x % 5 === 0) plot(u, -0.17 + droop, 0.35);
    }
    /* The cab closes the last gap after the telescoping tunnel is extended. */
    const cab = end + extend * 0.18;
    for (let y = 0; y <= 7; y += 1) plot(cab, -0.48 + (y / 7) * 0.66, 0.8);
    for (let x = 0; x <= 5; x += 1) plot(cab + (x / 5) * 0.2, 0.18, 0.55);
    for (let y = 0; y <= 7; y += 1) plot(cab - 0.15, 0.18 + (y / 7) * 0.52, 0.42);
    for (let a = 0; a <= 10; a += 1) {
      const angle = (a / 10) * TAU;
      plot(cab - 0.15 + Math.cos(angle) * 0.13, 0.73 + Math.sin(angle) * 0.12, 0.72);
    }
  });
}

/* -- Baggage loader: cases riding an inclined conveyor -------------------- */

function paintBaggageLoader(t: number): string {
  return paintPlotted((plot) => {
    const startU = -1.35;
    const endU = 1.1;
    const startV = 0.68;
    const endV = -0.45;
    for (let rail = 0; rail < 2; rail += 1) {
      for (let s = 0; s <= 32; s += 1) {
        const f = s / 32;
        plot(startU + (endU - startU) * f, startV + (endV - startV) * f + rail * 0.14, 0.5);
      }
    }
    for (let roller = 0; roller < 9; roller += 1) {
      const f = roller / 8;
      const phase = t * 5 + roller;
      plot(
        startU + (endU - startU) * f + Math.cos(phase) * 0.035,
        startV + (endV - startV) * f + 0.07 + Math.sin(phase) * 0.035,
        0.65,
      );
    }
    for (let bag = 0; bag < 4; bag += 1) {
      const f = (t * 0.27 + bag / 4) % 1;
      const bu = startU + (endU - startU) * f;
      const bv = startV + (endV - startV) * f - 0.09;
      for (let x = 0; x <= 4; x += 1) plot(bu - 0.16 + (x / 4) * 0.32, bv - 0.08, 0.9);
      plot(bu - 0.16, bv, 0.7);
      plot(bu + 0.16, bv - 0.05, 0.7);
    }
    /* Scissor legs keep changing their crossing point as the belt works. */
    for (let s = 0; s <= 12; s += 1) {
      const f = s / 12;
      plot(-0.6 + f * 1.1, 0.8 - f * 0.55, 0.35);
      plot(0.5 - f * 1.1, 0.8 - f * 0.55, 0.35);
    }
  });
}

/* -- Deicing boom: a nozzle sweeping fluid over a tail -------------------- */

function paintDeicingBoom(t: number): string {
  return paintPlotted((plot) => {
    const sweep = Math.sin(t * 0.75);
    const elbowU = -0.25 + sweep * 0.22;
    const elbowV = 0.02 - Math.abs(sweep) * 0.18;
    const nozzleU = 0.72 + sweep * 0.34;
    const nozzleV = -0.5 + Math.cos(t * 0.75) * 0.08;
    for (let x = 0; x <= 18; x += 1) plot(-1.35 + (x / 18) * 1.25, 0.65, 0.65);
    for (let wheel = 0; wheel < 2; wheel += 1) {
      const wu = -1.08 + wheel * 0.66;
      for (let a = 0; a <= 8; a += 1) {
        const angle = (a / 8) * TAU;
        plot(wu + Math.cos(angle) * 0.11, 0.76 + Math.sin(angle) * 0.1, 0.7);
      }
    }
    const drawArm = (au: number, av: number, bu: number, bv: number) => {
      for (let s = 0; s <= 16; s += 1) {
        const f = s / 16;
        plot(au + (bu - au) * f, av + (bv - av) * f, 0.7);
      }
    };
    drawArm(-0.62, 0.56, elbowU, elbowV);
    drawArm(elbowU, elbowV, nozzleU, nozzleV);
    for (let drop = 0; drop < 13; drop += 1) {
      const life = (t * 0.8 + hash(drop * 2.3)) % 1;
      const du = nozzleU + life * (0.55 + hash(drop) * 0.35);
      const dv = nozzleV + life * 0.48 + (hash(drop * 5.1) - 0.5) * 0.35;
      plot(du, dv, (1 - life) * 0.85);
    }
    /* The aircraft tail is the stationary target at the right edge. */
    for (let y = 0; y <= 12; y += 1) plot(1.42, -0.85 + (y / 12) * 1.45, 0.4);
    for (let x = 0; x <= 8; x += 1) plot(1.42 - (x / 8) * 0.68, -0.18 + (x / 8) * 0.28, 0.35);
  });
}

/* -- Windsock: a segmented sock filling and sagging with the gusts -------- */

function paintWindsock(t: number): string {
  return paintPlotted((plot) => {
    const gust = 0.5 + Math.sin(t * 0.85) * 0.35 + Math.sin(t * 2.2) * 0.15;
    for (let y = 0; y <= 15; y += 1) plot(-1.1, -0.62 + (y / 15) * 1.48, 0.55);
    for (let x = 0; x <= 8; x += 1) plot(-1.42 + (x / 8) * 0.64, 0.86, 0.42);
    plot(-1.1, -0.72, 0.9);
    for (let segment = 0; segment < 6; segment += 1) {
      const f = segment / 5;
      const centreU = -1 + f * (1.95 + gust * 0.35);
      const centreV = -0.61 + f * (1 - gust) * 0.75 + Math.sin(t * 2 + f * 4) * f * 0.06;
      const radius = 0.22 * (1 - f * 0.78);
      plot(centreU, centreV - radius, 0.65 + (segment % 2) * 0.25);
      plot(centreU, centreV + radius, 0.65 + (segment % 2) * 0.25);
      if (segment < 5) plot(centreU, centreV, 0.35);
    }
    /* A loose tail makes the changing air speed visible even at full extension. */
    for (let s = 0; s <= 8; s += 1) {
      const f = s / 8;
      plot(0.95 + gust * 0.35 + f * 0.35, -0.61 + (1 - gust) * 0.75 + Math.sin(t * 3 + f * 4) * 0.1, 0.65);
    }
  });
}

/* -- Runway lights: perspective lamps advancing beneath an arrival -------- */

function paintRunwayLights(t: number): string {
  return paintPlotted((plot) => {
    const horizon = -0.7;
    for (let edge = -1; edge <= 1; edge += 2) {
      for (let s = 0; s <= 24; s += 1) {
        const f = s / 24;
        plot(edge * (0.12 + f * 1.45), horizon + f * 1.55, 0.25);
      }
    }
    for (let lamp = 0; lamp < 11; lamp += 1) {
      const f = (t * 0.42 + lamp / 11) % 1;
      const depth = f * f;
      const v = horizon + depth * 1.55;
      const spread = 0.12 + depth * 1.45;
      const flash = 0.5 + Math.sin(t * 7 - lamp * 0.8) * 0.5;
      plot(-spread, v, 0.55 + flash * 0.45);
      plot(spread, v, 0.55 + flash * 0.45);
      if (lamp % 3 === 0) plot(0, v, 0.45 + flash * 0.35);
    }
    /* A threshold bar anchors the approaching stream of lights. */
    for (let x = 0; x <= 22; x += 1) plot(-1.48 + (x / 22) * 2.96, 0.86, 0.58);
  });
}

/* -- Air stairs: a mobile staircase raising to a cabin door --------------- */

function paintAirStairs(t: number): string {
  return paintPlotted((plot) => {
    const lift = 0.5 + Math.sin(t * 0.55) * 0.5;
    const topV = 0.1 - lift * 0.55;
    const bottomU = -1.25;
    const topU = 0.72;
    for (let step = 0; step < 9; step += 1) {
      const f = step / 8;
      const u = bottomU + (topU - bottomU) * f;
      const v = 0.6 + (topV - 0.6) * f;
      for (let x = 0; x <= 4; x += 1) plot(u + (x / 4) * 0.28, v, 0.7);
      if (step < 8) for (let y = 0; y <= 3; y += 1) plot(u + 0.28, v + (y / 3) * 0.12, 0.5);
    }
    for (let rail = 0; rail < 2; rail += 1) {
      for (let s = 0; s <= 22; s += 1) {
        const f = s / 22;
        plot(bottomU + (topU - bottomU) * f, 0.36 + (topV - 0.24 - 0.36) * f + rail * 0.08, 0.4);
      }
    }
    for (let x = 0; x <= 13; x += 1) plot(-1.35 + (x / 13) * 0.9, 0.75, 0.55);
    for (let wheel = 0; wheel < 2; wheel += 1) plot(-1.18 + wheel * 0.55, 0.84, 0.9);
    /* The door waits at one height while the stair platform rises to it. */
    for (let y = 0; y <= 9; y += 1) plot(1.18, -0.78 + (y / 9) * 0.9, 0.5);
    for (let x = 0; x <= 7; x += 1) plot(0.72 + (x / 7) * 0.46, topV, 0.75);
  });
}

/* -- Escapement: pallet stones releasing one tooth at a time -------------- */

function paintEscapement(t: number): string {
  return paintPlotted((plot) => {
    const tick = Math.sin(t * 4.2) >= 0 ? 1 : -1;
    const turn = Math.floor(t * 4.2 / Math.PI) * (TAU / 15);
    for (let tooth = 0; tooth < 15; tooth += 1) {
      const angle = turn + (tooth / 15) * TAU;
      for (let r = 0; r <= 5; r += 1) {
        const radius = 0.48 + (r / 5) * 0.17;
        plot(Math.cos(angle) * radius, 0.2 + Math.sin(angle) * radius * 0.82, 0.58 + (r / 5) * 0.25);
      }
    }
    for (let a = 0; a <= 28; a += 1) {
      const angle = (a / 28) * TAU;
      plot(Math.cos(angle) * 0.47, 0.2 + Math.sin(angle) * 0.39, 0.42);
    }
    /* The fork rocks between two banking pins and only one stone locks. */
    const fork = tick * 0.13;
    for (let s = 0; s <= 12; s += 1) plot(fork + (s / 12 - 0.5) * 1.35, -0.48 + Math.abs(s / 12 - 0.5) * 0.35, 0.72);
    plot(-0.68 + fork, -0.28, tick < 0 ? 1 : 0.45);
    plot(0.68 + fork, -0.28, tick > 0 ? 1 : 0.45);
    for (let y = 0; y <= 5; y += 1) plot(fork, -0.48 - (y / 5) * 0.36, 0.6);
  });
}

/* -- Balance wheel: an oscillator returning through its centre ------------ */

function paintBalanceWheel(t: number): string {
  return paintPlotted((plot) => {
    const angle = Math.sin(t * 2.8) * 1.15;
    for (let a = 0; a <= 64; a += 1) {
      const theta = (a / 64) * TAU;
      plot(Math.cos(theta) * 1.02, Math.sin(theta) * 0.79, 0.62);
    }
    for (let spoke = 0; spoke < 5; spoke += 1) {
      const theta = angle + (spoke / 5) * TAU;
      for (let r = 0; r <= 12; r += 1) {
        const f = r / 12;
        plot(Math.cos(theta) * f, Math.sin(theta) * f * 0.78, 0.45 + f * 0.25);
      }
    }
    for (let a = 0; a <= 12; a += 1) {
      const theta = (a / 12) * TAU;
      plot(Math.cos(theta) * 0.13, Math.sin(theta) * 0.1, 0.9);
    }
    /* The hairspring breathes opposite the wheel's angular displacement. */
    for (let s = 0; s <= 55; s += 1) {
      const f = s / 55;
      const theta = f * TAU * 3.2 + angle;
      const radius = 0.13 + f * (0.58 - Math.abs(angle) * 0.08);
      plot(Math.cos(theta) * radius, Math.sin(theta) * radius * 0.78, 0.36);
    }
  });
}

/* -- Mainspring wind: a barrel tightening a strip from the outside -------- */

function paintMainspringWind(t: number): string {
  return paintPlotted((plot) => {
    const wind = 0.5 + Math.sin(t * 0.52) * 0.5;
    for (let a = 0; a <= 56; a += 1) {
      const angle = (a / 56) * TAU;
      plot(Math.cos(angle) * 1.12, Math.sin(angle) * 0.82, 0.45);
    }
    const turns = 2.3 + wind * 2.4;
    for (let s = 0; s <= 120; s += 1) {
      const f = s / 120;
      const angle = f * TAU * turns - t * 0.2;
      const radius = 0.12 + f * (0.86 - wind * 0.18);
      plot(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.78, 0.52 + f * 0.28);
    }
    /* The arbor turns as the outer end remains hooked to the barrel. */
    for (let spoke = 0; spoke < 3; spoke += 1) {
      const angle = t * 1.1 + (spoke / 3) * TAU;
      for (let r = 0; r <= 5; r += 1) plot(Math.cos(angle) * (r / 5) * 0.22, Math.sin(angle) * (r / 5) * 0.17, 0.9);
    }
    plot(0.92, 0, 0.95);
  });
}

/* -- Gear train: three wheels handing rotation down the movement ---------- */

function paintWatchGearTrain(t: number): string {
  return paintPlotted((plot) => {
    const gears = [
      { u: -0.82, v: 0.15, r: 0.56, teeth: 12, speed: 0.7 },
      { u: 0.1, v: -0.3, r: 0.39, teeth: 9, speed: -1.0 },
      { u: 0.82, v: 0.28, r: 0.3, teeth: 7, speed: 1.35 },
    ];
    for (const gear of gears) {
      const turn = t * gear.speed;
      for (let tooth = 0; tooth < gear.teeth; tooth += 1) {
        const angle = turn + (tooth / gear.teeth) * TAU;
        for (let r = 0; r <= 4; r += 1) {
          const radius = gear.r * (0.82 + (r / 4) * 0.28);
          plot(gear.u + Math.cos(angle) * radius, gear.v + Math.sin(angle) * radius * 0.82, 0.55 + (r / 4) * 0.3);
        }
      }
      for (let a = 0; a <= 24; a += 1) {
        const angle = (a / 24) * TAU;
        plot(gear.u + Math.cos(angle) * gear.r * 0.72, gear.v + Math.sin(angle) * gear.r * 0.59, 0.36);
      }
      plot(gear.u, gear.v, 0.95);
    }
  });
}

/* -- Jewel press: a ruby seated by a descending staking tool -------------- */

function paintJewelPress(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.48) % 1;
    const press = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
    for (let x = 0; x <= 22; x += 1) plot(-1.3 + (x / 22) * 2.6, 0.78, 0.5);
    for (let y = 0; y <= 16; y += 1) plot(-1.2, -0.82 + (y / 16) * 1.6, 0.45);
    for (let x = 0; x <= 18; x += 1) plot(-1.2 + (x / 18) * 2.15, -0.78, 0.45);
    const tipV = -0.54 + press * 1.05;
    for (let y = 0; y <= 9; y += 1) plot(0.12, -0.8 + (y / 9) * (tipV + 0.8), 0.75);
    for (let x = 0; x <= 7; x += 1) plot(-0.1 + (x / 7) * 0.44, tipV, 0.95);
    /* The jewel settles into the plate only at the bottom of the stroke. */
    const jewelV = 0.56 + press * 0.08;
    for (let a = 0; a <= 14; a += 1) {
      const angle = (a / 14) * TAU;
      plot(0.12 + Math.cos(angle) * 0.18, jewelV + Math.sin(angle) * 0.13, 0.75 + press * 0.25);
    }
    for (let x = 0; x <= 14; x += 1) plot(-0.48 + (x / 14) * 1.2, 0.7, 0.55);
  });
}

/* -- Loupe inspection: a lens sweeping across a running movement ---------- */

function paintLoupeInspection(t: number): string {
  return paintPlotted((plot) => {
    const scan = Math.sin(t * 0.55) * 0.8;
    const lensV = -0.12 + Math.cos(t * 0.7) * 0.12;
    /* The movement underneath keeps turning while the lens crosses it. */
    for (let gear = 0; gear < 3; gear += 1) {
      const gu = -0.85 + gear * 0.85;
      const gv = 0.34 + (gear % 2) * 0.2;
      const radius = 0.25 + gear * 0.05;
      for (let tooth = 0; tooth < 9; tooth += 1) {
        const angle = t * (gear % 2 ? -1.2 : 0.9) + (tooth / 9) * TAU;
        plot(gu + Math.cos(angle) * radius, gv + Math.sin(angle) * radius * 0.78, 0.42);
      }
    }
    for (let a = 0; a <= 42; a += 1) {
      const angle = (a / 42) * TAU;
      plot(scan + Math.cos(angle) * 0.68, lensV + Math.sin(angle) * 0.54, 0.8);
    }
    for (let s = 0; s <= 17; s += 1) plot(scan + 0.52 + (s / 17) * 0.78, lensV + 0.34 + (s / 17) * 0.48, 0.58);
    /* A magnified balance appears brighter only inside the glass. */
    for (let a = 0; a <= 18; a += 1) {
      const angle = t * 2 + (a / 18) * TAU;
      plot(scan + Math.cos(angle) * 0.3, lensV + Math.sin(angle) * 0.22, 0.95);
    }
  });
}

/* -- Case polisher: a watch case meeting a fast buffing wheel ------------- */

function paintCasePolisher(t: number): string {
  return paintPlotted((plot) => {
    const contact = 0.5 + Math.sin(t * 0.7) * 0.5;
    const wheelU = -0.48;
    const caseU = 0.95 - contact * 0.42;
    for (let a = 0; a <= 52; a += 1) {
      const angle = (a / 52) * TAU;
      plot(wheelU + Math.cos(angle) * 0.64, -0.04 + Math.sin(angle) * 0.63, 0.45);
    }
    for (let spoke = 0; spoke < 7; spoke += 1) {
      const angle = t * 7 + (spoke / 7) * TAU;
      for (let r = 0; r <= 8; r += 1) plot(wheelU + Math.cos(angle) * (r / 8) * 0.6, -0.04 + Math.sin(angle) * (r / 8) * 0.59, 0.42);
    }
    for (let a = 0; a <= 30; a += 1) {
      const angle = (a / 30) * TAU;
      plot(caseU + Math.cos(angle) * 0.42, 0.08 + Math.sin(angle) * 0.33, 0.78);
    }
    for (let s = 0; s <= 12; s += 1) plot(caseU + 0.38 + (s / 12) * 0.58, 0.08 + (s / 12) * 0.55, 0.42);
    if (contact > 0.72) {
      for (let spark = 0; spark < 8; spark += 1) {
        const life = (t * 1.8 + hash(spark)) % 1;
        plot(0.15 + life * (0.45 + hash(spark * 3.3) * 0.3), 0.05 + life * (hash(spark * 7.1) - 0.2), (1 - life) * contact);
      }
    }
  });
}

/* -- Line shaft: overhead power split among three machines ---------------- */

function paintLineShaft(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 2, -0.72, 0.5);
    for (let pulley = 0; pulley < 3; pulley += 1) {
      const u = -1.05 + pulley * 1.05;
      const radius = 0.16 + pulley * 0.04;
      const turn = t * (3.4 - pulley * 0.45);
      for (let a = 0; a <= 16; a += 1) {
        const angle = (a / 16) * TAU;
        plot(u + Math.cos(angle) * radius, -0.72 + Math.sin(angle) * radius, 0.65);
      }
      plot(u + Math.cos(turn) * radius, -0.72 + Math.sin(turn) * radius, 1);
      /* Each crossed belt reverses the machine below it. */
      for (let s = 0; s <= 14; s += 1) {
        const f = s / 14;
        plot(u - radius + f * radius * 2, -0.58 + f * 1.05, 0.35);
        plot(u + radius - f * radius * 2, -0.58 + f * 1.05, 0.35);
      }
      for (let a = 0; a <= 18; a += 1) {
        const angle = (a / 18) * TAU;
        plot(u + Math.cos(angle) * 0.26, 0.56 + Math.sin(angle) * 0.23, 0.55);
      }
      plot(u + Math.cos(-turn * 0.7) * 0.22, 0.56 + Math.sin(-turn * 0.7) * 0.2, 0.9);
    }
  });
}

/* -- Shaper ram: a single-point tool cutting on the forward stroke -------- */

function paintShaperRam(t: number): string {
  return paintPlotted((plot) => {
    const phase = (t * 0.65) % 1;
    /* The return is faster than the cutting stroke, as the crank demands. */
    const travel = phase < 0.72 ? phase / 0.72 : 1 - (phase - 0.72) / 0.28;
    const ramU = -1.2 + travel * 1.65;
    for (let x = 0; x <= 24; x += 1) plot(-1.48 + (x / 24) * 2.5, -0.45, 0.44);
    for (let x = 0; x <= 13; x += 1) plot(ramU - 0.52 + (x / 13) * 1.04, -0.22, 0.78);
    for (let y = 0; y <= 5; y += 1) plot(ramU + 0.46, -0.2 + (y / 5) * 0.45, 0.72);
    plot(ramU + 0.46, 0.28, phase < 0.72 ? 1 : 0.45);
    for (let layer = 0; layer < 5; layer += 1) {
      for (let x = 0; x <= 13; x += 1) plot(0.25 + (x / 13) * 1.05, 0.48 + layer * 0.07, 0.58);
    }
    for (let x = 0; x <= 28; x += 1) plot(-1.45 + (x / 28) * 2.9, 0.84, 0.45);
    if (phase < 0.72) {
      for (let chip = 0; chip < 6; chip += 1) {
        const life = (travel * 3 + chip / 6) % 1;
        plot(ramU + 0.52 + life * 0.35, 0.3 - Math.sin(life * Math.PI) * 0.24, (1 - life) * 0.8);
      }
    }
  });
}

/* -- Milling table: feed moving under a rotating cutter ------------------- */

function paintMillingTable(t: number): string {
  return paintPlotted((plot) => {
    const feed = Math.sin(t * 0.5) * 0.72;
    for (let y = 0; y <= 8; y += 1) plot(0, -0.85 + (y / 8) * 0.65, 0.5);
    for (let tooth = 0; tooth < 10; tooth += 1) {
      const angle = t * 4.5 + (tooth / 10) * TAU;
      for (let r = 0; r <= 4; r += 1) {
        const radius = 0.28 + (r / 4) * 0.16;
        plot(Math.cos(angle) * radius, -0.08 + Math.sin(angle) * radius, 0.62 + (r / 4) * 0.25);
      }
    }
    for (let x = 0; x <= 26; x += 1) plot(feed - 1.1 + (x / 26) * 2.2, 0.49, 0.6);
    for (let groove = 0; groove < 6; groove += 1) {
      const u = feed - 0.9 + groove * 0.36;
      for (let y = 0; y <= 5; y += 1) plot(u, 0.5 + (y / 5) * 0.22, 0.42);
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, 0.78, 0.43);
    /* Chips fly only on the side where the cutter leaves the work. */
    for (let chip = 0; chip < 7; chip += 1) {
      const life = (t * 1.5 + hash(chip)) % 1;
      plot(0.2 + life * (0.35 + hash(chip * 3.1) * 0.35), 0.28 - Math.sin(life * Math.PI) * 0.42, (1 - life) * 0.72);
    }
  });
}

/* -- Surface grinder: the table reverses beneath a spinning wheel --------- */

function paintSurfaceGrinder(t: number): string {
  return paintPlotted((plot) => {
    const table = Math.sin(t * 0.8) * 0.76;
    const downfeed = 0.04 + Math.sin(t * 0.19) * 0.035;
    for (let a = 0; a <= 40; a += 1) {
      const angle = (a / 40) * TAU;
      plot(-0.2 + Math.cos(angle) * 0.55, -0.22 + downfeed + Math.sin(angle) * 0.48, 0.62);
    }
    for (let spoke = 0; spoke < 6; spoke += 1) {
      const angle = t * 7 + (spoke / 6) * TAU;
      for (let r = 0; r <= 7; r += 1) plot(-0.2 + Math.cos(angle) * (r / 7) * 0.5, -0.22 + downfeed + Math.sin(angle) * (r / 7) * 0.43, 0.4);
    }
    for (let x = 0; x <= 25; x += 1) plot(table - 0.95 + (x / 25) * 1.9, 0.43, 0.7);
    for (let x = 0; x <= 29; x += 1) plot(table - 1.15 + (x / 29) * 2.3, 0.68, 0.45);
    for (let y = 0; y <= 5; y += 1) plot(table - 0.95, 0.44 + (y / 5) * 0.24, 0.45);
    if (Math.abs(table + 0.2) < 0.58) {
      for (let spark = 0; spark < 8; spark += 1) {
        const life = (t * 2.2 + hash(spark)) % 1;
        plot(0.2 + life * 0.65, 0.18 + life * (0.28 + hash(spark) * 0.25), (1 - life) * 0.8);
      }
    }
  });
}

/* -- Turret indexer: a new tool locking into the cutting position --------- */

function paintTurretIndexer(t: number): string {
  return paintPlotted((plot) => {
    const steps = 6;
    const raw = t * 0.55;
    const index = Math.floor(raw);
    const move = clamp01((raw - index) * 3);
    const eased = move * move * (3 - 2 * move);
    const turn = (index + eased) * (TAU / steps);
    for (let side = 0; side < steps; side += 1) {
      const a = turn + (side / steps) * TAU;
      const b = turn + ((side + 1) / steps) * TAU;
      for (let s = 0; s <= 8; s += 1) {
        const f = s / 8;
        plot(
          Math.cos(a) * 0.65 + (Math.cos(b) - Math.cos(a)) * 0.65 * f,
          -0.12 + (Math.sin(a) + (Math.sin(b) - Math.sin(a)) * f) * 0.53,
          0.65,
        );
      }
      /* Tool holders point out from every turret face. */
      for (let r = 0; r <= 7; r += 1) {
        const radius = 0.65 + (r / 7) * 0.45;
        plot(Math.cos(a) * radius, -0.12 + Math.sin(a) * radius * 0.82, side === 0 ? 1 : 0.48);
      }
    }
    plot(0, -0.12, 0.95);
    for (let x = 0; x <= 26; x += 1) plot(-1.35 + (x / 26) * 2.7, 0.75, 0.42);
    for (let y = 0; y <= 8; y += 1) plot(1.25, 0.72 - (y / 8) * 0.48, 0.5);
  });
}

/* -- Broach press: graduated teeth pulled through a keyed part ------------ */

function paintBroachPress(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.35) % 1;
    const pull = cycle < 0.78 ? cycle / 0.78 : 1 - (cycle - 0.78) / 0.22;
    for (let y = 0; y <= 18; y += 1) {
      const v = -0.86 + (y / 18) * 1.72;
      plot(-1.22, v, 0.43);
      plot(1.22, v, 0.43);
    }
    for (let x = 0; x <= 22; x += 1) plot(-1.1 + (x / 22) * 2.2, 0.42, 0.65);
    for (let a = 0; a <= 18; a += 1) {
      const angle = (a / 18) * TAU;
      plot(Math.cos(angle) * 0.36, 0.42 + Math.sin(angle) * 0.18, 0.72);
    }
    const headV = -0.76 + pull * 1.38;
    for (let y = 0; y <= 18; y += 1) {
      const f = y / 18;
      const v = headV - f * 1.25;
      const width = 0.06 + f * 0.2;
      plot(-width, v, 0.75);
      plot(width, v, 0.75);
      if (y % 3 === 0) {
        plot(-width - 0.12, v, 0.9);
        plot(width + 0.12, v, 0.9);
      }
    }
    for (let x = 0; x <= 10; x += 1) plot(-0.45 + (x / 10) * 0.9, headV, 0.85);
  });
}

/* -- Chain hoist: an endless hand chain lifting a travelling hook --------- */

function paintChainHoist(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-ASPECT + (x / 30) * ASPECT * 2, -0.82, 0.45);
    for (let a = 0; a <= 24; a += 1) {
      const angle = (a / 24) * TAU;
      plot(Math.cos(angle) * 0.34, -0.55 + Math.sin(angle) * 0.28, 0.65);
    }
    /* Bright links walk around the fixed hand-chain loop. */
    for (let link = 0; link < 18; link += 1) {
      const f = (link / 18 + t * 0.28) % 1;
      const side = f < 0.5 ? -1 : 1;
      const along = f < 0.5 ? f * 2 : (1 - f) * 2;
      plot(0.72 + side * 0.16, -0.45 + along * 1.18, link % 2 ? 0.55 : 0.9);
    }
    for (let y = 0; y <= 13; y += 1) plot(0, -0.3 + (y / 13) * 0.9, 0.45);
    const lift = 0.5 + Math.sin(t * 0.72) * 0.5;
    const hookV = 0.62 - lift * 0.82;
    for (let y = 0; y <= 12; y += 1) plot(0, -0.27 + (y / 12) * (hookV + 0.27), 0.75);
    for (let a = 0; a <= 12; a += 1) {
      const angle = (a / 12) * Math.PI * 1.45;
      plot(0.13 + Math.cos(angle) * 0.2, hookV + 0.18 + Math.sin(angle) * 0.2, 0.9);
    }
    for (let x = 0; x <= 13; x += 1) plot(-0.52 + (x / 13) * 1.04, hookV + 0.48, 0.6);
  });
}

/* -- Trommel screen: mixed fragments tumbling through a turning drum ------ */

function paintTrommelScreen(t: number): string {
  return paintPlotted((plot) => {
    const leftU = -1.25;
    const rightU = 1.18;
    for (let s = 0; s <= 30; s += 1) {
      const f = s / 30;
      const u = leftU + (rightU - leftU) * f;
      const centreV = -0.12 + f * 0.34;
      plot(u, centreV - 0.42, 0.55);
      plot(u, centreV + 0.42, 0.55);
      if (s % 4 === 0) {
        plot(u, centreV - 0.25, 0.34);
        plot(u, centreV + 0.25, 0.34);
      }
    }
    for (let ring = 0; ring < 4; ring += 1) {
      const f = ring / 3;
      const u = leftU + (rightU - leftU) * f;
      const centreV = -0.12 + f * 0.34;
      for (let a = 0; a <= 16; a += 1) {
        const angle = (a / 16) * TAU;
        plot(u + Math.cos(angle) * 0.13, centreV + Math.sin(angle) * 0.42, 0.5);
      }
    }
    for (let scrap = 0; scrap < 15; scrap += 1) {
      const f = (t * 0.16 + hash(scrap * 3.7)) % 1;
      const angle = t * 2.8 + hash(scrap) * TAU;
      const u = leftU + (rightU - leftU) * f;
      const centreV = -0.12 + f * 0.34;
      plot(u, centreV + Math.sin(angle) * 0.31, 0.55 + hash(scrap) * 0.4);
      if (Math.sin(angle) > 0.7 && scrap % 3 === 0) plot(u, 0.76, 0.65);
    }
  });
}

/* -- Eddy separator: conductive pieces thrown clear of the belt ----------- */

function paintEddySeparator(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 25; x += 1) plot(-1.5 + (x / 25) * 2.35, 0.35, 0.55);
    for (let roller = 0; roller < 2; roller += 1) {
      const ru = -1.35 + roller * 2.05;
      for (let a = 0; a <= 18; a += 1) {
        const angle = (a / 18) * TAU;
        plot(ru + Math.cos(angle) * 0.19, 0.48 + Math.sin(angle) * 0.18, 0.65);
      }
      plot(ru + Math.cos(t * 5) * 0.14, 0.48 + Math.sin(t * 5) * 0.13, 0.95);
    }
    for (let piece = 0; piece < 9; piece += 1) {
      const life = (t * 0.28 + piece / 9) % 1;
      if (life < 0.64) {
        const f = life / 0.64;
        plot(-1.35 + f * 2.05, 0.25, 0.55 + (piece % 2) * 0.35);
      } else {
        const f = (life - 0.64) / 0.36;
        const conductive = piece % 2 === 0;
        const u = 0.7 + f * (conductive ? 1.0 : 0.55);
        const v = 0.25 - Math.sin(f * Math.PI) * (conductive ? 0.85 : 0.28) + f * 0.45;
        plot(u, v, conductive ? 0.95 : 0.55);
      }
    }
    /* The splitter makes the two landing bins unambiguous. */
    for (let y = 0; y <= 7; y += 1) plot(1.18, 0.25 + (y / 7) * 0.65, 0.48);
  });
}

/* -- Magnetic belt: ferrous pieces climbing away from the waste stream ---- */

function paintMagneticBelt(t: number): string {
  return paintPlotted((plot) => {
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, 0.68, 0.45);
    for (let s = 0; s <= 30; s += 1) {
      const f = s / 30;
      plot(-1.15 + f * 2.3, -0.62 + Math.sin(f * Math.PI) * 0.18, 0.58);
    }
    for (let roller = 0; roller < 2; roller += 1) {
      const ru = -1.15 + roller * 2.3;
      for (let a = 0; a <= 14; a += 1) {
        const angle = (a / 14) * TAU;
        plot(ru + Math.cos(angle) * 0.17, -0.59 + Math.sin(angle) * 0.16, 0.6);
      }
    }
    for (let item = 0; item < 11; item += 1) {
      const f = (t * 0.22 + item / 11) % 1;
      if (item % 3 === 0 && f > 0.28) {
        const lift = clamp01((f - 0.28) * 3);
        const u = -1.15 + f * 2.3;
        const beltV = -0.62 + Math.sin(f * Math.PI) * 0.18;
        plot(u, 0.58 + (beltV - 0.58) * lift, 0.95);
        if (f > 0.9) plot(u, beltV + (f - 0.9) * 4, 0.75);
      } else {
        plot(-1.55 + f * 3.1, 0.58, 0.55);
      }
    }
    for (let y = 0; y <= 7; y += 1) plot(1.35, 0.25 + (y / 7) * 0.64, 0.4);
  });
}

/* -- Glass crusher: counter-moving jaws reducing bottles to cullet -------- */

function paintGlassCrusher(t: number): string {
  return paintPlotted((plot) => {
    const crush = 0.5 + Math.sin(t * 1.3) * 0.5;
    for (let side = -1; side <= 1; side += 2) {
      const inner = side * (0.5 - crush * 0.28);
      for (let y = 0; y <= 12; y += 1) {
        const v = -0.55 + (y / 12) * 0.92;
        const u = inner + side * Math.abs(v + 0.1) * 0.55;
        plot(u, v, 0.75);
        if (y % 3 === 0) plot(u - side * 0.16, v, 0.95);
      }
    }
    for (let bottle = 0; bottle < 4; bottle += 1) {
      const life = (t * 0.33 + bottle / 4) % 1;
      if (life < 0.56) {
        const v = -0.9 + (life / 0.56) * 0.75;
        const u = (bottle - 1.5) * 0.24;
        for (let y = 0; y <= 4; y += 1) plot(u, v + (y / 4) * 0.25, 0.62);
        plot(u - 0.09, v + 0.24, 0.5);
        plot(u + 0.09, v + 0.24, 0.5);
      } else {
        for (let shard = 0; shard < 4; shard += 1) {
          const fall = (life - 0.56) / 0.44;
          plot((hash(bottle * 7 + shard) - 0.5) * (0.35 + fall), 0.1 + fall * 0.72, (1 - fall * 0.5) * 0.8);
        }
      }
    }
    for (let x = 0; x <= 22; x += 1) plot(-0.85 + (x / 22) * 1.7, 0.85, 0.48);
  });
}

/* -- Can baler: loose cans compressed and the finished bale ejected ------- */

function paintCanBaler(t: number): string {
  return paintPlotted((plot) => {
    const cycle = (t * 0.28) % 1;
    const close = cycle < 0.45 ? cycle / 0.45 : cycle < 0.7 ? 1 : clamp01(1 - (cycle - 0.7) / 0.2);
    const eject = clamp01((cycle - 0.82) / 0.18);
    for (let y = 0; y <= 15; y += 1) {
      plot(-1.25, -0.7 + (y / 15) * 1.5, 0.48);
      plot(0.72, -0.7 + (y / 15) * 1.5, 0.48);
    }
    for (let x = 0; x <= 18; x += 1) plot(-1.18 + (x / 18) * 1.82, 0.78, 0.5);
    const platenV = -0.62 + close * 0.9;
    for (let x = 0; x <= 17; x += 1) plot(-1.12 + (x / 17) * 1.7, platenV, 0.85);
    for (let y = 0; y <= 7; y += 1) plot(-0.28, -0.86 + (y / 7) * (platenV + 0.86), 0.65);
    for (let can = 0; can < 10; can += 1) {
      const row = Math.floor(can / 5);
      const u = -1 + (can % 5) * 0.34 + eject * 1.8;
      const v = 0.62 - row * (0.18 - close * 0.08);
      plot(u, v, 0.55 + close * 0.35);
      plot(u + 0.12 * (1 - close), v, 0.5);
    }
    for (let x = 0; x <= 12; x += 1) plot(0.72 + (x / 12) * 0.85, 0.78, 0.38);
  });
}

/* -- Bottle sorter: a star wheel metering containers into two lanes ------- */

function paintBottleSorter(t: number): string {
  return paintPlotted((plot) => {
    const turn = t * 1.5;
    for (let pocket = 0; pocket < 8; pocket += 1) {
      const angle = turn + (pocket / 8) * TAU;
      for (let r = 0; r <= 7; r += 1) {
        const f = r / 7;
        plot(Math.cos(angle) * f * 0.72, Math.sin(angle) * f * 0.56, 0.48 + f * 0.35);
      }
      plot(Math.cos(angle) * 0.78, Math.sin(angle) * 0.61, 0.9);
    }
    for (let x = 0; x <= 13; x += 1) plot(-1.55 + (x / 13) * 0.75, 0.02, 0.5);
    for (let lane = -1; lane <= 1; lane += 2) {
      for (let s = 0; s <= 14; s += 1) {
        const f = s / 14;
        plot(0.72 + f * 0.82, lane * 0.28 + f * lane * 0.34, 0.48);
      }
    }
    for (let bottle = 0; bottle < 6; bottle += 1) {
      const life = (t * 0.23 + bottle / 6) % 1;
      if (life < 0.4) {
        const u = -1.5 + (life / 0.4) * 0.75;
        plot(u, 0, 0.75);
        plot(u, -0.13, 0.55);
      } else if (life > 0.7) {
        const f = (life - 0.7) / 0.3;
        const lane = bottle % 2 ? -1 : 1;
        plot(0.72 + f * 0.8, lane * (0.28 + f * 0.34), 0.85);
      }
    }
  });
}

/* -- Paper pulper: sheets disappearing into a churning hydrapulper -------- */

function paintPaperPulper(t: number): string {
  return paintPlotted((plot) => {
    for (let a = 0; a <= 44; a += 1) {
      const angle = (a / 44) * Math.PI;
      plot(Math.cos(angle) * 1.32, 0.02 + Math.sin(angle) * 0.82, 0.52);
    }
    for (let x = 0; x <= 28; x += 1) plot(-1.32 + (x / 28) * 2.64, 0.03, 0.6);
    for (let spiral = 0; spiral < 3; spiral += 1) {
      for (let s = 0; s <= 36; s += 1) {
        const f = s / 36;
        const angle = t * 2.3 + spiral * (TAU / 3) + f * TAU * 1.4;
        const radius = 0.12 + f * 0.9;
        plot(Math.cos(angle) * radius, 0.35 + Math.sin(angle) * radius * 0.48, 0.35 + (1 - f) * 0.48);
      }
    }
    for (let sheet = 0; sheet < 4; sheet += 1) {
      const life = (t * 0.24 + sheet / 4) % 1;
      if (life < 0.7) {
        const v = -0.92 + (life / 0.7) * 1.25;
        const u = -0.78 + sheet * 0.5 + Math.sin(life * TAU + sheet) * 0.1;
        const shrink = 1 - life * 0.65;
        for (let x = 0; x <= 5; x += 1) plot(u - 0.22 * shrink + (x / 5) * 0.44 * shrink, v, 0.75);
      }
    }
    plot(Math.cos(t * 2.3) * 0.18, 0.36 + Math.sin(t * 2.3) * 0.1, 1);
  });
}

/* -- Trawl winch: twin drums hauling a loaded net onto the quay ----------- */

function paintTrawlWinch(t: number): string {
  return paintPlotted((plot) => {
    for (let drum = 0; drum < 2; drum += 1) {
      const du = -0.72 + drum * 1.02;
      for (let a = 0; a <= 24; a += 1) {
        const angle = (a / 24) * TAU;
        plot(du + Math.cos(angle) * 0.38, -0.12 + Math.sin(angle) * 0.36, 0.62);
      }
      for (let spoke = 0; spoke < 5; spoke += 1) {
        const angle = t * 2.2 + (spoke / 5) * TAU;
        for (let r = 0; r <= 6; r += 1) plot(du + Math.cos(angle) * (r / 6) * 0.34, -0.12 + Math.sin(angle) * (r / 6) * 0.32, 0.48);
      }
    }
    const load = 0.5 + Math.sin(t * 0.55) * 0.5;
    for (let s = 0; s <= 22; s += 1) {
      const f = s / 22;
      plot(0.68 + f * 0.9, 0.05 + f * (0.7 - load * 0.75), 0.7);
    }
    const netV = 0.72 - load * 0.75;
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        plot(1.08 + col * 0.09 + (row % 2) * 0.045, netV + row * 0.08, 0.42 + ((row + col) % 3) * 0.18);
      }
    }
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, 0.88, 0.4);
  });
}

/* -- Net mender: a needle carrying twine across a torn mesh ---------------- */

function paintNetMender(t: number): string {
  return paintPlotted((plot) => {
    const rows = 6;
    const cols = 10;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const u = -1.45 + col * 0.32 + (row % 2) * 0.16;
        const v = -0.72 + row * 0.28;
        /* Leave one diamond open until the shuttle crosses it. */
        if (!((row === 2 || row === 3) && (col === 4 || col === 5))) plot(u, v, 0.45);
      }
    }
    const stitch = (t * 0.42) % 1;
    const needleU = -0.35 + stitch * 1.05;
    const needleV = -0.12 + Math.sin(stitch * TAU) * 0.24;
    for (let s = 0; s <= 8; s += 1) plot(needleU - 0.28 + (s / 8) * 0.56, needleV, 0.95);
    for (let s = 0; s <= 22; s += 1) {
      const f = s / 22;
      const end = Math.min(f, stitch);
      plot(-0.42 + end * 1.1, -0.18 + Math.sin(end * TAU) * 0.2, 0.75);
    }
    if (stitch > 0.55) {
      for (let s = 0; s <= 12; s += 1) {
        const f = s / 12;
        plot(-0.05 + f * 0.42, -0.34 + Math.abs(f - 0.5) * 0.5, 0.65);
      }
    }
  });
}

/* -- Fish auction: lots advancing while the price clock counts down ------- */

function paintFishAuction(t: number): string {
  return paintPlotted((plot) => {
    const lot = Math.floor(t * 0.25);
    const price = 1 - ((t * 0.55) % 1);
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, 0.68, 0.45);
    for (let crate = 0; crate < 4; crate += 1) {
      const u = -1.4 + (((crate + lot) % 4) / 3) * 2.8;
      for (let x = 0; x <= 7; x += 1) {
        plot(u - 0.28 + (x / 7) * 0.56, 0.51, crate === lot % 4 ? 0.9 : 0.55);
        plot(u - 0.28 + (x / 7) * 0.56, 0.78, 0.45);
      }
      plot(u - 0.28, 0.62, 0.5);
      plot(u + 0.28, 0.62, 0.5);
      plot(u - 0.08, 0.6, 0.75);
      plot(u + 0.08, 0.6, 0.75);
    }
    const clockU = 0;
    const clockV = -0.4;
    for (let a = 0; a <= 30; a += 1) {
      const angle = (a / 30) * TAU;
      plot(clockU + Math.cos(angle) * 0.5, clockV + Math.sin(angle) * 0.42, 0.62);
    }
    const hand = -Math.PI / 2 + price * TAU;
    for (let r = 0; r <= 8; r += 1) plot(clockU + Math.cos(hand) * (r / 8) * 0.4, clockV + Math.sin(hand) * (r / 8) * 0.33, 0.95);
    plot(clockU, clockV, 1);
  });
}

/* -- Ice chute: blocks sliding down to a waiting fish box ----------------- */

function paintIceChute(t: number): string {
  return paintPlotted((plot) => {
    for (let rail = 0; rail < 2; rail += 1) {
      for (let s = 0; s <= 28; s += 1) {
        const f = s / 28;
        plot(-1.45 + f * 2.25, -0.72 + f * 1.02 + rail * 0.17, 0.48);
      }
    }
    for (let block = 0; block < 5; block += 1) {
      const life = (t * 0.3 + block / 5) % 1;
      if (life < 0.76) {
        const f = life / 0.76;
        const u = -1.38 + f * 2.15;
        const v = -0.77 + f * 1.02;
        plot(u, v, 0.95);
        plot(u + 0.13, v + 0.05, 0.68);
        plot(u - 0.1, v + 0.08, 0.58);
      } else {
        const fall = (life - 0.76) / 0.24;
        plot(0.8 + fall * 0.16, 0.28 + fall * 0.42, 0.8);
      }
    }
    for (let x = 0; x <= 18; x += 1) {
      plot(0.45 + (x / 18) * 1.05, 0.62, 0.6);
      plot(0.45 + (x / 18) * 1.05, 0.88, 0.46);
    }
    for (let y = 0; y <= 5; y += 1) {
      plot(0.45, 0.62 + (y / 5) * 0.26, 0.5);
      plot(1.5, 0.62 + (y / 5) * 0.26, 0.5);
    }
  });
}

/* -- Crab pot: a baited cage descending below the harbour surface --------- */

function paintCrabPot(t: number): string {
  return paintPlotted((plot) => {
    const cycle = 0.5 + Math.sin(t * 0.5) * 0.5;
    const potV = -0.3 + cycle * 0.95;
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, -0.58 + Math.sin(x * 1.3 + t * 1.4) * 0.05, 0.35);
    for (let y = 0; y <= 16; y += 1) plot(0, -0.9 + (y / 16) * (potV + 0.9), 0.68);
    for (let x = 0; x <= 18; x += 1) {
      const u = -0.62 + (x / 18) * 1.24;
      plot(u, potV, 0.72);
      plot(u, potV + 0.44, 0.56);
    }
    for (let side = -1; side <= 1; side += 2) {
      for (let y = 0; y <= 7; y += 1) plot(side * 0.62, potV + (y / 7) * 0.44, 0.62);
    }
    for (let rib = -2; rib <= 2; rib += 1) {
      for (let y = 0; y <= 6; y += 1) plot(rib * 0.2, potV + (y / 6) * 0.44, 0.34);
    }
    for (let bubble = 0; bubble < 8; bubble += 1) {
      const life = (t * 0.45 + hash(bubble)) % 1;
      plot(0.1 + (hash(bubble * 3.2) - 0.5) * 0.9, potV - life * 1.1, (1 - life) * cycle * 0.7);
    }
  });
}

/* -- Harbour crane: a slewing jib transferring a crate ashore ------------- */

function paintHarbourCrane(t: number): string {
  return paintPlotted((plot) => {
    const slew = 0.5 + Math.sin(t * 0.45) * 0.5;
    const tipU = -1.18 + slew * 2.35;
    const tipV = -0.58 + Math.abs(slew - 0.5) * 0.18;
    for (let y = 0; y <= 17; y += 1) plot(0, -0.72 + (y / 17) * 1.55, 0.55);
    for (let s = 0; s <= 26; s += 1) {
      const f = s / 26;
      plot(f * tipU, -0.68 + f * (tipV + 0.68), 0.72);
      if (s % 4 === 0) plot(f * tipU, -0.5 + f * (tipV + 0.48), 0.35);
    }
    const lift = 0.5 + Math.sin(t * 0.9 + 0.8) * 0.5;
    const crateV = tipV + 0.28 + lift * 0.75;
    for (let y = 0; y <= 10; y += 1) plot(tipU, tipV + (y / 10) * (crateV - tipV), 0.65);
    for (let x = 0; x <= 8; x += 1) {
      plot(tipU - 0.28 + (x / 8) * 0.56, crateV, 0.8);
      plot(tipU - 0.28 + (x / 8) * 0.56, crateV + 0.28, 0.55);
    }
    plot(tipU - 0.28, crateV + 0.14, 0.62);
    plot(tipU + 0.28, crateV + 0.14, 0.62);
    for (let x = 0; x <= 30; x += 1) plot(-1.55 + (x / 30) * 3.1, 0.88, 0.4);
  });
}

/* -- Slipway boat: a hull climbing the greased rails ---------------------- */

function paintSlipwayBoat(t: number): string {
  return paintPlotted((plot) => {
    const travel = 0.5 + Math.sin(t * 0.42) * 0.5;
    for (let rail = 0; rail < 2; rail += 1) {
      for (let s = 0; s <= 28; s += 1) {
        const f = s / 28;
        plot(-1.5 + f * 3, 0.85 - f * 0.88 + rail * 0.12, 0.42);
      }
    }
    for (let roller = 0; roller < 8; roller += 1) {
      const f = roller / 7;
      plot(-1.35 + f * 2.7, 0.85 - f * 0.8, 0.55 + Math.sin(t * 4 + roller) * 0.22);
    }
    const boatU = -1.05 + travel * 2.1;
    const boatV = 0.58 - travel * 0.62;
    for (let s = 0; s <= 24; s += 1) {
      const f = s / 24;
      const u = boatU - 0.78 + f * 1.56;
      const keel = boatV + Math.sin(f * Math.PI) * 0.33;
      plot(u, keel, 0.8);
      if (f > 0.14 && f < 0.86) plot(u, boatV - 0.06, 0.55);
    }
    for (let y = 0; y <= 6; y += 1) plot(boatU, boatV - 0.06 - (y / 6) * 0.52, 0.65);
    for (let x = 0; x <= 9; x += 1) plot(boatU - 0.1 + (x / 9) * 0.62, boatV - 0.42, 0.55);
    /* The winch cable shortens as the hull climbs the slip. */
    for (let s = 0; s <= 14; s += 1) {
      const f = s / 14;
      plot(boatU + 0.75 + f * (1.58 - boatU - 0.75), boatV + f * (-0.7 - boatV), 0.45);
    }
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
  stateless(paintDandelion),
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
  /* The second collection. Same contract as everything above it: a pure
     function of elapsed seconds, so all but the simulations stay shared. */
  stateless(paintIcosahedron),
  stateless(paintPyramid),
  stateless(paintTesseract),
  stateless(paintMobius),
  stateless(paintCone),
  stateless(paintSphereSpiral),
  stateless(paintGimbal),
  stateless(paintSpinningTop),
  stateless(paintTimesTable),
  stateless(paintEpitrochoid),
  stateless(paintPhyllotaxis),
  stateless(paintHilbert),
  stateless(paintHarmonograph),
  stateless(paintNautilus),
  stateless(paintNewtonsCradle),
  stateless(paintPong),
  stateless(paintRocket),
  stateless(paintSnowfall),
  stateless(paintTree),
  stateless(paintJuggler),
  stateless(paintDominoes),
  stateless(paintCarousel),
  stateless(paintRollercoaster),
  stateless(paintPaperPlane),
  stateless(paintPistons),
  stateless(paintMetronome),
  stateless(paintFerrisWheel),
  stateless(paintSwarm),
  stateless(paintKoi),
  stateless(paintConveyor),
  stateless(paintWindChime),
  field(lavaLampField),
  field(smokeField),
  field(turingField),
  field(marbleField),
  field(contourField),
  field(thinFilmField),
  field(vortexStreetField),
  field(nebulaField),
  field(crystalField),
  field(saddleField),
  field(zebraField),
  field(sunriseField),
  field(beaconField),
  stateless(paintCityscape),
  stateless(paintBlockDrop),
  stateless(paintLoadingBars),
  stateless(paintSorting),
  stateless(paintTypewriter),
  stateless(paintPunchTape),
  /* The third collection: weather and material fields, more solids, and a
     bench of small machines. Same contract as everything above. */
  field(inkBloomField),
  field(magmaField),
  field(frostField),
  field(oceanSwellField),
  field(pulsarField),
  field(wormholeField),
  field(heatHazeField),
  field(bokehField),
  field(gasGiantField),
  field(sandRippleField),
  field(stormFrontField),
  field(oilSlickField),
  field(dropletsField),
  field(weaveField),
  stateless(paintAntiprism),
  stateless(paintCuboctahedron),
  stateless(paintHanoi),
  stateless(paintTorusKnot),
  stateless(paintHyperboloid),
  stateless(paintSuperellipse),
  stateless(paintAstroid),
  stateless(paintAnemone),
  stateless(paintKite),
  stateless(paintSailboat),
  stateless(paintLighthouse),
  stateless(paintCrane),
  stateless(paintSeesaw),
  stateless(paintTrampoline),
  stateless(paintYoyo),
  stateless(paintSpinningCoin),
  stateless(paintHummingbird),
  stateless(paintCaterpillar),
  stateless(paintOctopus),
  stateless(paintSpiderWeb),
  stateless(paintRadioTower),
  stateless(paintHotAirBalloon),
  stateless(paintParachute),
  stateless(paintSubmarine),
  stateless(paintTrain),
  stateless(paintBicycle),
  stateless(paintChainDrive),
  stateless(paintScales),
  stateless(paintCompass),
  stateless(paintCandle),
  stateless(paintHeartbeat),
  stateless(paintSeismograph),
  stateless(paintSevenSegment),
  stateless(paintDiskDefrag),
  stateless(paintPachinko),
  stateless(paintWaterTank),
  /* The fourth collection: light and water fields, then a workshop of
     machines, rides, and throws. Same contract as everything above. */
  field(tidePoolField),
  field(steamVentField),
  field(cavernField),
  field(spectrogramField),
  field(domainWallField),
  field(rainGlassField),
  field(emberBedField),
  field(moonPhaseField),
  field(laserGridField),
  field(pollenDriftField),
  field(stainedGlassField),
  field(waterfallField),
  field(plasmaArcField),
  field(mudCrackField),
  field(fireflyField),
  field(whirlpoolField),
  field(blizzardField),
  field(canyonField),
  stateless(paintWaterWheel),
  stateless(paintTrebuchet),
  stateless(paintDrawbridge),
  stateless(paintElevator),
  stateless(paintEscalator),
  stateless(paintGovernor),
  stateless(paintLathe),
  stateless(paintSewingMachine),
  stateless(paintDotMatrix),
  stateless(paintRobotArm),
  stateless(paintDrone),
  stateless(paintZipline),
  stateless(paintSwingSet),
  stateless(paintPinwheel),
  stateless(paintRatchet),
  stateless(paintFidgetSpinner),
  stateless(paintAbacus),
  stateless(paintBowling),
  stateless(paintHoopShot),
  stateless(paintJumpRope),
  stateless(paintFlag),
  stateless(paintSparkler),
  stateless(paintVolcano),
  stateless(paintSpaceStation),
  stateless(paintLunarLander),
  stateless(paintDolphin),
  stateless(paintSlinky),
  stateless(paintMarbleRun),
  stateless(paintSundial),
  stateless(paintHydraulicPress),
  stateless(paintAnvil),
  stateless(paintPumpJack),
  /* The fifth collection: sky and surface fields, then a yard of machines,
     rides, and small performances. Same contract as everything above. */
  field(solarFlareField),
  field(iceFloeField),
  field(reedBedField),
  field(radioStaticField),
  field(phosphorDecayField),
  field(bubbleChamberField),
  field(sunspotField),
  field(starTrailField),
  field(glacierField),
  field(murmurationField),
  field(chladniField),
  field(targetWaveField),
  field(sunbeamField),
  field(dustDevilField),
  field(honeyDripField),
  field(slimeMouldField),
  field(plasmaGlobeField),
  field(treeRingField),
  stateless(paintWindTurbine),
  stateless(paintPileDriver),
  stateless(paintCuckooClock),
  stateless(paintRowboat),
  stateless(paintCableCar),
  stateless(paintTractor),
  stateless(paintExcavator),
  stateless(paintCementMixer),
  stateless(paintPrintingPress),
  stateless(paintPenPlotter),
  stateless(paintTurntable),
  stateless(paintCassetteReels),
  stateless(paintFilmProjector),
  stateless(paintLoom),
  stateless(paintPotterWheel),
  stateless(paintWaterClock),
  stateless(paintPinball),
  stateless(paintPoolBreak),
  stateless(paintSkiJump),
  stateless(paintSurfer),
  stateless(paintSkateRamp),
  stateless(paintPogoStick),
  stateless(paintUnicycle),
  stateless(paintTightrope),
  stateless(paintTrapeze),
  stateless(paintGyroscope),
  stateless(paintOrrery),
  stateless(paintTelescope),
  stateless(paintWeatherVane),
  stateless(paintFishingRod),
  stateless(paintBeeDance),
  stateless(paintAntTrail),
  /* The sixth collection: deep water and ground fields, then a row of
     vehicles, instruments, and games. Same contract as everything above. */
  field(abyssalVentField),
  field(kelpForestField),
  field(stalactiteField),
  field(filingsField),
  field(soapFilmField),
  field(neonTubeField),
  field(coralPolypField),
  field(jetStreamField),
  field(saltFlatField),
  field(swampGasField),
  field(quicksandField),
  field(fogBankField),
  field(hailBurstField),
  field(tidalBoreField),
  field(magnetosphereField),
  field(bacterialLawnField),
  field(cavitationField),
  field(sedimentCoreField),
  stateless(paintPaddleSteamer),
  stateless(paintTramCar),
  stateless(paintForklift),
  stateless(paintClawMachine),
  stateless(paintVendingMachine),
  stateless(paintEspressoMachine),
  stateless(paintZoetrope),
  stateless(paintBellows),
  stateless(paintPipeOrgan),
  stateless(paintHarp),
  stateless(paintDrumKit),
  stateless(paintXylophone),
  stateless(paintMusicBox),
  stateless(paintTheremin),
  stateless(paintTuningFork),
  stateless(paintDartboard),
  stateless(paintFoosball),
  stateless(paintAirHockey),
  stateless(paintRouletteWheel),
  stateless(paintDiceRoll),
  stateless(paintJenga),
  stateless(paintCardShuffle),
  stateless(paintKendama),
  stateless(paintPlough),
  stateless(paintCombine),
  stateless(paintGondola),
  stateless(paintHovercraft),
  stateless(paintRallyCar),
  stateless(paintFunicular),
  stateless(paintCarWash),
  stateless(paintRivetGun),
  stateless(paintCherryPicker),
  /* The seventh collection: high air and restless ground fields, then a
     workshop, a kitchen, and a sports field. */
  field(thermalColumnField),
  field(haboobField),
  field(noctilucentField),
  field(airglowField),
  field(sunPillarField),
  field(cirrusField),
  field(hydrothermalPoolField),
  field(permafrostField),
  field(peatFireField),
  field(geyserBasinField),
  field(obsidianFlowField),
  field(tideRipField),
  field(planktonBloomField),
  field(mangroveRootField),
  field(squallLineField),
  field(crevasseField),
  field(mirageLakeField),
  field(alluvialFanField),
  stateless(paintBandSaw),
  stateless(paintDrillPress),
  stateless(paintAngleGrinder),
  stateless(paintBenchVise),
  stateless(paintSolderingIron),
  stateless(paintOscilloscope),
  stateless(paintMetalDetector),
  stateless(paintKickScooter),
  stateless(paintPaintRoller),
  stateless(paintCoffeeGrinder),
  stateless(paintToaster),
  stateless(paintBlender),
  stateless(paintPopcornMaker),
  stateless(paintPancakeFlip),
  stateless(paintEggTimer),
  stateless(paintTeapot),
  stateless(paintWaffleIron),
  stateless(paintKnifeSharpener),
  stateless(paintArchery),
  stateless(paintCurlingStone),
  stateless(paintPoleVault),
  stateless(paintHighDive),
  stateless(paintKayakRoll),
  stateless(paintBoxingBag),
  stateless(paintTennisRally),
  stateless(paintGolfSwing),
  stateless(paintKickflip),
  stateless(paintHangGlider),
  stateless(paintZeppelin),
  stateless(paintSnowplough),
  stateless(paintStreetSweeper),
  stateless(paintLevelCrossing),
  /* The eighth collection: high air and underground fields, then a
     laboratory, a bakery, a winter station, and the works at a mine and a
     canal. */
  field(contrailField),
  field(virgaField),
  field(mammatusField),
  field(lenticularField),
  field(fogbowField),
  field(sinkholeField),
  field(mineSeamField),
  field(lavaTubeField),
  field(caveDripField),
  field(aquiferField),
  field(geodeField),
  field(brineChannelField),
  field(sastrugiField),
  field(rimeIceField),
  field(estuaryField),
  field(seaStackField),
  field(wrackLineField),
  field(sandbarField),
  stateless(paintCentrifuge),
  stateless(paintMicroscope),
  stateless(paintPipette),
  stateless(paintBunsenBurner),
  stateless(paintMagneticStirrer),
  stateless(paintVacuumPump),
  stateless(paintFumeHood),
  stateless(paintAutoclave),
  stateless(paintChromatograph),
  stateless(paintGeigerCounter),
  stateless(paintDoughMixer),
  stateless(paintRollingPin),
  stateless(paintBreadOven),
  stateless(paintIcingPipe),
  stateless(paintWhisk),
  stateless(paintPastaExtruder),
  stateless(paintDishwasher),
  stateless(paintIceResurfacer),
  stateless(paintSnowCannon),
  stateless(paintToboggan),
  stateless(paintIceCoreDrill),
  stateless(paintWeatherBalloon),
  stateless(paintDogSled),
  stateless(paintSkiTow),
  stateless(paintMineCart),
  stateless(paintPitHeadWheel),
  stateless(paintOreCrusher),
  stateless(paintBucketWheel),
  stateless(paintLockGate),
  stateless(paintSwingBridge),
  stateless(paintFishLadder),
  stateless(paintRopeFerry),
  /* The ninth collection: fields from small living things, then a
     glassworks, a foundry, a dairy, a vineyard, and a night market. */
  field(pondSkaterField),
  field(dewWebField),
  field(sporePrintField),
  field(mossCushionField),
  field(lichenCrustField),
  field(rootHairField),
  field(barnacleCirriField),
  field(glowWormField),
  field(cicadaChorusField),
  field(beeSwarmField),
  field(snailTrailField),
  field(wingScaleField),
  field(krillSwarmField),
  field(tadpoleShoalField),
  field(antRaftField),
  stateless(paintGlassBlower),
  stateless(paintFloatGlass),
  stateless(paintAnnealingLehr),
  stateless(paintGlassCane),
  stateless(paintBottleMould),
  stateless(paintGlassMarver),
  stateless(paintGlassShears),
  stateless(paintCrucible),
  stateless(paintLadlePour),
  stateless(paintSandMould),
  stateless(paintIngotRoll),
  stateless(paintQuenchBath),
  stateless(paintPowerHammer),
  stateless(paintWireDraw),
  stateless(paintMilkChurn),
  stateless(paintCheesePress),
  stateless(paintCreamSeparator),
  stateless(paintEggGrader),
  stateless(paintHayBaler),
  stateless(paintSheepShears),
  stateless(paintHoneyExtractor),
  stateless(paintGrapePress),
  stateless(paintBarrelRoll),
  stateless(paintCorker),
  stateless(paintBottlingLine),
  stateless(paintTeaPour),
  stateless(paintCoffeeSiphon),
  stateless(paintCocktailShaker),
  stateless(paintNoodlePull),
  stateless(paintWokToss),
  stateless(paintSkewerGrill),
  stateless(paintLanternString),
  stateless(paintShavedIce),
  stateless(paintCandyFloss),
  stateless(paintDumplingSteamer),
  /* The tenth collection: fields from ink, paper and materials under strain,
     then a print shop, a tailor's, a garage, a fairground, and a theatre. */
  field(halftoneField),
  field(darkroomField),
  field(capillaryField),
  field(foamHeadField),
  field(rustBloomField),
  field(craquelureField),
  field(dendriteField),
  field(boilField),
  field(chalkboardField),
  field(watermarkField),
  field(smogLayerField),
  field(bioluminWakeField),
  field(zodiacalLightField),
  field(gravLensField),
  field(tokamakField),
  stateless(paintLinotype),
  stateless(paintScreenPrint),
  stateless(paintGuillotine),
  stateless(paintFoldingMachine),
  stateless(paintSaddleStitcher),
  stateless(paintInkFountain),
  stateless(paintPaperReel),
  stateless(paintPinkingShears),
  stateless(paintButtonhole),
  stateless(paintSteamPress),
  stateless(paintTapeMeasure),
  stateless(paintZipPull),
  stateless(paintDressForm),
  stateless(paintCarLift),
  stateless(paintTyreChange),
  stateless(paintWheelBalancer),
  stateless(paintEngineHoist),
  stateless(paintOilDrain),
  stateless(paintSprayBooth),
  stateless(paintJumpStart),
  stateless(paintWaltzer),
  stateless(paintSwingBoat),
  stateless(paintHelterSkelter),
  stateless(paintCoconutShy),
  stateless(paintHookADuck),
  stateless(paintStrengthTester),
  stateless(paintGhostTrain),
  stateless(paintTeacups),
  stateless(paintStageCurtain),
  stateless(paintSpotlightRig),
  stateless(paintTrapDoor),
  stateless(paintFlyTower),
  stateless(paintRevolveStage),
  stateless(paintPuppetStrings),
  stateless(paintOrchestraPit),
  /* The eleventh collection: distant atmosphere, marine light and microscopic
     life, followed by an airport, watch bench, machine hall, recycling plant,
     and fishing quay. */
  field(tephraFallField),
  field(machDiamondField),
  field(vortexRingField),
  field(sunGlitterField),
  field(stElmoField),
  field(greenFlashField),
  field(thermoclineField),
  field(siphonophoreField),
  field(nacreField),
  field(chromatophoreField),
  field(diatomField),
  field(mitosisField),
  field(ciliaField),
  field(stomataField),
  field(brownianField),
  stateless(paintPushbackTug),
  stateless(paintJetBridge),
  stateless(paintBaggageLoader),
  stateless(paintDeicingBoom),
  stateless(paintWindsock),
  stateless(paintRunwayLights),
  stateless(paintAirStairs),
  stateless(paintEscapement),
  stateless(paintBalanceWheel),
  stateless(paintMainspringWind),
  stateless(paintWatchGearTrain),
  stateless(paintJewelPress),
  stateless(paintLoupeInspection),
  stateless(paintCasePolisher),
  stateless(paintLineShaft),
  stateless(paintShaperRam),
  stateless(paintMillingTable),
  stateless(paintSurfaceGrinder),
  stateless(paintTurretIndexer),
  stateless(paintBroachPress),
  stateless(paintChainHoist),
  stateless(paintTrommelScreen),
  stateless(paintEddySeparator),
  stateless(paintMagneticBelt),
  stateless(paintGlassCrusher),
  stateless(paintCanBaler),
  stateless(paintBottleSorter),
  stateless(paintPaperPulper),
  stateless(paintTrawlWinch),
  stateless(paintNetMender),
  stateless(paintFishAuction),
  stateless(paintIceChute),
  stateless(paintCrabPot),
  stateless(paintHarbourCrane),
  stateless(paintSlipwayBoat),
];
