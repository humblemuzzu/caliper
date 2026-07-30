import { describe, expect, test } from "bun:test";
import { classify, compare } from "./compare.ts";
import type { Band } from "./measure.ts";

const band = (top: number, height: number): Band => ({
  top,
  bottom: top + height - 1,
  height,
  xStart: 0,
  xEnd: 100,
});

describe("compare", () => {
  test("anchors both lists at zero, so a shifted section still lines up", () => {
    // The same layout, captured 200px further down the page.
    const ref = [band(100, 24), band(160, 16), band(220, 40)];
    const mine = [band(300, 24), band(360, 16), band(420, 40)];
    const table = compare(ref, mine);
    expect(table).toContain("3/3 within 3px");
    // No row is named when nothing is out: there is no worst row to name.
    expect(table).toContain("worst 0px");
    expect(table).not.toContain("row -1");
  });

  test("reports the delta of each band and the worst of them", () => {
    const ref = [band(0, 24), band(60, 16), band(120, 40)];
    const mine = [band(0, 24), band(62, 16), band(126, 38)];
    const table = compare(ref, mine);
    expect(table).toContain("+2");
    expect(table).toContain("+6");
    expect(table).toContain("worst +6px at row 2");
    expect(table).toContain("2/3 within 3px");
  });

  test("an unpaired band is marked, not silently dropped", () => {
    const table = compare([band(0, 24), band(60, 16)], [band(0, 24)]);
    expect(table).toContain("—");
    expect(table).toContain("ref has 2 bands, mine has 1");
  });

  test("the anchor can be a band other than the first", () => {
    // The first band differs by 10px; anchoring on it would hide that and
    // report the two identical bands below it as 10px out.
    const ref = [band(0, 24), band(60, 16), band(120, 40)];
    const mine = [band(10, 24), band(60, 16), band(120, 40)];
    expect(compare(ref, mine, { anchor: 0 })).toContain("worst -10px");
    expect(compare(ref, mine, { anchor: 1 })).toContain("worst +10px at row 0");
  });

  test("labels appear in the header", () => {
    const table = compare([band(0, 24)], [band(0, 24)], { labels: ["figma", "build"] });
    expect(table).toContain("figma");
    expect(table).toContain("build h");
  });

  test("an anchor beyond the measured bands is a programmer error", () => {
    expect(() => compare([band(0, 24)], [band(0, 24)], { anchor: 5 })).toThrow(/beyond/);
  });

  test("two empty lists produce a table, not a crash", () => {
    expect(compare([], [])).toContain("no bands in common");
  });
});

describe("classify", () => {
  test("agreement across sections means the value is a shared token", () => {
    const result = classify([1128, 1130, 1129, 1128]);
    expect(result.verdict).toBe("systemic");
    expect(result.spread).toBeLessThan(0.01);
  });

  test("the container-width bug: every section wrong by the same 6%", () => {
    // Four sections, each measured against its own reference and each passing.
    // Compared against each other they agree perfectly — which is exactly what
    // makes the error systemic rather than a per-section slip.
    const measured = [1063, 1063, 1064, 1063];
    expect(classify(measured).verdict).toBe("systemic");
    const intended = 1128;
    expect(Math.abs(1 - 1063 / intended)).toBeGreaterThan(0.05);
  });

  test("disagreement means the value belongs to one component", () => {
    const result = classify([1128, 960, 1240]);
    expect(result.verdict).toBe("local");
    expect(result.spread).toBeCloseTo(280 / ((1128 + 960 + 1240) / 3), 6);
  });

  test("two samples cannot support a verdict, however well they agree", () => {
    expect(classify([1128, 1128]).verdict).toBe("inconclusive");
    expect(classify([1128, 1128]).spread).toBe(0);
  });

  test("tolerance decides how close counts as the same number", () => {
    const samples = [1128, 1140, 1134];
    expect(classify(samples, { tolerance: 0.02 }).verdict).toBe("systemic");
    expect(classify(samples, { tolerance: 0.005 }).verdict).toBe("local");
  });

  test("no samples at all is a programmer error", () => {
    expect(() => classify([])).toThrow(/at least one/);
  });
});
