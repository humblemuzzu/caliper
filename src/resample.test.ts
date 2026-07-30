import { describe, expect, test } from "bun:test";
import { dotField, gradient } from "./fixtures.ts";
import { downscale } from "./resample.ts";

const mean = (values: Uint8Array): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

describe("downscale", () => {
  test("refuses to enlarge, on either axis", () => {
    const img = gradient({ width: 8, height: 8, from: "#000000", to: "#ffffff" });
    expect(() => downscale(img, { width: 16, height: 8 })).toThrow(/cannot enlarge/);
    expect(() => downscale(img, { width: 8, height: 16 })).toThrow(/cannot enlarge/);
  });

  test("refuses a zero-sized target", () => {
    const img = gradient({ width: 8, height: 8, from: "#000000", to: "#ffffff" });
    expect(() => downscale(img, { width: 0, height: 4 })).toThrow(/must be positive/);
  });

  test("an exact 2:1 ratio averages pixel pairs", () => {
    // Four rows of 0, 50, 100, 150 → two rows of 25 and 125.
    const img = gradient({ width: 1, height: 4, from: "#000000", to: "#969696" });
    expect(Array.from(img.gray)).toEqual([0, 50, 100, 150]);
    const half = downscale(img, { width: 1, height: 2 });
    expect(Array.from(half.gray)).toEqual([25, 125]);
  });

  test("a 3:2 ratio splits the straddling pixel by area, not by nearest neighbour", () => {
    // Rows 0, 105, 210. Output row 0 covers [0, 1.5) → (0·1 + 105·0.5)/1.5 = 35.
    // Output row 1 covers [1.5, 3) → (105·0.5 + 210·1)/1.5 = 175.
    // Nearest-neighbour would give 0 and 210; bilinear would give neither.
    const img = gradient({ width: 1, height: 3, from: "#000000", to: "#d2d2d2" });
    expect(Array.from(img.gray)).toEqual([0, 105, 210]);
    const fitted = downscale(img, { width: 1, height: 2 });
    expect(Array.from(fitted.gray)).toEqual([35, 175]);
  });

  test("a flat colour survives untouched", () => {
    const img = gradient({ width: 40, height: 40, from: "#3b82f6", to: "#3b82f6" });
    const small = downscale(img, { width: 10, height: 10 });
    expect(Array.from(small.rgb.subarray(0, 3))).toEqual([0x3b, 0x82, 0xf6]);
    expect(new Set(small.gray).size).toBe(1);
  });

  test("area averaging conserves the mean, which is why it cannot ring", () => {
    const img = dotField({
      width: 240,
      height: 240,
      pitch: 12,
      radius: 4,
      ink: "#000000",
      bg: "#ffffff",
      alpha: 1,
    });
    const small = downscale(img, { width: 60, height: 60 });
    expect(Math.abs(mean(small.gray) - mean(img.gray))).toBeLessThan(1);
  });

  test("the requested size is the size returned", () => {
    const img = gradient({ width: 1568, height: 1388, from: "#000000", to: "#ffffff" });
    const fitted = downscale(img, { width: 1170, height: 1036 });
    expect(fitted.width).toBe(1170);
    expect(fitted.height).toBe(1036);
    expect(fitted.gray.length).toBe(1170 * 1036);
  });
});
