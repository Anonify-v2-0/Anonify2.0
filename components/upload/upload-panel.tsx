"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
import {
  decodeUploadKey,
  sealFileForUpload,
  type UploadEncryption,
} from "@/lib/storage/chunked-web"
import {
  ACCEPTED_EXTENSIONS,
  MAX_BATCH_FILES,
  MAX_UPLOAD_BYTES,
} from "@/lib/config"
import {
  DEFAULT_PRESET_ID,
  PRESET_DISCLAIMER,
  PRESETS,
  presetById,
} from "@/lib/redaction/presets"
import { cn } from "@/lib/utils"
import type { LimitsReport } from "@/types/limits"
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

type Phase = "idle" | "reserving" | "uploading" | "starting"

/**
 * Getting the file in.
 *
 * First the file is sealed, here in the page, under a single-use key the
 * reservation handed back (lib/storage/chunked-web.ts), so what travels and
 * what lands in storage is ciphertext on every path.
 *
 * With Vercel Blob the server signs a token scoped to one path and the browser
 * uploads straight to storage, so the file never travels through a serverless
 * function. S3 can do the same with a presigned PUT when the operator has
 * enabled it. Otherwise — the local filesystem, or a bucket browsers cannot
 * reach — the bytes go through our own route instead.
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

type UploadMode = "vercel-blob" | "server-route" | "s3-presigned"

type Reserved = {
  id: string
  pathname: string
  uploadMode: UploadMode
  uploadEncryption?: UploadEncryption | null
}

/**
 * Whether this page can seal an upload at all.
 *
 * WebCrypto's `subtle` only exists in a secure context: HTTPS, or localhost.
 * A self-hosted install opened over plain HTTP on a LAN address has none, and
 * asking for an upload key there would reserve a document this page cannot
 * then seal. So the key is asked for only when it can be used; an install
 * that requires sealed uploads refuses the reservation instead, and says why.
 */
function canSealUploads(): boolean {
  return typeof globalThis.crypto?.subtle?.encrypt === "function"
}

/** How much of the progress bar sealing gets; sending gets the rest. */
const SEAL_SHARE = 10

/**
 * Sends a body with XMLHttpRequest, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch still cannot report upload progress
 * in browsers, and a 25 MB upload with no feedback looks like a hang.
 */
function sendWithProgress(input: {
  method: "POST" | "PUT"
  url: string
  body: XMLHttpRequestBodyInit
  headers?: Record<string, string>
  onProgress: (percentage: number) => void
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(input.method, input.url)
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      request.setRequestHeader(name, value)
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        input.onProgress((event.loaded / event.total) * 100)
      }
    })

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.responseText)
        return
      }

      let message = "Upload failed"
      try {
        message = (JSON.parse(request.responseText) as { error?: string }).error ?? message
      } catch {
        // Keep the generic message. A storage service answers in XML, and
        // nothing in it is written for the person uploading.
      }
      reject(new Error(message))
    })

    request.addEventListener("error", () => reject(new Error("Upload failed")))
    request.addEventListener("abort", () => reject(new Error("Upload cancelled")))

    request.send(input.body)
  })
}

/** Posts through our own route. */
async function uploadThroughServer(
  documentId: string,
  body: Blob,
  filename: string,
  onProgress: (percentage: number) => void
): Promise<{ url: string }> {
  const form = new FormData()
  form.append("documentId", documentId)
  form.append("file", body, filename)

  const response = await sendWithProgress({
    method: "POST",
    url: "/api/upload/local",
    body: form,
    onProgress,
  })
  try {
    return JSON.parse(response) as { url: string }
  } catch {
    throw new Error("Malformed upload response")
  }
}

/**
 * PUTs straight into the S3 bucket with a URL the server presigned for this
 * one object and exactly this many bytes.
 */
async function uploadStraightToStorage(
  documentId: string,
  body: Blob,
  onProgress: (percentage: number) => void
): Promise<{ url: string }> {
  const presign = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, size: body.size }),
  })
  const signed = (await presign.json()) as {
    url?: string
    headers?: Record<string, string>
    handle?: string
    error?: string
  }
  if (!presign.ok || !signed.url || !signed.handle) {
    throw new Error(signed.error ?? "Upload failed")
  }

  await sendWithProgress({
    method: "PUT",
    url: signed.url,
    body,
    headers: signed.headers,
    onProgress,
  })
  return { url: signed.handle }
}

