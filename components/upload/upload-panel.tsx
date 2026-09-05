"use client"

import { useCallback, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { upload } from "@vercel/blob/client"
import { Loader2, UploadCloud } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toastFailure } from "@/lib/api/errors"
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES } from "@/lib/config"
import {
  DEFAULT_PRESET_ID,
  PRESET_DISCLAIMER,
  PRESETS,
  presetById,
} from "@/lib/redaction/presets"
import { cn } from "@/lib/utils"
import {
  DEFAULT_TTL_SECONDS,
  TTL_OPTIONS,
  ttlLabel,
  type TtlOption,
} from "@/types/document"

/** What the file picker offers, derived from the register of formats. */
const ACCEPT = ACCEPTED_EXTENSIONS.join(",")
const MAX_BYTES = MAX_UPLOAD_BYTES

/**
 * The formats, as a short line under the drop zone.
 *
 * Ten of them written out is a wall rather than a sentence, so this is the
 * extensions — which is what someone looking at their own file cares about —
 * and it comes from the register, so it cannot fall behind what the server
 * accepts. The full names are in the docs and in the refusal message.
 */
const SUPPORTED_LABEL = ACCEPTED_EXTENSIONS.map((extension) =>
  extension.replace(".", "").toUpperCase()
).join(", ")
/** Above this size the browser splits the upload into parallel parts. */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024
/** Matches the server's own ceiling on one batch request. */
const MAX_BATCH_FILES = 20

type Phase = "idle" | "reserving" | "uploading" | "starting"

/**
 * Getting the file in.
 *
 * With Vercel Blob the server signs a token scoped to one path and the browser
 * uploads straight to storage, so the file never travels through a serverless
 * function. With S3 or the local filesystem there is no equivalent the browser
 * can safely use, so the bytes go through our own route instead.
 *
 * The server decides which, because it is the thing that knows what is
 * configured. Both paths report real transfer progress and both end with the
 * same call to start processing — everything downstream is identical.
 *
 * Several files at once become a batch: one upload, one review pass, and
 * decisions carried between the documents. They are transferred one at a time,
 * and a file that fails is reported and skipped rather than stopping the rest —
 * a batch is a convenience over separate uploads, not a transaction.
 */

type UploadMode = "vercel-blob" | "server-route"

type Reserved = {
  id: string
  pathname: string
  uploadMode: UploadMode
}

/**
 * Posts through our own route, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch still cannot report upload progress
 * in browsers, and a 25 MB upload with no feedback looks like a hang.
 */
function uploadThroughServer(
  documentId: string,
  file: File,
  onProgress: (percentage: number) => void
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.append("documentId", documentId)
    body.append("file", file)

    const request = new XMLHttpRequest()
    request.open("POST", "/api/upload/local")

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress((event.loaded / event.total) * 100)
      }
    })

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as { url: string })
        } catch {
          reject(new Error("Malformed upload response"))
        }
        return
      }

      let message = "Upload failed"
      try {
        message = (JSON.parse(request.responseText) as { error?: string }).error ?? message
      } catch {
        // Keep the generic message.
      }
      reject(new Error(message))
    })

    request.addEventListener("error", () => reject(new Error("Upload failed")))
    request.addEventListener("abort", () => reject(new Error("Upload cancelled")))

    request.send(body)
  })
}

type TransferResult =
  | { ok: true }
  /** The failing response, when there is one worth reading a message out of. */
  | { ok: false; response?: Response; message?: string }

