import type {
  DocumentExportProgress,
  DocumentExportStatus,
} from "@/lib/documents/document-exports"

/**
 * What a single export's run says about itself while it works (#187).
 *
 * The row is the durable record; this is the progress channel on top of it,
 * one whole snapshot per event so a client that missed one is corrected by
 * the next. A stage, a variant's name and a page count: nothing from the
 * document.
 */
export type DocumentExportStreamEvent = {
  type: "export.progress" | "export.finished"
  at: string
  status: DocumentExportStatus
  progress: DocumentExportProgress | null
  error?: string | null
}

export function encodeDocumentExportEvent(
  event: DocumentExportStreamEvent
): string {
  return `${JSON.stringify(event)}\n`
}

export function decodeDocumentExportEvent(
  line: string
): DocumentExportStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as DocumentExportStreamEvent
  } catch {
    return null
  }
}
