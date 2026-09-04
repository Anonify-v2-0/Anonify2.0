import type { CharRange } from "@/lib/documents/docx/xml-text"
import type { DocxRedactionPlan } from "@/lib/documents/docx/redact"
import type { ImageRedactionPlan, RedactionStyle } from "@/lib/documents/image/redact"
import type { PdfRedactionPlan } from "@/lib/documents/pdf/redact"
import type { XlsxRedactionPlan } from "@/lib/documents/xlsx/redact"
import { boxesForRedaction, padBox } from "@/lib/redaction/geometry"
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
 * PDF: collect the boxes covered by each accepted redaction.
 *
 * The geometry itself lives in lib/redaction/geometry.ts, shared with the
 * canvas — the preview and the export must agree about where a box goes.
 */
export function buildPdfPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): PdfRedactionPlan {
  const boxesByPage = new Map<number, BoundingBox[]>()

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    const pageNumber = redaction.page ?? 1
    const page = model.pages.find((candidate) => candidate.number === pageNumber)
    if (!page && !redaction.boundingBox) continue

    const boxes = boxesForRedaction(page ?? { spans: [] }, redaction)
    if (boxes.length === 0) continue

    boxesByPage.set(pageNumber, [
      ...(boxesByPage.get(pageNumber) ?? []),
      ...boxes.map((box) => padBox(box)),
    ])
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
        boundingBox: padBox(redaction.boundingBox),
        style: redaction.type === "face" ? options.imageStyle : "solid",
      })
      continue
    }

    // A text redaction on an image resolves through its OCR span geometry, and
    // is padded for the same reason the PDF plan pads: an OCR word box is drawn
    // tight around the glyphs, and a fill exactly that size can leave a legible
    // hairline of ascender or descender behind.
    if (page) {
      for (const box of boxesForRedaction(page, redaction)) {
        regions.push({ boundingBox: padBox(box), style: "solid" })
      }
    }
  }

  return {
    regions,
    defaultStyle: options.imageStyle ?? "solid",
    sanitizeMetadata: options.sanitizeMetadata,
  }
}
