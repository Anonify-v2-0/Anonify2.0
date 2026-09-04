"use client"

import { useCallback, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { upload } from "@vercel/blob/client"
import { Loader2, UploadCloud } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DEFAULT_TTL_SECONDS,
  TTL_OPTIONS,
  ttlLabel,
  type TtlOption,
} from "@/types/document"

const ACCEPT = ".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp"
const MAX_BYTES = 25 * 1024 * 1024
/** Above this size the browser splits the upload into parallel parts. */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024

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
export function UploadPanel() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState(0)
  const [ttl, setTtl] = useState<TtlOption>(DEFAULT_TTL_SECONDS)

  const busy = phase !== "idle"

  const send = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast.error("That file is larger than the 25 MB demo limit.")
        return
      }

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
          }),
        })

        const reserved = (await reserve.json()) as Partial<Reserved> & {
          error?: string
        }

        if (!reserve.ok || !reserved.id || !reserved.pathname) {
          toast.error(reserved.error ?? "Could not start the upload")
          setPhase("idle")
          return
        }

        setPhase("uploading")
        const uploaded =
          reserved.uploadMode === "vercel-blob"
            ? await upload(reserved.pathname, file, {
                access: "public",
                handleUploadUrl: "/api/upload/token",
                clientPayload: reserved.id,
                multipart: file.size > MULTIPART_THRESHOLD,
                onUploadProgress: ({ percentage }) => setProgress(percentage),
              })
            : await uploadThroughServer(reserved.id, file, setProgress)

        setPhase("starting")
        const started = await fetch(`/api/documents/${reserved.id}/process`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blobUrl: uploaded.url }),
        })

        if (!started.ok) {
          const payload = (await started.json()) as { error?: string }
          toast.error(payload.error ?? "Could not start processing")
          setPhase("idle")
          return
        }

        router.push(`/workspace/${reserved.id}`)
      } catch (error) {
        const message =
          error instanceof Error && error.message !== "Upload failed"
            ? error.message
            : "Upload failed. Check your connection and try again."
        toast.error(message)
        setPhase("idle")
      }
    },
    [router, ttl]
  )

  const label =
    phase === "reserving"
      ? "Preparing…"
      : phase === "uploading"
        ? `Uploading… ${Math.round(progress)}%`
        : phase === "starting"
          ? "Starting analysis…"
          : "Drop your document"

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
          const file = event.dataTransfer.files?.[0]
          if (file && !busy) void send(file)
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
            PDF, DOCX, XLSX or image · up to 25 MB
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
            Select file
          </Button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) void send(file)
          }}
        />
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
