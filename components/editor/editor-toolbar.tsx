"use client"

import {
  Maximize2,
  MousePointer2,
  Redo2,
  SquareDashed,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  fitModeChanged,
  toolChanged,
  zoomStepped,
  type EditorTool,
} from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { cn } from "@/lib/utils"

const TOOLS: { tool: EditorTool; label: string; icon: typeof MousePointer2 }[] = [
  { tool: "select", label: "Select", icon: MousePointer2 },
  { tool: "redact", label: "Redact (R)", icon: SquareDashed },
]

export function EditorToolbar() {
  const dispatch = useAppDispatch()
  const { tool, zoom } = useAppSelector((state) => state.editor)

  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-border bg-surface-2 px-3">
      <div className="flex items-center gap-1">
        {TOOLS.map(({ tool: value, label, icon: Icon }) => (
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
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch(zoomStepped(-0.1))}
        >
          <ZoomOut className="size-4" />
          <span className="sr-only">Zoom out</span>
        </Button>
        <span className="w-12 text-center text-xs text-text-muted tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch(zoomStepped(0.1))}
        >
          <ZoomIn className="size-4" />
          <span className="sr-only">Zoom in</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => dispatch(fitModeChanged("page"))}
        >
          <Maximize2 className="size-4" />
          <span className="sr-only">Fit page</span>
        </Button>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" disabled>
          <Undo2 className="size-4" />
          <span className="sr-only">Undo</span>
        </Button>
        <Button variant="ghost" size="icon-sm" disabled>
          <Redo2 className="size-4" />
          <span className="sr-only">Redo</span>
        </Button>
      </div>
    </div>
  )
}
