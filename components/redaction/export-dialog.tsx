"use client"

import { useEffect, useId, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  Download,
  FileArchive,
  FileText,
  KeyRound,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DocumentUsageSummary } from "@/components/documents/usage-summary"
import { toastFailure } from "@/lib/api/errors"
import type {
  DocumentExportProgress,
  DocumentExportStatus,
  DocumentExportView,
} from "@/lib/documents/document-exports"
import { collectBundle, zipBundle } from "@/lib/redaction/export-bundle"
import {
  canUseBackgroundExport,
  followExport,
  openVaults,
  readExport,
  recallKey,
  startBackgroundExport,
  type OpenedVaults,
} from "@/lib/redaction/export-client"
import { categoriesAllowing } from "@/lib/redaction/methods"
import type { ExportReport } from "@/lib/redaction/report"
import type { TokenVault } from "@/lib/redaction/vault"
import { cn } from "@/lib/utils"
import { exportDialogToggled } from "@/store/uiSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCounts } from "@/store/selectors"
import type { DocumentSummary } from "@/types/document"
import type { RedactionMethod } from "@/types/redaction"

/**
 * Export.
 *
 * The dialog states plainly what will happen — content removed, not covered —
 * and the result reports what was actually verified, because the export is
 * refused rather than delivered if an accepted value survived into the file.
 */

/**
 * How a redacted image region is obscured. Solid is the default because it is
 * the only one that is unarguably irreversible — the others are offered because
 * they read better on photographs, with the trade stated in the UI rather than
 * left in a doc nobody opens.
 */
const IMAGE_STYLES = [
  {
    value: "solid",
    label: "Solid black",
    note: "Irreversible. Recommended.",
  },
  {
    value: "pixelate",
    label: "Pixelate",
    note: "Detail is averaged away within each block.",
  },
  {
    value: "blur",
    label: "Blur",
    note: "Reads best on photographs, but heavy blur can in principle be attacked.",
  },
] as const

type ImageStyle = (typeof IMAGE_STYLES)[number]["value"]

/**
 * A second copy of the same review, with one method applied throughout.
 *
 * Deliberately not a per-category grid. A reviewer wanting two outputs wants
 * "one I can share and one I can join on", and the categories a method reaches
 * are decided by what is defensible for each — see lib/redaction/methods.ts —
 * not by what somebody remembered to tick. Per-suggestion control already
 * exists in the inspector, which is where a finer decision belongs.
 */
const SECOND_COPY = [
  {
    value: "none",
    label: "Just the one",
    note: "Every accepted value is handled the way the inspector says.",
  },
  {
    value: "pseudonymize",
    label: "…and a pseudonymized copy",
    note: "Names, emails, phones, customer ids and URLs become stable surrogates. Nothing can reverse them, including you.",
  },
  {
    value: "tokenize",
    label: "…and a tokenized copy",
    note: "The same values become tokens, and you get a vault that reverses them. Download it with the file: it is not stored here.",
  },
  {
    value: "encrypt",
    label: "…and an encrypted copy",
    note: "Values become ciphertext under a key you download once. Anonify keeps no copy of it, so a lost key is a lost value.",
  },
] as const

type SecondCopy = (typeof SECOND_COPY)[number]["value"]

type ExportedArtifact = {
  artifactId: string
  variant: string
  downloadUrl: string
  reportUrl: string
  report: ExportReport | null
  checksum: string
  appliedRedactions: number
  verifiedValues: number
  size: number
  vault: TokenVault | null
}

type ExportResponse = ExportedArtifact & {
  metadataSanitized: boolean
  artifacts: ExportedArtifact[]
}

/** A finished background export, in the shape the result view draws. */
function responseOf(
  view: DocumentExportView,
  opened: OpenedVaults
): ExportResponse | null {
  const artifacts: ExportedArtifact[] = (view.artifacts ?? []).map(
    (artifact) => {
      // The vault's link is spent once opened; what is drawn is the vault.
      const { vaultUrl, ...rest } = artifact
      void vaultUrl
      return { ...rest, vault: opened.vaults.get(artifact.artifactId) ?? null }
    }
  )
  if (artifacts.length === 0) return null
  return {
    ...artifacts[0],
    metadataSanitized: view.metadataSanitized,
    artifacts,
  }
}

