/**
 * Builds Android launcher layers from the official swimming-duck logo.
 *
 * Adaptive icons crop their foreground differently on every launcher. The
 * foreground generated here keeps the duck inside Android's central safe zone,
 * while legacy launchers receive complete rounded-square and circular tiles.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "src-tauri", "icons", "Square310x310Logo.png");
const RES = path.join(ROOT, "android", "app", "src", "main", "res");
const source = PNG.sync.read(readFileSync(SOURCE));
const CROP = { left: 28, top: 88, right: 288, bottom: 210 };
const GREEN = [123, 224, 90, 255];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function duckAlpha(x, y) {
  const sx = Math.max(0, Math.min(source.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(source.height - 1, Math.round(y)));
  const offset = (sy * source.width + sx) * 4;
  const alpha = source.data[offset + 3] / 255;
  const light = (source.data[offset] + source.data[offset + 1] + source.data[offset + 2]) / 3;
  return clamp01((78 - light) / 42) * alpha;
}

function blendPixel(png, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height || alpha <= 0) return;
  const offset = (y * png.width + x) * 4;
  const destinationAlpha = png.data[offset + 3] / 255;
  const outputAlpha = alpha + destinationAlpha * (1 - alpha);
  for (let channel = 0; channel < 3; channel += 1) {
    png.data[offset + channel] = Math.round(
      (color[channel] * alpha + png.data[offset + channel] * destinationAlpha * (1 - alpha)) /
        Math.max(outputAlpha, 0.0001),
    );
  }
  png.data[offset + 3] = Math.round(outputAlpha * 255);
}

function insideTile(x, y, size, shape) {
  const padding = size * 0.02;
  const left = padding;
  const right = size - padding;
  if (shape === "round") {
    const radius = (right - left) / 2;
    return Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= radius;
  }
  const radius = size * 0.22;
  const px = Math.max(left + radius, Math.min(right - radius, x + 0.5));
  const py = Math.max(left + radius, Math.min(right - radius, y + 0.5));
  return Math.hypot(x + 0.5 - px, y + 0.5 - py) <= radius;
}

function paintDuck(png, widthShare) {
  const cropWidth = CROP.right - CROP.left;
  const cropHeight = CROP.bottom - CROP.top;
  const drawWidth = png.width * widthShare;
  const drawHeight = drawWidth * (cropHeight / cropWidth);
  const left = (png.width - drawWidth) / 2;
  const top = (png.height - drawHeight) / 2;
  for (let y = Math.floor(top); y < Math.ceil(top + drawHeight); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(left + drawWidth); x += 1) {
      const sourceX = CROP.left + ((x + 0.5 - left) / drawWidth) * cropWidth;
      const sourceY = CROP.top + ((y + 0.5 - top) / drawHeight) * cropHeight;
      blendPixel(png, x, y, [12, 17, 12], duckAlpha(sourceX, sourceY));
    }
  }
}

function legacy(size, shape) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (insideTile(x, y, size, shape)) blendPixel(png, x, y, GREEN);
    }
  }
  paintDuck(png, 0.68);
  return png;
}

function foreground(size) {
  const png = new PNG({ width: size, height: size });
  paintDuck(png, 0.56);
  return png;
}

const densities = {
  mdpi: { legacy: 48, foreground: 108 },
  hdpi: { legacy: 72, foreground: 162 },
  xhdpi: { legacy: 96, foreground: 216 },
  xxhdpi: { legacy: 144, foreground: 324 },
  xxxhdpi: { legacy: 192, foreground: 432 },
};

for (const [density, sizes] of Object.entries(densities)) {
  const directory = path.join(RES, `mipmap-${density}`);
  mkdirSync(directory, { recursive: true });
  const assets = {
    "ic_launcher.png": legacy(sizes.legacy, "square"),
    "ic_launcher_round.png": legacy(sizes.legacy, "round"),
    "ic_launcher_foreground.png": foreground(sizes.foreground),
  };
  for (const [name, png] of Object.entries(assets)) {
    writeFileSync(path.join(directory, name), PNG.sync.write(png));
  }
}

console.log("Generated Android launcher assets with adaptive-icon safe-zone padding.");
