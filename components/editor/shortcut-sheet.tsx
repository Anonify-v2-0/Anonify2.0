"use client"

import { Fragment, useSyncExternalStore } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  isApplePlatform,
  keyLabel,
  SHORTCUT_GROUPS,
  SHORTCUTS,
} from "@/lib/editor/shortcuts"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { shortcutsToggled } from "@/store/uiSlice"

const subscribe = () => () => undefined

/**
 * The shortcut sheet, on `?`.
 *
 * Rendered from `SHORTCUTS`, which is the only list of bindings there is: the
 * tooltips read their hints from the same list and docs/editor.md points
 * here, so there is no second copy to fall out of date.
 */
export function ShortcutSheet() {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.shortcutsOpen)
  // The platform is only known in the browser; the server renders Ctrl.
  const apple = useSyncExternalStore(subscribe, isApplePlatform, () => false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => dispatch(shortcutsToggled(next))}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            None of these fire while you are typing in a field, and no single
            key changes the document without a selection. Undo is always one
            keystroke away.
          </DialogDescription>
        </DialogHeader>

        {SHORTCUT_GROUPS.map((group) => (
          <section key={group} aria-labelledby={`shortcuts-${group}`}>
            <h3 id={`shortcuts-${group}`} className="label-micro pb-2">
              {group}
            </h3>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              {SHORTCUTS.filter((shortcut) => shortcut.group === group).map(
                (shortcut) => (
                  <Fragment key={shortcut.id}>
                    <dt className="text-text-secondary">
                      {shortcut.label}
                      {shortcut.inSearchBox ? (
                        <span className="text-text-muted">
                          {" "}
                          (in the search box)
                        </span>
                      ) : null}
                    </dt>
                    <dd className="flex flex-wrap items-center justify-end gap-1.5">
                      {shortcut.keys.map((combination, index) => (
                        <Fragment key={index}>
                          {index > 0 ? (
                            <span className="text-xs text-text-muted">or</span>
                          ) : null}
                          <span className="flex items-center gap-0.5">
                            {combination.map((key) => (
                              <kbd
                                key={key}
                                className="min-w-6 rounded border border-border-strong bg-surface-3 px-1.5 py-0.5 text-center font-mono text-[11px] text-white"
                              >
                                {keyLabel(key, apple)}
                              </kbd>
                            ))}
                          </span>
                        </Fragment>
                      ))}
                    </dd>
                  </Fragment>
                )
              )}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
