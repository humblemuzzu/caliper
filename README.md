# caliper

Measure screenshots numerically, and never let one silently exceed Claude's
vision budget.

## The problem

Porting a design screenshot into pixel-accurate code is a measuring job, not a
looking job. Eyeballing a 3px gap is unreliable; counting the rows of ink in it
is not. The loop is: measure the reference → build → screenshot your render →
measure it the same way → diff the numbers → repeat until the deltas are 1-3px.

That loop breaks if the picture you are looking at is not the picture you think
you are looking at. Images over the budget get resized server-side before the
model ever sees them, and nothing tells you. A 1568×1388 screenshot arrives as
1170×1036 — 75%, survivable. A 1568×7698 full-page screenshot arrives as
**319×1568**: a fifth of its width, and useless.

## The two ceilings

On the standard tier an image must satisfy *both* limits: no edge over 1568px,
**and** no more than 1568 visual tokens, where a token is one 28×28 patch. The
token limit is what bites, and it bites images that are entirely inside the edge
limit. The largest sizes that need no resize:

| shape | standard tier | high-res tier |
| ----- | ------------- | ------------- |
| square | 1092×1092 | 1932×1932 |
| 16:9 | 1456×819 | 2576×1449 |

A 1920×1080 screenshot resizes to **1456×819, not 1568×882**. Assuming the edge
limit puts every coordinate you derive off target.

`docs/claude-vision-spec.md` is the specification, quoted from the official
docs. Where this code and that file disagree, this code is wrong — except at two
points where the spec contradicts itself, both pinned with their arithmetic in
`src/vision.test.ts`. (The high-res square ceiling above is one of them: §10
prints 2044×2044, which costs 73 × 73 = 5329 tokens against a 4784 budget.)

## The two-output rule

`capture` writes two files per shot and never conflates them:

- `<section>-<width>.raw.png` — full resolution. **Measure this.**
- `<section>-<width>.view.png` — passed through the budget planner. **Look at this.**

When the image is too tall to fit without becoming illegible, the view is not a
downscale at all — it is a set of full-width slices, tiled top to bottom with a
small overlap, each of which fits the budget on its own.

## Commands

```
bun run src/cli.ts <command>

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
```

Common flags: `--box=x,y,w,h`, `--tier=standard|highRes`, `--threshold=N`,
`--invert`, `--min-height=N`, `--cap-ratio=N`, `--depth=N`, `--window=N`,
`--range=a,b`, `--cell=N`, `--stride=N`, `--bands=N`, `--dilate=N`, `--erode=N`,
`--anchor=N`, `--labels=a,b`, `--snap`, `--classify=a,b,c`.

```
$ bun run src/cli.ts budget 1568 7698
1568×7698  ·  15400 tokens  ·  standard tier (max edge 1568, max tokens 1568)

  plan: SLICE — fitting 1568×7698 would give 319×1568 — 20% of the width,
  under the 900px legibility floor. 11 full-width slices of 1568×784 instead.
```

## Notes on the measurements

Every threshold is a parameter with a documented default, never a module
constant. The defaults — ink at 170 on a light background, Inter's 0.727 cap
ratio — are facts about one design and one typeface. On a different project they
are wrong, and a library that hides them lies to you.

Three of them exist because a specific approach failed in real work:

- **`edges`** finds a #fafafa card on a #fafafa page separated by a #e9e9e9
  hairline. No ink threshold can; a local minimum can.
- **`modal`** reports `confidence`, because sampling a *tilted* pill with a
  rectangular box returns the colour of the card behind it. A 60% sample has to
  announce itself.
- **`classify`** compares one measurement across several sections. Per-section
  checking cannot see a systematic error: a container width 6% wrong in *every*
  section passed four rounds of it.

Downscaling is area-average only, and throws if asked to enlarge. Lanczos rings
on hard edges, and a UI screenshot is nothing but hard edges.

## Layout

```
src/vision.ts      image budget maths — the safety layer
src/png.ts         PNG load/save/crop, grayscale precomputed at load
src/resample.ts    area-average downscale
src/measure.ts     the seven measurement primitives
src/fixtures.ts    synthetic images with answers known by construction
src/compare.ts     aligned delta tables, systemic/local classifier
src/capture.ts     playwright harness that enforces the budget
src/cli.ts         argument parsing and formatting only
scripts/sanity.ts  runs the budget maths over real screenshots on this machine
```

## Development

```
bun install
bun test          # 90 tests
bunx tsc --noEmit
```

Tests assert against generated images whose properties are exact by
construction, not against real screenshots whose "true" values are estimates.
