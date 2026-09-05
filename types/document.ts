/**
 * Layer B: the normalized representation every pipeline produces and both the
 * AI layer and the editor consume. It is deliberately independent of the source
 * format so the canvas, the detectors and the exporters share one vocabulary.
 */

export const DOCUMENT_KINDS = [
  "pdf",
  "docx",
  "xlsx",
  "image",
  "csv",
  "tsv",
  "txt",
  "rtf",
  "eml",
] as const

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export type BoundingBox = {
  x: number
  y: number
  width: number
  height: number
}

export type TextStyle = {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}

/**
 * How precisely a span's bounding box locates its text.
 *
 * `word` boxes bound the characters themselves, so a redaction can cover
 * exactly what it matched. `block` boxes bound a whole paragraph — some OCR
 * providers offer nothing finer — and a proportional slice of one would be a
 * rectangle in the wrong place, so a redaction touching a block covers all of
 * it. Over-redaction is recoverable; a box in the wrong place is a leak.
 */
export type SpanGeometry = "word" | "block"

/** A run of text with a stable offset into the page's normalized text stream. */
export type TextSpan = {
  id: string
  text: string
  /** Inclusive start offset within `NormalizedPage.text`. */
  start: number
  /** Exclusive end offset within `NormalizedPage.text`. */
  end: number
  boundingBox?: BoundingBox
  style?: TextStyle
  /** Defaults to `word` when absent, which is what extracted text gives. */
  geometry?: SpanGeometry
  /** Present for DOCX-derived spans so exports can find the originating run. */
  blockId?: string
}

/** A single formatting run inside a DOCX paragraph. */
export type DocxRun = {
  /** Stable address of this run in the source XML: p{paragraph}r{run}. */
  id: string
  text: string
  style?: TextStyle
}

/**
 * Which part of the Word package a block came from. A name that appears only in
 * a header has to be reviewable, not just swept at export time.
 */
export type DocxRegion =
  | "body"
  | "header"
  | "footer"
  | "footnote"
  | "endnote"
  | "comment"

export type DocxParagraph = {
  id: string
  type: "paragraph"
  region?: DocxRegion
  /** The OOXML part this block lives in, e.g. `word/header1.xml`. */
  part?: string
  /** Heading level 1-6 when the paragraph uses a heading style. */
  headingLevel?: number
  listLevel?: number
  alignment?: "left" | "center" | "right" | "justify"
  indent?: number
  spacingBefore?: number
  spacingAfter?: number
  runs: DocxRun[]
}

export type DocxTable = {
  id: string
  type: "table"
  region?: DocxRegion
  part?: string
  /** rows -> cells -> paragraphs. */
  rows: DocxParagraph[][][]
}

export type DocxBlock = DocxParagraph | DocxTable

export type NormalizedPage = {
  /** 1-based page number. */
  number: number
  width: number
  height: number
  /** Flattened text of the page; span offsets index into this string. */
  text: string
  spans: TextSpan[]
  /** True when the page text came from OCR rather than embedded text. */
  ocr?: boolean
  /**
   * True when the page paints an image. Text detection cannot see a face, a
   * signature or a photographed ID card, so these are the pages worth showing
   * to a vision model — and the only ones, because rendering the rest would be
   * paid for in tokens and return nothing.
   */
  images?: boolean
  /** Flow content for DOCX documents, used by the editorial renderer. */
  blocks?: DocxBlock[]
}

export type SpreadsheetCell = {
  row: number
  column: number
  value: string | null
  formula?: string
  numberFormat?: string
}

/**
 * How the workbook hides a sheet. Absent means visible.
 *
 * `veryHidden` cannot be unhidden from Excel's own sheet menu — it takes the
 * VBA editor — which is precisely why people forget the data is in there.
 */
export type SheetVisibility = "hidden" | "veryHidden"

export type SpreadsheetSheet = {
  name: string
  rowCount: number
  columnCount: number
  headers: (string | null)[]
  cells: SpreadsheetCell[]
  mergedRanges?: string[]
  hiddenRows?: number[]
  hiddenColumns?: number[]
  visibility?: SheetVisibility
}

export type ImageRegion = {
  id: string
  kind: "ocr-text" | "face" | "object"
  boundingBox: BoundingBox
  text?: string
  confidence?: number
}

