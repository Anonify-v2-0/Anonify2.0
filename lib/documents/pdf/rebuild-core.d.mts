import type { PDFDocument } from "pdf-lib"

type PdfLib = typeof import("pdf-lib")

export type DrawnPage = {
  data: Uint8Array
  /** Page size in PDF user-space units. */
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
}

export type RebuildPlan = {
  /** Zero-based indexes of the pages to replace with their drawing. */
  redacted: Set<number>
  drawn: Map<number, DrawnPage>
  sanitizeMetadata: boolean
}

export function sanitizeMetadata(pdf: PDFDocument): void

export function rebuildPdf(
  lib: PdfLib,
  source: Uint8Array,
  plan: RebuildPlan
): Promise<Uint8Array>
