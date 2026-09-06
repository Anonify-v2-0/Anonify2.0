"use client"

import { useEffect, useState } from "react"
import { Loader2, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { BatchStartOptions } from "@/hooks/use-batch-export"
import { cn } from "@/lib/utils"
import { DEFAULT_METHOD, type RedactionMethod } from "@/types/redaction"

/**
 * What to do with each file, before the run starts.
 *
 * A batch produces one artifact per document. Not one per document per
 * variant — every variant is a full pass over the file, and offering four of
 * them across a dozen documents is forty-eight exports for outputs most
 * reviewers will never open. A reviewer who wants a second form of one file
 * opens that file and exports it again, where variants do exist.
 *
 * What a batch gets instead is the more useful half of the same idea: the
 * contract tokenized, the invoices masked and the spreadsheet encrypted, in one
 * run. That is a decision per file, which is what this is.
 *
 * The run used to start the moment this window opened. It no longer does,
 * because there is now something to decide first — and the default is masking
 * everything, so the common case is one press rather than none.
 */

const METHODS: {
  value: RedactionMethod
  label: string
  note: string
}[] = [
  {
    value: "mask",
    label: "Mask",
    note: "Removed. Nothing stands in its place, and nothing reverses it.",
  },
  {
    value: "pseudonymize",
    label: "Pseudonymize",
    note: "Stable surrogates. Nothing reverses them, including us — but equal values stay equal, which is information.",
  },
  {
    value: "tokenize",
    label: "Tokenize",
    note: "Tokens, with a vault in the archive that reverses them. Anyone holding the zip holds both.",
  },
  {
    value: "encrypt",
    label: "Encrypt",
    note: "Ciphertext, with the key in a vault in the archive. Anyone holding the zip holds both.",
  },
]

const REVERSIBLE = new Set<RedactionMethod>(["tokenize", "encrypt"])

type BatchFile = { id: string; name: string; status: string }

function MethodSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: RedactionMethod
  onChange: (method: RedactionMethod) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as RedactionMethod)}
    >
      <SelectTrigger id={id} size="sm" className="w-33 shrink-0">
        <SelectValue>
          {(current) =>
            METHODS.find((method) => method.value === current)?.label ?? "Mask"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {METHODS.map((method) => (
          <SelectItem key={method.value} value={method.value}>
            {method.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function BatchExportSetup({
  batchId,
  starting,
  onStart,
}: {
  batchId: string
  starting: boolean
  onStart: (options: BatchStartOptions) => void
}) {
  const [files, setFiles] = useState<BatchFile[] | null>(null)
  const [method, setMethod] = useState<RedactionMethod>(DEFAULT_METHOD)
  const [perFile, setPerFile] = useState<Record<string, RedactionMethod>>({})

  // Read here rather than passed down, so this behaves the same wherever the
  // download button is rendered — the workspace header knows nothing about the
  // other documents in the batch.
  useEffect(() => {
    let cancelled = false

    async function read() {
      try {
        const response = await fetch(`/api/batches/${batchId}`, {
          cache: "no-store",
        })
        if (!response.ok) return
        const payload = (await response.json()) as {
          batch: { documents: BatchFile[] }
        }
        if (!cancelled) setFiles(payload.batch.documents)
      } catch {
        // The per-file list is a refinement. Without it the run still starts,
        // with one method for everything, which is what the select above says.
      }
    }

    void read()
    return () => {
      cancelled = true
    }
  }, [batchId])

  // Only a document that finished processing can be exported. Listing the rest
  // would offer a decision about a file the run is going to skip.
  const exportable = (files ?? []).filter((file) => file.status === "ready")

  const chosen = (file: string) => perFile[file] ?? method
  const anyReversible =
    REVERSIBLE.has(method) ||
    Object.values(perFile).some((value) => REVERSIBLE.has(value))

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="batch-method" className="text-sm font-normal">
          What happens to the values
        </Label>
        <div className="flex items-center gap-2">
          <MethodSelect id="batch-method" value={method} onChange={setMethod} />
          <span className="text-[11px] text-text-muted">
            for every file, unless changed below
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-text-muted">
          {METHODS.find((entry) => entry.value === method)?.note}{" "}
          Government ids, bank and card numbers, API keys and faces are removed
          whatever is chosen here — there is no softer option for them.
        </p>
      </div>

      {exportable.length > 0 ? (
        <div className="space-y-1.5">
          <p className="label-micro">Per file</p>
          <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {exportable.map((file) => (
              <li key={file.id} className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-xs text-text-secondary"
                  title={file.name}
                >
                  {file.name}
                </span>
                <MethodSelect
                  id={`batch-method-${file.id}`}
                  value={chosen(file.id)}
                  onChange={(next) =>
                    setPerFile((current) => ({ ...current, [file.id]: next }))
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ) : files === null ? (
        <p className="text-[11px] text-text-muted">Reading the batch…</p>
      ) : null}

      {anyReversible ? (
        <p
          className={cn(
            "rounded-[10px] border border-red-border p-3",
            "text-[11px] leading-relaxed text-text-muted"
          )}
        >
          A tokenized or encrypted file is delivered with the vault that
          reverses it, in the same archive. That is the only copy — it is kept
          only until this batch expires, and never after. Separate the vaults
          from the files before sharing either, or you have shared the values
          you just removed.
        </p>
      ) : null}

      <Button
        className="btn-pill h-10 w-full"
        disabled={starting}
        onClick={() =>
          onStart({
            method,
            methodByDocument: Object.keys(perFile).length > 0 ? perFile : undefined,
          })
        }
      >
        {starting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Start export
      </Button>
    </div>
  )
}
