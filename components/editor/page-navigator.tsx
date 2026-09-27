"use client"

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react"

import { PageThumbnail } from "@/components/editor/page-thumbnail"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useNormalizedPage } from "@/hooks/use-normalized-document"
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
  // Search hits per page, so a long document shows where they are at a glance.
  const hitsByPage = useAppSelector((state) =>
    state.search.open ? state.search.pages : null
  )

  const isPdf = summary?.kind === "pdf"
  const { pdf } = usePdfDocument(documentId, isPdf)

  const pageNumbers = useMemo(
    () =>
      normalized?.documentId === documentId
        ? normalized.pageNumbers
        : Array.from({ length: summary?.pageCount ?? 0 }, (_, index) => index + 1),
    [documentId, normalized, summary?.pageCount]
  )
  const pageCount = pageNumbers.length

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
            {pageNumbers.map((pageNumber) => (
              <li key={pageNumber} className="relative">
                <SearchBadge
                  count={hitsByPage?.find((entry) => entry.page === pageNumber)?.count}
                />
                <RailThumbnail
                  documentId={documentId}
                  pageNumber={pageNumber}
                  redactions={byPage.get(pageNumber) ?? []}
                  selected={pageNumber === currentPage}
                  pdf={pdf}
                  onSelect={() => dispatch(pageChanged(pageNumber))}
                />
              </li>
            ))}
          </ul>
        </nav>
      </ScrollArea>
    </aside>
  )
}

/**
 * A thumbnail that fetches its page once it is nearly in view.
 *
 * The rail lists every page, and a rail that fetched every page would be the
 * whole model again by another route. A tile far down a long document asks
 * for its page when the reader scrolls towards it, and not before.
 */
function RailThumbnail(props: Omit<ComponentProps<typeof PageThumbnail>, "page">) {
  const anchor = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const element = anchor.current
    if (!element || near) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: "400px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])

  const page = useNormalizedPage(props.documentId, props.pageNumber, near)

  return (
    <div ref={anchor}>
      <PageThumbnail {...props} page={page ?? undefined} />
    </div>
  )
}

/** How many search hits a page holds, over its thumbnail. */
function SearchBadge({ count }: { count: number | undefined }) {
  if (!count) return null
  return (
    <span
      className="pointer-events-none absolute top-1.5 right-1.5 z-10 min-w-5 rounded-full bg-search-current px-1.5 py-px text-center text-[10px] font-semibold text-surface-3 tabular-nums shadow-sm"
    >
      {count > 99 ? "99+" : count}
      <span className="sr-only"> search {count === 1 ? "match" : "matches"}</span>
    </span>
  )
}
