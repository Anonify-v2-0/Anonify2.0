import type { BoundingBox, NormalizedPage, TextSpan } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * Where a redaction actually sits on the page.
 *
 * One implementation, used by both the canvas and the exporter, because the
 * canvas is a promise about what the export will do. Two copies of this would
 * eventually disagree, and the way a user finds out is by downloading a file
 * with a black box somewhere other than where they saw it.
 *
 * Spans carry how precisely their box locates their text:
 *
 *   word  — the box bounds the characters, so a redaction covering part of the
 *           span gets a proportional slice of the box.
 *   block — the box bounds a whole paragraph, which is all some OCR providers
 *           report. A slice of that would be a rectangle in the wrong place,
 *           possibly on the wrong line, so the whole block is covered.
 *
 * Over-redaction is visible and recoverable. A box in the wrong place is a leak
 * that looks like a success.
 */

/** Padding in page units. Glyph boxes are tight, and a surviving hairline leaks. */
export const BOX_PADDING = 1.5

export function padBox(box: BoundingBox, padding = BOX_PADDING): BoundingBox {
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  }
}

/** The portion of one span's box that a character range covers. */
export function boxForRange(
  span: TextSpan,
  start: number,
  end: number
): BoundingBox | null {
  if (!span.boundingBox) return null

  // Block geometry locates a paragraph, not characters: cover all of it.
  if (span.geometry === "block") return span.boundingBox

  const from = Math.max(span.start, start) - span.start
  const to = Math.min(span.end, end) - span.start
  const length = Math.max(1, span.text.length)
  const unit = span.boundingBox.width / length

  return {
    x: span.boundingBox.x + unit * from,
    y: span.boundingBox.y,
    width: Math.max(unit * (to - from), unit),
    height: span.boundingBox.height,
  }
}

/**
 * Every box a redaction covers on a page. A redaction with its own geometry —
 * a drawn region, a detected face — is already an answer.
 */
export function boxesForRedaction(
  page: Pick<NormalizedPage, "spans">,
  redaction: Redaction
): BoundingBox[] {
  if (redaction.boundingBox) return [redaction.boundingBox]
  if (redaction.start === undefined || redaction.end === undefined) return []

  const boxes: BoundingBox[] = []
  for (const span of page.spans) {
    if (!span.boundingBox) continue
    if (span.end <= redaction.start || span.start >= redaction.end) continue

    const box = boxForRange(span, redaction.start, redaction.end)
    if (box) boxes.push(box)
  }

  return boxes
}
