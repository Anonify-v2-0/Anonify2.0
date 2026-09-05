import Image from "next/image"
import { Code } from "lucide-react"

import { REPOSITORY_URL } from "@/lib/config"
import { cn } from "@/lib/utils"

/**
 * The shared footer, mirrored after `Brand`.
 *
 * The landing page used to carry an inline footer with the retention sentence
 * and nothing else, and every other page carried no footer at all — so the one
 * place the repo was linkable from was at the bottom of one page. This is the
 * single copy: the Anonify mark, the temporary-by-default line, and a link to
 * the source, because the repo is where the heavy lifting actually lives.
 */
export function Footer({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-6 py-6 text-xs text-text-muted lg:px-10",
        className
      )}
    >
      <Image
        src="/Anonify.png"
        alt=""
        width={20}
        height={20}
        className="shrink-0 rounded-[4px] opacity-70"
      />
      <span className="flex-1">
        Open source — clone and run it yourself. Documents expire automatically
        and every artifact they produced is deleted with them.
      </span>
      <a
        href={REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-text-secondary transition-colors hover:border-border-strong hover:text-white"
      >
        <Code className="size-3.5" />
        View source
      </a>
    </footer>
  )
}
