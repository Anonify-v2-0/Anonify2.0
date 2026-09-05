"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Archive, Globe, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { BatchDownloadDialog } from "@/components/batch/batch-download-dialog"
import { StatusPill } from "@/components/processing/status-pill"
import { Button, buttonVariants } from "@/components/ui/button"
import { useRetryDocument } from "@/hooks/use-retry-document"
import { toastFailure } from "@/lib/api/errors"
import type { BatchOverview } from "@/lib/documents/batches"
import { isRetryable } from "@/lib/workflows/failure"
import { cn } from "@/lib/utils"

/**
 * A batch, reviewed as one pass.
 *
 * Two things are on this page that a list of documents does not have. The
 * decisions being reused across the batch are shown explicitly, with what they
 * matched and where — a rule that quietly redacts in files you have not opened
 * has to be visible and removable. And the export is one archive, assembled
 * from per-document exports that were each verified on their own, with the
 * documents it could not include named rather than missing.
 */

const IN_PROGRESS = new Set([
  "uploading",
  "queued",
  "extracting",
  "normalizing",
  "analyzing",
  "rendering",
])

const POLL_INTERVAL_MS = 4000

export function BatchView({ initial }: { initial: BatchOverview }) {
  const [batch, setBatch] = useState(initial)
  const [downloading, setDownloading] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const { retry: startRetry, retryingId } = useRetryDocument()

  const anyWorking = batch.documents.some((document) =>
    IN_PROGRESS.has(document.status)
  )

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/batches/${initial.id}`, {
        cache: "no-store",
      })
      if (!response.ok) return
      const payload = (await response.json()) as { batch: BatchOverview }
      setBatch(payload.batch)
    } catch {
      // A transient failure just means the next tick tries again.
    }
  }, [initial.id])

  useEffect(() => {
    if (!anyWorking) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      await reload()
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [anyWorking, reload])

  const ready = batch.documents.filter(
    (document) => document.status === "ready"
  ).length

  const removeRule = useCallback(
    async (ruleId: string) => {
      setRemoving(ruleId)
      try {
        const response = await fetch(
          `/api/batches/${batch.id}/rules?ruleId=${encodeURIComponent(ruleId)}`,
          { method: "DELETE" }
        )
        if (!response.ok) {
          await toastFailure(toast, response, "That rule could not be removed.")
          return
        }

        const payload = (await response.json()) as {
          documents: number
          redactions: number
        }
        toast.success(
          `Removed from ${payload.documents} ${
            payload.documents === 1 ? "document" : "documents"
          } · ${payload.redactions} redactions undone`
        )
        await reload()
      } catch {
        toast.error("That rule could not be removed.")
      } finally {
        setRemoving(null)
      }
    },
    [batch.id, reload]
  )

  const retry = useCallback(
    async (documentId: string) => {
      if (!(await startRetry(documentId))) return
      setBatch((current) => ({
        ...current,
        documents: current.documents.map((document) =>
          document.id === documentId
            ? { ...document, status: "queued", error: null, errorCode: null }
            : document
        ),
      }))
      toast.success("Analyzing again.")
    },
    [startRetry]
  )

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="label-micro">
            {batch.documents.length} documents · {ready} ready
          </p>
          <Button
            className="btn-pill h-9"
            disabled={ready === 0}
            title={
              ready === 0
                ? "Nothing in this batch has finished processing yet"
                : undefined
            }
            onClick={() => setDownloading(true)}
          >
            <Archive className="size-4" />
            Download all
          </Button>
        </div>

        <ul className="flex flex-col gap-2">
          {batch.documents.map((document, index) => (
            <li
              key={document.id}
              className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-4 py-3"
            >
              <span className="w-6 shrink-0 font-mono text-xs text-text-muted tabular-nums">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">
                  {document.originalName}
                </p>
                <p className="text-[11px] text-text-muted">
                  {document.status === "failed" && document.error
                    ? document.error
                    : `${document.counts.accepted} accepted · ${document.counts.suggested} to review`}
                </p>
              </div>

              <StatusPill status={document.status} />

              {document.status === "failed" &&
              isRetryable(document.errorCode) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retryingId === document.id}
                  onClick={() => retry(document.id)}
                >
                  {retryingId === document.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  Retry
                </Button>
              ) : null}

              <Link
                href={`/workspace/${document.id}`}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" })
                )}
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <div>
          <p className="label-micro">Decisions carried across this batch</p>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            Made once in one document and applied to the others, including any
            that finish processing later. Removing one undoes every redaction it
            produced.
          </p>
        </div>

        {batch.rules.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">
            None yet. In a document, use{" "}
            <span className="text-text-secondary">
              Everywhere → whole batch
            </span>{" "}
            on a suggestion to decide it once for every file here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batch.rules.map((rule) => (
              <li
                key={rule.id}
                className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-4 py-3"
              >
                <Globe className="size-4 shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{rule.pattern}</p>
                  <p className="text-[11px] text-text-muted">
                    {rule.category} · applied in {rule.documents}{" "}
                    {rule.documents === 1 ? "document" : "documents"} ·{" "}
                    {rule.redactions}{" "}
                    {rule.redactions === 1 ? "redaction" : "redactions"}
                  </p>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove the rule for ${rule.pattern}`}
                  disabled={removing === rule.id}
                  onClick={() => removeRule(rule.id)}
                >
                  {removing === rule.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BatchDownloadDialog
        batchId={batch.id}
        open={downloading}
        onOpenChange={setDownloading}
        documentCount={batch.documents.length}
      />
    </div>
  )
}
