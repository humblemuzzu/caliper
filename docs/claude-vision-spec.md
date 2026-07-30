# Claude vision — image limits, verbatim

Extracted 2026-07-30 from the official docs:

- https://platform.claude.com/docs/en/build-with-claude/vision.md
- https://platform.claude.com/docs/en/build-with-claude/vision-coordinates.md

Everything below is quoted or transcribed from those pages. **This file is the
specification. Where an implementation disagrees with this file, the
implementation is wrong.**

---

## 1. Token cost

> Claude views images in patches instead of pixels. Each patch is a 28×28-pixel
> block of the image, referred to as a visual token. An image, therefore, costs
> `⌈width / 28⌉ × ⌈height / 28⌉` visual tokens.

```
tokens(w, h) = ceil(w / 28) * ceil(h / 28)
```

## 2. Resolution tiers

| Resolution tier | Models | Max long edge | Max visual tokens |
| --------------- | ------ | ------------- | ----------------- |
| High-resolution | Claude 4.7 and later models | 2576 px | 4784 |
| Standard | All other models | 1568 px | 1568 |

> High-resolution support is automatic on the listed models and requires no beta
> header or client-side opt-in.

## 3. Published size table

Use these as test vectors. They are the ground truth.

| Image size | Standard: downsized to | Standard: tokens | High-res: downsized to | High-res: tokens |
| ---------- | ---------------------- | ---------------- | ---------------------- | ---------------- |
| 200×200 (0.04 MP) | Not resized | 64 | Not resized | 64 |
| 1000×1000 (1 MP) | Not resized | 1296 | Not resized | 1296 |
| 1092×1092 (1.19 MP) | Not resized | 1521 | Not resized | 1521 |
| 1920×1080 (2.07 MP) | 1456×819 | 1560 | Not resized | 2691 |
| 2000×1500 (3 MP) | 1269×952 | 1564 | Not resized | 3888 |
| 3840×2160 (8.29 MP) | 1456×819 | 1560 | 2576×1449 | 4784 |

## 4. The resize rule

> Claude finds the largest aspect-preserving size that satisfies both of the
> model's image limits:
>
> 1. **Edge limit:** neither side exceeds the maximum edge length (1568 px on the
>    standard tier, 2576 px on the high-resolution tier).
> 2. **Visual token limit:** the image's token cost `⌈width / 28⌉ × ⌈height / 28⌉`
>    does not exceed the model's visual token budget (1568 tokens on the standard
>    tier, 4784 on the high-resolution tier).

### THE TRAP — read this twice

> For nearly all photos and screenshots, the visual token limit is what
> determines the final size. The edge limit takes over only for elongated images
> such as panoramas or tall phone screenshots. Compute the size with the
> reference implementation rather than scaling to the edge length by hand: a
> 1920×1080 screenshot resizes to 1456×819, not 1568×882, and assuming the edge
> limit puts every coordinate noticeably off target.

> The token limit can also trigger a resize when neither side exceeds the edge
> limit. **Overlooking this is the most common cause of misaligned coordinates.**
> For example, an A4 page scanned at 130 DPI is 1075×1520 pixels: both sides are
> under 1568 px, but it costs `39 × 55 = 2145` visual tokens, so Claude resizes it
> to 924×1307.

An image can therefore be **fully inside the 1568 px edge limit and still be
resized.** Enforcing only the long edge is insufficient.

## 5. Padding

> Claude then pads every image, resized or not, up to the next multiple of 28
> pixels on the bottom and right edges (924×1307 becomes 924×1316 in the
> example). The padding contains no content: Claude perceives the padded image,
> but the page content only ever occupies the un-padded resized region.
> **Always normalize or rescale by the resized dimensions, not the padded
> dimensions**; dividing by the padded dimensions scales every coordinate by a
> small amount.

Consequence: an image whose dimensions are already multiples of 28 incurs **no
padding and no wasted tokens.**

## 6. Reference implementation (Python, verbatim from the docs)

