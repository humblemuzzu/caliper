import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { Box } from "./vision.ts";

/**
 * A decoded image, ready to measure. `rgb` is 3 bytes per pixel; `gray` is one.
 *
 * Grayscale is computed once at load rather than on demand because every
 * measurement primitive except `modal` reads it, and recomputing luma per
 * lookup dominated the runtime of the first version.
 */
export interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
  gray: Uint8Array;
}

/**
 * Rec.709 luma. Rec.601 (0.299/0.587/0.114) is the other common choice and
 * would shift every threshold in measure.ts, because it weights red half again
 * as heavily. 709 matches sRGB, which is what a browser renders and what a
 * screenshot therefore contains.
 */
export function luma(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function grayscale(rgb: Uint8Array, pixels: number): Uint8Array {
  const gray = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    gray[i] = luma(rgb[i * 3] as number, rgb[i * 3 + 1] as number, rgb[i * 3 + 2] as number);
  }
  return gray;
}

export function load(path: string): Image {
  const png = PNG.sync.read(readFileSync(path));
  const pixels = png.width * png.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const alpha = png.data[i * 4 + 3] as number;
    // Flatten onto white. A screenshot's transparent regions are page
    // background, and leaving them at 0 would read as ink to every threshold.
    for (let channel = 0; channel < 3; channel += 1) {
      const value = png.data[i * 4 + channel] as number;
      rgb[i * 3 + channel] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width: png.width, height: png.height, rgb, gray: grayscale(rgb, pixels) };
}

export function save(img: Image, path: string): void {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.width * img.height; i += 1) {
    png.data[i * 4] = img.rgb[i * 3] as number;
    png.data[i * 4 + 1] = img.rgb[i * 3 + 1] as number;
    png.data[i * 4 + 2] = img.rgb[i * 3 + 2] as number;
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

export function crop(img: Image, box: Box): Image {
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > img.width ||
    box.y + box.height > img.height
  ) {
    throw new Error(
      `crop box ${box.x},${box.y} ${box.width}×${box.height} falls outside ${img.width}×${img.height}`,
    );
  }
  const rgb = new Uint8Array(box.width * box.height * 3);
  const gray = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y += 1) {
    const from = (box.y + y) * img.width + box.x;
    gray.set(img.gray.subarray(from, from + box.width), y * box.width);
    rgb.set(img.rgb.subarray(from * 3, (from + box.width) * 3), y * box.width * 3);
  }
  return { width: box.width, height: box.height, rgb, gray };
}
