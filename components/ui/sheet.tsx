"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { X } from "lucide-react"

import {
  SNAP_FRACTIONS,
  settleSheet,
  stepSheet,
  type SheetSnap,
} from "@/lib/editor/sheet"
import { cn } from "@/lib/utils"

/**
 * The one bottom sheet.
 *
 * Every panel that becomes a sheet on a phone — the inspector, the pages,
 * the search results, Hush, the "More" menu — is this component, so they
 * share one set of behaviours rather than five hand-rolled ones:
 *
 *   - a drag handle, with snap points (peek, half, full) and swipe down to
 *     dismiss. The handle is a real button: Arrow Up and Down move between
 *     snap points, Enter cycles them, and Escape closes the sheet.
 *   - focus moves into the sheet when it opens, is trapped while it is open,
 *     and returns to whatever opened it when it closes.
 *   - closed, it is `inert`, not just `aria-hidden`: nothing inside it can be
 *     reached by Tab or by a screen reader's virtual cursor.
 *   - it is a labelled dialog, so opening it is announced.
 *
 * `modal` adds a backdrop that closes the sheet when tapped. A non-modal
 * sheet leaves the document visible and usable above it, which is what Hush
 * needs at half height: a reply's "show me" chip moves the page behind it.
 */

type SheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The accessible name; also shown as the header unless `header` is set. */
  title: string
  /** Replaces the default title row; the sheet is still named by `title`. */
  header?: ReactNode
  snaps?: SheetSnap[]
  /** Where the sheet opens. Defaults to the first snap point. */
  initialSnap?: SheetSnap
  /** Controlled snap point, for a parent that needs to move the sheet. */
  snap?: SheetSnap
  onSnapChange?: (snap: SheetSnap) => void
  modal?: boolean
  className?: string
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[inert]") && element.offsetParent !== null
  )
}

