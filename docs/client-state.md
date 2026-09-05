# Client state

`store/` and `hooks/`

The workspace is a React app backed by a Redux Toolkit store. The store holds
the document under review, the redactions decided on it, the editor's view of
it, the processing run's progress, and a handful of UI flags. The hooks are the
only things that dispatch into it or read from it, and they are where the
contract with the server actually lives: dispatch locally so the canvas responds
now, persist so the export agrees later.

This document covers what each slice owns, how undo/redo is built, and what
each hook is for. For the processing run that feeds `processingSlice`, see
[workflow.md](./workflow.md); for the layers the store reflects, see
[architecture.md](./architecture.md).

---

## 1. The store

`store/store.ts` wires five slices into one `configureStore`. The store is
created by `makeStore()` rather than at module scope, which matters for SSR:
`StoreProvider` calls it lazily inside `useState(makeStore)`, so the server
render and the client hydration never share a mutable singleton. One store per
browser session, created on first mount.

`store/hooks.ts` exports the typed bindings — `useAppDispatch`,
`useAppSelector`, `useAppStore` — via `useDispatch.withTypes<AppDispatch>()`
and its siblings. Components and hooks import these, never the bare
`react-redux` primitives.

### The five slices

| Slice | File | Owns | Notable actions |
| --- | --- | --- | --- |
| **document** | `documentSlice.ts` | The `DocumentSummary` and the `NormalizedDocument` model; `loading`, `error` | `documentLoaded`, `documentStatusChanged`, `documentFailureRecorded`, `normalizedLoaded`, `documentCleared` |
| **redactions** | `redactionSlice.ts` | The redaction entities + ids, global rules, selection, filters, and the undo/redo history | `redactionAdded`, `redactionStatusSet`, `undone`, `redone`, `ruleAdded`, `ruleRemoved` |
| **editor** | `editorSlice.ts` | The viewport: `currentPage`, `zoom`, `tool`, `activeSheet`, `fitMode`, `inspectorOpen`, the grid `selection` | `pageChanged`, `zoomChanged`, `toolChanged`, `cellSelected`, `inspectorToggled`, `editorReset` |
| **processing** | `processingSlice.ts` | The run's `status`, `progress`, the event log, `suggestionCount`, `error` | `statusChanged`, `eventReceived`, `suggestionCountChanged`, `processingFailed`, `processingReset` |
| **ui** | `uiSlice.ts` | Four boolean panels: `exportDialogOpen`, `shortcutsOpen`, `mobileSheetOpen`, `pagePanelOpen` | `exportDialogToggled`, `shortcutsToggled`, `mobileSheetToggled`, `pagePanelToggled` |

The editor and UI slices are plain state machines with no history. The document
slice mirrors what the server said and what the processing stream reported; it
does not own a copy of the redaction record. The redaction slice is the one
with a past, and the next section is about why.

---

## 2. Undo and redo

`store/redactionSlice.ts`

Undo is scoped to the redaction model and nothing else. Page turns, zoom
changes and tool switches are not undoable — they are view, not decision — so
`editorSlice` carries no history. A redaction change is a decision the reviewer
might want to take back, and that is the only thing the `past`/`future` stacks
remember.

### The snapshot

Only the **entities** and **ids** move between past and future. Everything else
— rules, selection, filters, the history stacks themselves — stays put:

```ts
type Snapshot = {
  entities: Record<string, Redaction>
  ids: string[]
}
```

### `current()` and the bug it fixes

```ts
function snapshot(state: RedactionState): Snapshot {
  const plain = current(state)
  return { entities: { ...plain.entities }, ids: [...plain.ids] }
}
```

The reducers run inside an Immer draft. Spreading the draft directly would
store **references into the draft**, and the very next mutation would edit the
snapshot in place — so an undo would restore the state it was supposed to
replace. `current()` materializes the draft into plain values first, and the
spread then copies them. The two-step is deliberate: `current()` alone returns
a frozen object, and the spread makes a mutable shallow copy the next reducer
can write into. This was a real bug, not a precaution.

### `remember` and the limit

Every mutating reducer calls `remember(state)` before it changes anything:

```ts
function remember(state: RedactionState): void {
  state.past.push(snapshot(state))
  if (state.past.length > HISTORY_LIMIT) state.past.shift()
  state.future = []
}
```

`HISTORY_LIMIT = 50` is deep enough to undo a burst of accepts without unbounded
growth. Any new edit clears `future`, which is the standard undo model: once you
branch, the redone branch is gone.

`undone` pops `past`, pushes the current state to `future`, and restores.
`redone` is the mirror. Both re-snapshot on the way out for the same reason
`remember` does.

### What is not undoable

- **`redactionsReplaced`** — a full reload from the server. It clears both
  stacks; the server's copy is the new baseline.
- **`suggestionsStreamed`** — merges streamed suggestions in without disturbing
  the user's history. A suggestion arriving is not a decision the user made.
