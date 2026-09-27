/**
 * Every keyboard binding in the review screen, in one list.
 *
 * This list is the only place a binding is written down. The shortcut sheet
 * (`?`) renders it, the tooltips read their hints from it, and docs/editor.md
 * points at the sheet rather than repeating it — three copies of a key map
 * drift apart, and the one a reviewer trusts is the one that is wrong.
 *
 * `hooks/use-shortcuts.ts` implements them. Its rule stands for every entry:
 * nothing fires while the reviewer is typing in a field, and nothing
 * destructive is bound to a bare key.
 */

export type ShortcutId =
  | "search"
  | "search-next"
  | "search-previous"
  | "search-close"
  | "assistant"
  | "shortcuts"
  | "redact-tool"
  | "select-tool"
  | "accept"
  | "reject"
  | "toggle"
  | "next-page"
  | "previous-page"
  | "undo"
  | "redo"

/** `Mod` is Ctrl, or ⌘ on a Mac. */
export type Key = "Mod" | "Shift" | string

export type Shortcut = {
  id: ShortcutId
  /** Alternative key combinations, any of which works. */
  keys: Key[][]
  label: string
  group: "Search and assistant" | "Reviewing" | "Moving around" | "History"
  /** Only while focus is in the search box. */
  inSearchBox?: boolean
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: "search",
    keys: [["Mod", "F"], ["/"]],
    label:
      "Search the whole document (replaces the browser's find, which cannot read the page)",
    group: "Search and assistant",
  },
  {
    id: "search-next",
    keys: [["Enter"]],
    label: "Next match",
    group: "Search and assistant",
    inSearchBox: true,
  },
  {
    id: "search-previous",
    keys: [["Shift", "Enter"]],
    label: "Previous match",
    group: "Search and assistant",
    inSearchBox: true,
  },
  {
    id: "search-close",
    keys: [["Esc"]],
    label: "Close search and clear the highlights",
    group: "Search and assistant",
  },
  {
    id: "assistant",
    keys: [["Mod", "K"]],
    label: "Open Hush, the review assistant",
    group: "Search and assistant",
  },
  {
    id: "shortcuts",
    keys: [["?"]],
    label: "Show this list",
    group: "Search and assistant",
  },
  {
    id: "redact-tool",
    keys: [["R"]],
    label: "Redact tool",
    group: "Reviewing",
  },
  {
    id: "select-tool",
    keys: [["V"], ["Esc"]],
    label: "Select tool",
    group: "Reviewing",
  },
  {
    id: "accept",
    keys: [["A"]],
    label: "Accept the selected suggestion",
    group: "Reviewing",
  },
  {
    id: "reject",
    keys: [["X"]],
    label: "Reject the selected suggestion",
    group: "Reviewing",
  },
  {
    id: "toggle",
    keys: [["Space"]],
    label: "Accept or reject the selected suggestion",
    group: "Reviewing",
  },
  {
    id: "next-page",
    keys: [["→"], ["Page Down"]],
    label: "Next page",
    group: "Moving around",
  },
  {
    id: "previous-page",
    keys: [["←"], ["Page Up"]],
    label: "Previous page",
    group: "Moving around",
  },
  { id: "undo", keys: [["Mod", "Z"]], label: "Undo", group: "History" },
  {
    id: "redo",
    keys: [["Mod", "Shift", "Z"]],
    label: "Redo",
    group: "History",
  },
]

export const SHORTCUT_GROUPS = [
  "Search and assistant",
  "Reviewing",
  "Moving around",
  "History",
] as const

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform
  return /mac|iphone|ipad/i.test(platform ?? "")
}

/** How one key reads on this platform. */
export function keyLabel(key: Key, apple = isApplePlatform()): string {
  if (key === "Mod") return apple ? "⌘" : "Ctrl"
  if (key === "Shift") return apple ? "⇧" : "Shift"
  return key
}

/** The first combination for a binding, as a tooltip hint: "Ctrl+F", "⌘F". */
export function shortcutHint(
  id: ShortcutId,
  apple = isApplePlatform()
): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id)
  if (!shortcut) return ""
  return shortcut.keys[0]
    .map((key) => keyLabel(key, apple))
    .join(apple ? "" : "+")
}
