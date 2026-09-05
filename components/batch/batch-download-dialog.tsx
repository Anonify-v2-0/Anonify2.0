"use client"

import { useEffect, useRef, useState } from "react"
import {
  Archive,
  Check,
  Download,
  Loader2,
  MinusCircle,
  RotateCcw,
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
import type {
  BatchExportDocument,
  BatchExportEvent,
  BatchExportSkip,
} from "@/lib/redaction/batch-export"
import type { SkipReason } from "@/lib/redaction/archive"
import { cn } from "@/lib/utils"

/**
 * Downloading a whole batch, with the wait made legible.
 *
 * A batch export is real work — each document is redacted, verified and sealed
 * on its own, and a dozen of them is minutes rather than seconds. A spinner
 * over that says nothing: not which document is being worked on, not that four
 * are already done, not that one was withheld because it failed verification.
 *
 * So the run reports itself. The server streams one event per document and this
 * shows them as they land, then switches to the archive itself — which is
 * assembled from those artifacts and can be tens of megabytes, so it is fetched
 * with its own progress rather than handed to the browser as a bare link.
 *
 * The same dialog serves the documents list, the batch page and the workspace,
 * because "get me everything" should not mean three different things.
 */

const SKIP_LABELS: Record<SkipReason, string> = {
  "not-ready": "had not finished processing",
  "verification-failed": "failed verification and was withheld",
  "rate-limited": "hit the export allowance",
  "archive-full": "did not fit in the archive",
  "export-failed": "could not be exported",
}

const ARCHIVE_FILENAME = "anonify-batch-redacted.zip"

type RowState =
  | { state: "pending" }
  | { state: "exporting" }
  | { state: "exported"; removed: number }
  | { state: "skipped"; reason: SkipReason }

type Row = BatchExportDocument & RowState

type Phase =
  | { phase: "exporting" }
  /** The archive is being built and sent; `total` is absent until known. */
  | { phase: "assembling"; received: number; total: number | null }
  | { phase: "done"; size: number }
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

function RowIcon({ row }: { row: Row }) {
  if (row.state === "exporting") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
  }
  if (row.state === "exported") {
    return <Check className="size-3.5 shrink-0 text-text-secondary" />
  }
  if (row.state === "skipped") {
    return <MinusCircle className="size-3.5 shrink-0 text-text-muted" />
  }
  return (
    <span className="size-3.5 shrink-0 rounded-full border border-border" />
  )
}

