import type { Band } from "./measure.ts";

export interface CompareOptions {
  labels?: [string, string];
  /**
   * Index of the band both lists are zeroed on. The default anchors on the
   * first band, which makes the table read as "distance below the first thing
   * on the page" and cancels out any difference in where the section starts.
   */
  anchor?: number;
  /** Deltas at or below this are the target, and are counted in the summary. */
  tolerance?: number;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function tabulate(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padStart(widths[column] as number)).join("  ");
  return [
    line(header),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

/**
 * An aligned delta table, as text. The most-used output of the toolkit.
 *
 * Both band lists are offset so the anchor band sits at zero before they are
 * printed side by side. Comparing absolute tops is useless — the two
 * screenshots almost never start at the same place — while comparing offsets
 * shows the only thing that matters, which is whether the spacing between
 * elements matches.
 */
export function compare(ref: Band[], mine: Band[], opts: CompareOptions = {}): string {
  const { labels = ["ref", "mine"], anchor = 0, tolerance = 3 } = opts;
  const origin = (list: Band[]): number => {
    if (list.length === 0) return 0;
    const band = list[anchor];
    if (!band) throw new Error(`anchor ${anchor} is beyond the ${list.length} bands measured`);
    return band.top;
  };
  const refOrigin = origin(ref);
  const mineOrigin = origin(mine);

  const rows: string[][] = [];
  let worst = 0;
  let worstRow = -1;
  let within = 0;
  let paired = 0;

  for (let i = 0; i < Math.max(ref.length, mine.length); i += 1) {
    const a = ref[i];
    const b = mine[i];
    if (a && b) {
      const delta = b.top - mineOrigin - (a.top - refOrigin);
      paired += 1;
      if (Math.abs(delta) <= tolerance) within += 1;
      if (Math.abs(delta) > Math.abs(worst)) {
        worst = delta;
        worstRow = i;
      }
      rows.push([
        String(i),
        String(a.top - refOrigin),
        String(b.top - mineOrigin),
        signed(delta),
        String(a.height),
        String(b.height),
        signed(b.height - a.height),
      ]);
      continue;
    }
    // An unpaired band means the two renders disagree about how many things
    // are on the page, which is a bigger problem than any delta.
    rows.push([
      String(i),
      a ? String(a.top - refOrigin) : "—",
      b ? String(b.top - mineOrigin) : "—",
      "—",
      a ? String(a.height) : "—",
      b ? String(b.height) : "—",
      "—",
    ]);
  }

  const header = ["#", labels[0], labels[1], "Δ", `${labels[0]} h`, `${labels[1]} h`, "Δh"];
  const summary =
    paired === 0
      ? "no bands in common"
      : `${within}/${paired} within ${tolerance}px · worst ${signed(worst)}px at row ${worstRow}`;
  const counts =
    ref.length === mine.length
      ? ""
      : `\n${labels[0]} has ${ref.length} bands, ${labels[1]} has ${mine.length}`;

  return `${tabulate(header, rows)}\n\n${summary}${counts}`;
}

export interface ClassifyOptions {
  /** Relative spread below which the samples are the same number. 0.02 is 2%. */
  tolerance?: number;
  /**
   * Two agreeing samples are a coincidence; three are a pattern. Below this
   * many samples the answer is "you have not looked at enough sections yet".
   */
  minSamples?: number;
}

/**
 * Decide whether one measurement, taken from several different reference
 * screenshots, belongs to a shared design token or to one component.
 *
 * This exists because per-section verification is blind to systematic error. A
 * container width that was 6% wrong in every section survived four rounds of
 * checking each section against its own reference, because each check compared
 * a wrong number against the same wrong number. Only comparing the sections
 * against each other exposes it.
 */
export function classify(
  samples: number[],
  opts: ClassifyOptions = {},
): { verdict: "systemic" | "local" | "inconclusive"; spread: number } {
  const { tolerance = 0.02, minSamples = 3 } = opts;
  if (samples.length === 0) throw new Error("classify needs at least one sample");

  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const spread = mean === 0 ? 0 : (Math.max(...samples) - Math.min(...samples)) / mean;

  if (samples.length < minSamples) return { verdict: "inconclusive", spread };
  return { verdict: spread <= tolerance ? "systemic" : "local", spread };
}
