"use client"

import {
  Keyboard,
  MousePointer2,
  Redo2,
  Search,
  Sparkles,
  SquareDashed,
  Undo2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ZoomControl } from "@/components/editor/zoom-control"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLearnedShapes } from "@/hooks/use-learned-shapes"
import { shortcutHint, type ShortcutId } from "@/lib/editor/shortcuts"
import { searchOpened } from "@/store/searchSlice"
import { assistantToggled, shortcutsToggled } from "@/store/uiSlice"
import { toolChanged, type EditorTool } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCanRedo, selectCanUndo } from "@/store/selectors"
import { cn } from "@/lib/utils"

const TOOLS: {
  tool: EditorTool
  label: string
  shortcut: ShortcutId
  icon: typeof MousePointer2
}[] = [
  { tool: "select", label: "Select", shortcut: "select-tool", icon: MousePointer2 },
  { tool: "redact", label: "Redact", shortcut: "redact-tool", icon: SquareDashed },
]

export function EditorToolbar({
  onUndo,
  onRedo,
}: {
  onUndo: () => void
  onRedo: () => void
  onExport?: () => void
}) {
  const dispatch = useAppDispatch()
  const tool = useAppSelector((state) => state.editor.tool)
  const canUndo = useAppSelector(selectCanUndo)
  const canRedo = useAppSelector(selectCanRedo)
  const searchOpen = useAppSelector((state) => state.search.open)
  const hushOpen = useAppSelector((state) => state.ui.assistant !== null)
  const learned = useLearnedShapes().length

  return (
    // The desktop toolbar. On a phone the action bar replaces it (see
    // mobile-action-bar.tsx); on a touch tablet in landscape it stays, with
    // every target grown to 44 px.
    <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-t border-border bg-surface-2 px-3 pb-[env(safe-area-inset-bottom)] compact:hidden">
      <div className="flex items-center gap-1">
        {TOOLS.map(({ tool: value, label, shortcut, icon: Icon }) => (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={tool === value}
                  onClick={() => dispatch(toolChanged(value))}
                  className={cn(
                    tool === value && "bg-red-soft text-primary"
                  )}
                >
                  <Icon className="size-4" />
                  <span className="sr-only">{label}</span>
                </Button>
              }
            />
            <TooltipContent>
              {label} ({shortcutHint(shortcut)})
            </TooltipContent>
          </Tooltip>
        ))}

        <span aria-hidden className="mx-1 h-5 w-px bg-border" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={searchOpen}
                onClick={() => dispatch(searchOpened())}
                className={cn(searchOpen && "bg-red-soft text-primary")}
              >
                <Search className="size-4" />
                <span className="sr-only">Search</span>
              </Button>
            }
          />
          <TooltipContent>Search the whole document ({shortcutHint("search")})</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={hushOpen}
                onClick={() => dispatch(assistantToggled())}
                className={cn("relative", hushOpen && "bg-red-soft text-primary")}
              >
                <Sparkles className="size-4" />
                <span className="sr-only">
                  Hush, the review assistant
                  {learned > 0 ? `, ${learned} rule ${learned === 1 ? "idea" : "ideas"}` : ""}
                </span>
                {learned > 0 ? (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </Button>
            }
          />
          <TooltipContent>Hush, the review assistant ({shortcutHint("assistant")})</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => dispatch(shortcutsToggled(true))}
                className="hidden sm:inline-flex pointer-coarse:hidden"
              >
                <Keyboard className="size-4" />
                <span className="sr-only">Keyboard shortcuts</span>
              </Button>
            }
          />
          <TooltipContent>Keyboard shortcuts ({shortcutHint("shortcuts")})</TooltipContent>
        </Tooltip>
      </div>

      <ZoomControl />

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canUndo}
                onClick={onUndo}
              >
                <Undo2 className="size-4" />
                <span className="sr-only">Undo</span>
              </Button>
            }
          />
          <TooltipContent>Undo ({shortcutHint("undo")})</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canRedo}
                onClick={onRedo}
              >
                <Redo2 className="size-4" />
                <span className="sr-only">Redo</span>
              </Button>
            }
          />
          <TooltipContent>Redo ({shortcutHint("redo")})</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
