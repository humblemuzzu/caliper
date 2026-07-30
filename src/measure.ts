import type { Image } from "./png.ts";
import type { Box } from "./vision.ts";

/**
 * Seven measurement primitives. Every one of them earned its place by being
 * needed repeatedly when porting a design to code.
 *
 * All thresholds are parameters with documented defaults, never module
 * constants. The defaults here — ink at 170 on a light background, Inter's
 * 0.727 cap ratio — are true of one design language and one typeface. Baking
 * them in would make the library quietly lie on the next project.
 */

function assertInside(img: Image, box: Box): void {
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > img.width ||
    box.y + box.height > img.height
  ) {
    throw new Error(
      `box ${box.x},${box.y} ${box.width}×${box.height} falls outside ${img.width}×${img.height}`,
    );
  }
}

/**
 * Whether a pixel counts as a mark. `invert` swaps the sense for light-on-dark
 * sections, where the marks are the bright pixels; `coverage` calls the same
 * predicate "lit" because a halftone's marks are the bright ones.
 *
 * The two branches are exact complements — `<= t` against `> t`, not `>= t` —
 * so that a threshold chosen by Otsu, which splits levels into `<= t` and
 * `> t`, means the same thing whichever way round the section is. Using `>=`
 * here made an inverted Otsu mask select every pixel and report 100% coverage.
 */
function isInk(value: number, threshold: number, invert: boolean): boolean {
  return invert ? value > threshold : value <= threshold;
}

export interface Band {
  top: number;
  bottom: number;
  height: number;
  xStart: number;
  xEnd: number;
}

export interface BandsOptions {
  box: Box;
  /** Grey level at or below which a pixel is ink. 170 separates text from a light UI background. */
  threshold?: number;
  /** Runs shorter than this are antialiasing crumbs, not lines. */
  minHeight?: number;
  /** Set for light-on-dark sections, where ink is the bright pixels. */
  invert?: boolean;
}

/**
 * Contiguous runs of rows that contain ink, in absolute image coordinates.
 *
 * One call over a section recovers every text baseline and every vertical gap
 * in it, which is the measurement the rest of the workflow is built on: the
 * gaps between consecutive bands are the design's spacing scale.
 */
export function bands(img: Image, opts: BandsOptions): Band[] {
  const { box, threshold = 170, minHeight = 4, invert = false } = opts;
  assertInside(img, box);

  const found: Band[] = [];
  let top = -1;
  let xStart = Number.POSITIVE_INFINITY;
  let xEnd = Number.NEGATIVE_INFINITY;

  const flush = (bottom: number) => {
    const height = bottom - top + 1;
    if (top >= 0 && height >= minHeight) {
      found.push({ top, bottom, height, xStart, xEnd });
    }
    top = -1;
    xStart = Number.POSITIVE_INFINITY;
    xEnd = Number.NEGATIVE_INFINITY;
  };

  for (let y = box.y; y < box.y + box.height; y += 1) {
    let rowStart = -1;
    let rowEnd = -1;
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (!isInk(img.gray[y * img.width + x] as number, threshold, invert)) continue;
      if (rowStart < 0) rowStart = x;
      rowEnd = x;
    }
    if (rowStart < 0) {
      if (top >= 0) flush(y - 1);
      continue;
    }
    if (top < 0) top = y;
    xStart = Math.min(xStart, rowStart);
    xEnd = Math.max(xEnd, rowEnd);
  }
  if (top >= 0) flush(box.y + box.height - 1);
  return found;
}

export interface CapsOptions {
  box: Box;
  threshold?: number;
  /**
   * Cap height ÷ em. 0.727 is Inter's, measured from its metrics (capHeight
   * 2048 units against a 2816 unit em). Every family differs — Helvetica is
   * 0.717, Georgia 0.692 — so this must be passed for anything but Inter.
   */
  capRatio?: number;
  invert?: boolean;
}

/**
 * Cap height of the tallest band in the box, and the font size it implies.
 *
 * Give it a box holding one line of text. Descenders and ascenders that reach
 * past the cap line inflate the reading, so a box around "Pricing" measures
 * true and one around "Pricing pages" does not.
 */
