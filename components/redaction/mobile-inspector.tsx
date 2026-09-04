"use client"

import { ChevronDown, ListFilter } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  InspectorBody,
  type InspectorActions,
} from "@/components/redaction/redaction-inspector"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCounts } from "@/store/selectors"
import { mobileSheetToggled } from "@/store/uiSlice"
import { cn } from "@/lib/utils"

/**
 * The inspector on small screens.
 *
 * Rather than shrinking the three-column editor, the review list becomes a
 * bottom sheet over the canvas: the document stays the largest thing on screen,
 * and the suggestions are a thumb-reach away.
 */
export function MobileInspector({ actions }: { actions?: InspectorActions }) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.mobileSheetOpen)
  const counts = useAppSelector(selectCounts)

  return (
    <>
      {!open ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => dispatch(mobileSheetToggled(true))}
          className="fixed right-4 bottom-16 z-30 rounded-full shadow-panel xl:hidden"
        >
          <ListFilter className="size-4" />
          {counts.suggested > 0
            ? `${counts.suggested} to review`
            : `${counts.total} redactions`}
        </Button>
      ) : null}

      <div
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex max-h-[70svh] flex-col rounded-t-[10px] border-t border-border bg-surface-2 shadow-panel transition-transform duration-200 xl:hidden",
          open ? "translate-y-0" : "pointer-events-none translate-y-full"
        )}
      >
        <button
          type="button"
          onClick={() => dispatch(mobileSheetToggled(false))}
          className="flex items-center justify-center gap-1 py-2 text-xs text-text-muted"
        >
          <ChevronDown className="size-4" />
          Hide
        </button>

        <div className="flex min-h-0 flex-1 flex-col">
          <InspectorBody actions={actions} />
        </div>
      </div>
    </>
  )
}
