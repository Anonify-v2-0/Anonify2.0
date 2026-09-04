import sharp, { type OverlayOptions } from "sharp"

import type { BoundingBox } from "@/types/document"

/**
 * Image redaction.
 *
 * The pixels are replaced, not covered: the exported image is re-encoded from a
 * buffer in which the redacted regions no longer contain the original content.
 * A CSS rectangle over the original file would be a caption, not a redaction.
 *
 * Blur and pixelate are offered because they read better in photographs, but
 * both are computed from the region and composited over it — the source pixels
 * are gone from the output either way. Note that heavy blurring can, in
 * principle, be attacked; solid fill is the default for that reason.
 */

export type RedactionStyle = "solid" | "blur" | "pixelate"

export type ImageRegionRedaction = {
  boundingBox: BoundingBox
  style?: RedactionStyle
}

export type ImageRedactionPlan = {
  regions: ImageRegionRedaction[]
  defaultStyle: RedactionStyle
  /** Strip EXIF, GPS and other identifying metadata from the export. */
  sanitizeMetadata: boolean
}

/** Pixelation block size as a fraction of the region's shorter side. */
const PIXELATE_DIVISOR = 8
const MIN_REGION_PX = 2

function clampRegion(
  box: BoundingBox,
  width: number,
  height: number
): BoundingBox | null {
  const x = Math.max(0, Math.floor(box.x))
  const y = Math.max(0, Math.floor(box.y))
  const right = Math.min(width, Math.ceil(box.x + box.width))
  const bottom = Math.min(height, Math.ceil(box.y + box.height))

  const clamped = {
    x,
    y,
    width: right - x,
    height: bottom - y,
  }

  if (clamped.width < MIN_REGION_PX || clamped.height < MIN_REGION_PX) {
    return null
  }
  return clamped
}

async function obscuredRegion(
  source: Buffer,
  region: BoundingBox,
  style: RedactionStyle
): Promise<Buffer> {
  const extract = {
    left: region.x,
    top: region.y,
    width: region.width,
    height: region.height,
  }

  if (style === "blur") {
    return sharp(source)
      .extract(extract)
      .blur(Math.max(8, Math.min(region.width, region.height) / 4))
      .png()
      .toBuffer()
  }

  // Pixelate: downscale to a handful of blocks, then scale back with no
  // interpolation, so the original detail is discarded rather than smoothed.
  // A sharp pipeline honours only one resize, so the two passes need separate
  // pipelines — chaining them would silently skip the downscale that does the
  // actual destroying.
  const blocks = Math.max(
    2,
    Math.floor(Math.min(region.width, region.height) / PIXELATE_DIVISOR)
  )

  const downscaled = await sharp(source)
    .extract(extract)
    .resize(blocks, blocks, { fit: "fill" })
    .png()
    .toBuffer()

  return sharp(downscaled)
    .resize(region.width, region.height, {
      fit: "fill",
      kernel: "nearest",
    })
    .png()
    .toBuffer()
}

export async function redactImage(
  bytes: Uint8Array,
  plan: ImageRedactionPlan
): Promise<Uint8Array> {
  const source = Buffer.from(bytes)
  const base = sharp(source)
  const metadata = await base.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width === 0 || height === 0) {
    throw new Error("Image has no readable dimensions")
  }

  const composites: OverlayOptions[] = []

  for (const region of plan.regions) {
    const box = clampRegion(region.boundingBox, width, height)
    if (!box) continue

    const style = region.style ?? plan.defaultStyle

    if (style === "solid") {
      composites.push({
        input: {
          create: {
            width: box.width,
            height: box.height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          },
        },
        left: box.x,
        top: box.y,
      })
      continue
    }

    composites.push({
      input: await obscuredRegion(source, box, style),
      left: box.x,
      top: box.y,
    })
  }

  // Re-encoding from the composited pixels is what makes this irreversible:
  // the output never contains the original region's data.
  let pipeline = sharp(source).composite(composites)

  if (!plan.sanitizeMetadata) {
    pipeline = pipeline.withMetadata()
  }

  const format = metadata.format === "jpeg" ? "jpeg" : "png"
  const output =
    format === "jpeg"
      ? await pipeline.jpeg({ quality: 92 }).toBuffer()
      : await pipeline.png().toBuffer()

  return new Uint8Array(output)
}

/**
 * Reads back the average colour of a region, used by the security tests.
 * sharp's `stats()` reports on the input image rather than the pipeline, so the
 * crop has to be materialized before it is measured.
 */
export async function sampleRegion(
  bytes: Uint8Array,
  box: BoundingBox
): Promise<{ r: number; g: number; b: number }> {
  const crop = await sharp(Buffer.from(bytes))
    .extract({
      left: Math.floor(box.x),
      top: Math.floor(box.y),
      width: Math.max(1, Math.floor(box.width)),
      height: Math.max(1, Math.floor(box.height)),
    })
    .png()
    .toBuffer()

  const stats = await sharp(crop).stats()
  const [r, g, b] = stats.channels
  return { r: r.mean, g: g.mean, b: b.mean }
}
