"use client"

import { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { Loader2 } from "lucide-react"

import type { NormalizedPage } from "@/types/document"

/**
 * Renders one PDF page to a canvas at the current zoom, with a transparent
 * overlay sized to the same box. Redaction annotations are DOM children of the
 * overlay: geometry stays in PDF user-space units and only the wrapper scales,
 * so a box drawn at 100% lines up at 400%.
 */

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist")
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
  return pdfjs
}

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
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load the document once per id.
  useEffect(() => {
    let cancelled = false
    let loadingTask: { destroy: () => Promise<void> } | null = null

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const pdfjs = await loadPdfjs()
        const task = pdfjs.getDocument({
          url: `/api/documents/${documentId}/source`,
          withCredentials: true,
          disableFontFace: false,
        })
        loadingTask = task
        const pdf = await task.promise
        if (cancelled) {
          await task.destroy()
          return
        }
        pdfRef.current = pdf
        setLoading(false)
      } catch {
        if (!cancelled) {
          setError("This document could not be rendered.")
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      pdfRef.current = null
      void loadingTask?.destroy()
    }
  }, [documentId])

  // Re-render whenever the page or the zoom changes.
  useEffect(() => {
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null

    async function render() {
      const pdf = pdfRef.current
      const canvas = canvasRef.current
      if (!pdf || !canvas || loading) return

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
      } catch {
        // A cancelled render is the expected outcome of a fast zoom change.
      }
    }

    void render()

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [loading, page.height, page.width, pageNumber, zoom])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
        {error}
      </div>
    )
  }

  return (
    <div
      className="relative shadow-document"
      style={{ width: page.width * zoom, height: page.height * zoom }}
    >
      <canvas ref={canvasRef} className="block bg-document" />

      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-document">
          <Loader2 className="size-5 animate-spin text-neutral-400" />
        </div>
      ) : null}

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