type Running = {
  exportId: string
  status: DocumentExportStatus
  progress: DocumentExportProgress | null
}

/** Where the run has got to, in words. */
function describeProgress(running: Running): string {
  const progress = running.progress
  if (running.status === "queued" || !progress) return "Waiting for a worker…"
  const of =
    progress.variants > 1
      ? ` (${progress.variantIndex + 1} of ${progress.variants})`
      : ""
  switch (progress.stage) {
    case "render":
      return `Redacting ${progress.variant}${of}: page ${progress.done ?? 0} of ${progress.total ?? 0}`
    case "verify":
      return `Verifying ${progress.variant}${of}: reading it back for anything left in`
    case "seal":
      return `Storing ${progress.variant}${of}`
    default:
      return `Preparing ${progress.variant}${of}`
  }
}

/**
 * The vault, as something the browser can save.
 *
 * Built here from JSON that arrived in the response rather than fetched from a
 * link, because there is no link: the server produced the vault, handed it
 * over, and kept nothing. A reviewer who closes this dialog without taking it
 * has lost the only copy, so the control says so instead of looking like one
 * more optional download.
 */
function VaultDownload({
  vault,
  variant,
}: {
  vault: TokenVault
  variant: string
}) {
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(
    `${JSON.stringify(vault, null, 2)}
`
  )}`

  return (
    <div className="space-y-1.5 rounded-[10px] border border-red-border p-3">
      <p className="label-micro text-primary">Vault — save this now</p>
      <p className="text-[11px] leading-relaxed text-text-muted">
        This file is the only way to reverse the {variant} copy. It holds the
        original values{vault.key ? " and the key that recovers them" : ""}, so
        keep it the way you keep the source document — not the way you keep the
        export. Anonify does not store it, and cannot send it again.
      </p>
      <a
        href={href}
        download={`${variant}-vault.json`}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        <KeyRound className="size-4" />
        Download vault
      </a>
    </div>
  )
}

/**
 * The export report, shown rather than only offered.
 *
 * The downloadable file is the artifact a third party checks; this is the same
 * content in front of the person who just made the decisions, because the
 * number that matters most — what was left in — is the one nobody opens a
 * JSON file to discover.
 */
function ReportSummary({ report }: { report: ExportReport }) {
  const leftIn =
    report.notRemoved.rejected.total + report.notRemoved.undecided.total

  return (
    <div className="space-y-2 rounded-[10px] border border-border p-3">
      <p className="label-micro">Export report</p>

      {report.removed.byCategory.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary">
          {report.removed.byCategory.map((entry) => (
            <div key={entry.category} className="flex justify-between gap-2">
              <dt className="truncate">{entry.category}</dt>
              <dd className="font-mono text-text-muted tabular-nums">
                {entry.count}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-text-secondary">Nothing was removed.</p>
      )}

      {report.lookedFor.narrowed && report.lookedFor.presetLabel ? (
        <p className="text-[11px] leading-relaxed text-text-muted">
          Looked for {report.lookedFor.presetLabel.toLowerCase()}. Anything
          outside that was never searched for, so its absence from these counts
          says nothing about the file.
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-text-muted">
        {leftIn === 0
          ? "Every suggestion was decided, and every accepted one was removed."
          : `${leftIn} suggested ${leftIn === 1 ? "item" : "items"} (${report.notRemoved.rejected.total} rejected, ${report.notRemoved.undecided.total} undecided) ${leftIn === 1 ? "was" : "were"} not accepted and remain in the file.`}{" "}
        The report records counts and checksums, never the values themselves.
      </p>
    </div>
  )
}

/**
 * One output of a two-copy export.
 *
 * Folded by default: two checksums and two reports stacked one above the other
 * made the dialog taller than the screen. What stays out of the fold is what
 * the reviewer has to act on — the downloads, and the vault above all, which
 * is the only copy there will ever be. A fold is a fine place for a report and
 * the wrong place for something that is lost when the dialog closes.
 */
function ArtifactSection({ artifact }: { artifact: ExportedArtifact }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()

  return (
    <div className="space-y-2 rounded-[10px] border border-border p-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="label-micro">{artifact.variant}</span>
        <span className="flex items-center gap-1 text-[11px] text-text-muted">
          {open ? "Hide report" : "Show report"}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180"
            )}
          />
        </span>
      </button>

      <div id={detailsId} hidden={!open} className="space-y-2">
        <p className="font-mono text-[11px] break-all text-text-muted">
          sha256 {artifact.checksum}
        </p>
        {artifact.report ? <ReportSummary report={artifact.report} /> : null}
      </div>

      {artifact.vault ? (
        <VaultDownload vault={artifact.vault} variant={artifact.variant} />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <a
          href={artifact.downloadUrl}
          download
          className={cn(buttonVariants({ size: "sm" }))}
        >
          <Download className="size-4" />
          {artifact.variant}
        </a>
        <a
          href={artifact.reportUrl}
          download
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <FileText className="size-4" />
          Report
        </a>
      </div>
    </div>
  )
}

export function ExportDialog({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.exportDialogOpen)
  const counts = useAppSelector(selectCounts)

  const [sanitizeMetadata, setSanitizeMetadata] = useState(true)
  const [addLabels, setAddLabels] = useState(false)
  const [imageStyle, setImageStyle] = useState<ImageStyle>("solid")
  const [secondCopy, setSecondCopy] = useState<SecondCopy>("none")
  const [busy, setBusy] = useState(false)
  const [bundling, setBundling] = useState(false)
  const [result, setResult] = useState<ExportResponse | null>(null)
  const [running, setRunning] = useState<Running | null>(null)
  const [unopened, setUnopened] = useState<string[]>([])
  const following = useRef<AbortController | null>(null)

  /**
   * Follows a background export to its end (#187), then opens its vaults.
   * Closing the dialog stops the following, not the export; opening it again
   * picks it back up.
   */
  async function follow(exportId: string) {
    following.current?.abort()
    const controller = new AbortController()
    following.current = controller
    setRunning({ exportId, status: "queued", progress: null })
    try {
      const view = await followExport(
        summary.id,
        exportId,
        (update) =>
          setRunning((current) =>
            current && current.exportId === exportId
              ? { ...current, ...update }
              : current
          ),
        controller.signal
      )
      if (controller.signal.aborted) return
      if (!view) {
        toast.error("The export could not be read back. Try again.")
      } else if (view.status === "ready") {
        const opened = await openVaults(view)
        setUnopened(opened.unopened)
        setResult(responseOf(view, opened))
      } else if (view.status === "failed") {
        toast.error(view.error ?? "The export could not be generated.")
      } else if (view.status === "cancelled") {
        toast("Export cancelled.")
      }
    } finally {
      if (following.current === controller) {
        following.current = null
        setRunning(null)
      }
    }
  }

  // Opening the dialog again picks up an export still running, or one that
  // finished while it was closed and whose vaults this browser can still open.
  useEffect(() => {
    if (!open) {
      following.current?.abort()
      return
    }
    let stale = false
    void (async () => {
      const latest = await readExport(summary.id).catch(() => null)
      if (stale || !latest) return
      if (latest.status === "queued" || latest.status === "running") {
        void follow(latest.id)
      } else if (
        latest.status === "ready" &&
        (latest.artifacts ?? []).some((artifact) => artifact.vaultUrl) &&
        (await recallKey(latest.id))
      ) {
        const opened = await openVaults(latest)
        if (stale) return
        setUnopened(opened.unopened)
        setResult(responseOf(latest, opened))
      }
    })()
    return () => {
      stale = true
    }
    // follow is stable enough here: it reads only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, summary.id])

  async function cancel() {
    if (!running) return
    const response = await fetch(
      `/api/documents/${summary.id}/export/${running.exportId}`,
      { method: "DELETE" }
    )
    if (!response.ok && response.status !== 409) {
      await toastFailure(toast, response, "The export could not be stopped.")
    }
  }

  /** Every copy and its report, as one zip. See lib/redaction/export-bundle.ts. */
  async function downloadAll(artifacts: ExportedArtifact[]) {
    setBundling(true)
    try {
      const zipped = await zipBundle(await collectBundle(artifacts))
      const url = URL.createObjectURL(
        new Blob([zipped as BlobPart], { type: "application/zip" })
      )
      const link = document.createElement("a")
      link.href = url
      link.download = `${
        summary.originalName.replace(/.[^.]+$/, "") || "document"
      }-redacted-copies.zip`
      link.click()
      // Revoked on the next tick: the click has started the download by then,
      // and holding the object URL longer keeps both copies in memory.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `${error.message}. Try the individual downloads.`
          : "The zip could not be built. Try the individual downloads."
      )
    } finally {
      setBundling(false)
    }
  }

  async function generate() {
    setBusy(true)
    setResult(null)
    setUnopened([])

    const base = { sanitizeMetadata, addLabels, imageStyle }
    const variants =
      secondCopy === "none"
        ? undefined
        : [
            base,
            {
              ...base,
              methods: categoriesAllowing(secondCopy as RedactionMethod),
            },
          ]

    // In the background, with any vault sealed to this page (#187). A page
    // without WebCrypto (plain HTTP, not localhost) cannot open a sealed
    // vault, and uses the synchronous answer while it lasts.
    if (canUseBackgroundExport()) {
      try {
        const started = await startBackgroundExport(summary.id, {
          ...base,
          variants,
        })
        if (!started.ok) {
          await toastFailure(
            toast,
            started.response,
            "The export could not be generated."
          )
          return
        }
        setBusy(false)
        await follow(started.exportId)
      } catch {
        toast.error("The export could not be generated.")
      } finally {
        setBusy(false)
      }
      return
    }

    try {
      const response = await fetch(`/api/documents/${summary.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, variants }),
      })

      const payload = (await response.json()) as ExportResponse & {
        error?: string
      }

      if (!response.ok) {
        await toastFailure(
          toast,
          response.clone(),
          "The export could not be generated."
        )
        return
      }

      setResult(payload)
    } catch {
      toast.error("The export could not be generated.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => dispatch(exportDialogToggled(next))}
    >
      {/*
        Header and footer stay put and the body between them scrolls, so a
        long result never pushes the close button or the downloads off screen.
      */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export redacted document</DialogTitle>
          <DialogDescription>
            {counts.accepted === 0
              ? "Nothing is accepted yet, so the export would match the original."
              : `${counts.accepted} accepted ${
                  counts.accepted === 1 ? "redaction" : "redactions"
                } will be removed from the file itself.`}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 overflow-y-auto overscroll-contain px-6">
          {result ? (
            <div className="space-y-3 py-2 text-sm">
              <p className="label-micro text-primary">Redaction complete</p>
              <ul className="space-y-1.5 text-text-secondary">
                <li className="flex items-center gap-2">
                  <Check className="size-4 text-text-muted" />
                  {result.appliedRedactions} sensitive{" "}
                  {result.appliedRedactions === 1 ? "item" : "items"} removed
                </li>
                {result.metadataSanitized ? (
                  <li className="flex items-center gap-2">
                    <Check className="size-4 text-text-muted" />
                    Metadata sanitized
                  </li>
                ) : null}
                <li className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-text-muted" />
                  Verified: {result.verifiedValues}{" "}
                  {result.verifiedValues === 1 ? "value" : "values"} confirmed
                  absent from the export
                </li>
              </ul>

              {/*
              Each output gets its own block. Two artifacts of one review
              differ only in what happened to the values, so showing one set of
              counts and two links would invite the reader to apply the first
              artifact's report to the second.
            */}
              {result.artifacts.length > 1
                ? result.artifacts.map((artifact) => (
                    <ArtifactSection
                      key={artifact.artifactId}
                      artifact={artifact}
                    />
                  ))
                : result.artifacts.map((artifact) => (
                    <div key={artifact.artifactId} className="space-y-2">
                      <p className="font-mono text-[11px] break-all text-text-muted">
                        sha256 {artifact.checksum}
                      </p>
                      {artifact.report ? (
                        <ReportSummary report={artifact.report} />
                      ) : null}
                      {artifact.vault ? (
                        <VaultDownload
                          vault={artifact.vault}
                          variant={artifact.variant}
                        />
                      ) : null}
                    </div>
                  ))}

              {result.artifacts.length > 1 &&
              result.artifacts.some((artifact) => artifact.vault) ? (
                <p className="text-[11px] leading-relaxed text-text-muted">
                  Download all bundles every copy with its report. The vault is
                  left out on purpose: it reverses a copy, so it should not
                  travel with one.
                </p>
              ) : null}

              {unopened.length > 0 ? (
                <p className="text-[11px] leading-relaxed text-primary">
                  The vault for {unopened.join(" and ")} could not be opened
                  here. A vault is sealed to the browser that asked for the
                  export, and handed over once.
                </p>
              ) : null}

              <DocumentUsageSummary documentId={summary.id} />
            </div>
          ) : running ? (
            <div className="space-y-3 py-4 text-sm" aria-live="polite">
              <p className="flex items-center gap-2 text-text-secondary">
                <Loader2 className="size-4 animate-spin" />
                {describeProgress(running)}
              </p>
              {running.progress?.stage === "render" &&
              running.progress.total ? (
                <div className="h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width: `${Math.round(
                        (100 * (running.progress.done ?? 0)) /
                          running.progress.total
                      )}%`,
                    }}
                  />
                </div>
              ) : null}
              <p className="text-[11px] leading-relaxed text-text-muted">
                This runs on the server. You can close this dialog: the export
                carries on, and opening it again shows where it has got to.
              </p>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-xs leading-relaxed text-text-muted">
                Accepted content is removed from the document, not covered over.
                The original file is never modified.
              </p>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="sanitize"
                  checked={sanitizeMetadata}
                  onCheckedChange={(checked) =>
                    setSanitizeMetadata(checked === true)
                  }
                />
                <Label htmlFor="sanitize" className="text-sm font-normal">
                  Sanitize metadata (author, tooling, EXIF, GPS)
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="labels"
                  checked={addLabels}
                  onCheckedChange={(checked) => setAddLabels(checked === true)}
                />
                <Label htmlFor="labels" className="text-sm font-normal">
                  Add [REDACTED] labels where content was removed
                </Label>
              </div>

              <div className="space-y-1.5 pt-1">
                <Label htmlFor="second-copy" className="text-sm font-normal">
                  Outputs
                </Label>
                <Select
                  value={secondCopy}
                  onValueChange={(value) => setSecondCopy(value as SecondCopy)}
                >
                  <SelectTrigger id="second-copy" size="sm" className="w-full">
                    <SelectValue>
                      {(value) =>
                        SECOND_COPY.find((option) => option.value === value)
                          ?.label ?? "Just the one"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SECOND_COPY.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-text-muted">
                  {
                    SECOND_COPY.find((option) => option.value === secondCopy)
                      ?.note
                  }{" "}
                  {secondCopy === "none"
                    ? ""
                    : "Government ids, bank and card numbers, API keys and faces are removed in every copy — there is no softer option for them."}
                </p>
              </div>

              {summary.kind === "image" ? (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="image-style" className="text-sm font-normal">
                    Redaction appearance
                  </Label>
                  <Select
                    value={imageStyle}
                    onValueChange={(value) =>
                      setImageStyle(value as ImageStyle)
                    }
                  >
                    <SelectTrigger
                      id="image-style"
                      size="sm"
                      className="w-full"
                    >
                      <SelectValue>
                        {(value) =>
                          IMAGE_STYLES.find((style) => style.value === value)
                            ?.label ?? "Solid black"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {IMAGE_STYLES.map((style) => (
                        <SelectItem key={style.value} value={style.value}>
                          {style.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-relaxed text-text-muted">
                    {
                      IMAGE_STYLES.find((style) => style.value === imageStyle)
                        ?.note
                    }{" "}
                    Every option replaces the pixels and re-encodes the file —
                    the original region is not in the export either way.
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          {result && result.artifacts.length > 1 ? (
            <Button
              className="btn-pill h-10"
              disabled={bundling}
              onClick={() => downloadAll(result.artifacts)}
            >
              {bundling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileArchive className="size-4" />
              )}
              Download all (.zip)
            </Button>
          ) : result ? (
            // Same reason as the card's Open control: these are download links,
            // and Base UI's Button would relabel them as buttons.
            <>
              {result.reportUrl ? (
                <a
                  href={result.reportUrl}
                  download
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" })
                  )}
                >
                  <FileText className="size-4" />
                  Report
                </a>
              ) : null}
              <a
                href={result.downloadUrl}
                download
                className={cn(buttonVariants(), "btn-pill h-10")}
              >
                <Download className="size-4" />
                Download
              </a>
            </>
          ) : running ? (
            <Button
              variant="outline"
              className="btn-pill h-10"
              onClick={() => void cancel()}
            >
              <X className="size-4" />
              Cancel export
            </Button>
          ) : (
            <Button
              className="btn-pill h-10"
              disabled={busy}
              onClick={generate}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Generate secure download
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
