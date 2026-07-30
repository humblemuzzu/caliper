import { describe, expect, test } from "bun:test";
import {
  base64Bytes,
  countImageTokens,
  MAX_BASE64_BYTES,
  MAX_EDGE_ABSOLUTE,
  paddedSize,

  planView,
  resizedSize,
  snapToPatch,
  TIERS,
} from "./vision.ts";

const size = (width: number, height: number) => ({ width, height });

describe("resizedSize — the published table in spec §3/§4", () => {
  test("1075×1520 → 924×1307 (the A4 example, §4)", () => {
    expect(resizedSize(1075, 1520)).toEqual(size(924, 1307));
  });

  test("1920×1080 → 1456×819, NOT 1568×882 (§4 warns explicitly)", () => {
    expect(resizedSize(1920, 1080)).toEqual(size(1456, 819));
    expect(resizedSize(1920, 1080)).not.toEqual(size(1568, 882));
  });

  test("3840×2160 → 1456×819", () => {
    expect(resizedSize(3840, 2160)).toEqual(size(1456, 819));
  });

  test("1092×1092 unchanged — the square ceiling", () => {
    expect(resizedSize(1092, 1092)).toEqual(size(1092, 1092));
  });

  test("1000×1000 unchanged", () => {
    expect(resizedSize(1000, 1000)).toEqual(size(1000, 1000));
  });

  test("200×200 unchanged", () => {
    expect(resizedSize(200, 200)).toEqual(size(200, 200));
  });

  test("1075×1520 unchanged on the high-res tier — 2145 tokens fits in 4784", () => {
    expect(resizedSize(1075, 1520, TIERS.highRes)).toEqual(size(1075, 1520));
    expect(countImageTokens(1075, 1520)).toBe(2145);
  });

  test("3840×2160 → 2576×1449 on the high-res tier", () => {
    expect(resizedSize(3840, 2160, TIERS.highRes)).toEqual(size(2576, 1449));
    expect(countImageTokens(2576, 1449)).toBe(4784);
  });
});

/**
 * 2000×1500 is the one row where the spec contradicts itself, and it is not a
 * coincidence that it is also the banker's-rounding tie case.
 *
 * The binary search probes width 1270, where 1270 / (2000/1500) is exactly
 * 952.5. Half-to-even gives 952 → 46×34 = 1564 tokens → fits → the answer is
 * 1270×952. Rounding halves up gives 953 → 46×35 = 1610 tokens → does not fit
 * → the search settles one pixel lower, on 1269×952.
 *
 * §3's table prints 1269×952; §6's reference implementation, run verbatim,
 * prints 1270×952. §4 instructs "Compute the size with the reference
 * implementation rather than scaling to the edge length by hand", so §6 wins:
 * it is the executable artifact and the only unambiguous one. Both candidates
 * cost the 1564 tokens §3's own token column reports, so nothing downstream of
 * the token budget is affected either way.
 *
 * These assertions exist so that a refactor to Math.round fails loudly rather
 * than silently shifting every derived coordinate by a pixel.
 */
describe("resizedSize — 2000×1500, the banker's-rounding pin", () => {
  test("§6's reference implementation gives 1270×952", () => {
    expect(resizedSize(2000, 1500)).toEqual(size(1270, 952));
  });

  test("§3's table prints 1269×952, which is what Math.round would produce", () => {
    const mathRoundHeight = Math.round(1270 / (2000 / 1500));
    expect(mathRoundHeight).toBe(953);
    expect(countImageTokens(1270, mathRoundHeight)).toBeGreaterThan(TIERS.standard.maxTokens);
    expect(countImageTokens(1269, 952)).toBe(1564);
  });

  test("both candidates cost the 1564 tokens §3 reports", () => {
    expect(countImageTokens(1270, 952)).toBe(1564);
  });
});

describe("resizedSize — the axis-swap recursion (§6 note 3)", () => {
  test("1080×1920 portrait → 819×1456, the transpose of 1920×1080", () => {
    expect(resizedSize(1080, 1920)).toEqual(size(819, 1456));
    const landscape = resizedSize(1920, 1080);
    expect(landscape).toEqual(size(1456, 819));
  });

  test("1520×1075 landscape is the transpose of the A4 example", () => {
    expect(resizedSize(1520, 1075)).toEqual(size(1307, 924));
  });

  test("a very tall image is driven to the edge limit, not the token limit", () => {
    expect(resizedSize(1568, 7698)).toEqual(size(319, 1568));
  });
});

