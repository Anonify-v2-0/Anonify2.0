import type {
  BatchExportDocument,
  BatchExportStatus,
} from "@/lib/documents/batch-exports"

/**
 * What the batch export run says about itself while it works.
 *
 * The row is still the durable record — a reload, a second tab or a visit an
 * hour later reads that. This is the progress channel on top of it, so a client
 * that is watching finds out when a document lands instead of asking every
 * couple of seconds whether anything has changed yet.
 *
 * Each event is a whole snapshot rather than a delta. A batch is at most a
 * couple of dozen entries, so the saving from sending differences is nothing
 * next to the cost of a client that missed one and is now quietly wrong.
 *
 * Filenames are the only thing from the documents that appears here, and the
 * reviewer already knows them: never a redaction, a category, or a count of
 * what was found in any file.
 */
export type BatchExportStreamEvent = {
  type: "export.progress" | "export.finished"
  at: string
  status: BatchExportStatus
  total: number
  completed: number
  exported: number
  documents: BatchExportDocument[]
  error?: string | null
}

export function encodeBatchExportEvent(event: BatchExportStreamEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function decodeBatchExportEvent(
  line: string
): BatchExportStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as BatchExportStreamEvent
  } catch {
    return null
  }
}
