import type { ProcessingEventType, ProcessingStatus } from "@/types/processing"

/**
 * The event shape the workflow writes to its run stream and the browser reads
 * back. It is deliberately small and JSON-serializable: never document text,
 * never extracted content, only what the UI needs to show progress.
 */
export type ProcessingStreamEvent = {
  type: ProcessingEventType
  documentId: string
  at: string
  status?: ProcessingStatus
  progress?: number
  message?: string
  payload?: Record<string, unknown>
}

export function encodeStreamEvent(event: ProcessingStreamEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function decodeStreamEvent(line: string): ProcessingStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as ProcessingStreamEvent
  } catch {
    return null
  }
}