/** Sends one reserved document's bytes and starts its run. */
async function transferFile(input: {
  documentId: string
  pathname: string
  uploadMode: UploadMode | undefined
  file: File
  onProgress: (percentage: number) => void
}): Promise<TransferResult> {
  try {
    const uploaded =
      input.uploadMode === "vercel-blob"
        ? await upload(input.pathname, input.file, {
            access: "public",
            handleUploadUrl: "/api/upload/token",
            clientPayload: input.documentId,
            multipart: input.file.size > MULTIPART_THRESHOLD,
            onUploadProgress: ({ percentage }) => input.onProgress(percentage),
          })
        : await uploadThroughServer(input.documentId, input.file, input.onProgress)

    const started = await fetch(`/api/documents/${input.documentId}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blobUrl: uploaded.url }),
    })

    if (!started.ok) return { ok: false, response: started }
    return { ok: true }
  } catch (error) {
    const message =
      error instanceof Error && error.message !== "Upload failed"
        ? error.message
        : "Upload failed. Check your connection and try again."
    return { ok: false, message }
  }
}

export function UploadPanel() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState(0)
  const [batchProgress, setBatchProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [ttl, setTtl] = useState<TtlOption>(DEFAULT_TTL_SECONDS)
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID)

  const busy = phase !== "idle"
  const preset = presetById(presetId)

  const send = useCallback(
    async (file: File) => {
      setProgress(0)
      setPhase("reserving")

      try {
        const reserve = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            contentType: file.type || undefined,
            ttlSeconds: ttl,
            preset: presetId,
          }),
        })

        const reserved = (await reserve.json()) as Partial<Reserved> & {
          error?: string
        }

        if (!reserve.ok || !reserved.id || !reserved.pathname) {
          // The server says which allowance was hit and how long the wait is;
          // "could not start the upload" throws all of that away.
          toast.error(reserved.error ?? "Could not start the upload")
          setPhase("idle")
          return
        }

        setPhase("uploading")
        const result = await transferFile({
          documentId: reserved.id,
          pathname: reserved.pathname,
          uploadMode: reserved.uploadMode,
          file,
          onProgress: setProgress,
        })

        if (!result.ok) {
          if (result.response) {
            await toastFailure(toast, result.response, "Could not start processing")
          } else {
            toast.error(result.message ?? "Upload failed")
          }
          setPhase("idle")
          return
        }

        setPhase("starting")
        router.push(`/workspace/${reserved.id}`)
      } catch {
        toast.error("Upload failed. Check your connection and try again.")
        setPhase("idle")
      }
    },
    [presetId, router, ttl]
  )

  const sendBatch = useCallback(
    async (files: File[]) => {
      setProgress(0)
      setBatchProgress({ done: 0, total: files.length })
      setPhase("reserving")

      try {
        const reserve = await fetch("/api/batches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            files: files.map((file) => ({
              filename: file.name,
              size: file.size,
              contentType: file.type || undefined,
            })),
            ttlSeconds: ttl,
            preset: presetId,
          }),
        })

        const payload = (await reserve.json()) as {
          batchId?: string
          uploadMode?: UploadMode
          accepted?: { index: number; id: string; pathname: string }[]
          refused?: { filename: string; reason: string }[]
          error?: string
        }

        if (!reserve.ok || !payload.batchId || !payload.accepted?.length) {
          toast.error(payload.error ?? "Could not start the upload")
          setPhase("idle")
          setBatchProgress(null)
          return
        }

        // Files the server would not take are said out loud rather than
        // disappearing: a batch that silently starts six of eight documents is
        // a batch the reviewer will finish believing they reviewed eight.
        for (const refusal of payload.refused ?? []) {
          toast.error(`${refusal.filename}: ${refusal.reason}`)
        }

        setPhase("uploading")
        setBatchProgress({ done: 0, total: payload.accepted.length })

        const failures: string[] = []
        for (const [position, item] of payload.accepted.entries()) {
          const file = files[item.index]
          if (!file) continue

          setProgress(0)
          const result = await transferFile({
            documentId: item.id,
            pathname: item.pathname,
            uploadMode: payload.uploadMode,
            file,
            onProgress: setProgress,
          })

          if (!result.ok) failures.push(file.name)
          setBatchProgress({
            done: position + 1,
            total: payload.accepted.length,
          })
        }

        if (failures.length > 0) {
          toast.error(
            failures.length === 1
              ? `${failures[0]} could not be uploaded. The rest were started.`
              : `${failures.length} files could not be uploaded. The rest were started.`
          )
        }

        setPhase("starting")
        router.push(`/batches/${payload.batchId}`)
      } catch {
        toast.error("Upload failed. Check your connection and try again.")
        setPhase("idle")
        setBatchProgress(null)
      }
    },
    [presetId, router, ttl]
  )

  /**
   * One file goes straight to its workspace; several become a batch. Oversized
   * files are named and dropped here rather than being sent and refused, which
   * costs an allowance to learn something the browser already knew.
   */
  const receive = useCallback(
    (selected: File[]) => {
      const withinLimit = selected.filter((file) => file.size <= MAX_BYTES)
      for (const file of selected) {
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is larger than the 25 MB demo limit.`)
        }
      }

      if (withinLimit.length === 0) return
      if (withinLimit.length === 1) {
        void send(withinLimit[0])
        return
      }

      if (withinLimit.length > MAX_BATCH_FILES) {
        toast.error(
          `A batch takes up to ${MAX_BATCH_FILES} files; the rest were not started.`
        )
      }
      void sendBatch(withinLimit.slice(0, MAX_BATCH_FILES))
    },
    [send, sendBatch]
  )

  const label =
    phase === "reserving"
      ? "Preparing…"
      : phase === "uploading"
        ? batchProgress && batchProgress.total > 1
          ? `Uploading ${Math.min(batchProgress.done + 1, batchProgress.total)} of ${batchProgress.total}… ${Math.round(progress)}%`
          : `Uploading… ${Math.round(progress)}%`
        : phase === "starting"
          ? "Starting analysis…"
          : "Drop your documents"

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const dropped = Array.from(event.dataTransfer.files ?? [])
          if (dropped.length > 0 && !busy) receive(dropped)
        }}
        className={cn(
          "group flex flex-col items-center justify-center gap-5 rounded-[10px] border border-dashed border-red-border px-6 py-14 text-center transition-colors duration-200",
          dragging
            ? "border-primary bg-red-soft"
            : "hover:border-primary hover:bg-red-soft",
          busy && "pointer-events-none"
        )}
      >
        {busy ? (
          <Loader2 className="size-8 animate-spin text-primary" />
        ) : (
          <UploadCloud className="size-8 text-primary" />
        )}

        <div className="w-full space-y-1">
          <p className="text-base font-medium text-white">{label}</p>
          <p className="text-sm text-text-muted">
            {SUPPORTED_LABEL} · up to {Math.round(MAX_BYTES / (1024 * 1024))} MB
            · several at once become a batch
          </p>
        </div>

        {phase === "uploading" ? (
          <Progress value={progress} className="h-1 w-48" />
        ) : (
          <Button
            className="btn-pill h-10"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Select files
          </Button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? [])
            event.target.value = ""
            if (selected.length > 0) receive(selected)
          }}
        />
      </div>

      {/*
        The preset and the sentence under it are one control. A preset changes
        what is searched for and nothing else, and the moment a person believes
        otherwise the tool has become worse than no tool — so the caveat is
        stated where the choice is made, not in a document nobody opens.
      */}
      <div className="space-y-2 rounded-[10px] border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="preset" className="text-xs font-normal">
            Look for
          </Label>
          <Select
            value={presetId}
            onValueChange={(value) =>
              setPresetId(value ? String(value) : DEFAULT_PRESET_ID)
            }
            disabled={busy}
          >
            <SelectTrigger id="preset" size="sm" className="w-[230px]">
              <SelectValue>
                {(value) =>
                  presetById(String(value))?.label ?? "Everything we can detect"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {preset ? (
          <ul className="space-y-0.5 text-[11px] text-text-muted">
            {preset.looksFor.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        ) : null}

        <p className="text-[11px] leading-relaxed text-text-secondary">
          {PRESET_DISCLAIMER}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span>Temporary by default · deleted on expiry</span>
        <Select
          value={String(ttl)}
          onValueChange={(value) => setTtl(Number(value) as TtlOption)}
          disabled={busy}
        >
          <SelectTrigger size="sm" className="w-[150px]">
            {/* The value is a count of seconds; the user reads a duration. */}
            <SelectValue>
              {(value) => `Expires in ${ttlLabel(Number(value))}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TTL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={String(option.value)}>
                Expires in {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