export function Sheet({
  open,
  onOpenChange,
  title,
  header,
  snaps = ["half", "full"],
  initialSnap,
  snap: controlledSnap,
  onSnapChange,
  modal = false,
  className,
  children,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [ownSnap, setOwnSnap] = useState<SheetSnap>(initialSnap ?? snaps[0])
  const snap = controlledSnap && snaps.includes(controlledSnap) ? controlledSnap : ownSnap
  const snapIndex = Math.max(0, snaps.indexOf(snap))
  const titleId = useId()

  /** The drag in progress: where it started and how far it has come. */
  const drag = useRef<{
    pointerId: number
    startY: number
    lastY: number
    lastTime: number
    velocity: number
  } | null>(null)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  /** A drag ends in a click on the handle; that click is not a tap. */
  const suppressClickUntil = useRef(0)

  const changeSnap = useCallback(
    (next: SheetSnap) => {
      setOwnSnap(next)
      onSnapChange?.(next)
    },
    [onSnapChange]
  )

  // Each opening starts from the snap point it was asked to open at.
  const [openedFor, setOpenedFor] = useState(open)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) {
      setOwnSnap(initialSnap ?? snaps[0])
      setOffset(0)
    }
  }

  // Focus in on open, back out on close.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (open) {
      const active = document.activeElement
      returnFocus.current =
        active instanceof HTMLElement && !panel.contains(active) ? active : null
      const target =
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        focusables(panel).find((element) => !element.dataset.sheetHandle) ??
        panel
      target.focus({ preventScroll: true })
    } else if (panel.contains(document.activeElement)) {
      const back = returnFocus.current
      if (back && back.isConnected && back.offsetParent !== null) {
        back.focus({ preventScroll: true })
      } else {
        ;(document.activeElement as HTMLElement | null)?.blur()
      }
      returnFocus.current = null
    }
  }, [open])

  // A viewport change moves every snap point; recompute on resize.
  const [viewport, setViewport] = useState(0)
  useEffect(() => {
    const measure = () => setViewport(window.innerHeight)
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])
  const heights = snaps.map((name) => SNAP_FRACTIONS[name] * viewport)

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  const settle = (height: number, velocity: number) => {
    const result = settleSheet({ heights, from: snapIndex, height, velocity })
    setOffset(0)
    if (result.close) close()
    else changeSnap(snaps[result.snap])
  }

  return (
    <>
      {modal && open ? (
        <div
          aria-hidden
          onClick={close}
          className="fixed inset-0 z-40 bg-black/50 motion-safe:animate-in motion-safe:fade-in-0"
        />
      ) : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        aria-hidden={!open || undefined}
        inert={!open}
        tabIndex={-1}
        data-state={open ? "open" : "closed"}
        data-snap={snap}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            event.preventDefault()
            close()
            return
          }
          if (event.key !== "Tab") return
          const panel = panelRef.current
          if (!panel) return
          const items = focusables(panel)
          if (items.length === 0) {
            event.preventDefault()
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        style={{
          height: `calc(${SNAP_FRACTIONS[snap] * 100}svh - ${offset}px)`,
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[14px] border-t border-border bg-surface-2 pb-[env(safe-area-inset-bottom)] shadow-panel outline-none",
          "pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
          dragging ? "" : "motion-safe:transition-[transform,height] motion-safe:duration-200 motion-safe:ease-out",
          open ? "translate-y-0" : "pointer-events-none translate-y-full",
          className
        )}
      >
        <div
          className="flex shrink-0 touch-none flex-col"
          onPointerDown={(event) => {
            // Buttons in the header act; everywhere else in it drags.
            if ((event.target as HTMLElement).closest("button:not([data-sheet-handle])")) return
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              lastY: event.clientY,
              lastTime: event.timeStamp,
              velocity: 0,
            }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            const elapsed = Math.max(1, event.timeStamp - current.lastTime)
            current.velocity = (event.clientY - current.lastY) / elapsed
            current.lastY = event.clientY
            current.lastTime = event.timeStamp
            // Upwards past the tallest snap point is resisted, not followed.
            const moved = event.clientY - current.startY
            setOffset(moved < 0 ? Math.max(moved, -(viewport - heights[heights.length - 1])) : moved)
          }}
          onPointerUp={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            drag.current = null
            setDragging(false)
            const moved = event.clientY - current.startY
            if (Math.abs(moved) < 4) {
              setOffset(0)
              return
            }
            suppressClickUntil.current = event.timeStamp + 400
            settle(heights[snapIndex] - moved, current.velocity)
          }}
          onPointerCancel={() => {
            drag.current = null
            setDragging(false)
            setOffset(0)
          }}
          onLostPointerCapture={() => {
            if (!drag.current) return
            drag.current = null
            setDragging(false)
            setOffset(0)
          }}
        >
          <button
            type="button"
            data-sheet-handle="true"
            aria-label={`Resize ${title}. Arrow up to expand, arrow down to shrink or close.`}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
              event.preventDefault()
              event.stopPropagation()
              const result = stepSheet(snaps.length, snapIndex, event.key === "ArrowUp" ? "up" : "down")
              if (result.close) close()
              else changeSnap(snaps[result.snap])
            }}
            onClick={(event) => {
              if (event.timeStamp < suppressClickUntil.current) return
              changeSnap(snaps[(snapIndex + 1) % snaps.length])
            }}
            className="flex h-6 w-full items-center justify-center rounded-t-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span aria-hidden className="h-1 w-10 rounded-full bg-white/25" />
          </button>
          {header ?? (
            <div className="flex min-h-11 items-center gap-2 border-b border-border px-4 pb-1">
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                {title}
              </h2>
              <button
                type="button"
                onClick={close}
                className="-mr-2 flex size-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-4" />
                <span className="sr-only">Close {title}</span>
              </button>
            </div>
          )}
          {header ? (
            <span id={titleId} className="sr-only">
              {title}
            </span>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{open ? children : null}</div>
      </div>
    </>
  )
}
