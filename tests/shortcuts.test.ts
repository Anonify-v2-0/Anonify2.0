import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { routeShortcut, type ShortcutEvent, type ShortcutHandlers } from "@/hooks/use-shortcuts"
import { SHORTCUTS, shortcutHint, type ShortcutId } from "@/lib/editor/shortcuts"

/**
 * The review screen's keyboard. Two rules hold for every binding: nothing
 * fires while the reviewer is typing in a field, and nothing destructive is
 * bound to a bare key. And the shortcut sheet is the one list of them, so
 * every binding the router knows has to be on it.
 */

// The router asks whether the target is a field; the suite has no DOM.
class FakeElement {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false
  ) {}
}

beforeAll(() => {
  vi.stubGlobal("HTMLElement", FakeElement)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

function handlers(): ShortcutHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onRedactTool: vi.fn(),
    onSelectTool: vi.fn(),
    onEscape: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onToggle: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onNextPage: vi.fn(),
    onPreviousPage: vi.fn(),
    onSearch: vi.fn(),
    onAssistant: vi.fn(),
    onShortcuts: vi.fn(),
  }
}

function press(
  key: string,
  options: Partial<Omit<ShortcutEvent, "key" | "preventDefault">> = {}
): ShortcutEvent & { prevented: boolean } {
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    prevented: false,
    ...options,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

describe("the search and assistant bindings", () => {
  it("opens search on Ctrl+F, ⌘F and /, taking Ctrl+F from the browser", () => {
    for (const event of [press("f", { ctrlKey: true }), press("F", { metaKey: true }), press("/")]) {
      const bound = handlers()
      routeShortcut(event, bound)
      expect(bound.onSearch).toHaveBeenCalledOnce()
      expect(event.prevented).toBe(true)
    }
  })

  it("opens Hush on Ctrl+K and ⌘K", () => {
    for (const event of [press("k", { ctrlKey: true }), press("k", { metaKey: true })]) {
      const bound = handlers()
      routeShortcut(event, bound)
      expect(bound.onAssistant).toHaveBeenCalledOnce()
    }
  })

  it("opens the shortcut sheet on ?, which is Shift+/ on most layouts", () => {
    const bound = handlers()
    routeShortcut(press("?", { shiftKey: true }), bound)
    expect(bound.onShortcuts).toHaveBeenCalledOnce()
    expect(bound.onSearch).not.toHaveBeenCalled()
  })

  it("sends Esc to the handler that decides what it closes", () => {
    const bound = handlers()
    routeShortcut(press("Escape"), bound)
    expect(bound.onEscape).toHaveBeenCalledOnce()
    expect(bound.onSelectTool).not.toHaveBeenCalled()
  })
})

describe("the rules every binding keeps", () => {
  it("fires nothing while the reviewer is typing in a field", () => {
    for (const target of [
      new FakeElement("INPUT"),
      new FakeElement("TEXTAREA"),
      new FakeElement("SELECT"),
      new FakeElement("DIV", true),
    ]) {
      for (const event of [
        press("f", { ctrlKey: true, target: target as unknown as EventTarget }),
        press("k", { ctrlKey: true, target: target as unknown as EventTarget }),
        press("/", { target: target as unknown as EventTarget }),
        press("?", { target: target as unknown as EventTarget }),
        press("a", { target: target as unknown as EventTarget }),
      ]) {
        const bound = handlers()
        routeShortcut(event, bound)
        for (const handler of Object.values(bound)) expect(handler).not.toHaveBeenCalled()
        expect(event.prevented).toBe(false)
      }
    }
  })

  it("ignores a held key and an event something else already handled", () => {
    const bound = handlers()
    routeShortcut(press("a", { repeat: true }), bound)
    routeShortcut(press("a", { defaultPrevented: true }), bound)
    expect(bound.onAccept).not.toHaveBeenCalled()
  })

  it("does not treat Ctrl+A or Ctrl+X as accept or reject", () => {
    const bound = handlers()
    routeShortcut(press("a", { ctrlKey: true }), bound)
    routeShortcut(press("x", { metaKey: true }), bound)
    expect(bound.onAccept).not.toHaveBeenCalled()
    expect(bound.onReject).not.toHaveBeenCalled()
  })
})

describe("the shortcut sheet", () => {
  it("lists every binding the router knows, once", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id)
    expect(new Set(ids).size).toBe(ids.length)
    const expected: ShortcutId[] = [
      "search",
      "search-next",
      "search-previous",
      "search-close",
      "assistant",
      "shortcuts",
      "redact-tool",
      "select-tool",
      "accept",
      "reject",
      "toggle",
      "next-page",
      "previous-page",
      "undo",
      "redo",
    ]
    expect([...ids].sort()).toEqual([...expected].sort())
  })

  it("writes tooltip hints for the platform", () => {
    expect(shortcutHint("search", false)).toBe("Ctrl+F")
    expect(shortcutHint("search", true)).toBe("⌘F")
    expect(shortcutHint("redo", false)).toBe("Ctrl+Shift+Z")
    expect(shortcutHint("assistant", true)).toBe("⌘K")
  })
})
