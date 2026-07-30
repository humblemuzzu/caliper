import { describe, expect, test } from "bun:test";
import {
  bandStack,
  card,
  dotField,
  gradient,
  halftoneRamp,
  type HalftoneRampSpec,
  rampRadius,
  tiltedPill,
} from "./fixtures.ts";
import { bands, caps, coverage, edges, field, inkWidth, modal } from "./measure.ts";
import type { Box } from "./vision.ts";

const whole = (width: number, height: number): Box => ({ x: 0, y: 0, width, height });

describe("bands", () => {
  const stack = bandStack({
    width: 200,
    height: 300,
    bands: [
      { y: 20, h: 24 },
      { y: 80, h: 16 },
      { y: 140, h: 40 },
    ],
    ink: "#111111",
    bg: "#ffffff",
  });

  test("recovers every band's top, bottom and height exactly", () => {
    expect(bands(stack, { box: whole(200, 300) })).toEqual([
      { top: 20, bottom: 43, height: 24, xStart: 0, xEnd: 199 },
      { top: 80, bottom: 95, height: 16, xStart: 0, xEnd: 199 },
      { top: 140, bottom: 179, height: 40, xStart: 0, xEnd: 199 },
    ]);
  });

  test("the gaps between bands are the design's spacing scale", () => {
    const found = bands(stack, { box: whole(200, 300) });
    const gaps = found.slice(1).map((band, i) => band.top - (found[i] as { bottom: number }).bottom - 1);
    expect(gaps).toEqual([36, 44]);
  });

  test("minHeight drops runs too short to be a line of text", () => {
    const noisy = bandStack({
      width: 100,
      height: 100,
      bands: [
        { y: 10, h: 2 },
        { y: 40, h: 20 },
      ],
      ink: "#000000",
      bg: "#ffffff",
    });
    expect(bands(noisy, { box: whole(100, 100) }).map((b) => b.height)).toEqual([20]);
    expect(bands(noisy, { box: whole(100, 100), minHeight: 1 }).map((b) => b.height)).toEqual([2, 20]);
  });

  test("invert reads a light-on-dark section identically", () => {
    const dark = bandStack({
      width: 200,
      height: 300,
      bands: [
        { y: 20, h: 24 },
        { y: 80, h: 16 },
        { y: 140, h: 40 },
      ],
      ink: "#ffffff",
      bg: "#111111",
    });
    expect(bands(dark, { box: whole(200, 300), invert: true })).toEqual(
      bands(stack, { box: whole(200, 300) }),
    );
  });

  test("xStart and xEnd bound the ink horizontally", () => {
    const indented = bandStack({
      width: 200,
      height: 60,
      bands: [{ y: 10, h: 20, x: 30, w: 140 }],
      ink: "#000000",
      bg: "#ffffff",
    });
    expect(bands(indented, { box: whole(200, 60) })).toEqual([
      { top: 10, bottom: 29, height: 20, xStart: 30, xEnd: 169 },
    ]);
  });

  test("the box, not the image, bounds the measurement", () => {
    const found = bands(stack, { box: { x: 0, y: 60, width: 200, height: 60 } });
    expect(found.map((band) => band.top)).toEqual([80]);
  });

  test("a box outside the image is a programmer error", () => {
    expect(() => bands(stack, { box: whole(400, 300) })).toThrow(/falls outside/);
  });
});

describe("caps", () => {
  const heading = bandStack({
    width: 200,
    height: 60,
    bands: [{ y: 10, h: 22, x: 20, w: 120 }],
    ink: "#000000",
    bg: "#ffffff",
  });

  test("cap height is the tallest band, and font size follows the cap ratio", () => {
    const measured = caps(heading, { box: whole(200, 60) });
    expect(measured.capHeight).toBe(22);
    // Inter: 22 / 0.727 = 30.26px, which reads as a 30px heading.
    expect(measured.fontSize).toBeCloseTo(30.26, 2);
  });

  test("a different typeface needs its own cap ratio", () => {
    // Georgia's 0.692 turns the same 22px cap into a 31.8px font.
    expect(caps(heading, { box: whole(200, 60), capRatio: 0.692 }).fontSize).toBeCloseTo(31.79, 2);
  });

  test("an empty box measures zero rather than throwing", () => {
    const blank = bandStack({ width: 50, height: 50, bands: [], ink: "#000000", bg: "#ffffff" });
    expect(caps(blank, { box: whole(50, 50) })).toEqual({ capHeight: 0, fontSize: 0 });
  });
});