- **`redactionSelected`, `filtersChanged`, `ruleAdded`, `ruleToggled`** —
  selection, filtering and rule registration are view/config, not edits.
- **`ruleRemoved`** *does* call `remember`, because deleting a rule also deletes
  the redactions it created, and that is a change the user would expect to undo.

---

## 3. Selectors

`store/selectors.ts`

All memoized with `createSelector`, so the canvas and the inspector can both
read them on every render without recomputing.

| Selector | Returns |
| --- | --- |
| `selectRedactions` | The redaction list, in id order, holes filtered. |
| `selectFilteredRedactions` | The list after the current status/source/category filters. |
| `selectRedactionsForPage(page)` | Redactions on a given page, excluding rejected. |
| `selectCounts` | `{ total, suggested, accepted, rejected }`. |
| `selectCategories` | Category → count, sorted by frequency. |
| `selectSelectedRedaction` | The entity behind `selectedId`, or null. |
| `selectCanUndo` / `selectCanRedo` | Whether the relevant stack is non-empty. |

### `selectOccurrenceGroups` — the core UX model

```ts
export const selectOccurrenceGroups = createSelector(
  [selectFilteredRedactions],
  (redactions) => { … }
)
```

Groups redactions by the **value they cover**, not by row. The key is
`${category}|${normalizeValue(text)}`, so seventeen suggestions over "John
Smith" become one group with seventeen members. This is the conceptual basis
for the reviewer's task: **one decision about John Smith, not seventeen.** The
inspector renders groups sorted by member count, so the most consequential
decision is at the top, and an accept or reject acts on every member at once
through `redactionStatusSet`.

`normalizeValue` (from `lib/documents/shared/text`) collapses case and
whitespace so the same name written differently still groups — the server's
rule search does the same thing, which is why a global rule and a manual
selection land in the same group.

---

## 4. The processing slice

`store/processingSlice.ts`

Mirrors the durable run described in [workflow.md](./workflow.md). The
`use-processing-stream` hook feeds it: every SSE event becomes an
`eventReceived` dispatch, and status transitions become `statusChanged`.

```ts
const MAX_EVENTS = 200
```

The event log is bounded because the inspector only ever renders its tail. When
the 201st event arrives the oldest is `shift()`ed off; the run's own stream is
the durable record, so capping the in-memory copy costs nothing but memory.
`statusChanged` also derives `progress` from the status via `statusProgress`,
and clears `error` on any non-failure transition so a recovered run does not
keep displaying its old failure message.

---

## 5. `StoreProvider` and lazy creation

`store/provider.tsx`

```tsx
export function StoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(makeStore)
  return <Provider store={store}>{children}</Provider>
}
```

`useState(makeStore)` passes the *function* itself, so `makeStore` runs once,
on first client render, and the result is cached. Creating the store at module
scope would share one instance across every request on the server — and, worse,
across the server render and the client hydration of the same document — which
is exactly the class of SSR state-leak Redux Toolkit's docs warn about. Lazy
creation inside the component keeps one store per browser session and none on
the server.

---

## 6. Hooks

The hooks are the only consumers of the store. They own the contract with the
API: dispatch for immediate feedback, fetch to persist, and reconcile on
failure.

### `use-redactions.ts`

The editor's connection to the redaction record. Every method follows the same
**optimistic-update-then-persist** contract:

1. **Dispatch immediately** so the canvas responds without waiting on the
   network.
2. **POST/PATCH/DELETE** to the API.
3. **On failure, undo and reload.** The export reads the server's copy, so the
   two must not disagree about what the user accepted.

For `setStatus` (which backs `accept` and `reject`), a failed PATCH calls
`undone()` to roll the local state back and then `reload()` to re-fetch the
server's truth:

```ts
if (!response.ok) {
  await toastFailure(toast, response, "That change could not be saved.")
  dispatch(undone())
  void reload()
}
```

`create` is slightly different: it dispatches an optimistic redaction with a
client-generated id, and on success **swaps** it for the server's row so later
edits address the right id. On failure it removes the optimistic row.

**`RuleScope`** — `export type RuleScope = "document" | "batch"`. A `document`
rule applies to the document on screen; a `batch` rule is recorded on the batch
itself and also applies to documents that finish processing after it was made.
`applyGlobalRule` posts the scope to the server, dispatches `ruleAdded` and
`redactionsAdded`, and toasts the reach — for a batch rule, the interesting
number is the one across *all* documents, not just the one on screen.

**`syncStatuses`** — after an undo or redo, the post-undo state has to be
pushed to the server. It reads from `store.getState().redactions` rather than
the render's snapshot, because the dispatch that just ran is exactly the change
being synced. It groups ids by their current status and PATCHes each group in
parallel. `undo` and `redo` both call it:

```ts
const undo = useCallback(() => {
  dispatch(undone())
  void syncStatuses()
}, [dispatch, syncStatuses])
```

### `use-pdf-document.ts`

