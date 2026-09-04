"use client"

import { useState } from "react"
import { Check, Download, Loader2, ShieldCheck } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { exportDialogToggled } from "@/store/uiSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCounts } from "@/store/selectors"
import type { DocumentSummary } from "@/types/document"

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

type ExportResponse = {
  downloadUrl: string
  checksum: string
  appliedRedactions: number
  verifiedValues: number
  metadataSanitized: boolean
  size: number
}

export function ExportDialog({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.exportDialogOpen)
  const counts = useAppSelector(selectCounts)

  const [sanitizeMetadata, setSanitizeMetadata] = useState(true)
  const [addLabels, setAddLabels] = useState(false)
  const [imageStyle, setImageStyle] = useState<ImageStyle>("solid")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportResponse | null>(null)

  async function generate() {
    setBusy(true)
    setResult(null)

    try {
      const response = await fetch(`/api/documents/${summary.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sanitizeMetadata, addLabels, imageStyle }),
      })

      const payload = (await response.json()) as ExportResponse & {
        error?: string
      }

      if (!response.ok) {
        toast.error(payload.error ?? "The export could not be generated.")
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
            <p className="font-mono text-[11px] break-all text-text-muted">
              sha256 {result.checksum}
            </p>
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
            // Same reason as the card's Open control: this is a download link,
            // and Base UI's Button would relabel it as a button.
            <a
              href={result.downloadUrl}
              download
              className={cn(buttonVariants(), "btn-pill h-10")}
            >
              <Download className="size-4" />
              Download
            </a>
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
