"use client"

import { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"

import { DocxViewer } from "@/components/document-viewer/docx-viewer"
import { EmlViewer } from "@/components/document-viewer/eml-viewer"
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
 *
 * A PDF page is rasterized by pdf.js. A DOCX page has no raster to ask for —
 * there is no PDF behind it — so it is drawn by the same viewer the canvas
 * uses, scaled down. Without this the rail showed a column of blank rectangles
 * for every DOCX, which reads as a broken panel rather than as a document with
 * nothing on its pages.
 *
 * A message is the same, with one difference: only its *body* is drawn. A rail
 * of tiles all showing the same `From:` block tells a reviewer nothing about
 * which page they are looking for, and the body is the part that differs from
 * page to page.
 */

/**
 * The width of the raster asked of pdf.js. A resolution, not a layout size:
 * the image is drawn `object-contain` into whatever the tile turns out to be.
 */
const THUMBNAIL_RASTER_WIDTH = 120

/**
 * The page width a DOM-rendered preview is laid out at.
 *
 * A PDF thumbnail is a photograph of a real page, so reducing it is right. A
 * DOCX or EML page has no real geometry — `612 x 792` is invented by the
 * extractor — so reducing *that* until 10.5pt type lands on under three
 * physical pixels is fidelity to nothing, and it costs the reviewer the glance
 * the rail exists for. Laying the same content out in a narrower page reflows
 * it instead, and the type lands around 7px: still small, but a miniature of
 * the document rather than grey noise.
 *
 * The margin shrinks with it. Keeping a 72pt margin on a 260pt page would
 * spend more than half the width on white.
 */
const PREVIEW_PAGE_WIDTH = 260
const PREVIEW_PAGE_MARGIN = 14

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
  const viewport = page.getViewport({
    scale: THUMBNAIL_RASTER_WIDTH / base.width,
  })

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

/** True when an accepted redaction covers any of the run's characters. */
function coveredByAccepted(
  page: NormalizedPage,
  spanId: string,
  redactions: Redaction[]
): boolean {
  const span = page.spans.find((candidate) => candidate.id === spanId)
  if (!span) return false

  return redactions.some(
    (redaction) =>
      redaction.status === "accepted" &&
      redaction.start !== undefined &&
      redaction.end !== undefined &&
      span.start < redaction.end &&
      span.end > redaction.start
  )
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

  /**
   * The tile is `w-full` of a rail whose width is a layout decision, so the
   * only honest scale is the one measured off the tile itself. Scaling to a
   * constant left every DOM-rendered preview a little smaller than its tile,
   * with a dead strip down the right — the raster branch never showed it,
   * because an `object-contain` image stretches to whatever it is given.
   */
  const tile = useRef<HTMLSpanElement>(null)
  const [tileWidth, setTileWidth] = useState(0)

  useEffect(() => {
    const element = tile.current
    if (!element) return

    const measure = () => setTileWidth(element.clientWidth)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const previewZoom = tileWidth > 0 ? tileWidth / PREVIEW_PAGE_WIDTH : 0

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
        ref={tile}
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
        ) : page?.sections && previewZoom > 0 ? (
          <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <EmlViewer
              page={page}
              zoom={previewZoom}
              width={PREVIEW_PAGE_WIDTH}
              padding={PREVIEW_PAGE_MARGIN}
              variant="preview"
              renderSpan={(spanId, children) =>
                coveredByAccepted(page, spanId, redactions) ? (
                  <span className="bg-black text-black">{children}</span>
                ) : (
                  children
                )
              }
            />
          </span>
        ) : page?.blocks && previewZoom > 0 ? (
          // Inert: the whole tile is one button, so the miniature must not be
          // reachable or announced separately.
          <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <DocxViewer
              page={page}
              zoom={previewZoom}
              width={PREVIEW_PAGE_WIDTH}
              padding={PREVIEW_PAGE_MARGIN}
              renderSpan={(spanId, children) =>
                // DOCX spans carry no geometry, so the boxes drawn below this
                // find nothing to place. Blacking the run out here is what
                // keeps the rail a progress view for a Word document too.
                coveredByAccepted(page, spanId, redactions) ? (
                  <span className="bg-black text-black">{children}</span>
                ) : (
                  children
                )
              }
            />
          </span>
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