export type NormalizedDocument = {
  documentId: string
  kind: DocumentKind
  /** Pages for pdf/docx/image pipelines. Empty for workbooks. */
  pages: NormalizedPage[]
  /** Worksheets for the xlsx pipeline. */
  sheets?: SpreadsheetSheet[]
  /** Detected regions for the image pipeline. */
  regions?: ImageRegion[]
  language?: string
  metadata?: Record<string, unknown>
}

/**
 * Where a document sits in the batch it was uploaded with.
 *
 * The workspace needs this to move between the documents of one review pass,
 * and to say how many decisions arrived here from elsewhere in the batch — a
 * redaction the reviewer did not make in this file has to explain itself.
 */
export type BatchPlacement = {
  batchId: string
  position: number
  total: number
  previousId: string | null
  nextId: string | null
  carriedRules: number
}

/** Server-owned document record as exposed to the client. */
export type DocumentSummary = {
  id: string
  originalName: string
  kind: DocumentKind
  mimeType: string
  size: number
  status: string
  pageCount: number | null
  createdAt: string
  expiresAt: string
  /** A sentence written for the user; see lib/workflows/failure.ts. */
  error?: string | null
  /** Why it failed, so the interface can tell a verdict from weather. */
  errorCode?: string | null
  /**
   * Whether there is a normalized model to open.
   *
   * A document that failed during analysis still has its text and can be
   * redacted by hand; one that failed during ingest has nothing behind it, and
   * showing an editor over nothing is how a failure came to read as a hang.
   */
  reviewable?: boolean
  /** Absent for a document uploaded on its own. */
  batch?: BatchPlacement | null
  /**
   * The preset the analysis ran with, if the sweep was narrowed. Shown in the
   * editor because a short suggestion list means two very different things
   * depending on whether everything was looked for.
   */
  presetLabel?: string | null
}

/**
 * Whether there is something to put in front of a reviewer.
 *
 * Ready is the ordinary case. A failed document counts only when extraction
 * finished: there is a normalized model behind it, so the text is real and can
 * be redacted by hand even though analysis never completed. A document that
 * failed before that has nothing an editor could show, and rendering one over
 * nothing is how a failure came to read as "Preparing this document…".
 */
export function isReviewable(
  summary: Pick<DocumentSummary, "status" | "reviewable">
): boolean {
  if (summary.status === "ready") return true
  return summary.status === "failed" && summary.reviewable === true
}

export type TtlOption = 3600 | 21600 | 86400 | 259200

export const TTL_OPTIONS: { value: TtlOption; label: string }[] = [
  { value: 3600, label: "1 hour" },
  { value: 21600, label: "6 hours" },
  { value: 86400, label: "24 hours" },
  { value: 259200, label: "3 days" },
]

export const DEFAULT_TTL_SECONDS: TtlOption = 86400

/**
 * The ceiling on how long an anonymous demo document may live, measured from
 * when it was created — not from when it was last extended. Extending resets
 * nothing: it can only raise the window towards this limit, so a document
 * cannot be kept alive indefinitely by repeatedly renewing it.
 */
export const MAX_RETENTION_SECONDS = 72 * 60 * 60

/** Human label for a retention window, e.g. 86400 -> "24 hours". */
export function ttlLabel(seconds: number): string {
  const option = TTL_OPTIONS.find((candidate) => candidate.value === seconds)
  if (option) return option.label

  const hours = Math.round(seconds / 3600)
  if (hours >= 48) return `${Math.round(hours / 24)} days`
  return hours === 1 ? "1 hour" : `${hours} hours`
}

/** The windows still available to a document created `createdAt`. */
export function extendableOptions(
  createdAt: string | Date,
  currentExpiresAt: string | Date,
  now: Date = new Date()
): { value: TtlOption; label: string; expiresAt: Date }[] {
  const created = new Date(createdAt).getTime()
  const currentExpiry = new Date(currentExpiresAt).getTime()

  return TTL_OPTIONS.filter((option) => {
    const expiresAt = created + option.value * 1000
    // Only windows that actually push the expiry out, and only ones that have
    // not already elapsed — offering "1 hour" to a two-hour-old document would
    // be offering to delete it.
    return (
      option.value * 1000 <= MAX_RETENTION_SECONDS * 1000 &&
      expiresAt > currentExpiry &&
      expiresAt > now.getTime()
    )
  }).map((option) => ({
    ...option,
    expiresAt: new Date(created + option.value * 1000),
  }))
}
