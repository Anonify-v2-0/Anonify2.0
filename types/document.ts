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
