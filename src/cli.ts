import { copyFileSync, statSync } from "node:fs";
import { captureSection, formatReport } from "./capture.ts";
import { classify, compare } from "./compare.ts";
import { bands, caps, coverage, edges, field, inkWidth, modal } from "./measure.ts";
import { crop, type Image, load, save } from "./png.ts";
import { downscale } from "./resample.ts";
import {
  base64Bytes,
  type Box,
  countImageTokens,
  MAX_BASE64_BYTES,
  MAX_EDGE_ABSOLUTE,
  paddedSize,
  planView,
  resizedSize,
  snapToPatch,
  type Tier,
  TIERS,
} from "./vision.ts";

/**
 * Argument parsing and formatting. No measurement or budget logic lives here —
 * if a number is computed in this file, it belongs in a module instead.
 */

const USAGE = `caliper — measure screenshots, and never exceed Claude's vision budget by accident

  budget <w> <h>                 what Claude will do to an image of this size
  fit <in.png> <out.png>         pre-resize so the API resizes nothing
  capture --url=<u> --section=<id> --widths=1440,1568 --out=<dir>

  bands <png>                    contiguous rows of ink: every baseline and gap
  caps <png>                     cap height of the tallest glyph, and font size
  edges <png> --row=N | --col=N  borders a threshold cannot see
  color <png>                    modal colour, with a confidence you must read
  field <png>                    where texture exists, as a deviation map
  coverage <png>                 lit ÷ silhouette per band, for halftones
  compare <ref.png> <mine.png>   the aligned delta table

common flags
  --box=x,y,w,h                  region to measure (default: the whole image)
  --tier=standard|highRes        resolution tier (default: standard)
  --threshold=N --invert         ink level, and which side of it is ink
  --min-height=N --cap-ratio=N --depth=N --window=N --range=a,b
  --cell=N --stride=N --bands=N --dilate=N --erode=N
  --anchor=N --labels=a,b        for compare
  --snap                         for fit: also round down to a multiple of 28
  --classify=a,b,c               verdict on one measurement across sections
`;

interface Args {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, value] = arg.slice(2).split("=", 2);
    flags.set(key as string, value ?? "true");
  }
  return { positional, flags };
}

