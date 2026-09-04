"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { usePdfDocument } from "@/hooks/use-pdf-document"
import type { NormalizedPage } from "@/types/document"

/**
 * Renders one PDF page to a canvas at the current zoom, with a transparent
 * overlay sized to the same box. Redaction annotations are DOM children of the
 * overlay: geometry stays in PDF user-space units and only the wrapper scales,
 * so a box drawn at 100% lines up at 400%.
 */

type PdfViewerProps = {
  documentId: string
  page: NormalizedPage
  pageNumber: number
  zoom: number
  children?: React.ReactNode
}

export function PdfViewer({
  documentId,
  page,
  pageNumber,
  zoom,
  children,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // The rail renders the same file; one parsed document serves both.
  const { pdf, error } = usePdfDocument(documentId)
  const [rendered, setRendered] = useState(false)

  // Re-render whenever the page or the zoom changes.
  useEffect(() => {
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null

    async function render() {
      const canvas = canvasRef.current
      if (!pdf || !canvas) return

      const pdfPage = await pdf.getPage(pageNumber)
      if (cancelled) return

      const ratio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: zoom * ratio })
      const context = canvas.getContext("2d")
      if (!context) return

      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${page.width * zoom}px`
      canvas.style.height = `${page.height * zoom}px`

      task = pdfPage.render({ canvas, canvasContext: context, viewport })
      try {
        await task.promise
        if (!cancelled) setRendered(true)
      } catch {
        // A cancelled render is the expected outcome of a fast zoom change.
      }
    }

    void render()

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [page.height, page.width, pageNumber, pdf, zoom])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
        This document could not be rendered.
      </div>
    )
  }

  return (
    <div
      className="relative shadow-document"
      style={{ width: page.width * zoom, height: page.height * zoom }}
    >
      <canvas ref={canvasRef} className="block bg-document" />

      {rendered ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-document">
          <Loader2 className="size-5 animate-spin text-neutral-400" />
          <span className="sr-only">Rendering page {pageNumber}</span>
        </div>
      )}

      {/*
        Annotation layer. Children position themselves in PDF user-space units;
        the layer scales as one so nothing drifts at high zoom.
      */}
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: page.width,
          height: page.height,
          transform: `scale(${zoom})`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