```python
import math


def count_image_tokens(width: int, height: int) -> int:
    """Visual tokens consumed by an image: one token per 28x28 pixel patch."""
    return math.ceil(width / 28) * math.ceil(height / 28)


def resized_size(
    width: int,
    height: int,
    max_edge: int = 1568,
    max_tokens: int = 1568,
) -> tuple[int, int]:
    """The size Claude resizes an image to before padding.

    Defaults are for the standard resolution tier. For high-resolution-tier
    models, use max_edge=2576 and max_tokens=4784. Returns (width, height).
    Images that already fit within the limits are returned unchanged.
    """

    def fits(w: int, h: int) -> bool:
        return (
            math.ceil(w / 28) * 28 <= max_edge
            and math.ceil(h / 28) * 28 <= max_edge
            and count_image_tokens(w, h) <= max_tokens
        )

    if fits(width, height):
        return (width, height)
    if height > width:
        resized_h, resized_w = resized_size(height, width, max_edge, max_tokens)
        return (resized_w, resized_h)

    # Binary search along the long edge for the largest aspect-preserving
    # size that fits.
    aspect_ratio = width / height
    lo, hi = 1, width  # lo always fits; hi never fits
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fits(mid, max(round(mid / aspect_ratio), 1)):
            lo = mid
        else:
            hi = mid
    return (lo, max(round(lo / aspect_ratio), 1))


# The A4 example from "How Claude resizes and pads images":
print(resized_size(1075, 1520))  # (924, 1307)
```

Three details in that code are load-bearing:

1. **`fits` compares `ceil(w/28)*28` against the edge limit**, i.e. the *padded*
   edge, not the raw edge.
2. **`round` is Python's**, which is banker's rounding (half-to-even). The docs
   note for the TypeScript port: *"Round half to even (banker's rounding),
   matching Python's round(). The live API resolves exact .5 ties toward the even
   neighbor, so Math.round (which rounds halves up) would"* — diverge. Any port
   must reproduce half-to-even.
3. **The tall case recurses with the axes swapped**, then swaps the result back.

## 7. Request and size limits

> The maximum number of images per message or request is:
> - 20 per message on claude.ai.
> - 100 per request on the API, for models with a 200k-token context window.
> - 600 per request on the API, for all other models.
>
> The maximum dimensions per image are 8000x8000 px.

> If a single API request contains more than 20 images, a stricter per-image
> dimension limit applies. […] Images exceeding the stricter limit are rejected
> with an `invalid_request_error` whose message references "many-image requests"
> and states the current limit in pixels. To stay under the limit on all
> platforms, either resize each image so that neither dimension exceeds 2000 px,
> or keep the request to 20 or fewer image and document blocks.

> The maximum size per image is:
> - **10 MB (base64-encoded)** when using the Claude API directly.
> - **5 MB (base64-encoded)** on Amazon Bedrock and Google Cloud.
> - 10 MB on claude.ai.

**These limits are on the BASE64-ENCODED size, not the raw file size.** Base64
encodes 3 bytes as 4 characters, so:

```
base64Bytes(raw) = ceil(raw / 3) * 4
```

A raw file is therefore ~1.37× larger once encoded. Comparing raw bytes against
a base64 limit is wrong and passes files that will be rejected: a 4.5 MB raw PNG
becomes a 6 MB payload.

## 8. Supported formats

> Claude supports JPEG, PNG, GIF, and WebP images (`image/jpeg`, `image/png`,
> `image/gif`, `image/webp`). Animations are unsupported, and only the first frame
> is used.

## 9. Quality guidance

> - **Image clarity:** Ensure images are clear and not too blurry or pixelated.
> - **Text:** If the image contains important text, make sure it's legible and
>   not too small. Avoid cropping out key visual context solely to enlarge the
>   text.
> - **Resizing:** Take into account that your image might be resized if it is too
>   large; this might, for example, make text less legible. Consider pre-resizing
>   your images, cropping them, or both.
> - **Image compression:** Compressing images before sending them, using a lossy
>   format such as JPEG or WebP (lossy mode), can reduce latency by reducing the
>   size of requests. However, **this can introduce artifacts that are detrimental
>   to model performance, especially when multiple compression passes are
>   applied. For example, heavy JPEG compression can make text difficult to
>   read.** Confirm your compression settings are appropriate for the task by
>   inspecting the actual images sent to the API.

> To minimize latency and to simplify coordinate-based workflows, prefer resizing
> images before uploading them.

## 10. Consequences worth spelling out

**Practical ceilings** (largest size that needs no resize, standard tier):

| shape | standard tier | high-res tier |
| ----- | ------------- | ------------- |
| square | 1092×1092 | 2044×2044 |
| 16:9 | 1456×819 | 2576×1449 |

**Pre-resizing to exactly `resized_size(...)` means the API resizes nothing**,
which avoids a second resampling pass. Two resamplings of text are visibly worse
than one.

**Very tall images degrade catastrophically.** A 1568×7698 full-page screenshot
costs 15,400 tokens and is reduced to **319×1568** — 20% of its width, and
useless. The correct response to a tall image is to **crop it into slices**, not
to scale it. The docs say the same thing for fine targets: *"crop the region of
interest and send the crop (offset returned coordinates by the crop origin)."*