function number(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} needs a number, got "${raw}"`);
  return value;
}

function integers(args: Args, name: string): number[] | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  return raw.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value)) throw new Error(`--${name} needs numbers, got "${raw}"`);
    return value;
  });
}

/**
 * A pixel dimension. Rejects zero, negatives and fractions, because every one of
 * them produces confident nonsense downstream rather than an error: `budget -5
 * 100` printed "0 tokens, plan: AS-IS" before this guard existed.
 */
function positionalNumber(args: Args, index: number, name: string): number {
  const raw = args.positional[index];
  if (raw === undefined) throw new Error(`missing <${name}>`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`<${name}> needs a whole number of pixels above zero, got "${raw}"`);
  }
  return value;
}

function positionalPath(args: Args, index: number, name: string): string {
  const raw = args.positional[index];
  if (raw === undefined) throw new Error(`missing <${name}>`);
  return raw;
}

function tierOf(args: Args): Tier {
  const name = args.flags.get("tier") ?? "standard";
  if (name === "standard") return TIERS.standard;
  if (name === "highRes") return TIERS.highRes;
  throw new Error(`--tier must be standard or highRes, got "${name}"`);
}

function boxOf(args: Args, img: Image): Box {
  const parts = integers(args, "box");
  if (!parts) return { x: 0, y: 0, width: img.width, height: img.height };
  const [x, y, width, height] = parts;
  if (parts.length !== 4 || x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error("--box needs x,y,w,h");
  }
  return { x, y, width, height };
}

function bandOptions(args: Args, img: Image) {
  return {
    box: boxOf(args, img),
    threshold: number(args, "threshold"),
    minHeight: number(args, "min-height"),
    invert: args.flags.has("invert"),
  };
}

function bytes(count: number): string {
  return `${(count / 1_000_000).toFixed(2)} MB`;
}

function budget(args: Args): string {
  const width = positionalNumber(args, 0, "width");
  const height = positionalNumber(args, 1, "height");
  const tier = tierOf(args);
  const minLongEdge = number(args, "min-long-edge");
  const overlap = number(args, "overlap");
  const plan = planView(width, height, { tier, minLongEdge, overlap });
  const tierName = tier === TIERS.highRes ? "high-res" : "standard";

  const lines = [
    `${width}×${height}  ·  ${countImageTokens(width, height)} tokens  ·  ${tierName} tier ` +
      `(max edge ${tier.maxEdge}, max tokens ${tier.maxTokens})`,
    "",
  ];

  if (width > MAX_EDGE_ABSOLUTE || height > MAX_EDGE_ABSOLUTE) {
    lines.push(
      `  REJECTED AT SOURCE — ${MAX_EDGE_ABSOLUTE}px is the hard per-image dimension limit.`,
      "",
    );
  }

  if (plan.kind === "asis") {
    const padded = paddedSize(width, height);
    lines.push(
      `  plan: AS-IS — ${plan.tokens} tokens, nothing is resized`,
      `  Claude pads it to ${padded.width}×${padded.height}; normalise coordinates by ${width}×${height}, not that`,
    );
  } else if (plan.kind === "downscale") {
    const padded = paddedSize(plan.to.width, plan.to.height);
    lines.push(
      `  plan: DOWNSCALE to ${plan.to.width}×${plan.to.height} — ${Math.round(plan.scale * 100)}% ` +
        `of the original, ${plan.tokens} tokens`,
      `  Claude pads that to ${padded.width}×${padded.height}`,
      `  pre-resize to exactly ${plan.to.width}×${plan.to.height} and the API resizes nothing,`,
      "  which saves a second resampling pass over the text",
    );
  } else {
    lines.push(`  plan: SLICE — ${plan.reason}`, "");
    let total = 0;
    for (const [i, box] of plan.slices.entries()) {
      const tokens = countImageTokens(box.width, box.height);
      total += tokens;
      lines.push(
        `    ${String(i + 1).padStart(2)}  y ${String(box.y).padStart(5)}..${String(box.y + box.height).padEnd(5)}` +
          `  ${box.width}×${box.height}  ${tokens} tok`,
      );
    }
    lines.push(
      "",
      `  ${plan.slices.length} images, ${total} tokens total`,
      `  the alternative is one ${Math.round(plan.scaleIfForced * 100)}% image, which is not measurable`,
    );
  }

  const square = resizedSize(tier.maxEdge, tier.maxEdge, tier);
  const wide = resizedSize(tier.maxEdge, Math.round((tier.maxEdge * 9) / 16), tier);
  lines.push(
    "",
    `  ceilings on this tier: ${square.width}×${square.height} square, ${wide.width}×${wide.height} at 16:9`,
  );
  return lines.join("\n");
}

function fit(args: Args): string {
  const inPath = positionalPath(args, 0, "in.png");
  const outPath = positionalPath(args, 1, "out.png");
  const tier = tierOf(args);
  const img = load(inPath);
  const plan = planView(img.width, img.height, { tier });
  const lines = [`${inPath}  ${img.width}×${img.height}  ${countImageTokens(img.width, img.height)} tok`];
  const written: string[] = [];

  if (plan.kind === "slice") {
    for (const [i, box] of plan.slices.entries()) {
      const path = outPath.replace(/\.png$/, `.slice-${i + 1}.png`);
      save(crop(img, box), path);
      written.push(path);
    }
    lines.push(`  sliced: ${plan.reason}`);
  } else {
    const target = plan.kind === "asis" ? { width: img.width, height: img.height } : plan.to;
    const snapped = args.flags.has("snap") ? snapToPatch(target.width, target.height) : target;
    if (snapped.width === img.width && snapped.height === img.height) {
      copyFileSync(inPath, outPath);
    } else {
      save(downscale(img, snapped), outPath);
    }
    written.push(outPath);
    lines.push(
      `  → ${snapped.width}×${snapped.height}  ${countImageTokens(snapped.width, snapped.height)} tok` +
        (args.flags.has("snap") ? "  (snapped to a multiple of 28: zero padding)" : ""),
    );
  }

  for (const path of written) {
    const raw = statSync(path).size;
    const payload = base64Bytes(raw);
    const verdict =
      payload > MAX_BASE64_BYTES.api
        ? "OVER the 10 MB API limit"
        : payload > MAX_BASE64_BYTES.bedrock
          ? "over the 5 MB Bedrock limit, under the API's"
          : "inside both limits";
    lines.push(`  wrote ${path}  ${bytes(raw)} on disk → ${bytes(payload)} base64, ${verdict}`);
  }
  return lines.join("\n");
}

function describeBands(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const options = bandOptions(args, img);
  const found = bands(img, options);
  if (found.length === 0) return "no bands — try --threshold or --invert";
  const lines = ["  #      top   bottom   height    gap    x range", "  ──────────────────────────────────────────────"];
  for (const [i, band] of found.entries()) {
    const previous = found[i - 1];
    const gap = previous ? String(band.top - previous.bottom - 1) : "—";
    lines.push(
      `  ${String(i).padStart(2)}  ${String(band.top).padStart(7)}  ${String(band.bottom).padStart(7)}` +
        `  ${String(band.height).padStart(7)}  ${gap.padStart(5)}    ${band.xStart}..${band.xEnd}`,
    );
  }
  lines.push("", `  ${found.length} bands · ink width ${inkWidth(img, options)}px`);
  return lines.join("\n");
}

function describeCaps(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const capRatio = number(args, "cap-ratio");
  const measured = caps(img, {
    box: boxOf(args, img),
    threshold: number(args, "threshold"),
    capRatio,
    invert: args.flags.has("invert"),
  });
  return (
    `  cap height ${measured.capHeight}px\n` +
    `  font size  ${measured.fontSize.toFixed(1)}px  (cap ratio ${capRatio ?? 0.727})`
  );
}

function describeEdges(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const range = integers(args, "range");
  const found = edges(img, {
    row: number(args, "row"),
    col: number(args, "col"),
    depth: number(args, "depth"),
    window: number(args, "window"),
    range: range && range.length === 2 ? [range[0] as number, range[1] as number] : undefined,
  });
  if (found.length === 0) return "no edges — try a smaller --depth";
  const spans = found.slice(1).map((position, i) => position - (found[i] as number));
  return `  edges at ${found.join(", ")}\n  spans   ${spans.join(", ") || "—"}`;
}

function describeColour(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const sampled = modal(img, { box: boxOf(args, img) });
  const percent = (sampled.confidence * 100).toFixed(1);
  const warning =
    sampled.confidence < 0.8
      ? `\n  ONLY ${percent}% of the box is this colour — the box probably does not fit the shape`
      : "";
  return (
    `  ${sampled.hex}   hsv(${sampled.hsv.h}, ${sampled.hsv.s}%, ${sampled.hsv.v}%)\n` +
    `  confidence ${percent}%  (${sampled.matched} of ${sampled.total} pixels)${warning}`
  );
}

function describeField(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const measured = field(img, {
    box: boxOf(args, img),
    cell: number(args, "cell"),
    stride: number(args, "stride"),
  });
  const values = measured.grid.flat();
  const peak = values.length === 0 ? 0 : Math.max(...values);
  return `${measured.ascii}\n\n  peak deviation ${peak.toFixed(2)}  (ramp: " .:-=+*#" at 0.5 1 2 4 8 16 32)`;
}

function describeCoverage(args: Args): string {
  const img = load(positionalPath(args, 0, "png"));
  const measured = coverage(img, {
    box: boxOf(args, img),
    bands: number(args, "bands"),
    threshold: number(args, "threshold"),
    dilate: number(args, "dilate"),
    erode: number(args, "erode"),
    invert: args.flags.has("invert"),
  });
  return measured
    .map(
      ({ band, coverage: value }) =>
        `  ${String(band).padStart(2)}  ${(value * 100).toFixed(1).padStart(5)}%  ` +
        "█".repeat(Math.round(value * 40)),
    )
    .join("\n");
}

function describeCompare(args: Args): string {
  const samples = integers(args, "classify");
  if (samples) {
    const result = classify(samples, { tolerance: number(args, "tolerance") });
    return (
      `  ${samples.join(", ")}\n` +
      `  spread ${(result.spread * 100).toFixed(2)}%  →  ${result.verdict.toUpperCase()}` +
      (result.verdict === "systemic" ? "\n  this value belongs in a shared token, not in one component" : "")
    );
  }

  const ref = load(positionalPath(args, 0, "ref.png"));
  const mine = load(positionalPath(args, 1, "mine.png"));
  const labels = args.flags.get("labels")?.split(",");
  return compare(bands(ref, bandOptions(args, ref)), bands(mine, bandOptions(args, mine)), {
    anchor: number(args, "anchor"),
    tolerance: number(args, "tolerance"),
    labels: labels?.length === 2 ? [labels[0] as string, labels[1] as string] : undefined,
  });
}

async function capture(args: Args): Promise<string> {
  const url = args.flags.get("url");
  const sectionId = args.flags.get("section");
  const outDir = args.flags.get("out");
  if (!url || !sectionId || !outDir) throw new Error("capture needs --url, --section and --out");
  const report = await captureSection({
    url,
    sectionId,
    outDir,
    widths: integers(args, "widths") ?? [1440],
    tier: tierOf(args),
    deviceScaleFactor: number(args, "dsf"),
    children: args.flags.get("children")?.split(","),
  });
  return formatReport(report);
}

async function run(): Promise<string> {
  const [command, ...rest] = Bun.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "budget":
      return budget(args);
    case "fit":
      return fit(args);
    case "capture":
      return capture(args);
    case "bands":
      return describeBands(args);
    case "caps":
      return describeCaps(args);
    case "edges":
      return describeEdges(args);
    case "color":
      return describeColour(args);
    case "field":
      return describeField(args);
    case "coverage":
      return describeCoverage(args);
    case "compare":
      return describeCompare(args);
    default:
      return USAGE;
  }
}

run().then(
  (output) => {
    console.log(output);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