export function BatchDownloadDialog({
  batchId,
  open,
  onOpenChange,
  documentCount,
}: {
  batchId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Known before the run starts, so the dialog can say what it is doing. */
  documentCount?: number
}) {
  // Bumping this remounts the run, which is the whole of "try again": there is
  // no partial state worth carrying from an attempt that failed.
  const [attempt, setAttempt] = useState(0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <BatchRun
            key={attempt}
            batchId={batchId}
            documentCount={documentCount}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * One attempt, mounted for exactly as long as it lasts.
 *
 * Closing the dialog unmounts this, which aborts the request — the documents
 * already exported keep their artifacts, so reopening picks them up rather than
 * redoing them.
 */
function BatchRun({
  batchId,
  documentCount,
  onRetry,
}: {
  batchId: string
  documentCount?: number
  onRetry: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [phase, setPhase] = useState<Phase>({ phase: "exporting" })
  const [archiveUrl, setArchiveUrl] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<BatchExportSkip[]>([])

  const objectUrlRef = useRef<string | null>(null)

  /**
   * The run, start to saved file.
   *
   * It starts on its own rather than behind a button because the click already
   * happened: the control that opened this dialog said "download the batch",
   * and asking the reviewer to confirm that answers nothing.
   */
  useEffect(() => {
    const controller = new AbortController()

    const patch = (documentId: string, next: RowState) =>
      setRows((current) =>
        current.map((row) =>
          row.id === documentId ? { ...row, ...next } : row
        )
      )

    async function run() {
      let downloadUrl: string | null = null

      try {
        const response = await fetch(`/api/batches/${batchId}/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson",
          },
          body: JSON.stringify({ sanitizeMetadata: true, addLabels: false }),
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          setPhase({
            phase: "failed",
            message:
              payload.error?.trim() ||
              "Nothing in this batch could be exported yet.",
          })
          return
        }

        // Newline-delimited JSON: one line is one event, and a chunk boundary
        // can fall anywhere, so the remainder is carried to the next read.
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line) as
              BatchExportEvent | { type: "error"; message: string }

            if (event.type === "start") {
              setRows(
                event.documents.map((document) => ({
                  ...document,
                  state: "pending" as const,
                }))
              )
            } else if (event.type === "exporting") {
              patch(event.documentId, { state: "exporting" })
            } else if (event.type === "exported") {
              patch(event.documentId, {
                state: "exported",
                removed: event.removed,
              })
            } else if (event.type === "skipped") {
              patch(event.documentId, {
                state: "skipped",
                reason: event.reason,
              })
            } else if (event.type === "done") {
              setSkipped(event.skipped)
              downloadUrl = event.downloadUrl
            } else if (event.type === "error") {
              setPhase({ phase: "failed", message: event.message })
              return
            }
          }
        }

        if (!downloadUrl) {
          setPhase({
            phase: "failed",
            message: "Nothing in this batch could be exported yet.",
          })
          return
        }

        // The archive is assembled server-side from the artifacts just written,
        // re-hashing every one of them against the checksum it passed
        // verification with. Fetching it rather than following a link is what
        // lets that second wait have a progress bar too.
        setPhase({ phase: "assembling", received: 0, total: null })

        const archive = await fetch(downloadUrl, { signal: controller.signal })
        if (!archive.ok || !archive.body) {
          const payload = (await archive.json().catch(() => ({}))) as {
            error?: string
          }
          setPhase({
            phase: "failed",
            message:
              payload.error?.trim() || "The archive could not be assembled.",
          })
          return
        }

        const declared = Number(archive.headers.get("content-length"))
        const total =
          Number.isFinite(declared) && declared > 0 ? declared : null

        const chunks: Uint8Array[] = []
        let received = 0
        const archiveReader = archive.body.getReader()

        for (;;) {
          const { done, value } = await archiveReader.read()
          if (done) break
          chunks.push(value)
          received += value.byteLength
          setPhase({ phase: "assembling", received, total })
        }

        const blob = new Blob(chunks as BlobPart[], { type: "application/zip" })
        const url = URL.createObjectURL(blob)
        objectUrlRef.current = url
        setArchiveUrl(url)
        setPhase({ phase: "done", size: blob.size })

        // Handed to the browser without a second click. The button stays for
        // the case where something swallows this one.
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = ARCHIVE_FILENAME
        anchor.click()
      } catch {
        // An abort is the dialog closing, not a failure to report.
        if (controller.signal.aborted) return
        setPhase({
          phase: "failed",
          message: "The batch export could not be completed.",
        })
      }
    }

    void run()

    return () => {
      controller.abort()
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [batchId])

  const settled = rows.filter(
    (row) => row.state === "exported" || row.state === "skipped"
  )
  const exported = rows.filter((row) => row.state === "exported")
  const planned = rows.length || documentCount || 0
  const running = phase.phase === "exporting" || phase.phase === "assembling"

  const percent =
    phase.phase === "done"
      ? 100
      : phase.phase === "assembling"
        ? phase.total
          ? (phase.received / phase.total) * 100
          : 0
        : planned === 0
          ? 0
          : (settled.length / planned) * 100

  return (
    <>
      <DialogHeader>
        <DialogTitle>Download this batch</DialogTitle>
        <DialogDescription>
          {phase.phase === "failed"
            ? phase.message
            : phase.phase === "done"
              ? `${exported.length} ${exported.length === 1 ? "document" : "documents"} exported and verified · ${formatBytes(phase.size)}`
              : phase.phase === "assembling"
                ? "Assembling the archive — every export is re-checked against the checksum it passed verification with."
                : planned === 0
                  ? "Preparing the export…"
                  : `Exporting ${planned} ${planned === 1 ? "document" : "documents"}. Each one is redacted and verified on its own.`}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <ProgressBar
            value={percent}
            indeterminate={phase.phase === "assembling" && phase.total === null}
            label="Batch export progress"
          />
          <p className="text-[11px] text-text-muted tabular-nums">
            {phase.phase === "assembling"
              ? phase.total
                ? `${formatBytes(phase.received)} of ${formatBytes(phase.total)}`
                : formatBytes(phase.received)
              : phase.phase === "done"
                ? "Saved to your downloads."
                : phase.phase === "failed"
                  ? "Nothing was delivered. Documents already exported are kept."
                  : planned === 0
                    ? " "
                    : `${settled.length} of ${planned}`}
          </p>
        </div>

        {rows.length > 0 ? (
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 text-xs text-text-secondary"
              >
                <RowIcon row={row} />
                <span className="min-w-0 flex-1 truncate" title={row.name}>
                  {row.name}
                </span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  {row.state === "exported"
                    ? `${row.removed} removed`
                    : row.state === "skipped"
                      ? SKIP_LABELS[row.reason]
                      : row.state === "exporting"
                        ? "exporting"
                        : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {phase.phase === "done" && skipped.length > 0 ? (
          <p className="text-[11px] leading-relaxed text-text-muted">
            {skipped.length}{" "}
            {skipped.length === 1 ? "document is" : "documents are"} not in the
            archive — named above, and in the batch report inside it.
          </p>
        ) : null}
      </div>

      <DialogFooter>
        {phase.phase === "failed" ? (
          <Button className="btn-pill h-10" onClick={onRetry}>
            <RotateCcw className="size-4" />
            Try again
          </Button>
        ) : phase.phase === "done" && archiveUrl ? (
          // A link, not a button that downloads: same reason as everywhere else
          // here — Base UI's Button would relabel it as a button.
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
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            {phase.phase === "assembling" ? "Assembling" : "Exporting"}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
