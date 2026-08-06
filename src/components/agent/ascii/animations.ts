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
];
