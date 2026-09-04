"use client"

import { useCallback, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, UploadCloud } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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

export function UploadPanel() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [ttl, setTtl] = useState<TtlOption>(DEFAULT_TTL_SECONDS)

  const upload = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast.error("That file is larger than the 25 MB demo limit.")
        return
      }

      setUploading(true)
      try {
        const body = new FormData()
        body.append("file", file)
        body.append("ttlSeconds", String(ttl))

        const response = await fetch("/api/upload", { method: "POST", body })
        const payload = (await response.json()) as {
          id?: string
          error?: string
        }

        if (!response.ok || !payload.id) {
          toast.error(payload.error ?? "Upload failed")
          return
        }

        router.push(`/workspace/${payload.id}`)
      } catch {
        toast.error("Upload failed. Check your connection and try again.")
      } finally {
        setUploading(false)
      }
    },
    [router, ttl]
  )

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
          if (file) void upload(file)
        }}
        className={cn(
          "group flex flex-col items-center justify-center gap-5 rounded-[10px] border border-dashed border-red-border px-6 py-14 text-center transition-colors duration-200",
          dragging ? "border-primary bg-red-soft" : "hover:border-primary hover:bg-red-soft",
          uploading && "pointer-events-none opacity-70"
        )}
      >
        {uploading ? (
          <Loader2 className="size-8 animate-spin text-primary" />
        ) : (
          <UploadCloud className="size-8 text-primary" />
        )}

        <div className="space-y-1">
          <p className="text-base font-medium text-white">
            {uploading ? "Uploading…" : "Drop your document"}
          </p>
          <p className="text-sm text-text-muted">
            PDF, DOCX, XLSX or image · up to 25 MB
          </p>
        </div>

        <Button
          className="btn-pill h-10"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          Select file
        </Button>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) void upload(file)
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span>Temporary by default · deleted on expiry</span>
        <Select
          value={String(ttl)}
          onValueChange={(value) => setTtl(Number(value) as TtlOption)}
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