export function caps(img: Image, opts: CapsOptions): { capHeight: number; fontSize: number } {
  const { box, threshold = 170, capRatio = 0.727, invert = false } = opts;
  // minHeight 1: the tallest run is wanted, and filtering short runs first
  // could only ever remove a candidate that was not going to win.
  const rows = bands(img, { box, threshold, minHeight: 1, invert });
  const capHeight = rows.reduce((tallest, band) => Math.max(tallest, band.height), 0);
  return { capHeight, fontSize: capHeight / capRatio };
}

export interface InkWidthOptions {
  box: Box;
  threshold?: number;
  invert?: boolean;
}

/**
 * Horizontal extent of ink in the box, in pixels.
 *
 * The most reliable font-size recovery available: measure the same string in
 * the reference and in your own render, and the ratio of the two widths is the
 * ratio of the font sizes. It needs no cap ratio, no baseline, and no guess
 * about which typeface is in the screenshot.
 */
export function inkWidth(img: Image, opts: InkWidthOptions): number {
  const { box, threshold = 170, invert = false } = opts;
  assertInside(img, box);
  let first = -1;
  let last = -1;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (!isInk(img.gray[y * img.width + x] as number, threshold, invert)) continue;
      if (first < 0 || x < first) first = x;
      if (x > last) last = x;
    }
  }
  return first < 0 ? 0 : last - first + 1;
}

export interface EdgesOptions {
  /** Scan across this row. Exactly one of row/col must be given. */
  row?: number;
  /** Scan down this column. */
  col?: number;
  /** How much darker than both neighbourhoods a position must be. 1.5 levels finds a #e9e9e9 border on #fafafa. */
  depth?: number;
  /** Neighbourhood size on each side, in pixels. */
  window?: number;
  /** Inclusive [start, end] along the scan axis. Defaults to the whole line. */
  range?: [number, number];
}

/**
 * Positions along one row or column that are darker than both neighbourhoods
 * by at least `depth`.
 *
 * This finds borders that no threshold can: a #fafafa card on a #fafafa page,
 * separated by a #e9e9e9 hairline, differs from its surroundings by three
 * levels out of 255. Absolute level says "all background"; a local minimum says
 * "there is an edge exactly here".
 *
 * A border several pixels wide produces several qualifying positions. They are
 * collapsed to the run's centre, because three numbers for one border is not a
 * measurement anybody can use.
 */
/**
 * The row or column of grey values to scan. Taking exactly one of row/col is
 * enforced here rather than in the type, because the alternative — a
 * discriminated union — reads worse at every call site than `{ row: 420 }`.
 */
function lineValues(img: Image, row: number | undefined, col: number | undefined): Uint8Array {
  if (row !== undefined && col === undefined) {
    if (row < 0 || row >= img.height) throw new Error(`row ${row} is outside 0..${img.height - 1}`);
    return img.gray.subarray(row * img.width, (row + 1) * img.width);
  }
  if (col !== undefined && row === undefined) {
    if (col < 0 || col >= img.width) throw new Error(`col ${col} is outside 0..${img.width - 1}`);
    const values = new Uint8Array(img.height);
    for (let y = 0; y < img.height; y += 1) values[y] = img.gray[y * img.width + col] as number;
    return values;
  }
  throw new Error("edges needs exactly one of row or col");
}

export function edges(img: Image, opts: EdgesOptions): number[] {
  const { depth = 1.5, window = 3, range } = opts;
  const values = lineValues(img, opts.row, opts.col);

  const [start, end] = range ?? [0, values.length - 1];
  if (start < 0 || end >= values.length || start > end) {
    throw new Error(`range ${start}..${end} falls outside 0..${values.length - 1}`);
  }

  const mean = (from: number, to: number): number => {
    let total = 0;
    for (let i = from; i <= to; i += 1) total += values[i] as number;
    return total / (to - from + 1);
  };

  const hits: number[] = [];
  for (let i = start + window; i <= end - window; i += 1) {
    const here = values[i] as number;
    if (here <= mean(i - window, i - 1) - depth && here <= mean(i + 1, i + window) - depth) {
      hits.push(i);
    }
  }

  // Collapse each run of qualifying positions to its centre: an n-pixel border
  // is uniformly dark, so every pixel in it qualifies and none is more central
  // than the middle one.
  const centres: number[] = [];
  let runStart = -1;
  for (let i = 0; i < hits.length; i += 1) {
    const current = hits[i] as number;
    if (runStart < 0) runStart = current;
    if (hits[i + 1] !== current + 1) {
      centres.push(Math.round((runStart + current) / 2));
      runStart = -1;
    }
  }
  return centres;
}

