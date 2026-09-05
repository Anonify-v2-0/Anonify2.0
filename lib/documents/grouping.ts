import type { DocumentListItem } from "@/lib/documents/listing"

/**
 * The session list, with batches kept together.
 *
 * Documents uploaded as one pass are reviewed as one pass — the decisions are
 * carried across them and the export is one archive — and a flat list left the
 * reviewer reconstructing that from filenames.
 */

export type ListEntry =
  | { kind: "document"; document: DocumentListItem }
  | { kind: "batch"; batchId: string; documents: DocumentListItem[] }

/**
 * Batches collapsed into one entry each, in place.
 *
 * A batch sits where its most recent document would have sat, so the newest
 * work stays at the top of a newest-first list. Inside it the documents run
 * oldest first, which is the order the batch page numbers them in and the order
 * the workspace steps through them: two orders for one sequence would make
 * "document 3 of 5" mean something different on each page.
 */
export function groupByBatch(documents: DocumentListItem[]): ListEntry[] {
  const entries: ListEntry[] = []
  const groups = new Map<string, DocumentListItem[]>()

  for (const document of documents) {
    if (!document.batchId) {
      entries.push({ kind: "document", document })
      continue
    }

    const existing = groups.get(document.batchId)
    if (existing) {
      existing.push(document)
      continue
    }

    const group = [document]
    groups.set(document.batchId, group)
    entries.push({ kind: "batch", batchId: document.batchId, documents: group })
  }

  return entries.map((entry) => {
    if (entry.kind === "document") return entry

    // A batch of one is a document whose companions have expired or been
    // deleted. Wrapping it in a group says nothing and costs a row of chrome.
    if (entry.documents.length === 1) {
      return { kind: "document", document: entry.documents[0] }
    }

    return { ...entry, documents: [...entry.documents].reverse() }
  })
}
