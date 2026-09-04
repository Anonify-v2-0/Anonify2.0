"use client"

import { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"

import { boxesForRedaction } from "@/components/redaction/redaction-layer"
import { cn } from "@/lib/utils"
import type { NormalizedPage } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * One page in the navigator.
 *
 * The thumbnail shows the actual page with its accepted redactions drawn on, so
 * the rail doubles as a progress view: a glance tells you which pages you have
 * worked through and which are still untouched. Renders are cached per document
 * and page, because scrolling the rail should not re-rasterize.
 */

const THUMBNAIL_WIDTH = 120

const renderCache = new Map<string, string>()

function cacheKey(documentId: string, page: number): string {
  return `${documentId}:${page}`
}

async function renderThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number
): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / base.width })

  const canvas = document.createElement("canvas")
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)

  const context = canvas.getContext("2d")
  if (!context) throw new Error("no 2d context")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvas, canvasContext: context, viewport }).promise
  page.cleanup()

  return canvas.toDataURL("image/png")
}

export type PageThumbnailProps = {
  documentId: string
  pageNumber: number
  page?: NormalizedPage
  redactions: Redaction[]
  selected: boolean
  pdf: PDFDocumentProxy | null
  onSelect: () => void
}

export function PageThumbnail({
  documentId,
  pageNumber,
  page,
  redactions,
  selected,
  pdf,
  onSelect,
}: PageThumbnailProps) {
  const [source, setSource] = useState<string | null>(
    () => renderCache.get(cacheKey(documentId, pageNumber)) ?? null
  )
  const rendering = useRef(false)

  useEffect(() => {
    if (!pdf || source || rendering.current) return

    let cancelled = false
    rendering.current = true

    renderThumbnail(pdf, pageNumber)
      .then((dataUrl) => {
        renderCache.set(cacheKey(documentId, pageNumber), dataUrl)
        if (!cancelled) setSource(dataUrl)
      })
      .catch(() => {
        // A page that will not render still gets a surface and its boxes.
      })
      .finally(() => {
        rendering.current = false
      })

    return () => {
      cancelled = true
    }
  }, [documentId, pageNumber, pdf, source])

  const accepted = redactions.filter(
    (redaction) => redaction.status === "accepted"
  )
  const suggested = redactions.filter(
    (redaction) => redaction.status === "suggested"
  )

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      aria-label={`Page ${pageNumber}${
        accepted.length > 0 ? `, ${accepted.length} redacted` : ""
      }${suggested.length > 0 ? `, ${suggested.length} to review` : ""}`}
      className="group flex flex-col items-center gap-1.5 focus-visible:outline-none"
    >
      <span
        className={cn(
          "relative block w-full overflow-hidden rounded-[3px] border bg-document transition-colors",
          selected
            ? "border-primary"
            : "border-border group-hover:border-border-strong",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring"
        )}
        style={{ aspectRatio: page ? `${page.width} / ${page.height}` : "1 / 1.294" }}
      >
        {source ? (
          // eslint-disable-next-line @next/next/no-img-element -- a client-rendered data URL
          <img src={source} alt="" className="block h-full w-full object-contain" />
        ) : null}

        {/* Redactions in page units, scaled to the thumbnail by percentage. */}
        {page
          ? redactions.flatMap((redaction) =>
              boxesForRedaction(page, redaction).map((box, index) => (
                <span
                  key={`${redaction.id}-${index}`}
                  aria-hidden
                  className={cn(
                    "absolute",
                    redaction.status === "accepted"
                      ? "bg-black"
                      : "bg-primary/30 outline-1 outline-red-border"
                  )}
                  style={{
                    left: `${(box.x / page.width) * 100}%`,
                    top: `${(box.y / page.height) * 100}%`,
                    width: `${(box.width / page.width) * 100}%`,
                    height: `${(box.height / page.height) * 100}%`,
                  }}
                />
              ))
            )
          : null}
      </span>

      <span className="flex items-center gap-1.5 text-[11px]">
        <span className={selected ? "text-white" : "text-text-muted"}>
          {pageNumber}
        </span>
        {accepted.length > 0 ? (
          <span className="text-primary tabular-nums">{accepted.length}</span>
        ) : null}
      </span>
    </button>
  )
}
