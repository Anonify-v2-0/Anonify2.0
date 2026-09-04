/**
 * Layer B: the normalized representation every pipeline produces and both the
 * AI layer and the editor consume. It is deliberately independent of the source
 * format so the canvas, the detectors and the exporters share one vocabulary.
 */

export const DOCUMENT_KINDS = ["pdf", "docx", "xlsx", "image"] as const

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

export type DocxParagraph = {
  id: string
  type: "paragraph"
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

export type SpreadsheetSheet = {
  name: string
  rowCount: number
  columnCount: number
  headers: (string | null)[]
  cells: SpreadsheetCell[]
  mergedRanges?: string[]
  hiddenRows?: number[]
  hiddenColumns?: number[]
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
  error?: string | null
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
