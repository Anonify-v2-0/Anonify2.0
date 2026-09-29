import type { BoundingBox } from "@/types/document"
import {
  DEFAULT_METHOD,
  type Redaction,
  type RedactionMethod,
  type RedactionStatus,
} from "@/types/redaction"

export type HistoryWrite =
  | { ids: string[]; status: RedactionStatus }
  | { ids: string[]; method: RedactionMethod }
  | { ids: [string]; boundingBox: BoundingBox }

/**
 * What the server has to be told after an undo or a redo.
 *
 * Only what the step changed. This used to send the status of every redaction
 * in the document, which is harmless when the tab and the server agree. When
 * they do not (a second tab, a reload that raced, or Ctrl+Z pressed with
 * nothing left to undo), it overwrote the server's copy of the whole document
 * with whatever this tab happened to be holding, in one request, and the
 * export reads the server's copy.
 *
 * A redaction the step removed, such as a manual one being taken back, is
 * reported as rejected: the canvas no longer draws it, so the export must not
 * apply it. One the step brings back gets its status again.
 */
export function historyWrites(
  before: Record<string, Redaction | undefined>,
  after: Record<string, Redaction | undefined>
): HistoryWrite[] {
  const statuses = new Map<RedactionStatus, string[]>()
  const methods = new Map<RedactionMethod, string[]>()
  const boxes: { ids: [string]; boundingBox: BoundingBox }[] = []

  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const id of ids) {
    const was = before[id]
    const now = after[id]
    if (!was && !now) continue

    const wasStatus: RedactionStatus = was?.status ?? "rejected"
    const nowStatus: RedactionStatus = now?.status ?? "rejected"
    if (wasStatus !== nowStatus) {
      statuses.set(nowStatus, [...(statuses.get(nowStatus) ?? []), id])
    }

    // An absent method is a mask, so going back to one is a change to send.
    const nowMethod = now?.method ?? DEFAULT_METHOD
    if (now && nowMethod !== (was?.method ?? DEFAULT_METHOD)) {
      methods.set(nowMethod, [...(methods.get(nowMethod) ?? []), id])
    }

    // A region moved or resized: the box the export will cover goes back
    // with it. One request per region, because each has its own box.
    const nowBox = now?.boundingBox
    const wasBox = was?.boundingBox
    if (
      was &&
      nowBox &&
      wasBox &&
      (nowBox.x !== wasBox.x ||
        nowBox.y !== wasBox.y ||
        nowBox.width !== wasBox.width ||
        nowBox.height !== wasBox.height)
    ) {
      boxes.push({ ids: [id], boundingBox: nowBox })
    }
  }

  return [
    ...[...statuses].map(([status, ids]) => ({ ids, status })),
    ...[...methods].map(([method, ids]) => ({ ids, method })),
    ...boxes,
  ]
}
