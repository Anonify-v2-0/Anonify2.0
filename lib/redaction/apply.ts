import type { DelimitedRedactionPlan } from "@/lib/documents/delimited/redact"
import { parseEmlAddress } from "@/lib/documents/eml/address"
import {
  headerKey,
  type EmlRedactionPlan,
} from "@/lib/documents/eml/redact"
import type {
  CharRange,
  ReplacementRange,
  ValueReplacement,
} from "@/lib/documents/shared/text"
import type { DocxRedactionPlan } from "@/lib/documents/docx/redact"
import type { ImageRedactionPlan, RedactionStyle } from "@/lib/documents/image/redact"
import type { LabeledBox, PdfRedactionPlan } from "@/lib/documents/pdf/redact"
import { parseTextAddress } from "@/lib/documents/text/extract"
import type { TextRedactionPlan } from "@/lib/documents/text/redact"
import type { XlsxRedactionPlan } from "@/lib/documents/xlsx/redact"
import { boxesForRedaction, padBox } from "@/lib/redaction/geometry"
import type { MethodOverrides } from "@/lib/redaction/methods"
import { acceptedValues, isAccepted } from "@/lib/redaction/model"
import { NO_SURROGATES, type Surrogates } from "@/lib/redaction/surrogates"
import type { NormalizedDocument, TextSpan } from "@/types/document"
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
  /**
   * A method asked for by category, overriding what each redaction carries.
   * This is what distinguishes one variant of an export from another.
   */
  methods?: MethodOverrides
  /**
   * The key `encrypt` uses, when the caller needs several exports to share
   * one — a message and the attachments substituted into it. Generated per
   * export when absent, and never stored either way.
   */
  valueKey?: Buffer
  /**
   * What stands in for each accepted value.
   *
   * Absent means every accepted redaction masks, which is what an export
   * asked for before methods existed and what every per-format test still
   * asks for. When present, a redaction whose value was given a method
   * carries its surrogate on the ranges it produced, and the safety sweep
   * carries the same surrogate for the occurrences nobody reviewed — see
   * lib/redaction/surrogates.ts for why that has to be the same string.
   */
  surrogates?: Surrogates
}

export const DEFAULT_LABEL = "[REDACTED]"

function labelFor(options: ExportOptions): string | null {
  return options.addLabels ? DEFAULT_LABEL : null
}

function surrogatesFor(options: ExportOptions): Surrogates {
  return options.surrogates ?? NO_SURROGATES
}

/**
 * The values the package-wide sweep looks for, each with what replaces it.
 *
 * A value with no replacement is masked, and `undefined` is how that is said:
 * `cutRanges` falls back to the plan's label, and a range with no replacement
 * beats one with a surrogate when the two overlap.
 */