describe("countImageTokens (§1)", () => {
  test("1000×1000 → 1296", () => expect(countImageTokens(1000, 1000)).toBe(1296));
  test("1092×1092 → 1521", () => expect(countImageTokens(1092, 1092)).toBe(1521));
  test("200×200 → 64", () => expect(countImageTokens(200, 200)).toBe(64));
  test("1920×1080 → 2691 on the high-res tier, unresized", () => {
    expect(countImageTokens(1920, 1080)).toBe(2691);
  });
  test("2000×1500 → 3888 on the high-res tier, unresized", () => {
    expect(countImageTokens(2000, 1500)).toBe(3888);
  });
  test("1456×819 → 1560 and 1269×952 → 1564, both inside the 1568 budget", () => {
    expect(countImageTokens(1456, 819)).toBe(1560);
    expect(countImageTokens(1269, 952)).toBe(1564);
  });
});

/**
 * §10's "practical ceilings" table lists 2044×2044 as the largest unresized
 * square on the high-res tier. It cannot be: 2044 pads to 73 patches, and
 * 73 × 73 = 5329 tokens against a 4784 budget. The true ceiling is 1932×1932
 * at 4761 tokens, which the reference implementation agrees with.
 *
 * The standard-tier figure in the same table, 1092×1092, is correct.
 */
describe("the practical ceilings (§10)", () => {
  test("1092×1092 is the largest unresized square on the standard tier", () => {
    expect(resizedSize(1092, 1092)).toEqual(size(1092, 1092));
    expect(countImageTokens(1092, 1092)).toBe(1521);
    expect(countImageTokens(1120, 1120)).toBeGreaterThan(TIERS.standard.maxTokens);
  });

  test("1456×819 is the largest unresized 16:9 frame on the standard tier", () => {
    expect(resizedSize(1456, 819)).toEqual(size(1456, 819));
    expect(countImageTokens(1456, 819)).toBe(1560);
  });

  test("the high-res square ceiling is 1932, not the 2044 §10 prints", () => {
    expect(countImageTokens(2044, 2044)).toBe(5329);
    expect(countImageTokens(2044, 2044)).toBeGreaterThan(TIERS.highRes.maxTokens);
    expect(resizedSize(2044, 2044, TIERS.highRes)).toEqual(size(1932, 1932));
    expect(countImageTokens(1932, 1932)).toBe(4761);
  });

  test("2576×1449 is the largest unresized 16:9 frame on the high-res tier", () => {
    expect(resizedSize(2576, 1449, TIERS.highRes)).toEqual(size(2576, 1449));
    expect(countImageTokens(2576, 1449)).toBe(4784);
  });
});

describe("padding (§5)", () => {
  test("924×1307 pads to 924×1316", () => {
    expect(paddedSize(924, 1307)).toEqual(size(924, 1316));
  });

  test("a multiple of 28 is not padded at all", () => {
    expect(paddedSize(1092, 1092)).toEqual(size(1092, 1092));
  });

  test("snapToPatch rounds down, so the snapped size still fits what the input fit", () => {
    expect(snapToPatch(924, 1307)).toEqual(size(924, 1288));
    expect(paddedSize(924, 1288)).toEqual(size(924, 1288));
    expect(countImageTokens(924, 1288)).toBeLessThanOrEqual(TIERS.standard.maxTokens);
  });

  test("snapToPatch leaves a sub-patch axis alone rather than enlarging it", () => {
    // Clamping up to PATCH would be an enlargement, and `downscale` refuses to
    // enlarge — so the old clamp made `fit --snap` fail outright on a 1×N image.
    expect(snapToPatch(20, 20)).toEqual(size(20, 20));
    expect(snapToPatch(1, 1568)).toEqual(size(1, 1568));
    expect(snapToPatch(27, 56)).toEqual(size(27, 56));
    // and it never returns zero
    expect(snapToPatch(1, 1).width).toBeGreaterThan(0);
  });

  test("snapToPatch never enlarges either axis", () => {
    for (let w = 1; w <= 200; w++) {
      const snapped = snapToPatch(w, w);
      expect(snapped.width).toBeLessThanOrEqual(w);
      expect(snapped.height).toBeLessThanOrEqual(w);
    }
  });
});

