"use client"

import { useEffect, useState } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"

/**
 * One parsed PDF per document, shared by everything that renders it.
 *
 * The page canvas and the thumbnail rail both need the same file. Loading it
 * twice would parse and hold the whole document twice for no benefit, so the
 * proxy is cached and reference counted: it is destroyed when the last consumer
 * unmounts, not when the first one does.
 */

type Entry = {
  promise: Promise<PDFDocumentProxy>
  task: { destroy: () => Promise<void> }
  refs: number
}

const cache = new Map<string, Entry>()

/**
 * pdf.js's legacy build, not its default one.
 *
 * The default build assumes the newest JavaScript: pdf.js 6 calls
 * `Map.prototype.getOrInsertComputed`, which Chromium before 145 and the iOS
 * and Android browsers a phone reviewer is likely to have do not ship. There
 * it threw on the first page and the canvas sat on its spinner forever, with
 * no page and no error. The legacy build carries its own polyfills, in the
 * library and in the worker (see scripts/copy-pdf-worker.mjs), for a little
 * over 10% more code. The server already renders with it.
 */
async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
  return pdfjs
}

function acquire(documentId: string): Entry {
  const existing = cache.get(documentId)
  if (existing) {
    existing.refs += 1
    return existing
  }

  let task: { destroy: () => Promise<void> } | null = null

  const promise = (async () => {
    const pdfjs = await loadPdfjs()
    const loadingTask = pdfjs.getDocument({
      url: `/api/documents/${documentId}/source`,
      withCredentials: true,
    })
    task = loadingTask
    return loadingTask.promise
  })()

  const entry: Entry = {
    promise,
    // The task only exists after the async work starts; destroy waits for it.
    task: { destroy: async () => task?.destroy() },
    refs: 1,
  }

  cache.set(documentId, entry)
  return entry
}

function release(documentId: string): void {
  const entry = cache.get(documentId)
  if (!entry) return

  entry.refs -= 1
  if (entry.refs > 0) return

  cache.delete(documentId)
  void entry.task.destroy().catch(() => undefined)
}

export function usePdfDocument(documentId: string, enabled = true) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const entry = acquire(documentId)

    entry.promise
      .then((loaded) => {
        if (!cancelled) setPdf(loaded)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })

    return () => {
      cancelled = true
      setPdf(null)
      release(documentId)
    }
  }, [documentId, enabled])

  return { pdf, error }
}