describe("inkWidth", () => {
  const wide = bandStack({
    width: 300,
    height: 60,
    bands: [{ y: 10, h: 20, x: 30, w: 140 }],
    ink: "#000000",
    bg: "#ffffff",
  });

  test("measures the horizontal extent of ink exactly", () => {
    expect(inkWidth(wide, { box: whole(300, 60) })).toBe(140);
  });

  test("the ratio of two widths is the ratio of two font sizes", () => {
    const narrow = bandStack({
      width: 300,
      height: 60,
      bands: [{ y: 10, h: 15, x: 30, w: 105 }],
      ink: "#000000",
      bg: "#ffffff",
    });
    const ratio = inkWidth(narrow, { box: whole(300, 60) }) / inkWidth(wide, { box: whole(300, 60) });
    expect(ratio).toBeCloseTo(0.75, 6);
    // A 32px reference rendering at this ratio is a 24px render.
    expect(32 * ratio).toBeCloseTo(24, 6);
  });

  test("no ink measures zero", () => {
    const blank = bandStack({ width: 50, height: 50, bands: [], ink: "#000000", bg: "#ffffff" });
    expect(inkWidth(blank, { box: whole(50, 50) })).toBe(0);
  });
});

/**
 * The invisible-border case. The card, the page and the border differ by so
 * little that this fixture exists to assert BOTH halves of the contract: the
 * threshold approach must fail, and the local-minimum approach must succeed.
 */
describe("edges — a #fafafa card on a #fafafa page", () => {
  const invisible = card({
    width: 240,
    height: 80,
    x: 40,
    cardWidth: 120,
    fill: "#fafafa",
    page: "#fafafa",
    border: "#e9e9e9",
    borderWidth: 3,
  });

  test("no ink threshold can see it — bands finds nothing", () => {
    expect(bands(invisible, { box: whole(240, 80) })).toEqual([]);
    // Even a threshold set just under the page colour cannot separate them,
    // because the card fill and the page are the same three bytes.
    expect(bands(invisible, { box: whole(240, 80), threshold: 249 }).length).toBe(1);
  });

  test("edges finds both borders, at their centres", () => {
    // Borders occupy columns 40-42 and 157-159; their centres are 41 and 158.
    expect(edges(invisible, { row: 40 })).toEqual([41, 158]);
  });

  test("the recovered card width matches the drawn one", () => {
    const [left, right] = edges(invisible, { row: 40 });
    expect((right as number) - (left as number)).toBe(117);
  });

  test("a smooth gradient has no local minimum, so there are no false positives", () => {
    const smooth = gradient({ width: 60, height: 200, from: "#ffffff", to: "#202020" });
    expect(edges(smooth, { col: 30 })).toEqual([]);
  });

  test("depth controls how faint a border may be", () => {
    const fainter = card({
      width: 240,
      height: 80,
      x: 40,
      cardWidth: 120,
      fill: "#fafafa",
      page: "#fafafa",
      border: "#f8f8f8",
      borderWidth: 3,
    });
    expect(edges(fainter, { row: 40, depth: 1.5 })).toEqual([]);
    expect(edges(fainter, { row: 40, depth: 0.5 })).toEqual([41, 158]);
  });

  test("range narrows the scan to one border", () => {
    expect(edges(invisible, { row: 40, range: [0, 100] })).toEqual([41]);
  });

  test("asking for both a row and a column is a programmer error", () => {
    expect(() => edges(invisible, { row: 40, col: 40 })).toThrow(/exactly one/);
    expect(() => edges(invisible, {})).toThrow(/exactly one/);
  });
});

/**
 * The tilted-sample case: a rectangular box over a rotated shape reports the
 * background, and the only thing that saves you is the confidence figure.
 */
