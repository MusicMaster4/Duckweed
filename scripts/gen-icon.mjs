// Generates assets/icon.png (1024x1024) with no image dependencies.
// `bun run gen:icon` feeds it to `tauri icon`, which produces every platform size.
//
// The Duckweed mark: a cluster of floating fronds — the little oval pond plant
// the app is named after — with one root trailing down to a bar that doubles as
// the waterline and a prompt caret. Drawn on the app's near-black surface with
// a green rim. Everything is signed distance fields, antialiased by
// smoothstepping the distance, so it stays crisp down to the 32px favicon.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SIZE = 1024;

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Signed distance to a rotated ellipse. There is no closed form, so this uses
 * the standard first-order estimate: how far the implicit value sits from the
 * boundary, divided by the gradient there. It is only accurate near the edge,
 * which is exactly where the antialiasing samples it.
 */
function ellipseDist(px, py, cx, cy, rx, ry, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = px - cx;
  const dy = py - cy;
  const x = dx * c + dy * s;
  const y = -dx * s + dy * c;
  const k = Math.hypot(x / rx, y / ry);
  if (k === 0) return -Math.min(rx, ry);
  const grad = Math.hypot(x / (rx * rx), y / (ry * ry));
  return (k - 1) / grad;
}

// Palette: the app's own surfaces, with the accent green as the fronds.
const BG_TOP = [26, 34, 24];
const BG_BOTTOM = [14, 18, 13];
const FROND_LIT = [157, 240, 125];
const FROND_DEEP = [74, 155, 50];
const RIM = [123, 224, 90];

const CX = SIZE / 2;

/*
 * Five fronds drifting on the surface. Every position is deliberately unequal
 * and off-axis: three big ovals in a triangle read as a face, and any mirrored
 * pair reads as eyes, so no two here share a size or sit level with each other.
 * The gaps are load-bearing too — the fronds are all one colour, so anything
 * that touches merges into one unreadable blob.
 */
const FRONDS = [
  { cx: 335, cy: 330, rx: 132, ry: 104, angle: -0.28 },
  { cx: 610, cy: 268, rx: 104, ry: 82, angle: 0.3 },
  { cx: 700, cy: 480, rx: 116, ry: 90, angle: -0.18 },
  { cx: 420, cy: 545, rx: 122, ry: 96, angle: 0.22 },
  { cx: 620, cy: 690, rx: 74, ry: 58, angle: -0.35 },
];

/** Where the root leaves the colony — under the large lower-left frond. */
const ROOT_X = 430;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const bg = roundedRectDist(x, y, CX, CX, SIZE / 2, SIZE / 2, 210);
    const bgA = 1 - smoothstep(-1.2, 1.2, bg);

    // Surface: a soft vertical gradient, lighter at the top.
    const t = clamp01(y / SIZE);
    let r = lerp(BG_TOP[0], BG_BOTTOM[0], t);
    let g = lerp(BG_TOP[1], BG_BOTTOM[1], t);
    let b = lerp(BG_TOP[2], BG_BOTTOM[2], t);

    // Green rim just inside the edge, so the tile has a shape on dark docks.
    const rim = 1 - smoothstep(7, 11, Math.abs(bg + 9));
    r = lerp(r, RIM[0], rim * 0.42);
    g = lerp(g, RIM[1], rim * 0.42);
    b = lerp(b, RIM[2], rim * 0.42);

    let leaf = Infinity;
    for (const { cx, cy, rx, ry, angle } of FRONDS) {
      leaf = Math.min(leaf, ellipseDist(x, y, cx, cy, rx, ry, angle));
    }
    // A single root trailing from the colony down into the water. It meets the
    // bar off-centre on purpose — a root dead-centre under a symmetric bar
    // turns the whole mark into a lollipop.
    const root = roundedRectDist(x, y, ROOT_X, 730, 7, 92, 7);
    // The bar reads two ways: the waterline the colony floats on, and the
    // caret of a prompt.
    const caret = roundedRectDist(x, y, CX, 840, 124, 25, 25);
    const ink = 1 - smoothstep(-1.4, 1.4, Math.min(leaf, root, caret));

    // Vertical gradient through the mark: lit at the top, deeper near the water.
    const shade = clamp01((y - 230) / 620);
    r = lerp(r, lerp(FROND_LIT[0], FROND_DEEP[0], shade), ink);
    g = lerp(g, lerp(FROND_LIT[1], FROND_DEEP[1], shade), ink);
    b = lerp(b, lerp(FROND_LIT[2], FROND_DEEP[2], shade), ink);

    raw[o++] = Math.round(r);
    raw[o++] = Math.round(g);
    raw[o++] = Math.round(b);
    raw[o++] = Math.round(bgA * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = resolve(import.meta.dirname ?? ".", "..", "assets", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);
