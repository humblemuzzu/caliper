import { type Image, luma } from "./png.ts";
import type { Size } from "./vision.ts";

/**
 * Area-average (box filter) downscale.
 *
 * Lanczos and bicubic ring on hard edges, and a UI screenshot is nothing but
 * hard edges — text stems, 1px borders, button outlines. The ringing shows up
 * as a light halo that shifts where a threshold thinks the edge is, which
 * corrupts the very measurements this library exists to take. Area averaging
 * has no negative lobes, so it cannot ring, and it is what a browser
 * approximates when it draws an <img> smaller than its natural size.
 *
 * Upscaling throws rather than returning something. Enlarging a measurement
 * source invents pixels that were never captured; every caller that has asked
 * for it has been wrong about which image was the reference.
 */
export function downscale(img: Image, to: Size): Image {
  if (to.width > img.width || to.height > img.height) {
    throw new Error(
      `downscale cannot enlarge: ${img.width}×${img.height} → ${to.width}×${to.height}`,
    );
  }
  if (to.width <= 0 || to.height <= 0) {
    throw new Error(`downscale target must be positive, got ${to.width}×${to.height}`);
  }
  if (to.width === img.width && to.height === img.height) return img;

  const xRatio = img.width / to.width;
  const yRatio = img.height / to.height;
  const rgb = new Uint8Array(to.width * to.height * 3);

  for (let dy = 0; dy < to.height; dy += 1) {
    const yStart = dy * yRatio;
    const yEnd = (dy + 1) * yRatio;
    for (let dx = 0; dx < to.width; dx += 1) {
      const xStart = dx * xRatio;
      const xEnd = (dx + 1) * xRatio;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let sy = Math.floor(yStart); sy < Math.ceil(yEnd); sy += 1) {
        const yWeight = Math.min(sy + 1, yEnd) - Math.max(sy, yStart);
        for (let sx = Math.floor(xStart); sx < Math.ceil(xEnd); sx += 1) {
          const weight = yWeight * (Math.min(sx + 1, xEnd) - Math.max(sx, xStart));
          const at = (sy * img.width + sx) * 3;
          r += (img.rgb[at] as number) * weight;
          g += (img.rgb[at + 1] as number) * weight;
          b += (img.rgb[at + 2] as number) * weight;
          total += weight;
        }
      }
      const out = (dy * to.width + dx) * 3;
      rgb[out] = Math.round(r / total);
      rgb[out + 1] = Math.round(g / total);
      rgb[out + 2] = Math.round(b / total);
    }
  }

  const gray = new Uint8Array(to.width * to.height);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = luma(rgb[i * 3] as number, rgb[i * 3 + 1] as number, rgb[i * 3 + 2] as number);
  }
  return { width: to.width, height: to.height, rgb, gray };
}
