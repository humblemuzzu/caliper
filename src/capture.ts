import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { crop, load, save } from "./png.ts";
import { downscale } from "./resample.ts";
import { countImageTokens, planView, type Tier, TIERS, type ViewPlan } from "./vision.ts";

/**
 * Screenshot a page section at several widths, and never hand back an image
 * that will be silently degraded when it is looked at.
 */

export interface CaptureOptions {
  url: string;
  /** id of the element to shoot. The element is shot, not a page-level clip. */
  sectionId: string;
  widths: number[];
  outDir: string;
  tier?: Tier;
  /**
   * Multiplies the pixels, and therefore the token cost, by its square. The
   * budget is counted in device pixels, so a 1568 CSS-px shot at dsf 2 is a
   * 3136px image costing four times as much.
   */
  deviceScaleFactor?: number;
  /** Selectors inside the section whose offsets to report, relative to its top-left. */
  children?: string[];
}

export interface ChildOffset {
  selector: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ShotReport {
  width: number;
  raw: { path: string; width: number; height: number; tokens: number };
  view: { kind: ViewPlan["kind"]; paths: string[]; tokens: number; note: string };
  /** scrollWidth - clientWidth. Anything but 0 means the page scrolls sideways. */
  overflow: number;
  pageErrors: string[];
  children: ChildOffset[];
}

export interface CaptureReport {
  url: string;
  sectionId: string;
  shots: ShotReport[];
}

/**
 * Sticky chrome overlaps whatever is scrolled under it, and a half-finished
 * transition makes the same page produce two different screenshots. Both are
 * removed before anything is measured.
 */
const DETERMINISM_CSS = `
  header, nextjs-portal { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

function writeView(rawPath: string, base: string, plan: ViewPlan): ShotReport["view"] {
  if (plan.kind === "asis") {
    const path = `${base}.view.png`;
    copyFileSync(rawPath, path);
    return { kind: "asis", paths: [path], tokens: plan.tokens, note: "as-is" };
  }

  if (plan.kind === "downscale") {
    const path = `${base}.view.png`;
    save(downscale(load(rawPath), plan.to), path);
    const percent = Math.round(plan.scale * 100);
    return {
      kind: "downscale",
      paths: [path],
      tokens: plan.tokens,
      note: `${plan.to.width}×${plan.to.height} (${plan.tokens} tok, ${percent}%)`,
    };
  }

  const img = load(rawPath);
  const paths = plan.slices.map((box, i) => {
    const path = `${base}.slice-${i + 1}.png`;
    save(crop(img, box), path);
    return path;
  });
  const first = plan.slices[0];
  const perSlice = first ? countImageTokens(first.width, first.height) : 0;
  return {
    kind: "slice",
    paths,
    tokens: perSlice * plan.slices.length,
    note: `${paths.length} slices — ${plan.reason}`,
  };
}

export async function captureSection(opts: CaptureOptions): Promise<CaptureReport> {
  const tier = opts.tier ?? TIERS.standard;
  const deviceScaleFactor = opts.deviceScaleFactor ?? 1;
  mkdirSync(opts.outDir, { recursive: true });

  // One browser, a fresh context per width: the context carries the viewport,
  // and a new one guarantees no state survives from the previous shot.
  const browser = await chromium.launch();
  const shots: ShotReport[] = [];
  try {
    for (const width of opts.widths) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(opts.url, { waitUntil: "networkidle" });
      await page.addStyleTag({ content: DETERMINISM_CSS });
      await page.evaluate(() => document.fonts.ready);

      const measured = await page.evaluate(
        (args: { sectionId: string; selectors: string[] }) => {
          const section = document.getElementById(args.sectionId);
          if (!section) return null;
          const base = section.getBoundingClientRect();
          return {
            overflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
            children: args.selectors.flatMap((selector) => {
              const child = section.querySelector(selector);
              if (!child) return [];
              const rect = child.getBoundingClientRect();
              return [
                {
                  selector,
                  top: Math.round(rect.top - base.top),
                  left: Math.round(rect.left - base.left),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              ];
            }),
          };
        },
        { sectionId: opts.sectionId, selectors: opts.children ?? [] },
      );
      if (!measured) throw new Error(`no element with id "${opts.sectionId}" at ${opts.url}`);

      const section = page.locator(`#${opts.sectionId}`);
      await section.scrollIntoViewIfNeeded();

      // Shoot the ELEMENT. A page-level clip silently returns the wrong region
      // once the element is below the fold, because the clip is in viewport
      // coordinates and the element is not.
      const base = join(opts.outDir, `${opts.sectionId}-${width}`);
      const rawPath = `${base}.raw.png`;
      await section.screenshot({ path: rawPath });
      await context.close();

      const raw = load(rawPath);
      const plan = planView(raw.width, raw.height, { tier });
      shots.push({
        width,
        raw: {
          path: rawPath,
          width: raw.width,
          height: raw.height,
          tokens: countImageTokens(raw.width, raw.height),
        },
        view: writeView(rawPath, base, plan),
        overflow: measured.overflow,
        pageErrors,
        children: measured.children,
      });
    }
  } finally {
    await browser.close();
  }

  return { url: opts.url, sectionId: opts.sectionId, shots };
}

export function formatReport(report: CaptureReport): string {
  const lines: string[] = [`${report.sectionId} — ${report.url}`];
  for (const shot of report.shots) {
    lines.push(
      `  ${report.sectionId} @${shot.width} → raw ${shot.raw.width}×${shot.raw.height} ` +
        `(${shot.raw.tokens} tok) view ${shot.view.note}`,
    );
    if (shot.overflow !== 0) lines.push(`    horizontal overflow: ${shot.overflow}px`);
    for (const error of shot.pageErrors) lines.push(`    pageerror: ${error}`);
    for (const child of shot.children) {
      lines.push(
        `    ${child.selector}: top ${child.top} left ${child.left} ${child.width}×${child.height}`,
      );
    }
    for (const path of shot.view.paths) lines.push(`    wrote ${path}`);
  }
  return lines.join("\n");
}
