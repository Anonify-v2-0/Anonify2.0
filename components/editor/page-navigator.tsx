"use client"

import { useMemo } from "react"

import { PageThumbnail } from "@/components/editor/page-thumbnail"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePdfDocument } from "@/hooks/use-pdf-document"
import { pageChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectRedactions } from "@/store/selectors"

/**
 * The page rail.
 *
 * Thumbnails carry the accepted redactions, so the rail is also a progress
 * view — a glance shows which pages have been worked through. It is a real
 * navigation list, so a keyboard user can tab through pages and a screen reader
 * hears how many redactions each one holds.
 */
export function PageNavigator({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const currentPage = useAppSelector((state) => state.editor.currentPage)
  const summary = useAppSelector((state) => state.document.summary)
  const normalized = useAppSelector((state) => state.document.normalized)
  const redactions = useAppSelector(selectRedactions)

  const isPdf = summary?.kind === "pdf"
  const { pdf } = usePdfDocument(documentId, isPdf)

  const pageCount =
    normalized?.pages.length ?? summary?.pageCount ?? 0

  const byPage = useMemo(() => {
    const grouped = new Map<number, typeof redactions>()
    for (const redaction of redactions) {
      if (redaction.status === "rejected") continue
      const page = redaction.page ?? 1
      grouped.set(page, [...(grouped.get(page) ?? []), redaction])
    }
    return grouped
  }, [redactions])

  if (pageCount === 0) return null

  return (
    <aside className="hidden w-[168px] shrink-0 flex-col border-r border-border bg-surface-2 lg:flex">
      <p className="label-micro px-4 py-3" id="page-rail-label">
        Pages
      </p>

      <ScrollArea className="flex-1">
        <nav aria-labelledby="page-rail-label">
          <ul className="flex flex-col gap-3 px-4 pb-4">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (pageNumber) => (
                <li key={pageNumber}>
                  <PageThumbnail
                    documentId={documentId}
                    pageNumber={pageNumber}
                    page={normalized?.pages.find(
                      (candidate) => candidate.number === pageNumber
                    )}
                    redactions={byPage.get(pageNumber) ?? []}
                    selected={pageNumber === currentPage}
                    pdf={pdf}
                    onSelect={() => dispatch(pageChanged(pageNumber))}
                  />
                </li>
              )
            )}
          </ul>
        </nav>
      </ScrollArea>
    </aside>
  )
}
