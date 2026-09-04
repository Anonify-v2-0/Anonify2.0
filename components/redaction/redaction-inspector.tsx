"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppSelector } from "@/store/hooks"

export function RedactionInspector() {
  const count = useAppSelector((state) => state.redactions.ids.length)

  return (
    <aside className="hidden w-[300px] shrink-0 flex-col border-l border-border bg-surface-2 xl:flex">
      <div className="flex items-baseline justify-between px-4 py-3">
        <p className="label-micro">Redactions</p>
        <span className="text-xs text-text-muted">{count} found</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 pb-4">
          {count === 0 ? (
            <p className="text-xs leading-relaxed text-text-muted">
              No suggestions yet. Detection results appear here as the analysis
              stage produces them.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}
