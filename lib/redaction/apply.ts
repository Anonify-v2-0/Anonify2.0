import type { CharRange } from "@/lib/documents/docx/xml-text"
import type { DocxRedactionPlan } from "@/lib/documents/docx/redact"
import type { ImageRedactionPlan, RedactionStyle } from "@/lib/documents/image/redact"
import type { PdfRedactionPlan } from "@/lib/documents/pdf/redact"
import type { XlsxRedactionPlan } from "@/lib/documents/xlsx/redact"
import { acceptedValues, isAccepted } from "@/lib/redaction/model"
import type { BoundingBox, NormalizedDocument, TextSpan } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * Turning accepted redactions into format-specific instructions.
 *
 * This is the one place that reads the redaction model and decides what each
 * exporter must do. Only `accepted` redactions are ever considered: a
 * suggestion the user ignored, or one they rejected, has no effect on the
 * output — which is the whole point of keeping the two apart.
 */

export type ExportOptions = {
  /** Leave a visible "[REDACTED]" marker where content was removed. */
  addLabels: boolean
  sanitizeMetadata: boolean
  /** Appearance for image regions. */
  imageStyle?: RedactionStyle
}

export const DEFAULT_LABEL = "[REDACTED]"

function labelFor(options: ExportOptions): string | null {
  return options.addLabels ? DEFAULT_LABEL : null
}

/** Character range of a redaction, expressed within one span's own text. */
function rangeWithinSpan(
  span: TextSpan,
  start: number,
  end: number
): CharRange | null {
  const from = Math.max(span.start, start)
  const to = Math.min(span.end, end)
  if (to <= from) return null
  return { start: from - span.start, end: to - span.start }
}

/**
 * DOCX: map page-level offsets onto the runs that produced them.
 *
 * A value can straddle several runs — Word splits text at every formatting
 * change — so each run gets exactly the slice of the value it contributed.
 */
export function buildDocxPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): DocxRedactionPlan {
  const runEdits: Record<string, CharRange[]> = {}

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    if (redaction.start === undefined || redaction.end === undefined) continue

    const page = model.pages.find(
      (candidate) => candidate.number === (redaction.page ?? 1)
    )
    if (!page) continue

    for (const span of page.spans) {
      if (span.end <= redaction.start || span.start >= redaction.end) continue
      const range = rangeWithinSpan(span, redaction.start, redaction.end)
      if (!range) continue
      runEdits[span.id] = [...(runEdits[span.id] ?? []), range]
    }
  }

  return {
    runEdits,
    values: acceptedValues(redactions),
    label: labelFor(options),
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

/**
 * PDF: collect the glyph boxes covered by each accepted redaction.
 *
 * Boxes are padded slightly because glyph extents are tight around the ink and
 * a hairline of a letter surviving at the edge of a black box is a leak.
 */
const BOX_PADDING = 1.5

export function buildPdfPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): PdfRedactionPlan {
  const boxesByPage = new Map<number, BoundingBox[]>()

  const add = (page: number, box: BoundingBox) => {
    const padded: BoundingBox = {
      x: box.x - BOX_PADDING,
      y: box.y - BOX_PADDING,
      width: box.width + BOX_PADDING * 2,
      height: box.height + BOX_PADDING * 2,
    }
    boxesByPage.set(page, [...(boxesByPage.get(page) ?? []), padded])
  }

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    const pageNumber = redaction.page ?? 1

    // A hand-drawn or vision-detected region is already geometry.
    if (redaction.boundingBox) {
      add(pageNumber, redaction.boundingBox)
      continue
    }

    if (redaction.start === undefined || redaction.end === undefined) continue

    const page = model.pages.find((candidate) => candidate.number === pageNumber)
    if (!page) continue

    for (const span of page.spans) {
      if (!span.boundingBox) continue
      if (span.end <= redaction.start || span.start >= redaction.end) continue

      // Cover only the characters the redaction actually reaches, scaled
      // across the span's box, so redacting one word does not black out a line.
      const from = Math.max(span.start, redaction.start) - span.start
      const to = Math.min(span.end, redaction.end) - span.start
      const length = Math.max(1, span.text.length)
      const unit = span.boundingBox.width / length

      add(pageNumber, {
        x: span.boundingBox.x + unit * from,
        y: span.boundingBox.y,
        width: Math.max(unit * (to - from), unit),
        height: span.boundingBox.height,
      })
    }
  }

  return {
    boxesByPage,
    label: labelFor(options),
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

export function buildXlsxPlan(
  redactions: Redaction[],
  options: ExportOptions
): XlsxRedactionPlan {
  const cells: XlsxRedactionPlan["cells"] = []
  const rows: XlsxRedactionPlan["rows"] = []
  const columns: XlsxRedactionPlan["columns"] = []

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    const sheet = redaction.worksheet
    if (!sheet) continue

    switch (redaction.type) {
      case "column":
        if (redaction.column) columns.push({ sheet, column: redaction.column })
        break
      case "row":
        if (redaction.row) rows.push({ sheet, row: redaction.row })
        break
      default:
        if (redaction.row && redaction.column) {
          cells.push({ sheet, row: redaction.row, column: redaction.column })
        }
    }
  }

  return {
    cells,
    rows,
    columns,
    values: acceptedValues(redactions),
    label: labelFor(options),
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

export function buildImagePlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): ImageRedactionPlan {
  const regions: ImageRedactionPlan["regions"] = []
  const page = model.pages[0]

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue

    if (redaction.boundingBox) {
      regions.push({
        boundingBox: redaction.boundingBox,
        style: redaction.type === "face" ? options.imageStyle : "solid",
      })
      continue
    }

    // A text redaction on an image resolves through its OCR span geometry.
    if (
      page &&
      redaction.start !== undefined &&
      redaction.end !== undefined
    ) {
      for (const span of page.spans) {
        if (!span.boundingBox) continue
        if (span.end <= redaction.start || span.start >= redaction.end) continue
        regions.push({ boundingBox: span.boundingBox, style: "solid" })
      }
    }
  }

  return {
    regions,
    defaultStyle: options.imageStyle ?? "solid",
    sanitizeMetadata: options.sanitizeMetadata,
  }
}