export interface ModalOptions {
  box: Box;
}

export interface ModalColour {
  hex: string;
  hsv: { h: number; s: number; v: number };
  matched: number;
  total: number;
  /** matched ÷ total. Read this before trusting the hex. */
  confidence: number;
}

function toHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let h = 0;
  if (span !== 0) {
    if (max === r) h = 60 * (((g - b) / span + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / span + 2);
    else h = 60 * ((r - g) / span + 4);
  }
  return {
    h: Math.round(h),
    s: max === 0 ? 0 : Math.round((span / max) * 100),
    v: Math.round((max / 255) * 100),
  };
}

/**
 * The most common exact colour in the box.
 *
 * `confidence` is not decoration. A rectangular sample of a TILTED pill picks
 * up more page than pill and returns the card colour behind it; that reading
 * was once used to confirm a design token, and the token was wrong. A sample
 * that is 60% page announces itself here instead of two days later.
 */
export function modal(img: Image, opts: ModalOptions): ModalColour {
  const { box } = opts;
  assertInside(img, box);

  const counts = new Map<number, number>();
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const at = (y * img.width + x) * 3;
      const key =
        ((img.rgb[at] as number) << 16) | ((img.rgb[at + 1] as number) << 8) | (img.rgb[at + 2] as number);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }

  let best = 0;
  let matched = 0;
  for (const [key, count] of counts) {
    if (count > matched) {
      best = key;
      matched = count;
    }
  }

  const r = (best >> 16) & 255;
  const g = (best >> 8) & 255;
  const b = best & 255;
  return {
    hex: `#${best.toString(16).padStart(6, "0")}`,
    hsv: toHsv(r, g, b),
    matched,
    total,
    confidence: matched / total,
  };
}

export interface FieldOptions {
  box: Box;
  /** Window side length. 12px is about one halftone cell at the pitches used in print-styled UI. */
  cell?: number;
  /** Step between windows. Defaults to `cell`, i.e. non-overlapping. */
  stride?: number;
}

/**
 * Standard deviation of grey within each cell — a map of where texture exists.
 *
 * Mean brightness cannot tell a faint texture from a flat tint of the same
 * average value. Standard deviation can, which is the difference between
 * "the noise layer did not render" and "the noise layer is subtle".
 */
export function field(img: Image, opts: FieldOptions): { grid: number[][]; ascii: string } {
  const { box, cell = 12 } = opts;
  const stride = opts.stride ?? cell;
  assertInside(img, box);

  const grid: number[][] = [];
  for (let y = box.y; y + cell <= box.y + box.height; y += stride) {
    const row: number[] = [];
    for (let x = box.x; x + cell <= box.x + box.width; x += stride) {
      let sum = 0;
      let sumSquares = 0;
      for (let cy = y; cy < y + cell; cy += 1) {
        for (let cx = x; cx < x + cell; cx += 1) {
          const value = img.gray[cy * img.width + cx] as number;
          sum += value;
          sumSquares += value * value;
        }
      }
      const count = cell * cell;
      const mean = sum / count;
      row.push(Math.sqrt(Math.max(0, sumSquares / count - mean * mean)));
    }
    grid.push(row);
  }

  return { grid, ascii: grid.map((row) => row.map(rampChar).join("")).join("\n") };
}

/**
 * Absolute, not relative, breakpoints. Normalising the ramp to the box's own
 * maximum would draw a confident picture of pure sensor noise, which defeats
 * the point of asking whether any texture is there at all.
 */
const FIELD_LEVELS = [0.5, 1, 2, 4, 8, 16, 32];
const FIELD_CHARS = " .:-=+*#";

function rampChar(deviation: number): string {
  const level = FIELD_LEVELS.findIndex((limit) => deviation < limit);
  return (level === -1 ? FIELD_CHARS[FIELD_CHARS.length - 1] : FIELD_CHARS[level]) as string;
}

