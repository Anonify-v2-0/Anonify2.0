"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"

import { readFailure } from "@/lib/api/errors"

/**
 * Sending a failed document back through the pipeline.
 *
 * The document list, the processing screen and the workspace banner all offer
 * this, and each used to carry its own copy of the fetch, the toast and the
 * pending flag. Three copies of one behaviour is three places for it to drift —
 * and it already had: only two of them reported what the server actually said.
 *
 * The caller decides what to do on success, because that differs by surface:
 * the list patches one row, the workspace moves its own status so the
 * processing stream reconnects.
 */
export function useRetryDocument() {
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const retry = useCallback(async (documentId: string): Promise<boolean> => {
    setRetryingId(documentId)
    try {
      const response = await fetch(`/api/documents/${documentId}/retry`, {
        method: "POST",
      })

      if (!response.ok) {
        // The server knows why — a rate limit with a wait, or a failure that
        // retrying cannot fix — and saying so beats a generic shrug.
        const failure = await readFailure(
          response,
          "That analysis could not be retried."
        )
        toast.error(failure.message)
        return false
      }

      return true
    } catch {
      // No response to read: the request never landed.
      toast.error("That analysis could not be retried.")
      return false
    } finally {
      setRetryingId(null)
    }
  }, [])

  return { retry, retryingId }
}
