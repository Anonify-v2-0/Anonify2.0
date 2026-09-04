import Image from "next/image"
import Link from "next/link"

import { cn } from "@/lib/utils"

/**
 * The Anonify mark.
 *
 * The shield carries the product's whole palette already — charcoal, red,
 * white — so it sits beside the wordmark without anything extra. In the
 * workspace header the wordmark drops away on narrow screens and the mark alone
 * carries the brand, which is what a logo is for.
 */
export function Brand({
  className,
  showWordmark = true,
  size = 28,
}: {
  className?: string
  showWordmark?: boolean
  size?: number
}) {
  return (
    <Link
      href="/"
      aria-label="Anonify home"
      className={cn("group flex items-center gap-2.5", className)}
    >
      <Image
        src="/Anonify.png"
        alt=""
        width={size}
        height={size}
        priority
        className="shrink-0 rounded-[6px]"
      />
      {showWordmark ? (
        <span className="text-lg font-bold tracking-[0.18em] text-primary uppercase transition-colors group-hover:text-white">
          Anonify
        </span>
      ) : null}
    </Link>
  )
}
