"use client"

import { useState } from "react"
import { Clock, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  extendableOptions,
  MAX_RETENTION_SECONDS,
  ttlLabel,
} from "@/types/document"

/**
 * Extending a document's retention window.
 *
 * The options offered are only the ones that would actually push the expiry
 * out, computed from the creation time — so a document that has already used
 * most of its allowance simply has fewer choices, and one at the ceiling has
 * none. The limit is stated rather than discovered by trying.
 */

function remaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return "expired"

  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours >= 1) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export function RetentionControl({
  documentId,
  createdAt,
  expiresAt,
  onExtended,
  className,
}: {
  documentId: string
  createdAt: string
  expiresAt: string
  onExtended: (expiresAt: string) => void
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const options = extendableOptions(createdAt, expiresAt)
  const capHours = MAX_RETENTION_SECONDS / 3600

  async function extend(ttlSeconds: number) {
    setBusy(true)
    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttlSeconds }),
      })

      const payload = (await response.json()) as {
        expiresAt?: string
        error?: string
      }

      if (!response.ok || !payload.expiresAt) {
        toast.error(payload.error ?? "That window could not be applied.")
        return
      }

      onExtended(payload.expiresAt)
      toast.success(`Now expires in ${remaining(payload.expiresAt)}.`)
    } catch {
      toast.error("That window could not be applied.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className={cn("text-text-muted hover:text-white", className)}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Clock className="size-3.5" />
            )}
            {remaining(expiresAt)}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-[11px] font-normal text-text-muted">
          Keep this document for
        </DropdownMenuLabel>

        {options.length === 0 ? (
          <p className="px-2 py-2 text-xs leading-relaxed text-text-muted">
            This document is at the {capHours}-hour demo limit. It will be
            deleted with everything it produced when the window ends.
          </p>
        ) : (
          options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => void extend(option.value)}
            >
              <span className="flex-1">{ttlLabel(option.value)}</span>
              <span className="text-[11px] text-text-muted">
                from upload
              </span>
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />
        <p className="px-2 pb-1 text-[11px] leading-relaxed text-text-muted">
          Windows are measured from when the document was uploaded, and cap at{" "}
          {capHours} hours.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