function sweepValues(
  redactions: Redaction[],
  options: ExportOptions
): ValueReplacement[] {
  const surrogates = surrogatesFor(options)
  return acceptedValues(redactions).map((value) => ({
    value,
    replacement: surrogates.forValue(value),
  }))
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
  const runEdits: Record<string, ReplacementRange[]> = {}
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    if (redaction.start === undefined || redaction.end === undefined) continue

    const page = model.pages.find(
      (candidate) => candidate.number === (redaction.page ?? 1)
    )
    if (!page) continue

    const replacement = surrogates.forRedaction(redaction)

    for (const span of page.spans) {
      if (span.end <= redaction.start || span.start >= redaction.end) continue
      const range = rangeWithinSpan(span, redaction.start, redaction.end)
      if (!range) continue
      runEdits[span.id] = [...(runEdits[span.id] ?? []), { ...range, replacement }]
    }
  }

  return {
    runEdits,
    values: sweepValues(redactions, options),
    label: labelFor(options),
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

/**
 * PDF: collect the boxes covered by each accepted redaction.
 *
 * The geometry itself lives in lib/redaction/geometry.ts, shared with the
 * canvas — the preview and the export must agree about where a box goes.
 *
 * A page carrying a redaction is rasterised, so there is no text stream left
 * to substitute into. The surrogate is painted onto the strip instead — the
 * strip is a rectangle this pipeline draws, and it can be drawn with a name on
 * it. That is why a scanned contract gets the same methods a DOCX does.
 */
export function buildPdfPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): PdfRedactionPlan {
  const boxesByPage = new Map<number, LabeledBox[]>()
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    const pageNumber = redaction.page ?? 1
    const page = model.pages.find((candidate) => candidate.number === pageNumber)
    if (!page && !redaction.boundingBox) continue

    const boxes = boxesForRedaction(page ?? { spans: [] }, redaction)
    if (boxes.length === 0) continue

    const label = surrogates.forRedaction(redaction)

    boxesByPage.set(pageNumber, [
      ...(boxesByPage.get(pageNumber) ?? []),
      ...boxes.map((box) => ({ ...padBox(box), label })),
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
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    const sheet = redaction.worksheet
    if (!sheet) continue

    switch (redaction.type) {
      // A row or a column is emptied by position and carries no value to
      // substitute, so it is masked whatever method was asked for — which is
      // what `methodsFor()` already told the reviewer.
      case "column":
        if (redaction.column) columns.push({ sheet, column: redaction.column })
        break
      case "row":
        if (redaction.row) rows.push({ sheet, row: redaction.row })
        break
      default:
        if (redaction.row && redaction.column) {
          cells.push({
            sheet,
            row: redaction.row,
            column: redaction.column,
            replacement: surrogates.forRedaction(redaction),
          })
        }
    }
  }

  return {
    cells,
    rows,
    columns,
    values: sweepValues(redactions, options),
    label: labelFor(options),
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

/**
 * The appearance a bounding-box redaction is exported with.
 *
 * Only a face takes the chosen style: the option exists because a blurred face
 * reads as a photograph and a black rectangle reads as a mistake, whereas a
 * blurred account number is just an account number somebody might get back.
 *
 * The export report asks this same function what happened, so the record and
 * the artifact cannot drift apart.
 */
export function regionStyle(
  redaction: Redaction,
  options: ExportOptions
): RedactionStyle {
  return redaction.type === "face" ? (options.imageStyle ?? "solid") : "solid"
}

export function buildImagePlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): ImageRedactionPlan {
  const regions: ImageRedactionPlan["regions"] = []
  const page = model.pages[0]
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue

    // A surrogate is painted onto the strip, so it only exists where OCR
    // recognised something to substitute. A face, or a region with nothing
    // behind it, has no label and gets the fill it always got.
    const label = surrogates.forRedaction(redaction)

    if (redaction.boundingBox) {
      regions.push({
        boundingBox: padBox(redaction.boundingBox),
        style: regionStyle(redaction, options),
        label,
      })
      continue
    }

    // A text redaction on an image resolves through its OCR span geometry, and
    // is padded for the same reason the PDF plan pads: an OCR word box is drawn
    // tight around the glyphs, and a fill exactly that size can leave a legible
    // hairline of ascender or descender behind.
    //
    // The label goes on the first box only: a name split across two OCR words
    // is one value, and painting the surrogate twice would say it was two.
    if (page) {
      boxesForRedaction(page, redaction).forEach((box, index) => {
        regions.push({
          boundingBox: padBox(box),
          style: "solid",
          label: index === 0 ? label : undefined,
        })
      })
    }
  }

  return {
    regions,
    defaultStyle: options.imageStyle ?? "solid",
    sanitizeMetadata: options.sanitizeMetadata,
  }
}

/**
 * CSV and TSV: the same three units a workbook has, addressed the same way.
 *
 * A delimited file normalizes to a worksheet, so a redaction against it
 * already carries a sheet, a row and a column. There is nothing to translate —
 * which is the point of having normalized it that way.
 */
export function buildDelimitedPlan(
  redactions: Redaction[],
  options: ExportOptions
): DelimitedRedactionPlan {
  const cells: DelimitedRedactionPlan["cells"] = []
  const rows: number[] = []
  const columns: number[] = []
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue

    switch (redaction.type) {
      case "column":
        if (redaction.column) columns.push(redaction.column)
        break
      case "row":
        if (redaction.row) rows.push(redaction.row)
        break
      default:
        if (redaction.row && redaction.column) {
          cells.push({
            row: redaction.row,
            column: redaction.column,
            replacement: surrogates.forRedaction(redaction),
          })
        }
    }
  }

  return {
    cells,
    rows,
    columns,
    values: sweepValues(redactions, options),
    label: labelFor(options),
  }
}