/** Otsu's method: the level that best splits the box into two classes. */
function otsuThreshold(img: Image, box: Box): number {
  const histogram = new Array<number>(256).fill(0);
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const value = img.gray[y * img.width + x] as number;
      histogram[value] = (histogram[value] as number) + 1;
      total += 1;
    }
  }
  let sum = 0;
  for (let level = 0; level < 256; level += 1) sum += level * (histogram[level] as number);

  let belowWeight = 0;
  let belowSum = 0;
  let bestVariance = -1;
  let best = 127;
  for (let level = 0; level < 256; level += 1) {
    belowWeight += histogram[level] as number;
    if (belowWeight === 0) continue;
    const aboveWeight = total - belowWeight;
    if (aboveWeight === 0) break;
    belowSum += level * (histogram[level] as number);
    const variance =
      belowWeight * aboveWeight * (belowSum / belowWeight - (sum - belowSum) / aboveWeight) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}

/**
 * Binary max (dilate) or min (erode) over a square window, via a summed-area
 * table so the cost does not depend on the radius.
 *
 * The window is clamped at the image border rather than treating the outside as
 * empty. A full-bleed texture's silhouette is the whole frame, and an eroding
 * border would eat a margin that has no counterpart in the design.
 */
function morph(mask: Uint8Array, width: number, height: number, radius: number, fill: boolean): Uint8Array {
  const integral = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += mask[y * width + x] as number;
      integral[(y + 1) * (width + 1) + x + 1] =
        (integral[y * (width + 1) + x + 1] as number) + rowSum;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count =
        (integral[(y1 + 1) * (width + 1) + x1 + 1] as number) -
        (integral[y0 * (width + 1) + x1 + 1] as number) -
        (integral[(y1 + 1) * (width + 1) + x0] as number) +
        (integral[y0 * (width + 1) + x0] as number);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      out[y * width + x] = (fill ? count > 0 : count === area) ? 1 : 0;
    }
  }
  return out;
}

export interface CoverageOptions {
  box: Box;
  /** Number of horizontal bands to split the box into. */
  bands?: number;
  /** Lit-pixel threshold. Defaults to Otsu over the box, because a varying dot size shifts any fixed level. */
  threshold?: number;
  /** Dilation radius. Must exceed half the lattice pitch, or the dots never merge into a silhouette. */
  dilate?: number;
  /** Erosion radius. Smaller than the dilation, so the silhouette stays slightly generous. */
  erode?: number;
  /** Set when the marks are the bright pixels, which is the usual case for a halftone. */
  invert?: boolean;
}

/**
 * Lit pixels ÷ silhouette pixels, per horizontal band.
 *
 * This is how you measure a halftone whose DOT SIZE varies down the image.
 * Average brightness cannot: it mixes the dots with the gaps between them and
 * reports one number that a smaller dot on a lighter background can imitate
 * exactly. Coverage divides by the area the dots actually occupy, recovered by
 * dilating the lit mask until the lattice closes and then eroding back.
 */
export function coverage(
  img: Image,
  opts: CoverageOptions,
): { band: number; coverage: number }[] {
  const { box, bands: bandCount = 12, dilate = 11, erode = 8, invert = false } = opts;
  assertInside(img, box);
  const threshold = opts.threshold ?? otsuThreshold(img, box);

  const lit = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const value = img.gray[(box.y + y) * img.width + box.x + x] as number;
      lit[y * box.width + x] = isInk(value, threshold, invert) ? 1 : 0;
    }
  }
  const closed = morph(morph(lit, box.width, box.height, dilate, true), box.width, box.height, erode, false);

  const bandHeight = Math.floor(box.height / bandCount);
  const out: { band: number; coverage: number }[] = [];
  for (let band = 0; band < bandCount; band += 1) {
    const from = band * bandHeight;
    const to = band === bandCount - 1 ? box.height : from + bandHeight;
    let litCount = 0;
    let silhouette = 0;
    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        if (!closed[y * box.width + x]) continue;
        silhouette += 1;
        if (lit[y * box.width + x]) litCount += 1;
      }
    }
    out.push({ band, coverage: silhouette === 0 ? 0 : litCount / silhouette });
  }
  return out;
}
