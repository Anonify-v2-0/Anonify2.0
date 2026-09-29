"use client"

import { ListFilter } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import {
  InspectorTabs,
  type InspectorActions,
} from "@/components/redaction/redaction-inspector"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCounts } from "@/store/selectors"
import { mobileSheetToggled } from "@/store/uiSlice"

/**
 * The inspector on small screens.
 *
 * Rather than shrinking the three-column editor, the review list becomes a
 * bottom sheet over the canvas: the document stays the largest thing on screen,
 * and the suggestions are a thumb-reach away. At half height the page stays
 * visible above it, so picking a suggestion shows where it is.
 *
 * On a phone the action bar's Review button opens it. Between the phone
 * layout and the wide one (a narrow desktop window, say) there is no action
 * bar, so a floating button does, sitting above the toolbar.
 */
export function MobileInspector({
  actions,
  documentId,
}: {
  actions?: InspectorActions
  documentId: string
}) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.mobileSheetOpen)
  const counts = useAppSelector(selectCounts)

  return (
    <>
      {!open ? (
        <Button
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          onClick={() => dispatch(mobileSheetToggled(true))}
          className="fixed right-4 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 rounded-full shadow-panel compact:hidden xl:hidden"
        >
          <ListFilter className="size-4" />
          {counts.suggested > 0
            ? `${counts.suggested} to review`
            : `${counts.total} redactions`}
        </Button>
      ) : null}

      <Sheet
        open={open}
        onOpenChange={(next) => dispatch(mobileSheetToggled(next))}
        title="Review"
        snaps={["peek", "half", "full"]}
        initialSnap="half"
        className="xl:hidden"
      >
        <InspectorTabs actions={actions} documentId={documentId} idPrefix="sheet" />
      </Sheet>
    </>
  )
}
