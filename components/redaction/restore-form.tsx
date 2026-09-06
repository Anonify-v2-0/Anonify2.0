"use client"

import { useRef, useState } from "react"
import { Download, KeyRound, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button, buttonVariants } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { toastFailure } from "@/lib/api/errors"
import { cn } from "@/lib/utils"

/**
 * Reversing an export.
 *
 * Two files in, one file out. Nothing about this form belongs to a session or
 * a document: the reviewer holds the export and the vault, and those two are
 * the whole of what a restore needs — which is the same reason the route takes
 * no document id. A version of this that started from "pick one of your
 * documents" would be a version where the tool, rather than the reviewer, was
 * the one able to reverse the redaction.
 *
 * The restored file is handed straight to the browser and never stored, so the
 * link below is an object URL over bytes that only exist in this tab.
 */

type Restored = {
  url: string
  name: string
  restored: number
  unresolved: number
  matchesVault: boolean
}

export function RestoreForm() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Restored | null>(null)
  const documentInput = useRef<HTMLInputElement>(null)
  const vaultInput = useRef<HTMLInputElement>(null)

  async function restore() {
    const file = documentInput.current?.files?.[0]
    const vault = vaultInput.current?.files?.[0]

    if (!file) return toast.error("Choose the redacted document.")
    if (!vault) return toast.error("Choose the vault that came with it.")

    setBusy(true)
    // Revoked before the next attempt rather than left to the tab's lifetime:
    // the bytes behind it are the original values.
    if (result) URL.revokeObjectURL(result.url)
    setResult(null)

    const form = new FormData()
    form.append("file", file)
    form.append("vault", vault)

    try {
      const response = await fetch("/api/restore", { method: "POST", body: form })

      if (!response.ok) {
        await toastFailure(
          toast,
          response,
          "That document could not be restored."
        )
        return
      }

      const blob = await response.blob()
      const disposition = response.headers.get("Content-Disposition") ?? ""
      const named = /filename="([^"]+)"/.exec(disposition)?.[1]

      setResult({
        url: URL.createObjectURL(blob),
        name: named ?? `restored-${file.name}`,
        restored: Number(response.headers.get("X-Restored-Values") ?? 0),
        unresolved: Number(response.headers.get("X-Unresolved-Values") ?? 0),
        matchesVault: response.headers.get("X-Vault-Matches") === "true",
      })
    } catch {
      toast.error("That document could not be restored.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 rounded-[14px] border border-border p-5">
      <div className="space-y-1.5">
        <Label htmlFor="restore-document" className="text-sm font-normal">
          The redacted document
        </Label>
        <input
          ref={documentInput}
          id="restore-document"
          type="file"
          className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-full file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-white"
        />
        <p className="text-[11px] leading-relaxed text-text-muted">
          A PDF or an image cannot be restored: its pages were turned into
          pixels when they were redacted, which is what made the redaction real.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="restore-vault" className="text-sm font-normal">
          The vault
        </Label>
        <input
          ref={vaultInput}
          id="restore-vault"
          type="file"
          accept="application/json,.json"
          className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-full file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-white"
        />
        <p className="text-[11px] leading-relaxed text-text-muted">
          The JSON you downloaded with the export. Pseudonymized values are not
          in it and never come back — that is the difference between a pseudonym
          and a token.
        </p>
      </div>

      <Button className="btn-pill h-10" disabled={busy} onClick={restore}>
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <KeyRound className="size-4" />
        )}
        Restore
      </Button>

      {result ? (
        <div className="space-y-2 rounded-[10px] border border-border p-3">
          <p className="label-micro text-primary">Restored</p>
          <p className="text-xs leading-relaxed text-text-secondary">
            {result.restored} {result.restored === 1 ? "value" : "values"} put
            back.
            {result.unresolved > 0
              ? ` ${result.unresolved} could not be opened with this vault and were left exactly as they were.`
              : ""}
          </p>
          {result.matchesVault ? null : (
            <p className="text-[11px] leading-relaxed text-text-muted">
              This vault names a different export. That is usually a file that
              was re-saved on the way here, but check the result: a restore run
              with the wrong vault produces something plausible rather than an
              error.
            </p>
          )}
          <a
            href={result.url}
            download={result.name}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <Download className="size-4" />
            Download
          </a>
          <p className="text-[11px] leading-relaxed text-text-muted">
            Held in this tab only. Nothing about this restore was stored, and
            reloading the page loses it.
          </p>
        </div>
      ) : null}

      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-text-muted">
        <Upload className="mt-0.5 size-3 shrink-0" />
        Both files are read in memory to produce the result and are not kept.
        The restored document holds the original values, so treat what you
        download the way you treat the source.
      </p>
    </div>
  )
}
