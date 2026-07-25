// Generates assets/icon.png (1024x1024) with no image dependencies.
// `bun run gen:icon` feeds it to `tauri icon`, which produces every platform size.
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

/** Distance from point p to the segment a-b. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

// Palette: violet -> cyan diagonal gradient on a rounded square, with a white
// prompt chevron and caret bar.
const FROM = [124, 92, 255];
const TO = [33, 212, 253];
const INK = [250, 251, 255];

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const bg = roundedRectDist(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 210);
    const bgA = 1 - smoothstep(-1.2, 1.2, bg);

    const t = clamp01((x / SIZE) * 0.65 + (y / SIZE) * 0.35);
    let r = lerp(FROM[0], TO[0], t);
    let g = lerp(FROM[1], TO[1], t);
    let b = lerp(FROM[2], TO[2], t);

    // Subtle radial darkening so the mark reads on light backgrounds too.
    const vig = 1 - 0.18 * clamp01(Math.hypot(x - SIZE / 2, y - SIZE / 2) / (SIZE * 0.72));
    r *= vig;
    g *= vig;
    b *= vig;

    // Chevron `>`
    const d1 = segDist(x, y, 318, 326, 556, 512);
    const d2 = segDist(x, y, 556, 512, 318, 698);
    const chevron = 1 - smoothstep(38, 40.5, Math.min(d1, d2));

    // Caret bar `_`
    const bar = 1 - smoothstep(-1, 1, roundedRectDist(x, y, 700, 672, 116, 30, 30));

    const ink = Math.max(chevron, bar);
    r = lerp(r, INK[0], ink);
    g = lerp(g, INK[1], ink);
    b = lerp(b, INK[2], ink);

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
