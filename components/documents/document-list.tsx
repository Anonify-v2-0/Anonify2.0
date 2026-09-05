"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { UploadCloud } from "lucide-react"
import { toast } from "sonner"

import { DocumentCard } from "@/components/documents/document-card"
import { useRetryDocument } from "@/hooks/use-retry-document"
import { toastFailure } from "@/lib/api/errors"
import type { DocumentListItem } from "@/lib/documents/listing"

/**
 * The session's document list.
 *
 * It refreshes on its own while anything is still processing, so a document
 * that was queued when the page loaded turns into a ready one without the user
 * reaching for reload. Once everything has settled the polling stops.
 */

const POLL_INTERVAL_MS = 4000

const IN_PROGRESS = new Set([
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
])

export function DocumentList({
  initialDocuments,
}: {
  initialDocuments: DocumentListItem[]
}) {
  const [documents, setDocuments] = useState(initialDocuments)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { retry: startRetry, retryingId } = useRetryDocument()

  const anyWorking = documents.some((document) =>
    IN_PROGRESS.has(document.status)
  )

  useEffect(() => {
    if (!anyWorking) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      try {
        const response = await fetch("/api/documents", { cache: "no-store" })
        if (response.ok) {
          const payload = (await response.json()) as {
            documents: DocumentListItem[]
          }
          if (!cancelled) setDocuments(payload.documents)
        }
      } catch {
        // A transient failure just means the next tick tries again.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [anyWorking])

  const onExtended = useCallback((id: string, expiresAt: string) => {
    setDocuments((current) =>
      current.map((document) =>
        document.id === id ? { ...document, expiresAt } : document
      )
    )
  }, [])

  const remove = useCallback(async (id: string) => {
    setDeleting(id)
    try {
      const response = await fetch(`/api/documents/${id}`, { method: "DELETE" })
      if (!response.ok) {
        await toastFailure(toast, response, "That document could not be deleted.")
        return
      }

      setDocuments((current) =>
        current.filter((document) => document.id !== id)
      )
      toast.success("Document and every artifact it produced were deleted.")
    } catch {
      toast.error("That document could not be deleted.")
    } finally {
      setDeleting(null)
    }
  }, [])

  /**
   * Sends a failed document back through the pipeline.
   *
   * The status is moved to "queued" locally rather than waiting for the next
   * poll, because that is what restarts the polling that will report the rest.
   */
  const retry = useCallback(
    async (id: string) => {
      if (!(await startRetry(id))) return

      // Patching the row rather than waiting for the next poll is what restarts
      // the polling that will report the rest.
      setDocuments((current) =>
        current.map((document) =>
          document.id === id
            ? { ...document, status: "queued", error: null, errorCode: null }
            : document
        )
      )
      toast.success("Analyzing again.")
    },
    [startRetry]
  )

  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-[10px] border border-dashed border-border px-6 py-16 text-center">
        <p className="label-micro">No document</p>
        <p className="max-w-sm text-sm text-text-muted">
          Your workspace is waiting. Documents you upload in this session appear
          here until they expire.
        </p>
        <Link
          href="/"
          className="btn-pill mt-1 inline-flex h-10 items-center gap-2 text-sm"
        >
          <UploadCloud className="size-4" />
          Upload document
        </Link>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {documents.map((document) => (
        <DocumentCard
          key={document.id}
          document={document}
          onDelete={remove}
          onRetry={retry}
          onExtended={onExtended}
          deleting={deleting === document.id}
          retrying={retryingId === document.id}
        />
      ))}
    </ul>
  )
}
