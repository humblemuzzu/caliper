import { type Image, luma } from "./png.ts";

/**
 * Synthetic images whose measurements are known by construction.
 *
 * Real screenshots make bad fixtures: they live in a cache that gets cleared,
 * they are large, and their "true" values are estimates read off by eye. A
 * generated image has an exact answer, so a test can assert equality instead of
 * a range, and a regression cannot hide inside a generous tolerance.
 */

interface Canvas {
  width: number;
  height: number;
  rgb: Uint8Array;
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`expected a #rrggbb colour, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function canvas(width: number, height: number, fill: string): Canvas {
  const [r, g, b] = parseHex(fill);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

function plot(c: Canvas, x: number, y: number, colour: [number, number, number], alpha: number) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const at = (y * c.width + x) * 3;
  const keep = 1 - alpha;
  c.rgb[at] = Math.round(colour[0] * alpha + (c.rgb[at] as number) * keep);
  c.rgb[at + 1] = Math.round(colour[1] * alpha + (c.rgb[at + 1] as number) * keep);
  c.rgb[at + 2] = Math.round(colour[2] * alpha + (c.rgb[at + 2] as number) * keep);
}

function rect(c: Canvas, x: number, y: number, w: number, h: number, hex: string) {
  const colour = parseHex(hex);
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) plot(c, px, py, colour, 1);
  }
}

/**
 * Hard-edged disc: a pixel is in or out, never partly in. Antialiasing would
 * make the dot area depend on the rasteriser's filter, and these fixtures exist
 * so that the area is exactly countable.
 */
function disc(c: Canvas, cx: number, cy: number, radius: number, hex: string, alpha: number) {
  const colour = parseHex(hex);
  const limit = radius * radius;
  for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy += 1) {
    for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx += 1) {
      if (dx * dx + dy * dy <= limit) plot(c, cx + dx, cy + dy, colour, alpha);
    }
  }
}

function finish(c: Canvas): Image {
  const gray = new Uint8Array(c.width * c.height);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = luma(c.rgb[i * 3] as number, c.rgb[i * 3 + 1] as number, c.rgb[i * 3 + 2] as number);
  }
  return { width: c.width, height: c.height, rgb: c.rgb, gray };
}

interface DotFieldSpec {
  width: number;
  height: number;
  pitch: number;
  radius: number;
  ink: string;
  bg: string;
  /** Blend factor for the dots. Below ~0.15 the field is the "faint texture" case. */
  alpha: number;
}

/** A regular lattice of discs. Coverage is πr²/pitch², textured everywhere. */
export function dotField(spec: DotFieldSpec): Image {
  const c = canvas(spec.width, spec.height, spec.bg);
  const offset = Math.floor(spec.pitch / 2);
  for (let cy = offset; cy < spec.height; cy += spec.pitch) {
    for (let cx = offset; cx < spec.width; cx += spec.pitch) {
      disc(c, cx, cy, spec.radius, spec.ink, spec.alpha);
    }
  }
  return finish(c);
}

interface BandSpec {
  y: number;
  h: number;
  /** Horizontal extent, so one fixture serves bands, caps and inkWidth. */
  x?: number;
  w?: number;
}

interface BandStackSpec {
  width: number;
  height: number;
  bands: BandSpec[];
  ink: string;
  bg: string;
}

/** Solid horizontal bars standing in for lines of text at known baselines. */
export function bandStack(spec: BandStackSpec): Image {
  const c = canvas(spec.width, spec.height, spec.bg);
  for (const band of spec.bands) {
    rect(c, band.x ?? 0, band.y, band.w ?? spec.width, band.h, spec.ink);
  }
  return finish(c);
}

interface CardSpec {
  width: number;
  height: number;
  x: number;
  cardWidth: number;
  fill: string;
  page: string;
  border: string;
  borderWidth: number;
}

/**
 * A card on a page, both of which may be the same colour.
 *
 * This exists to prove a specific failure is handled: with fill and page both
 * #fafafa and a #e9e9e9 border, the card is separated from the page by three
 * levels out of 255. No ink threshold can find that edge — the test asserts
 * `bands` finds nothing — while `edges`, which looks for a local minimum rather
 * than an absolute level, finds both borders exactly.
 */
export function card(spec: CardSpec): Image {
  const c = canvas(spec.width, spec.height, spec.page);
  rect(c, spec.x, 0, spec.cardWidth, spec.height, spec.fill);
  rect(c, spec.x, 0, spec.borderWidth, spec.height, spec.border);
  rect(c, spec.x + spec.cardWidth - spec.borderWidth, 0, spec.borderWidth, spec.height, spec.border);
  return finish(c);
}

export interface HalftoneRampSpec {
  width: number;
  height: number;
  pitch: number;
  rTop: number;
  rBottom: number;
  /** y at which the radius sits halfway between rTop and rBottom. */
  midpoint: number;
  /** Logistic growth rate, per pixel of y. */
  steepness: number;
  ink: string;
  bg: string;
}

/** The radius the ramp has at a given row — the exact curve a test compares against. */
export function rampRadius(spec: HalftoneRampSpec, y: number): number {
  return (
    spec.rTop + (spec.rBottom - spec.rTop) / (1 + Math.exp(-spec.steepness * (y - spec.midpoint)))
  );
}

/**
 * A halftone whose DOT SIZE follows a logistic ramp down the image while the
 * lattice pitch stays fixed. Mean brightness and coverage disagree about this
 * image, which is the point: coverage recovers the ramp, brightness averages it
 * away against the background.
 */
export function halftoneRamp(spec: HalftoneRampSpec): Image {
  const c = canvas(spec.width, spec.height, spec.bg);
  const offset = Math.floor(spec.pitch / 2);
  for (let cy = offset; cy < spec.height; cy += spec.pitch) {
    const radius = rampRadius(spec, cy);
    for (let cx = offset; cx < spec.width; cx += spec.pitch) {
      disc(c, cx, cy, radius, spec.ink, 1);
    }
  }
  return finish(c);
}

interface TiltedPillSpec {
  width: number;
  height: number;
  cx: number;
  cy: number;
  pillWidth: number;
  pillHeight: number;
  /** Rotation in degrees. Zero would make a rectangular sample honest. */
  angle: number;
  fill: string;
  page: string;
}

/**
 * A rotated pill on a page.
 *
 * This exists to prove a specific failure is handled: sampling a tilted shape
 * with an axis-aligned box picks up more page than pill, so `modal` returns the
 * PAGE colour. That reading was once used to confirm a design token, and the
 * token was wrong. The test asserts the confidence is low enough for the bad
 * sample to announce itself.
 */
export function tiltedPill(spec: TiltedPillSpec): Image {
  const c = canvas(spec.width, spec.height, spec.page);
  const fill = parseHex(spec.fill);
  const radians = (spec.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfW = spec.pillWidth / 2;
  const halfH = spec.pillHeight / 2;
  const radius = halfH;
  const straight = halfW - radius;
  for (let y = 0; y < spec.height; y += 1) {
    for (let x = 0; x < spec.width; x += 1) {
      // Rotate the sample point into the pill's own frame; a pill is the set of
      // points within `radius` of its centre segment.
      const dx = x - spec.cx;
      const dy = y - spec.cy;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const nearest = Math.max(-straight, Math.min(straight, localX));
      const distX = localX - nearest;
      if (distX * distX + localY * localY <= radius * radius) plot(c, x, y, fill, 1);
    }
  }
  return finish(c);
}

interface GradientSpec {
  width: number;
  height: number;
  from: string;
  to: string;
}

/**
 * A vertical linear gradient — smooth everywhere, with no local minimum
 * anywhere. `edges` must return nothing for it, which is the false-positive
 * half of the border-detection contract.
 */
export function gradient(spec: GradientSpec): Image {
  const c = canvas(spec.width, spec.height, spec.from);
  const [r0, g0, b0] = parseHex(spec.from);
  const [r1, g1, b1] = parseHex(spec.to);
  for (let y = 0; y < spec.height; y += 1) {
    const t = spec.height === 1 ? 0 : y / (spec.height - 1);
    const colour: [number, number, number] = [
      Math.round(r0 + (r1 - r0) * t),
      Math.round(g0 + (g1 - g0) * t),
      Math.round(b0 + (b1 - b0) * t),
    ];
    for (let x = 0; x < spec.width; x += 1) plot(c, x, y, colour, 1);
  }
  return finish(c);
}