describe("base64 payload size (§7)", () => {
  test("a 4.5 MB raw file is a 6 MB payload", () => {
    expect(base64Bytes(4_500_000)).toBe(6_000_000);
  });

  test("that payload passes the API limit and fails Bedrock's", () => {
    expect(base64Bytes(4_500_000)).toBeLessThan(MAX_BASE64_BYTES.api);
    expect(base64Bytes(4_500_000)).toBeGreaterThan(MAX_BASE64_BYTES.bedrock);
  });
});

describe("planView", () => {
  test("1568×602 fits as-is", () => {
    const plan = planView(1568, 602);
    expect(plan.kind).toBe("asis");
    if (plan.kind !== "asis") throw new Error("unreachable");
    expect(plan.tokens).toBe(1232);
  });

  test("1568×1388 downscales to 1170×1036 — the 75% case from real work", () => {
    const plan = planView(1568, 1388);
    expect(plan.kind).toBe("downscale");
    if (plan.kind !== "downscale") throw new Error("unreachable");
    expect(plan.to).toEqual(size(1170, 1036));
    expect(plan.tokens).toBe(1554);
    expect(Math.round(plan.scale * 100)).toBe(75);
  });

  test("1568×7698 slices rather than shrinking to 319px wide", () => {
    const plan = planView(1568, 7698);
    expect(plan.kind).toBe("slice");
    if (plan.kind !== "slice") throw new Error("unreachable");
    expect(plan.scaleIfForced).toBeCloseTo(319 / 1568, 4);
    expect(plan.reason).toContain("319");
  });

  test("every slice fits the budget on its own and none is a sliver", () => {
    const plan = planView(1568, 7698);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.width).toBe(1568);
      expect(box.height).toBe(784);
      expect(countImageTokens(box.width, box.height)).toBeLessThanOrEqual(
        TIERS.standard.maxTokens,
      );
    }
  });

  test("slices cover the image top to bottom and overlap by the requested amount", () => {
    const plan = planView(1568, 7698, { overlap: 40 });
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    const first = plan.slices[0];
    const last = plan.slices[plan.slices.length - 1];
    if (!first || !last) throw new Error("expected slices");
    expect(first.y).toBe(0);
    expect(last.y + last.height).toBe(7698);
    for (let i = 1; i < plan.slices.length; i += 1) {
      const previous = plan.slices[i - 1];
      const current = plan.slices[i];
      if (!previous || !current) throw new Error("expected slices");
      expect(current.y).toBeLessThanOrEqual(previous.y + previous.height - 40);
    }
  });

  test("a portrait phone screenshot downscales — 76% is legible, slicing it is over-eager", () => {
    const plan = planView(1080, 1920);
    expect(plan.kind).toBe("downscale");
  });

  test("a 4K screenshot downscales because full-width slices could never fit", () => {
    const plan = planView(3840, 2160);
    expect(plan.kind).toBe("downscale");
    if (plan.kind !== "downscale") throw new Error("unreachable");
    expect(plan.to).toEqual(size(1456, 819));
  });

  test("the high-res tier still slices the tall page, into fewer, taller crops", () => {
    const standard = planView(1568, 7698);
    const plan = planView(1568, 7698, { tier: TIERS.highRes });
    expect(plan.kind).toBe("slice");
    if (plan.kind !== "slice" || standard.kind !== "slice") throw new Error("unreachable");
    expect(plan.slices.length).toBeLessThan(standard.slices.length);
    for (const box of plan.slices) {
      expect(countImageTokens(box.width, box.height)).toBeLessThanOrEqual(
        TIERS.highRes.maxTokens,
      );
    }
  });

  test("raising the legibility floor turns a downscale into a slice plan", () => {
    expect(planView(1568, 1388).kind).toBe("downscale");
    expect(planView(1568, 1388, { minLongEdge: 1400 }).kind).toBe("slice");
  });
});

describe("the hard limits (§7)", () => {
  test("8000px is the absolute per-image dimension limit", () => {
    expect(MAX_EDGE_ABSOLUTE).toBe(8000);
    // A page taller than the hard limit still yields a usable plan, because
    // every slice is cropped well below it.
    const plan = planView(1568, 12_000);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.height).toBeLessThanOrEqual(MAX_EDGE_ABSOLUTE);
    }
  });
});
