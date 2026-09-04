"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { pageChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { cn } from "@/lib/utils"

export function PageNavigator() {
  const dispatch = useAppDispatch()
  const currentPage = useAppSelector((state) => state.editor.currentPage)
  const pageCount = useAppSelector(
    (state) => state.document.summary?.pageCount ?? 0
  )

  return (
    <aside className="hidden w-[168px] shrink-0 flex-col border-r border-border bg-surface-2 lg:flex">
      <p className="label-micro px-4 py-3">Pages</p>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 px-4 pb-4">
          {pageCount === 0 ? (
            <p className="text-xs text-text-muted">No pages yet</p>
          ) : (
            Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (page) => (
                <button
                  key={page}
                  type="button"
                  onClick={() => dispatch(pageChanged(page))}
                  className="flex flex-col items-center gap-1.5"
                >
                  <span
                    className={cn(
                      "aspect-[1/1.294] w-full rounded-[3px] border bg-document transition-colors",
                      page === currentPage
                        ? "border-primary"
                        : "border-border hover:border-border-strong"
                    )}
                  />
                  <span
                    className={cn(
                      "text-[11px]",
                      page === currentPage ? "text-white" : "text-text-muted"
                    )}
                  >
                    {page}
                  </span>
                </button>
              )
            )
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
