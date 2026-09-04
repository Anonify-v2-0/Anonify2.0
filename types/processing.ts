export const PROCESSING_STATUSES = [
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
  "ready",
  "failed",
  "expired",
] as const

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number]

export const PROCESSING_STAGES = [
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
] as const

export type ProcessingStage = (typeof PROCESSING_STAGES)[number]

export type ProcessingEventType =
  | "document.uploaded"
  | "document.queued"
  | "document.extracting"
  | "document.normalizing"
  | "document.ai.started"
  | "document.ai.progress"
  | "document.redaction.created"
  | "document.rendering"
  | "document.ready"
  | "document.failed"

export type ProcessingEvent = {
  id: string
  documentId: string
  type: ProcessingEventType
  at: string
  payload?: Record<string, unknown>
}

export function statusProgress(status: ProcessingStatus): number {
  switch (status) {
    case "uploading":
      return 5
    case "queued":
      return 10
    case "extracting":
      return 30
    case "normalizing":
      return 50
    case "analyzing":
      return 75
    case "rendering":
      return 92
    case "ready":
      return 100
    default:
      return 0
  }
}
