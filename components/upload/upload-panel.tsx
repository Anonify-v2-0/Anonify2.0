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
  type TtlOption,
} from "@/types/document"

const ACCEPT = ".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp"
const MAX_BYTES = 25 * 1024 * 1024
/** Above this size the browser splits the upload into parallel parts. */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024

type Phase = "idle" | "reserving" | "uploading" | "starting"

/**
 * Uploads go from the browser straight to Blob storage.
 *
 * The server reserves the document and signs a token scoped to that one path,
 * so the file never travels through a serverless function: large documents are
 * not bound by a request body limit, and the progress bar reflects the real
 * transfer.
 */
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

        const reserved = (await reserve.json()) as {
          id?: string
          pathname?: string
          error?: string
        }

        if (!reserve.ok || !reserved.id || !reserved.pathname) {
          toast.error(reserved.error ?? "Could not start the upload")
          setPhase("idle")
          return
        }

        setPhase("uploading")
        const blob = await upload(reserved.pathname, file, {
          access: "public",
          handleUploadUrl: "/api/upload/token",
          clientPayload: reserved.id,
          multipart: file.size > MULTIPART_THRESHOLD,
          onUploadProgress: ({ percentage }) => setProgress(percentage),
        })

        setPhase("starting")
        const started = await fetch(`/api/documents/${reserved.id}/process`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blobUrl: blob.url }),
        })

        if (!started.ok) {
          const payload = (await started.json()) as { error?: string }
          toast.error(payload.error ?? "Could not start processing")
          setPhase("idle")
          return
        }

        router.push(`/workspace/${reserved.id}`)
      } catch {
        toast.error("Upload failed. Check your connection and try again.")
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
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue />
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
