"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Archive,
  Check,
  Download,
  Loader2,
  MinusCircle,
  RotateCcw,
  X,
} from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { BatchExportSetup } from "@/components/batch/batch-export-setup"
import type {
  BatchExportControls,
  BatchStartOptions,
} from "@/hooks/use-batch-export"
import { isActiveExport } from "@/hooks/use-batch-export"
import type { BatchExportDocument } from "@/lib/documents/batch-exports"
import type { SkipReason } from "@/lib/redaction/archive"
import { cn } from "@/lib/utils"

/**
 * Downloading a whole batch, with the wait made legible.
 *
 * A batch export is real work — each document redacted, verified and sealed on
 * its own — and a spinner over that says nothing: not which document is being
 * worked on, not that four are already done, not that one was withheld because
 * it failed verification.
 *
 * The run is durable and its progress lives on the server, so this window is a
 * view of it rather than the thing keeping it alive. Closing it does not stop
 * anything; the button behind it keeps showing where the run has got to, and
 * stopping is a decision the reviewer makes explicitly.
 *
 * The archive itself is fetched here with its own progress, because assembling
 * tens of megabytes from verified artifacts is a second wait and a bare link
 * would hide it.
 */

const SKIP_LABELS: Record<SkipReason, string> = {
  "not-ready": "had not finished processing",
  "verification-failed": "failed verification and was withheld",
  "rate-limited": "hit the export allowance",
  "archive-full": "did not fit in the archive",
  "export-failed": "could not be exported",
  cancelled: "not reached",
  container: "expanded into the messages above",
}

const ARCHIVE_FILENAME = "anonify-batch-redacted.zip"

/** The archive fetch, which is separate from the run that produced it. */
type Fetching =
  | { phase: "idle" }
  | { phase: "assembling"; received: number; total: number | null }
  | { phase: "saved"; size: number }
  | { phase: "failed"; message: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ProgressBar({
  value,
  indeterminate,
  label,
}: {
  value: number
  indeterminate?: boolean
  label: string
}) {
  return (
    <span
      className="block h-1 w-full overflow-hidden rounded-full bg-surface-3"
      role="progressbar"
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        className={cn(
          "block h-full bg-primary",
          indeterminate
            ? "w-1/3 animate-pulse"
            : "transition-[width] duration-300"
        )}
        style={indeterminate ? undefined : { width: `${value}%` }}
      />
    </span>
  )
}

function RowIcon({ document }: { document: BatchExportDocument }) {
  if (document.state === "exporting") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
  }
  if (document.state === "exported") {
    return <Check className="size-3.5 shrink-0 text-text-secondary" />
  }
  if (document.state === "skipped") {
    return <MinusCircle className="size-3.5 shrink-0 text-text-muted" />
  }
  return (
    <span className="size-3.5 shrink-0 rounded-full border border-border" />
  )
}