One parsed PDF per document, shared by every component that renders it. The
page canvas and the thumbnail rail both need the same file; parsing it twice
would hold the whole document in memory twice for no benefit.

```ts
type Entry = {
  promise: Promise<PDFDocumentProxy>
  task: { destroy: () => Promise<void> }
  refs: number
}

const cache = new Map<string, Entry>()
```

The cache is a module-level `Map` with **reference counting**. `acquire` bumps
`refs` (or creates the entry on first request); `release` decrements, and only
when the last consumer unmounts is the proxy destroyed. This is the difference
between "destroyed when the first consumer leaves" (wrong — the second consumer
loses its document) and "destroyed when the last consumer leaves" (right). The
cleanup in the hook's `useEffect` calls `release`, so navigating away from the
workspace is what frees the memory.

### `use-batch-export.ts`

One batch export, watched from anywhere. The run is durable and lives on the
server (see [workflow.md](./workflow.md) §5), so this hook is a reader: it
starts a run, asks it to stop, and follows it while it works.

**SSE with fallback to polling.** The hook reads the record once, then follows
the run's event stream. Every event is a whole snapshot, so a missed frame is
corrected by the next. When the stream has given up — after `MAX_RECONNECTS`
failed attempts — it falls back to reading the row:

```ts
const RECONNECT_DELAY_MS = 1500
const MAX_RECONNECTS = 6
const FALLBACK_POLL_MS = 5000
```

`FALLBACK_POLL_MS = 5000` is deliberately slow: the stream is the fast path, and
the poll is just enough to stay honest on a connection that will not hold one
open, rather than leaving a stale count on screen. The stream tracks
`lastIndex` and resumes from `lastIndex + 1` on reconnect, the same resume
contract as the processing stream.

**The `generation` counter.** `start` and `cancel` each bump a `generation`
state value, and the watch `useEffect` depends on it. That bump is what
reconnects the watcher after the run's state has changed at our request —
without it, the effect would still be holding the old stream open (or waiting
to reconnect to a run that no longer exists) instead of re-reading and
re-watching the one that just started or stopped.

### `use-shortcuts.ts`

Editor keyboard shortcuts. Nothing fires while the user is typing in a field
(`isTypingTarget` checks `INPUT`, `TEXTAREA`, `SELECT`, and `contentEditable`),
and nothing destructive is bound to a bare key.

| Key | Action | Handler |
| --- | --- | --- |
| `r` | Switch to the redact tool | `onRedactTool` |
| `v` / `escape` | Switch to the select tool | `onSelectTool` |
| `a` | Accept the current selection | `onAccept` |
| `x` | Reject the current selection | `onReject` |
| `space` | Toggle the inspector | `onToggle` |
| `arrowright` / `pagedown` | Next page | `onNextPage` |
| `arrowleft` / `pageup` | Previous page | `onPreviousPage` |
| `cmd/ctrl+z` | Undo | `onUndo` |
| `cmd/ctrl+shift+z` | Redo | `onRedo` |

Undo and redo require the modifier and are checked before the bare-key fallthrough,
so `cmd/ctrl` plus any other key is ignored rather than colliding. `a` and `x`
call `preventDefault` so they do not trigger browser shortcuts; the page-nav
keys do not, so the browser's own scrolling still works.

### `use-normalized-document.ts`

Pulls the normalized model once there is one to pull. It is the shared source
of geometry and text for the canvas, the inspector, and every client-side rule
match.

This used to wait for `ready` — the terminal success status — which meant a
document whose analysis **failed after extraction** never loaded the model it
already had. The canvas sat on its "Preparing this document…" placeholder for a
run that had already ended. The fix is to load as soon as the document is
**reviewable** (`isReviewable(summary)`), not once it is fully `ready`: a
failed run that got through extraction still has a normalized model, and manual
redaction has to start from whatever is actually on the server.

### `use-retry-document.ts`

Sending a failed document back through the pipeline. The document list, the
processing screen, and the workspace banner all offer retry, and each used to
carry its own copy of the fetch, the toast, and the pending flag — three copies
of one behaviour is three places for it to drift, and it already had: only two
of the three reported what the server actually said.

This hook is the single implementation. It returns `{ retry, retryingId }`,
where `retry` posts to `/api/documents/:id/retry`, reads the failure reason
from the response when it can (a rate limit with a wait, a failure retrying
cannot fix), and falls back to a generic toast when there is no response to
read. The **caller** decides what to do on success, because that differs by
surface: the list patches one row, the workspace moves its own status so the
processing stream reconnects.

---

## 7. Why a store, and not server state alone

The redaction record is the server's to own — the export reads it, not the
client. But the reviewer's experience of it is local: an accept is immediate,
an undo is one keystroke, and a filtered view recomputes on every render. The
store is the workspace's working memory of the server's record, and the hooks
are what keep the two from drifting: every local change is a promise to
persist, and every failed promise is an undo and a reload.