/**
 * Plain text and RTF: page offsets translated back to source offsets.
 *
 * A redaction is recorded against the page it was made on, and a page is a
 * slice this pipeline invented. The span it covers carries the absolute offset
 * of its first character in its id, so the translation is exact and does not
 * depend on how the text happened to be paginated — change the page size and
 * every existing redaction still points at the same characters.
 */
export function buildTextPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions
): TextRedactionPlan {
  const ranges: ReplacementRange[] = []
  const surrogates = surrogatesFor(options)

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    if (redaction.start === undefined || redaction.end === undefined) continue

    const page = model.pages.find(
      (candidate) => candidate.number === (redaction.page ?? 1)
    )
    if (!page) continue

    const replacement = surrogates.forRedaction(redaction)

    for (const span of page.spans) {
      if (span.end <= redaction.start || span.start >= redaction.end) continue

      const sourceStart = parseTextAddress(span.id)
      // A span with no source address cannot be safely edited: guessing an
      // offset would delete characters somewhere else in the file.
      if (sourceStart === null) continue

      const within = rangeWithinSpan(span, redaction.start, redaction.end)
      if (!within) continue

      ranges.push({
        start: sourceStart + within.start,
        end: sourceStart + within.end,
        replacement,
      })
    }
  }

  return {
    ranges,
    values: sweepValues(redactions, options),
    label: labelFor(options),
  }
}

/**
 * Email: page offsets translated back to places in the MIME tree.
 *
 * Every span the reviewer saw carries an address — a header and which
 * occurrence of it, a part and an offset into that part's decoded text, or an
 * attachment's filename — so this is a translation rather than a search. That
 * matters more here than anywhere else in the codebase: the same value can be
 * in a header, in a body, in the HTML alternative of that body, in a quoted
 * reply and in a filename, and "the second occurrence of john@example.com"
 * would not tell an exporter which of those to touch.
 *
 * A span whose address does not parse is skipped rather than guessed at. There
 * is no safe fallback: editing the wrong part of a message means either
 * leaving the value or corrupting something that was fine.
 */
export function buildEmlPlan(
  model: NormalizedDocument,
  redactions: Redaction[],
  options: ExportOptions,
  /**
   * What to do with each attachment part's body, keyed by MIME path. Worked
   * out from the children the message was expanded into, which is knowledge
   * this file does not have and should not acquire — it maps offsets onto
   * addresses, and nothing here should need a database.
   */
  attachments: EmlRedactionPlan["attachments"] = {}
): EmlRedactionPlan {
  const bodies: EmlRedactionPlan["bodies"] = {}
  const headers: EmlRedactionPlan["headers"] = {}
  const filenames: EmlRedactionPlan["filenames"] = {}

  const surrogates = surrogatesFor(options)

  const add = (
    into: Record<string, ReplacementRange[]>,
    key: string,
    range: ReplacementRange
  ) => {
    into[key] = [...(into[key] ?? []), range]
  }

  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    if (redaction.start === undefined || redaction.end === undefined) continue

    const page = model.pages.find(
      (candidate) => candidate.number === (redaction.page ?? 1)
    )
    if (!page) continue

    // A header value, a body line and a filename are all text this pipeline
    // rewrites, so all three take a surrogate where the value used to be —
    // pseudonymising a sender is the same operation as redacting one, with a
    // different string going in.
    const replacement = surrogates.forRedaction(redaction)

    for (const span of page.spans) {
      if (span.end <= redaction.start || span.start >= redaction.end) continue

      const address = parseEmlAddress(span.id)
      if (!address) continue

      const within = rangeWithinSpan(span, redaction.start, redaction.end)
      if (!within) continue

      switch (address.kind) {
        case "header":
          add(headers, headerKey(address.path, address.name, address.index), {
            ...within,
            replacement,
          })
          break
        case "body":
          // The span is one line of the part; its address is where that line
          // begins in the part's own decoded text.
          add(bodies, address.path, {
            start: address.offset + within.start,
            end: address.offset + within.end,
            replacement,
          })
          break
        case "filename":
          add(filenames, address.path, { ...within, replacement })
          break
      }
    }
  }

  return {
    bodies,
    headers,
    filenames,
    attachments,
    values: sweepValues(redactions, options),
    label: labelFor(options),
  }
}
