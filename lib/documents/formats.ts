import type { UsageKind } from "@/lib/security/quota-config"
import { DOCUMENT_KINDS, type DocumentKind } from "@/types/document"

/**
 * The register of supported formats.
 *
 * What a format *is* used to be spread across eight files that had to agree
 * and had no way to: the MIME allow-list, the extension allow-list, the byte
 * sniffer, the reservation route, the processing dispatch, the export
 * dispatch, the quota mapping and the file input's `accept` attribute. Adding
 * one meant finding all eight, and the failure mode when you missed one was
 * silent — a file the browser offered to upload and the server then refused,
 * or worse, a format the backend accepted that no exporter knew how to write.
 *
 * So there is one entry per kind here and everything else derives from it. The
 * table is typed as `Record<DocumentKind, FormatDefinition>`, which means
 * adding a kind to `DOCUMENT_KINDS` without registering it does not compile.
 *
 * This is a description, not a dispatcher. The pipelines stay where they are —
 * a registry that imported every extractor would drag pdf.js, ExcelJS, sharp
 * and Tesseract into the browser bundle to answer "is .csv allowed?".
 */

export type FormatContainer =
  /** One stream of bytes: a text file, an image, a PDF. */
  | "flat"
  /** A zip of XML parts, where the same text can live in several of them. */
  | "ooxml"
  /** A MIME tree, where the same text can live in several parts and headers. */
  | "mime"

export type FormatDefinition = {
  kind: DocumentKind
  /** Shown to people: in the upload panel, in error messages, in the docs. */
  label: string
  /** What an export of this kind is delivered as. */
  mimeType: string
  /**
   * Every MIME type accepted on upload for this kind. A browser's `file.type`
   * is a guess and a wrong one often enough to matter, so this list is a hint
   * used for labelling — the bytes decide, in lib/documents/detect.ts.
   */
  mimeTypes: string[]
  /** Canonical extension, without the dot. */
  extension: string
  /** Every extension accepted for this kind, without the dot. */
  extensions: string[]
  /** False for a kind that can be stored but not turned into a review model. */
  extractable: boolean
  /** False for a kind with no exporter, which cannot be redacted at all. */
  exportable: boolean
  /** The daily allowance this kind is charged against. */
  quota: UsageKind
  /** What one unit of that allowance is, for the docs and the usage panel. */
  quotaUnit: string
  /**
   * Whether the format is a container whose parts must be walked separately.
   * A flat format has one place text can hide; a package has as many as it has
   * parts, and both extraction and the export sweep have to visit all of them.
   */
  container: FormatContainer
}

const OOXML = "application/vnd.openxmlformats-officedocument"

export const FORMATS: Record<DocumentKind, FormatDefinition> = {
  pdf: {
    kind: "pdf",
    label: "PDF",
    mimeType: "application/pdf",
    mimeTypes: ["application/pdf"],
    extension: "pdf",
    extensions: ["pdf"],
    extractable: true,
    exportable: true,
    quota: "pdfPages",
    quotaUnit: "pages",
    container: "flat",
  },
  docx: {
    kind: "docx",
    label: "Word (.docx)",
    mimeType: `${OOXML}.wordprocessingml.document`,
    mimeTypes: [`${OOXML}.wordprocessingml.document`],
    extension: "docx",
    extensions: ["docx"],
    extractable: true,
    exportable: true,
    quota: "docxPages",
    quotaUnit: "pages",
    container: "ooxml",
  },
  xlsx: {
    kind: "xlsx",
    label: "Excel (.xlsx)",
    mimeType: `${OOXML}.spreadsheetml.sheet`,
    mimeTypes: [`${OOXML}.spreadsheetml.sheet`],
    extension: "xlsx",
    extensions: ["xlsx"],
    extractable: true,
    exportable: true,
    quota: "xlsxCells",
    quotaUnit: "filled cells",
    container: "ooxml",
  },
  csv: {
    kind: "csv",
    label: "CSV",
    mimeType: "text/csv",
    mimeTypes: ["text/csv"],
    extension: "csv",
    extensions: ["csv"],
    extractable: true,
    exportable: true,
    // A grid is a grid: a workbook, a CSV and a TSV cost the same per cell,
    // and a second counter for the same unit would only be a second number to
    // keep in step.
    quota: "xlsxCells",
    quotaUnit: "filled cells",
    container: "flat",
  },
  tsv: {
    kind: "tsv",
    label: "TSV",
    mimeType: "text/tab-separated-values",
    mimeTypes: ["text/tab-separated-values"],
    extension: "tsv",
    extensions: ["tsv", "tab"],
    extractable: true,
    exportable: true,
    quota: "xlsxCells",
    quotaUnit: "filled cells",
    container: "flat",
  },
  txt: {
    kind: "txt",
    label: "Plain text (.txt)",
    mimeType: "text/plain",
    mimeTypes: ["text/plain"],
    extension: "txt",
    extensions: ["txt", "text", "log"],
    extractable: true,
    exportable: true,
    quota: "textPages",
    quotaUnit: "pages of extracted text",
    container: "flat",
  },
  image: {
    kind: "image",
    label: "Images (PNG, JPEG, WebP)",
    mimeType: "image/png",
    mimeTypes: ["image/png", "image/jpeg", "image/webp"],
    extension: "png",
    extensions: ["png", "jpg", "jpeg", "webp"],
    extractable: true,
    exportable: true,
    quota: "images",
    quotaUnit: "images",
    container: "flat",
  },
}

export const FORMAT_LIST: FormatDefinition[] = DOCUMENT_KINDS.map(
  (kind) => FORMATS[kind]
)

export function formatOf(kind: DocumentKind): FormatDefinition {
  return FORMATS[kind]
}

/** MIME type to kind, for the upload allow-list and for labelling. */
export const ACCEPTED_MIME_TYPES: Record<string, DocumentKind> =
  Object.fromEntries(
    FORMAT_LIST.flatMap((format) =>
      format.mimeTypes.map((mimeType) => [mimeType, format.kind] as const)
    )
  )

/** Extension (no dot) to kind. */
export const EXTENSION_KINDS: Record<string, DocumentKind> =
  Object.fromEntries(
    FORMAT_LIST.flatMap((format) =>
      format.extensions.map((extension) => [extension, format.kind] as const)
    )
  )

/** Dotted extensions, in registration order — the file input's `accept`. */
export const ACCEPTED_EXTENSIONS: string[] = FORMAT_LIST.flatMap((format) =>
  format.extensions.map((extension) => `.${extension}`)
)

export function kindForExtension(
  extension: string
): DocumentKind | undefined {
  return EXTENSION_KINDS[extension.replace(/^\./, "").toLowerCase()]
}

export function kindForMimeType(mimeType: string): DocumentKind | undefined {
  return ACCEPTED_MIME_TYPES[mimeType.trim().toLowerCase()]
}

/** The daily allowance a document of this kind is charged against. */
export function quotaKindFor(kind: DocumentKind): UsageKind {
  return FORMATS[kind].quota
}

/** What an export of this kind is written as. */
export function outputTypeFor(kind: DocumentKind): {
  extension: string
  mimeType: string
} {
  const format = FORMATS[kind]
  return { extension: format.extension, mimeType: format.mimeType }
}

/**
 * The supported formats as a sentence, for the message a user gets when their
 * file is not one of them. Generated rather than written out, because the
 * hand-written version is the first thing to go stale.
 */
export function supportedFormatsSentence(): string {
  const labels = FORMAT_LIST.map((format) => format.label)
  if (labels.length <= 1) return labels[0] ?? ""
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}
