import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  base64Bytes,
  countImageTokens,
  MAX_BASE64_BYTES,
  MAX_EDGE_ABSOLUTE,
  planView,
  resizedSize,
} from "../src/vision.ts";

/**
 * Runs the budget maths over real screenshots on this machine and flags every
 * one that would be silently degraded if it were sent at native size.
 *
 * Dimensions are read from the PNG header rather than by decoding the file:
 * this walks thousands of images to read two integers each, and decoding them
 * would take minutes to learn nothing extra.
 */
function pngSize(path: string): { width: number; height: number } | null {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(24);
    if (readSync(fd, header, 0, 24, 0) < 24) return null;
    if (header.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** Evenly spaced picks, so a sample of a sorted directory is not just its first N. */
function sample(paths: string[], count: number): string[] {
  if (paths.length <= count) return paths;
  const step = paths.length / count;
  return Array.from({ length: count }, (_, i) => paths[Math.floor(i * step)] as string);
}

function pngsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

const BEACON_SHOTS = "/Users/muzammil/Documents/Code stuff/beacon/apps/web/design/shots";

const sources: { label: string; paths: string[] }[] = [
  {
    label: "ClaudeResized (2,623 real screenshots, 40 sampled)",
    paths: sample(pngsIn(join(homedir(), "Pictures/ClaudeResized")), 40),
  },
  {
    label: "Raycast clipboard originals (12 sampled)",
    paths: sample(
      pngsIn(join(homedir(), "Library/Caches/com.raycast-x.macos/clipboard")),
      12,
    ),
  },
  {
    label: "beacon rendered UI sections (14 sampled)",
    paths: sample(pngsIn(BEACON_SHOTS), 14),
  },
  {
    // Pinned rather than sampled: the whole reason planView has a slice branch
    // is the full-page screenshot, and a random sample keeps missing it.
    label: "full-page screenshots (pinned)",
    paths: pngsIn(BEACON_SHOTS).filter((path) => path.includes("-full")),
  },
];

const counts = { asis: 0, downscale: 0, slice: 0 };
let degraded = 0;
let oversize = 0;
let overPayload = 0;
let worstScale = 1;
let worstPath = "";

for (const source of sources) {
  console.log(`\n${source.label}`);
  console.log(
    `  ${"file".padEnd(34)}${"native".padStart(12)}${"tok".padStart(8)}  ${"plan".padEnd(10)}${"fitted".padStart(12)}   flag`,
  );
  console.log(`  ${"─".repeat(88)}`);

  for (const path of source.paths) {
    const size = pngSize(path);
    if (!size) continue;
    const tokens = countImageTokens(size.width, size.height);
    const plan = planView(size.width, size.height);
    counts[plan.kind] += 1;

    const payload = base64Bytes(statSync(path).size);
    if (payload > MAX_BASE64_BYTES.api) overPayload += 1;
    if (size.width > MAX_EDGE_ABSOLUTE || size.height > MAX_EDGE_ABSOLUTE) oversize += 1;

    let fitted = "—";
    let flag = "";
    if (plan.kind === "downscale") {
      fitted = `${plan.to.width}×${plan.to.height}`;
      flag = `DEGRADED ${Math.round(plan.scale * 100)}%`;
      degraded += 1;
      if (plan.scale < worstScale) {
        worstScale = plan.scale;
        worstPath = path;
      }
    } else if (plan.kind === "slice") {
      const forced = resizedSize(size.width, size.height);
      fitted = `${plan.slices.length}×slice`;
      flag = `UNUSABLE if fitted (${forced.width}×${forced.height}, ${Math.round(plan.scaleIfForced * 100)}%)`;
      degraded += 1;
      if (plan.scaleIfForced < worstScale) {
        worstScale = plan.scaleIfForced;
        worstPath = path;
      }
    }
    if (payload > MAX_BASE64_BYTES.api) flag += " · OVER 10MB base64";

    const name = basename(path);
    console.log(
      `  ${(name.length > 33 ? `${name.slice(0, 30)}...` : name).padEnd(34)}` +
        `${`${size.width}×${size.height}`.padStart(12)}${String(tokens).padStart(8)}  ` +
        `${plan.kind.padEnd(10)}${fitted.padStart(12)}   ${flag}`,
    );
  }
}

const total = counts.asis + counts.downscale + counts.slice;
console.log(`\nsummary over ${total} images`);
console.log(`  as-is      ${String(counts.asis).padStart(3)}  sent at native size, nothing lost`);
console.log(`  downscale  ${String(counts.downscale).padStart(3)}  silently shrunk unless caliper resizes them first`);
console.log(`  slice      ${String(counts.slice).padStart(3)}  too tall to fit — must be cropped, not scaled`);
console.log(`  ${degraded} of ${total} (${Math.round((degraded / total) * 100)}%) would be degraded if sent raw`);
console.log(`  ${oversize} exceed the ${MAX_EDGE_ABSOLUTE}px hard limit · ${overPayload} exceed the 10 MB base64 limit`);
console.log(`  worst: ${basename(worstPath)} at ${Math.round(worstScale * 100)}% of its native width`);
