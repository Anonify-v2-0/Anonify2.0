"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * On a phone a dialog is a sheet: full width, anchored to the bottom, within
 * thumb reach, with a handle that closes it on a swipe down. Everything else
 * (focus trap and restore, Esc, the backdrop) is Base UI's, and a swipe
 * closes through the same close button a tap would, so each dialog's
 * `onOpenChange` hears about it the usual way.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const drag = React.useRef<{ id: number; startY: number } | null>(null)
  const [offset, setOffset] = React.useState(0)

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          // A sheet below `sm`. Listed after the caller's classes would lose
          // to them, so the phone layout is written with max-sm: and wins by
          // specificity of intent: nothing else here targets max-sm.
          "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92svh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pt-7 max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-sm:data-open:slide-in-from-bottom-10 max-sm:data-open:zoom-in-100",
          className
        )}
        {...props}
      >
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 flex h-7 touch-none items-center justify-center sm:hidden"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { id: event.pointerId, startY: event.clientY }
          }}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId) return
            setOffset(Math.max(0, event.clientY - drag.current.startY))
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return
            const moved = event.clientY - drag.current.startY
            drag.current = null
            setOffset(0)
            if (moved > 80) closeRef.current?.click()
          }}
          onPointerCancel={() => {
            drag.current = null
            setOffset(0)
          }}
        >
          <span className="h-1 w-10 rounded-full bg-white/25" />
        </div>
        <DialogPrimitive.Close ref={closeRef} tabIndex={-1} aria-hidden className="hidden" />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-4 right-4 pointer-coarse:top-2 pointer-coarse:right-2 pointer-coarse:size-11"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading leading-none font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
