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
  /**
   * A message was expanded into a batch: one child document per supported
   * attachment. Carries counts only — how many became documents, how many were
   * carried through as they arrived — never a filename.
   */
  | "document.attachments.expanded"
  | "document.ai.started"
  | "document.ai.progress"
  /**
   * The model pass did less than it set out to — a rate limit it could not wait
   * out, an empty balance, a bad key. Carries the reason and how many calls
   * were lost, never a prompt or a document's text.
   *
   * It exists because losing the contextual pass is invisible otherwise: a
   * document reviewed against pattern matching alone finishes, goes ready, and
   * looks exactly like one the model genuinely found nothing in.
   */
  | "document.ai.degraded"
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
