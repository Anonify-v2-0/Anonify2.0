"use client"

import { useState } from "react"
import {
  Check,
  Download,
  FileText,
  KeyRound,
  Loader2,
  ShieldCheck,
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
  report: ExportReport
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
              <dd className="font-mono tabular-nums text-text-muted">
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

export function ExportDialog({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.exportDialogOpen)
  const counts = useAppSelector(selectCounts)

  const [sanitizeMetadata, setSanitizeMetadata] = useState(true)
  const [addLabels, setAddLabels] = useState(false)
  const [imageStyle, setImageStyle] = useState<ImageStyle>("solid")
  const [secondCopy, setSecondCopy] = useState<SecondCopy>("none")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportResponse | null>(null)

  async function generate() {
    setBusy(true)
    setResult(null)

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
        await toastFailure(toast, response.clone(), "The export could not be generated.")
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
      <DialogContent className="sm:max-w-md">
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
            {result.artifacts.map((artifact) => (
              <div key={artifact.artifactId} className="space-y-2">
                {result.artifacts.length > 1 ? (
                  <p className="label-micro">{artifact.variant}</p>
                ) : null}
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
                {result.artifacts.length > 1 ? (
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
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" })
                      )}
                    >
                      <FileText className="size-4" />
                      Report
                    </a>
                  </div>
                ) : null}
              </div>
            ))}

            <DocumentUsageSummary documentId={summary.id} />
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
                  onValueChange={(value) => setImageStyle(value as ImageStyle)}
                >
                  <SelectTrigger id="image-style" size="sm" className="w-full">
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
                  Every option replaces the pixels and re-encodes the file — the
                  original region is not in the export either way.
                </p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {result ? (
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
          ) : (
            <Button className="btn-pill h-10" disabled={busy} onClick={generate}>
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
