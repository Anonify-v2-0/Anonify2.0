"use client"

import { memo, type ReactNode } from "react"
import { Streamdown, type Components } from "streamdown"

import { cn } from "@/lib/utils"

/**
 * Hush's replies, rendered as Markdown while they stream.
 *
 * Streamdown, because a reply arrives a few tokens at a time and ordinary
 * Markdown renderers flash half-parsed syntax — an unclosed `**` or a table
 * with one row — until the closing token lands. Streamdown completes the
 * fragment for display and re-renders only the block that changed.
 *
 * Hardened past its defaults, because a reply can quote the document and the
 * document is untrusted. Nothing in a reply can make the browser fetch
 * anything: links render as their text, images as their alt text, every URL
 * is dropped before it reaches an attribute, and raw HTML is not rendered. It is the rule the email viewer
 * already keeps — a tracking pixel must not phone home from a reviewer's
 * screen by way of a model that repeated it.
 */

const components: Components = {
  a: ({ children }) => (
    <span className="text-white underline decoration-white/30 underline-offset-2">
      {children}
    </span>
  ),
  img: ({ alt }) => (
    <span className="text-text-muted italic">
      [image{alt ? `: ${alt}` : ""}]
    </span>
  ),
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-white/8 px-1 py-0.5 font-mono text-[0.85em] text-white">
        {children}
      </code>
    ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-white/4 px-2 py-1.5 text-left font-medium text-text-secondary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-2 py-1.5 align-top text-text-secondary">
      {children}
    </td>
  ),
}

/** No URL survives into an attribute: see above. */
const noUrls = () => ""

export const HushMarkdown = memo(function HushMarkdown({
  children,
  streaming,
  className,
}: {
  children: string
  streaming: boolean
  className?: string
}): ReactNode {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown
      skipHtml
      urlTransform={noUrls}
      components={components}
      controls={{
        code: { copy: true, download: false },
        table: false,
        mermaid: false,
      }}
      className={cn(
        "hush-markdown space-y-2 text-[13px] leading-relaxed text-text-secondary",
        "[&_[data-streamdown=strong]]:text-white [&_li]:my-0.5 [&_ol]:list-outside [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:text-white [&_ul]:list-outside [&_ul]:list-disc [&_ul]:pl-5",
        "[&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-white [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-white [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-white",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-3 [&_pre]:p-2.5 [&_pre]:text-xs",
        className
      )}
    >
      {children}
    </Streamdown>
  )
})
