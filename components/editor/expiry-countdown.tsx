"use client"

import { useEffect, useState } from "react"
import { Clock } from "lucide-react"

function remaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return "expired"

  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours >= 1) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const [label, setLabel] = useState(() => remaining(expiresAt))

  useEffect(() => {
    const id = setInterval(() => setLabel(remaining(expiresAt)), 30_000)
    return () => clearInterval(id)
  }, [expiresAt])

  return (
    <span className="hidden items-center gap-1.5 text-xs text-text-muted lg:flex">
      <Clock className="size-3.5" />
      Expires in {label}
    </span>
  )
}
