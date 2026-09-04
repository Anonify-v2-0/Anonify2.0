import Link from "next/link"

import { cn } from "@/lib/utils"

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "text-lg font-bold tracking-[0.18em] text-primary uppercase transition-colors hover:text-white",
        className
      )}
    >
      Anonify
    </Link>
  )
}
