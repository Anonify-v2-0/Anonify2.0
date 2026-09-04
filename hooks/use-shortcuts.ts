"use client"

import { useEffect } from "react"

/**
 * Editor keyboard shortcuts.
 *
 * Nothing here fires while the user is typing in a field, and nothing
 * destructive is bound to a bare key — accept and reject act on the current
 * selection only, and undo is always one keystroke away.
 */

export type ShortcutHandlers = {
  onRedactTool: () => void
  onSelectTool: () => void
  onAccept: () => void
  onReject: () => void
  onToggle: () => void
  onUndo: () => void
  onRedo: () => void
  onNextPage: () => void
  onPreviousPage: () => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

export function useShortcuts(handlers: ShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return
      if (isTypingTarget(event.target)) return

      const modifier = event.metaKey || event.ctrlKey

      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault()
        if (event.shiftKey) handlers.onRedo()
        else handlers.onUndo()
        return
      }

      if (modifier) return

      switch (event.key.toLowerCase()) {
        case "r":
          event.preventDefault()
          handlers.onRedactTool()
          break
        case "v":
        case "escape":
          handlers.onSelectTool()
          break
        case "a":
          event.preventDefault()
          handlers.onAccept()
          break
        case "x":
          event.preventDefault()
          handlers.onReject()
          break
        case " ":
          event.preventDefault()
          handlers.onToggle()
          break
        case "arrowright":
        case "pagedown":
          handlers.onNextPage()
          break
        case "arrowleft":
        case "pageup":
          handlers.onPreviousPage()
          break
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, handlers])
}
