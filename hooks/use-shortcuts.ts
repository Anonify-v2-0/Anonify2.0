"use client"

import { useEffect } from "react"

/**
 * Editor keyboard shortcuts. The bindings themselves are listed, for people,
 * in `lib/editor/shortcuts.ts`, which the `?` sheet renders.
 *
 * Nothing here fires while the user is typing in a field, and nothing
 * destructive is bound to a bare key — accept and reject act on the current
 * selection only, and undo is always one keystroke away. The search box
 * handles its own Enter, Shift+Enter and Esc.
 */

export type ShortcutHandlers = {
  onRedactTool: () => void
  /** `v`. Esc is `onEscape`, which decides for itself what it closes. */
  onSelectTool: () => void
  onEscape: () => void
  onAccept: () => void
  onReject: () => void
  onToggle: () => void
  onUndo: () => void
  onRedo: () => void
  onNextPage: () => void
  onPreviousPage: () => void
  onSearch: () => void
  onAssistant: () => void
  onShortcuts: () => void
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

/** The parts of a keydown event the router reads. */
export type ShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "metaKey"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "repeat"
  | "defaultPrevented"
  | "target"
  | "preventDefault"
>

/**
 * Sends one keydown to the handler it is bound to, if any. Kept apart from the
 * listener so the rules above can be tested without a browser.
 */
export function routeShortcut(event: ShortcutEvent, handlers: ShortcutHandlers): void {
  if (event.defaultPrevented || event.repeat) return
  if (isTypingTarget(event.target)) return

  const modifier = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()

  if (modifier && key === "z") {
    event.preventDefault()
    if (event.shiftKey) handlers.onRedo()
    else handlers.onUndo()
    return
  }

  // The browser's own find cannot see text drawn on a canvas, and a PDF
  // page is exactly that; on this screen it would report "0 results" for a
  // value sitting in plain sight. Search is the find that can read it.
  if (modifier && !event.altKey && key === "f") {
    event.preventDefault()
    handlers.onSearch()
    return
  }

  if (modifier && !event.altKey && key === "k") {
    event.preventDefault()
    handlers.onAssistant()
    return
  }

  if (modifier || event.altKey) return

  // `?` is Shift+/ on most layouts, so it is matched by the character typed
  // rather than by the key, and before `/`.
  if (event.key === "?") {
    event.preventDefault()
    handlers.onShortcuts()
    return
  }

  switch (key) {
    case "/":
      event.preventDefault()
      handlers.onSearch()
      break
    case "r":
      event.preventDefault()
      handlers.onRedactTool()
      break
    case "v":
      handlers.onSelectTool()
      break
    case "escape":
      handlers.onEscape()
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

export function useShortcuts(handlers: ShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      routeShortcut(event, handlers)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, handlers])
}