describe("modal", () => {
  const pill = tiltedPill({
    width: 300,
    height: 160,
    cx: 150,
    cy: 80,
    pillWidth: 200,
    pillHeight: 48,
    angle: 20,
    fill: "#f97316",
    page: "#fafafa",
  });

  test("a rectangular sample of a tilted pill returns the PAGE colour", () => {
    const sampled = modal(pill, { box: { x: 48, y: 24, width: 204, height: 113 } });
    expect(sampled.hex).toBe("#fafafa");
    expect(sampled.hex).not.toBe("#f97316");
  });

  test("and it says so: the confidence is low enough to disbelieve", () => {
    const sampled = modal(pill, { box: { x: 48, y: 24, width: 204, height: 113 } });
    expect(sampled.confidence).toBeLessThan(0.7);
    expect(sampled.matched / sampled.total).toBe(sampled.confidence);
  });

  test("a box wholly inside the pill reports the fill at full confidence", () => {
    const sampled = modal(pill, { box: { x: 140, y: 72, width: 20, height: 16 } });
    expect(sampled.hex).toBe("#f97316");
    expect(sampled.confidence).toBe(1);
  });

  test("HSV comes back alongside, for comparing against a design token", () => {
    const flat = gradient({ width: 20, height: 20, from: "#f97316", to: "#f97316" });
    const sampled = modal(flat, { box: whole(20, 20) });
    expect(sampled.hsv).toEqual({ h: 25, s: 91, v: 98 });
    expect(sampled.total).toBe(400);
    expect(sampled.matched).toBe(400);
  });
});

describe("field", () => {
  const textured = dotField({
    width: 120,
    height: 120,
    pitch: 12,
    radius: 3,
    ink: "#000000",
    bg: "#ffffff",
    alpha: 0.06,
  });

  test("a flat tint of the same mean brightness has no texture at all", () => {
    const flatMean = textured.gray.reduce((total, v) => total + v, 0) / textured.gray.length;
    const flat = gradient({ width: 120, height: 120, from: "#fcfcfc", to: "#fcfcfc" });
    const flatValue = flat.gray[0] as number;
    expect(Math.abs(flatMean - flatValue)).toBeLessThan(1.5);

    const flatField = field(flat, { box: whole(120, 120) });
    expect(flatField.grid.flat().every((deviation) => deviation === 0)).toBe(true);
    expect(flatField.ascii.replace(/\n/g, "")).toMatch(/^ +$/);
  });

  test("the faint texture is visible in the deviation map even so", () => {
    const textureField = field(textured, { box: whole(120, 120) });
    expect(textureField.grid.length).toBe(10);
    expect(textureField.grid[0]?.length).toBe(10);
    expect(textureField.grid.flat().every((deviation) => deviation > 4)).toBe(true);
    expect(textureField.ascii).not.toMatch(/ /);
  });

  test("stride controls the overlap between windows", () => {
    const overlapped = field(textured, { box: whole(120, 120), cell: 12, stride: 6 });
    expect(overlapped.grid.length).toBe(19);
  });
});

describe("coverage", () => {
  const ramp: HalftoneRampSpec = {
    width: 512,
    height: 768,
    pitch: 16,
    rTop: 2,
    rBottom: 6,
    midpoint: 384,
    steepness: 0.012,
    ink: "#ffffff",
    bg: "#000000",
  };
  const image = halftoneRamp(ramp);

  test("recovers the logistic radius ramp to within 0.02 coverage", () => {
    const measured = coverage(image, { box: whole(512, 768), bands: 12, invert: true });
    expect(measured.length).toBe(12);
    for (const { band, coverage: value } of measured) {
      const centre = band * 64 + 32;
      const radius = rampRadius(ramp, centre);
      const expected = (Math.PI * radius * radius) / (ramp.pitch * ramp.pitch);
      expect(Math.abs(value - expected)).toBeLessThan(0.02);
    }
  });

  test("the ramp never reverses, and rises eightfold from top to bottom", () => {
    const measured = coverage(image, { box: whole(512, 768), bands: 12, invert: true });
    for (let i = 1; i < measured.length; i += 1) {
      // Non-decreasing, not strictly increasing: at the flat top of the
      // logistic a 2.03px and a 2.06px radius rasterise to the same 13 pixels,
      // so two adjacent bands legitimately measure the same coverage.
      expect(measured[i]?.coverage).toBeGreaterThanOrEqual(measured[i - 1]?.coverage as number);
    }
    const first = measured[0]?.coverage as number;
    const last = measured[measured.length - 1]?.coverage as number;
    expect(last / first).toBeGreaterThan(8);
  });

  test("a uniform dot field measures πr²/pitch² in every band", () => {
    const uniform = dotField({
      width: 512,
      height: 768,
      pitch: 16,
      radius: 4,
      ink: "#ffffff",
      bg: "#000000",
      alpha: 1,
    });
    const measured = coverage(uniform, { box: whole(512, 768), bands: 12, invert: true });
    const expected = (Math.PI * 16) / 256;
    for (const { coverage: value } of measured) {
      expect(Math.abs(value - expected)).toBeLessThan(0.02);
    }
  });
});
