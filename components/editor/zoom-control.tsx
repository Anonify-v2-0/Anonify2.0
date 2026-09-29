"use client"

import { Maximize2, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  fitModeChanged,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomChanged,
  zoomStepped,
} from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"

/**
 * Zoom: out, a slider, in, and the two fits.
 *
 * The slider runs on a log scale, so 100% sits in the middle of the track and
 * a drag from 25% to 50% takes as much travel as one from 200% to 400% — on a
 * linear track everything below 100% was crammed into the first sliver. It is
 * a native range input, so arrows, Page Up/Down and Home/End work on it and a
 * screen reader announces the percentage.
 */

const LOG_MIN = Math.log2(MIN_ZOOM)
const LOG_MAX = Math.log2(MAX_ZOOM)
const STEPS = 200

function toPosition(zoom: number): number {
  return Math.round(((Math.log2(zoom) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * STEPS)
}

function fromPosition(position: number): number {
  const zoom = 2 ** (LOG_MIN + (position / STEPS) * (LOG_MAX - LOG_MIN))
  // Snap to 100% when close, so it can be found again by dragging.
  return Math.abs(zoom - 1) < 0.03 ? 1 : Number(zoom.toFixed(3))
}

function Hinted({
  hint,
  children,
}: {
  hint: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

export function ZoomControl() {
  const dispatch = useAppDispatch()
  const { zoom, fitMode } = useAppSelector((state) => state.editor)
  const percent = Math.round(zoom * 100)
  const position = toPosition(zoom)

  return (
    <div className="flex items-center gap-1">
      <Hinted hint="Zoom out">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => dispatch(zoomStepped(-0.1))}
        >
          <ZoomOut className="size-4" />
          <span className="sr-only">Zoom out</span>
        </Button>
      </Hinted>

      <input
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={position}
        aria-label="Zoom"
        aria-valuetext={`${percent}%`}
        onChange={(event) =>
          dispatch(zoomChanged(fromPosition(Number(event.target.value))))
        }
        // The track's middle is 100%; a tick marks it.
        style={{ ["--zoom-fill" as string]: `${(position / STEPS) * 100}%` }}
        className={cn(
          "hidden h-4 w-28 cursor-pointer appearance-none bg-transparent sm:block pointer-coarse:h-11",
          "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full",
          "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-primary)_var(--zoom-fill),rgba(255,255,255,0.14)_var(--zoom-fill))]",
          "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow",
          "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/14",
          "[&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-primary",
          "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-white",
          "focus-visible:outline-none [&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-ring"
        )}
      />

      <Hinted hint="Zoom in">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => dispatch(zoomStepped(0.1))}
        >
          <ZoomIn className="size-4" />
          <span className="sr-only">Zoom in</span>
        </Button>
      </Hinted>

      <Hinted hint="Actual size (100%)">
        <button
          type="button"
          onClick={() => dispatch(zoomChanged(1))}
          className="w-11 rounded px-1 text-center text-xs text-text-muted tabular-nums transition-colors hover:bg-white/5 hover:text-white pointer-coarse:h-11"
        >
          {percent}%<span className="sr-only">, reset to 100%</span>
        </button>
      </Hinted>

      <Hinted hint="Fit width">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={fitMode === "width"}
          onClick={() => dispatch(fitModeChanged("width"))}
          className={cn(fitMode === "width" && "bg-white/10 text-white")}
        >
          <MoveHorizontal className="size-4" />
          <span className="sr-only">Fit width</span>
        </Button>
      </Hinted>
      <Hinted hint="Fit page">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={fitMode === "page"}
          onClick={() => dispatch(fitModeChanged("page"))}
          className={cn(fitMode === "page" && "bg-white/10 text-white")}
        >
          <Maximize2 className="size-4" />
          <span className="sr-only">Fit page</span>
        </Button>
      </Hinted>
    </div>
  )
}