export function BatchDownloadDialog({
  open,
  onOpenChange,
  batchId,
  controls,
  documentCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  batchId: string
  controls: BatchExportControls
  /** Known before a run exists, so the window can say what it is about to do. */
  documentCount?: number
}) {
  const { state, loading, starting, cancelling, start, cancel } = controls
  const [fetching, setFetching] = useState<Fetching>({ phase: "idle" })
  /** What the reviewer chose, kept so "Export again" can reuse it. */
  const optionsRef = useRef<BatchStartOptions>({})

  const objectUrlRef = useRef<string | null>(null)
  const [archiveUrl, setArchiveUrl] = useState<string | null>(null)
  // Which export id this window has already fetched an archive for, so a fresh
  // token arriving on the next poll does not start the download over.
  const fetchedRef = useRef<string | null>(null)

  const active = isActiveExport(state)
  const deliverable = state?.downloadUrl ?? null

  const releaseArchive = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  useEffect(() => releaseArchive, [releaseArchive])

  /**
   * Whether this window is asking a question rather than reporting progress.
   *
   * Opening it used to start the run immediately. It no longer does, because
   * there is now something to decide first — what happens to the values in each
   * file — and a run that started before the reviewer could say would have made
   * the choice for them. The default is masking everything, so the common case
   * costs one press.
   */
  const setup = !loading && state === null

  /** Fetching the archive once the run has produced one. */
  useEffect(() => {
    if (!open || !deliverable || !state) return
    if (fetchedRef.current === state.id) return

    fetchedRef.current = state.id
    const controller = new AbortController()

    async function download(url: string) {
      setFetching({ phase: "assembling", received: 0, total: null })

      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          setFetching({
            phase: "failed",
            message:
              payload.error?.trim() || "The archive could not be assembled.",
          })
          return
        }

        const declared = Number(response.headers.get("content-length"))
        const total =
          Number.isFinite(declared) && declared > 0 ? declared : null

        const chunks: Uint8Array[] = []
        let received = 0
        const reader = response.body.getReader()

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.byteLength
          setFetching({ phase: "assembling", received, total })
        }

        const blob = new Blob(chunks as BlobPart[], { type: "application/zip" })
        releaseArchive()
        const objectUrl = URL.createObjectURL(blob)
        objectUrlRef.current = objectUrl
        setArchiveUrl(objectUrl)
        setFetching({ phase: "saved", size: blob.size })

        // Handed to the browser without a second click. The button stays for
        // the case where something swallows this one.
        const anchor = document.createElement("a")
        anchor.href = objectUrl
        anchor.download = ARCHIVE_FILENAME
        anchor.click()
      } catch {
        if (controller.signal.aborted) return
        setFetching({
          phase: "failed",
          message: "The archive could not be downloaded.",
        })
      }
    }

    void download(deliverable)
    return () => controller.abort()
  }, [open, deliverable, state, releaseArchive])

  const documents = state?.documents ?? []
  const planned = state?.total || documentCount || 0
  const settled = state?.completed ?? 0
  const exported = state?.exported ?? 0

  const percent =
    fetching.phase === "assembling"
      ? fetching.total
        ? (fetching.received / fetching.total) * 100
        : 0
      : fetching.phase === "saved"
        ? 100
        : planned === 0
          ? 0
          : (settled / planned) * 100

  const restart = useCallback(() => {
    fetchedRef.current = null
    setFetching({ phase: "idle" })
    setArchiveUrl(null)
    releaseArchive()
    void start(optionsRef.current)
  }, [releaseArchive, start])

  const begin = useCallback(
    (options: BatchStartOptions) => {
      optionsRef.current = options
      void start(options)
    },
    [start]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download this batch</DialogTitle>
          <DialogDescription>
            {setup
              ? documentCount
                ? `${documentCount} ${documentCount === 1 ? "document" : "documents"}. Each one is redacted and verified on its own, and gets one output — choose what that output does to the values.`
                : "Each document is redacted and verified on its own, and gets one output — choose what that output does to the values."
              : describe({
                  state,
                  loading,
                  fetching,
                  planned,
                  exported,
                })}
          </DialogDescription>
        </DialogHeader>

        {setup ? (
          <BatchExportSetup
            batchId={batchId}
            starting={starting}
            onStart={begin}
          />
        ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <ProgressBar
              value={percent}
              indeterminate={
                (fetching.phase === "assembling" && fetching.total === null) ||
                (planned === 0 && active)
              }
              label="Batch export progress"
            />
            <p className="text-[11px] text-text-muted tabular-nums">
              {fetching.phase === "assembling"
                ? fetching.total
                  ? `${formatBytes(fetching.received)} of ${formatBytes(fetching.total)}`
                  : formatBytes(fetching.received)
                : fetching.phase === "saved"
                  ? "Saved to your downloads."
                  : planned === 0
                    ? " "
                    : `${settled} of ${planned}`}
            </p>
          </div>

          {documents.length > 0 ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {documents.map((document) => (
                <li
                  key={document.id}
                  className="flex items-center gap-2 text-xs text-text-secondary"
                >
                  <RowIcon document={document} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={document.name}
                  >
                    {document.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {document.state === "exported"
                      ? `${document.removed ?? 0} removed`
                      : document.state === "skipped"
                        ? SKIP_LABELS[document.reason ?? "export-failed"]
                        : document.state === "exporting"
                          ? "exporting"
                          : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {active ? (
            <p className="text-[11px] leading-relaxed text-text-muted">
              This runs on the server. You can close this window — the button
              keeps the progress, and the archive will be waiting.
            </p>
          ) : null}
        </div>
        )}

        <DialogFooter>
          {active ? (
            <Button
              variant="outline"
              size="lg"
              disabled={cancelling || state?.cancelRequested}
              onClick={() => void cancel()}
            >
              {cancelling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <X className="size-4" />
              )}
              {state?.cancelRequested ? "Stopping" : "Stop export"}
            </Button>
          ) : null}

          {!active && state && !deliverable ? (
            <Button
              className="btn-pill h-10"
              disabled={starting}
              onClick={restart}
            >
              {starting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Try again
            </Button>
          ) : null}

          {!active && deliverable ? (
            <>
              <Button
                variant="outline"
                size="lg"
                disabled={starting}
                onClick={restart}
              >
                <RotateCcw className="size-4" />
                Export again
              </Button>
              {archiveUrl ? (
                // A link, not a button that downloads: Base UI's Button would
                // relabel it as a button and lose the link semantics.
                <a
                  href={archiveUrl}
                  download={ARCHIVE_FILENAME}
                  className={cn(buttonVariants(), "btn-pill h-10")}
                >
                  <Download className="size-4" />
                  Save again
                </a>
              ) : (
                <Button className="btn-pill h-10" disabled>
                  {fetching.phase === "assembling" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Archive className="size-4" />
                  )}
                  Assembling
                </Button>
              )}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One sentence for whatever is true right now. */
function describe({
  state,
  loading,
  fetching,
  planned,
  exported,
}: {
  state: BatchExportControls["state"]
  loading: boolean
  fetching: Fetching
  planned: number
  exported: number
}): string {
  if (fetching.phase === "failed") return fetching.message
  if (fetching.phase === "saved") {
    return `${exported} ${exported === 1 ? "document" : "documents"} exported and verified · ${formatBytes(fetching.size)}`
  }
  if (fetching.phase === "assembling") {
    return "Assembling the archive — every export is re-checked against the checksum it passed verification with."
  }

  if (loading || !state) return "Preparing the export…"

  if (state.status === "failed") {
    return state.error ?? "Nothing in this batch could be exported."
  }
  if (state.status === "cancelled") {
    return exported === 0
      ? "Stopped before anything was exported."
      : `Stopped after ${exported} ${exported === 1 ? "document" : "documents"}. What was exported is still yours to download.`
  }
  if (state.status === "ready") {
    return `${exported} ${exported === 1 ? "document" : "documents"} exported and verified.`
  }
  if (state.cancelRequested) {
    return "Stopping after the document being exported now."
  }

  return planned === 0
    ? "Preparing the export…"
    : `Exporting ${planned} ${planned === 1 ? "document" : "documents"}. Each one is redacted and verified on its own.`
}