/**
 * Seals the file in the page, when the reservation handed back a key for it.
 *
 * The raw key lives for exactly this call: it is decoded, imported into
 * WebCrypto as non-extractable, and the decoded bytes are zeroed however
 * sealing ends. What leaves the page afterwards is ciphertext only.
 */
async function sealIfAsked(input: {
  file: File
  pathname: string
  encryption: UploadEncryption | null | undefined
  onProgress: (percentage: number) => void
}): Promise<Blob> {
  if (!input.encryption) return input.file
  const key = decodeUploadKey(input.encryption.key)
  try {
    return await sealFileForUpload({
      file: input.file,
      key,
      // The path it was reserved under, which ingest binds it to.
      logicalKey: input.pathname,
      chunkShift: input.encryption.chunkShift,
      onProgress: (fraction) => input.onProgress(fraction * SEAL_SHARE),
    })
  } finally {
    key.fill(0)
  }
}

type TransferResult =
  | { ok: true }
  /** The failing response, when there is one worth reading a message out of. */
  | { ok: false; response?: Response; message?: string }

/** Seals and sends one reserved document's bytes, and starts its run. */
async function transferFile(input: {
  documentId: string
  pathname: string
  uploadMode: UploadMode | undefined
  encryption: UploadEncryption | null | undefined
  file: File
  onProgress: (percentage: number) => void
}): Promise<TransferResult> {
  try {
    const body = await sealIfAsked(input)
    const sealed = body !== input.file
    const onSendProgress = sealed
      ? (percentage: number) =>
          input.onProgress(SEAL_SHARE + (percentage * (100 - SEAL_SHARE)) / 100)
      : input.onProgress

    const uploaded =
      input.uploadMode === "vercel-blob"
        ? await upload(input.pathname, body, {
            access: "public",
            handleUploadUrl: "/api/upload/token",
            clientPayload: input.documentId,
            contentType: sealed ? "application/octet-stream" : undefined,
            multipart: body.size > MULTIPART_THRESHOLD,
            onUploadProgress: ({ percentage }) => onSendProgress(percentage),
          })
        : // Only ciphertext goes straight to the bucket; a page that could not
          // seal still has our own route.
          input.uploadMode === "s3-presigned" && sealed
          ? await uploadStraightToStorage(input.documentId, body, onSendProgress)
          : await uploadThroughServer(
              input.documentId,
              body,
              input.file.name,
              onSendProgress
            )
    // The bytes are there. A small file can finish before the browser reports
    // any progress at all, and without this the bar would sit at 0% for as
    // long as starting the run takes.
    input.onProgress(100)

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
  /**
   * How many files this deployment takes in one batch.
   *
   * Asked for rather than compiled in: the limit is a server setting and a
   * bundle cannot read one, so `MAX_BATCH_FILES` is the value to slice with
   * until the answer arrives. Slicing is a courtesy either way — the server
   * refuses anything over its own ceiling and says so per file — but a panel
   * that quietly drops files a raised limit would have accepted is a panel
   * that lies about what the tool can do.
   */
  const [maxFiles, setMaxFiles] = useState(MAX_BATCH_FILES)

  useEffect(() => {
    let cancelled = false

    async function readLimits() {
      try {
        const response = await fetch("/api/limits", { cache: "no-store" })
        if (!response.ok) return
        const payload = (await response.json()) as LimitsReport
        if (!cancelled && payload.batch?.maxFiles) {
          setMaxFiles(payload.batch.maxFiles)
        }
      } catch {
        // The compiled default stands, and the server still decides.
      }
    }

    void readLimits()
    return () => {
      cancelled = true
    }
  }, [])

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
            uploadEncryption: canSealUploads() ? "v1" : undefined,
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
          encryption: reserved.uploadEncryption,
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
            uploadEncryption: canSealUploads() ? "v1" : undefined,
          }),
        })

        const payload = (await reserve.json()) as {
          batchId?: string
          uploadMode?: UploadMode
          accepted?: {
            index: number
            id: string
            pathname: string
            uploadEncryption?: UploadEncryption | null
          }[]
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
            encryption: item.uploadEncryption,
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

      if (withinLimit.length > maxFiles) {
        toast.error(
          `A batch takes up to ${maxFiles} files; the rest were not started.`
        )
      }
      void sendBatch(withinLimit.slice(0, maxFiles))
    },
    [maxFiles, send, sendBatch]
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

        {/*
          The same height either way, so the drop zone — and the column around
          it — does not jump when the button gives way to the progress bar.
        */}
        <div className="flex h-10 items-center justify-center">
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
        </div>

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
