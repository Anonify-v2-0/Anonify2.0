# The editor UI

`components/`

The editor is where a document becomes a set of decisions. This document walks
the component tree from the top — the workspace that wires everything together —
down through the canvas, the redaction layer, the inspector, the export dialog,
and the surrounding pages that get the reviewer in and out.

It is a walkthrough of *components*, not of the pipeline that feeds them. For
how a document reaches the editor in the first place, see
[workflow.md](./workflow.md); for the detection logic behind the suggestions the
inspector lists, see [ai-engine.md](./ai-engine.md).

---

## 1. The component tree

```
Providers                         ThemeProvider (forced dark), StoreProvider,
                                  TooltipProvider, Toaster

Workspace                         the orchestrator
 ├── WorkspaceHeader              filename, batch nav, retention, export
 ├── PageNavigator                thumbnail rail (PDF pages)
 ├── DocumentCanvas               format-dispatching surface
 │    ├── PdfViewer               rendered PDF page
 │    │    └── RedactionLayer     boxes, spans, drag regions
 │    ├── DocxViewer              paginated runs  ── renderSpan
 │    ├── TextViewer              txt / rtf / eml / pptx  ── renderSpan
 │    ├── ImageCanvas             pixels + OCR words + regions
 │    └── SpreadsheetGrid         sheets, rows, columns, cells
 ├── RedactionInspector           grouped suggestions, accept/reject, rules
 ├── MobileInspector              same body, as a bottom sheet
 ├── EditorToolbar                tools, zoom, undo/redo
 ├── ExportDialog                 style, metadata, report, download
 └── LiveAnnouncer                sr-only live region
```

Everything below `Workspace` reads its state from the Redux store rather than
from props drilled through the tree. `Workspace` owns the *shape* — what is on
screen and in what order — and delegates the *content* to selectors and hooks.

---

## 2. `Providers` — the root

`components/providers.tsx`

Composes four providers in a fixed order:

| Provider | Role |
| --- | --- |
| `ThemeProvider` | `next-themes`, **forced dark** |
| `StoreProvider` | Redux Toolkit store |
| `TooltipProvider` | Base UI tooltip context |
| `Toaster` | sonner, bottom-right |

### The forced-dark decision

Anonify is a dark-only workspace. `ThemeProvider` sets `forcedTheme="dark"` and
`enableSystem={false}` (`components/theme-provider.tsx`), so the OS preference
is never read and the user cannot override it. The reason is visual: the
application chrome stays charcoal so the white document surface — the one thing
on screen that matters — remains the strongest element. A light chrome would
compete with the document and wash out the redaction overlays, which are black
on purpose: they show what the export will actually produce.

---

## 3. `Workspace` — the orchestrator

`components/editor/workspace.tsx`

`Workspace` receives a server-rendered `DocumentSummary` and decides what to
show: the editor, or the processing screen. It does not render document content
itself — it composes the components that do and wires them to the store.

### What it owns

- **Status routing.** A document is only worth opening in the editor if
  extraction left a normalized model behind. `isReviewable(current)` is the
  gate: a document still processing shows `ProcessingScreen`; a document that
  failed *before* extraction shows the failure screen; a document that failed
  *after* extraction opens the editor with a `FailureNotice` banner, because
  manual redaction is still real and an empty suggestion list must never read as
  "nothing to redact."
- **Stream subscription.** `useProcessingStream(summary.id, summary.status)`
  connects to the SSE channel and pushes status events into the store. The hook
  only subscribes while a document is still working, so a ready document costs
  nothing.
- **Refresh on terminal status.** The server component holds page count,
  checksum, and whether a normalized model exists. When the stream reports
  `ready` or `failed`, `Workspace` calls `router.refresh()` — once per status,
  tracked by a ref, so a retry that fails a second time still refreshes.
- **Keyboard shortcuts.** `useShortcuts` binds accept/reject/toggle, undo/redo,
  tool switching, and page navigation. The bindings are only armed when the
  document is reviewable.

### What it delegates

| Concern | Delegated to |
| --- | --- |
| Redaction mutations | `useRedactions` hook (`accept`, `reject`, `create`, `applyGlobalRule`, `undo`, `redo`) |
| Canvas creation | `canvasActions.create` → `DocumentCanvas` |
| Inspector actions | `inspectorActions` → `RedactionInspector` / `MobileInspector` |
| Export | `ExportDialog` (open state in `uiSlice`) |
| Toolbar undo/redo | `EditorToolbar` (wired to the same `undo`/`redo`) |

The `onExport` callback on the toolbar is a no-op (`useCallback(() => undefined,
[])`): the export button that actually opens the dialog lives in
`WorkspaceHeader`, and the toolbar's `onExport` prop exists only for the type.
This is intentional rather than a leftover — the toolbar does not own export
entry, the header does.

---

## 4. `WorkspaceHeader`

`components/editor/workspace-header.tsx`

The top bar of the editor. It carries:

- The brand and a link back to `/documents`.
- The filename and kind, plus the detection preset ("looked for PII") — said
  here because an empty inspector reads as "nothing to redact" unless you know
  the search was narrowed.
- **Batch navigation**, when the document belongs to one: a chip linking to the
  batch page with position and carried-rule count, plus previous/next arrows.
  The chip is the only route back to the batch and stays at every width; the
  arrows fold away on narrow screens because they are a convenience, not a
  necessity.
- `RetentionControl` (hidden below `lg`), `StatusPill`, and `BatchDownloadButton`
  — the batch archive is offered here because the reviewer finishes the last
  document in the workspace, not on the batch page.
- The **Export** button, which dispatches `exportDialogToggled(true)`.

---

## 5. `DocumentCanvas` — the format dispatch

`components/document-viewer/document-canvas.tsx`

The canvas reads `summary.kind` and picks a viewer. The dispatch is a chain of
early returns, not a lookup table, because image and spreadsheet take a
different shape from the page-based viewers:

| `kind` | Viewer | Scrolling | Page model |
| --- | --- | --- | --- |
| `image` | `ImageCanvas` | own `<section>` | single page, pixels + OCR |
| `xlsx`, `csv`, `tsv` | `SpreadsheetGrid` | own grid | sheets, rows, cells |
| `pdf` | `PdfViewer` | container | paginated, rendered page |
| `docx` | `DocxViewer` | container | paginated runs |
| `txt`, `rtf`, `eml`, `pptx` | `TextViewer` | container | paginated text |

CSV and TSV normalize to the same worksheet model a workbook does, so they are
reviewed in the same grid rather than as text that happens to have commas.

### The dispatch contract

Every page-based viewer receives the same inputs: the current `NormalizedPage`,
a `zoom` factor, and — for text-bearing formats — a `renderSpan` callback. The
callback is defined once in `DocumentCanvas` and shared by `DocxViewer` and
`TextViewer`, because a DOCX run and a line of a text file are the same thing
to a reviewer: a piece of the document you can point at and remove. Two copies
of that logic would be two places for the highlight, the accepted state, and the
keyboard affordance to drift apart.

`renderSpan` checks whether any redaction on the page covers the span (by
offset overlap, via `coversSpan`) and renders it accordingly: solid black for
accepted, dashed red for suggested, hover tint for unredacted. Clicking a
covered span selects its redaction; clicking an uncovered span creates one.

### Fit-to-width

A `ResizeObserver` recomputes zoom when the container resizes, unless the user
has chosen an explicit zoom (which flips `fitMode` to `"custom"`). Fit-to-page
constrains both dimensions; fit-to-width constrains only width. The mode is
restored after `zoomChanged` flips it, so the user's fit choice survives a
resize.

### `RedactionLayer` over PDFs

For PDFs, `DocumentCanvas` renders `PdfViewer` with a `RedactionLayer` child
positioned over the page. The layer is the annotation surface; the viewer is
the rendered page underneath. For DOCX and text, the spans are inline in the
text flow (`renderSpan`), so there is no separate layer — but the same
`pageRedactions` feed both paths.

---

## 6. `RedactionLayer`

`components/redaction/redaction-layer.tsx`

The annotation layer over a rendered page. It reads `pageRedactions` (filtered
in `DocumentCanvas` to the current page, excluding rejected) and renders three
kinds of element:

| Element | Source | Behavior |
| --- | --- | --- |
| Word hit targets | `page.spans` with `boundingBox` | Transparent until hovered; click redacts the span by offset |
| Redaction boxes | `boxesForRedaction(page, redaction)` | Solid black if accepted, dashed red if suggested; click selects |
| Draft region | pointer drag | Live rectangle; on release, creates a region if larger than `MIN_DRAG_PX` |

### OCR spans and text-detection offsets

A redaction carries `start`/`end` character offsets, not geometry. `boxesForRedaction`
(`lib/redaction/geometry.ts`) resolves those offsets to the bounding boxes of the
spans they overlap — the same function the exporter uses. This is the contract:
**what is drawn here is a promise about what the exported file will look like.**
Sharing the function is the point, not a convenience.

For images, the same resolution happens in `ImageCanvas`: a text redaction
found by OCR carries offsets, and `boxesForRedaction` places it on the pixels
the OCR span covers. Without this, a suggestion would exist in the inspector
and nowhere on the image.

### Accessibility

Word hit targets are `tabIndex={-1}` and `aria-hidden`. A page of prose would
otherwise be several hundred tab stops, which is worse than having none.
Redactions themselves are focusable buttons with descriptive labels
(`describe()`), and the inspector list is the complete keyboard path to every
suggestion on the page.

---

## 7. `RedactionInspector`

`components/redaction/redaction-inspector.tsx`

The list of suggestions and decisions, on the right rail of the editor
(`xl:flex`; hidden below). `MobileInspector` reuses `InspectorBody` as a bottom
sheet for narrow screens.

### Occurrence grouping

Suggestions are grouped by the value they cover, via
`selectOccurrenceGroups` in `store/selectors.ts`. The group key is
`category|normalizedText`, so seventeen occurrences of "John Smith" in the
`person` category become one row — because that is the decision a reviewer is
actually making: one call about John Smith, not seventeen.

| Filter | Control | Store path |
| --- | --- | --- |
| Source (All / AI / Manual / Rules) | pill row | `redactions.filters.source` |
| Category | chip row (top 8) | `redactions.filters.category` |
| Status | (implicit — rejected excluded from canvas) | `redactions.filters.status` |

### Per-group actions

Each group row offers:

- **Redact this** — accept the first occurrence.
- **Redact all N** — accept every occurrence in the group (when N > 1).
- **Everywhere** — `applyGlobalRule(text, category)` across this document
  (when N === 1, since "all" is the same as "this").
- **Whole batch** — `applyGlobalRule(text, category, "batch")`, offered only
  when the document belongs to a batch with more than one document. A promise
  about files that do not exist is not offered.
- **Ignore** — reject every occurrence in the group.

**Accept all** and **Reject all** operate on every filtered suggestion, not
just the visible ones.

### Confidence

Confidence is shown as a band (`high` / `medium` / `low`, via
`confidenceBand`) and a percentage, never as a verdict. The accept and ignore
buttons are the only things that change the document — the percentage informs
the decision, it does not make it.

---

## 8. `ExportDialog`

`components/redaction/export-dialog.tsx`

The surface for export decisions, cost display, and the report. Open state
lives in `uiSlice.exportDialogOpen`, so the header button and the dialog are
decoupled.

### Before generation

| Control | Purpose |
| --- | --- |
| Metadata sanitization | Strip author, tooling, EXIF, GPS (on by default) |
| `[REDACTED]` labels | Insert placeholder text where content was removed |
| Image style | `solid` / `pixelate` / `blur` — images only |

Solid black is the default and the only unarguably irreversible option. Blur
and pixelate are offered because they read better on photographs, with the
trade stated in the UI: "heavy blur can in principle be attacked." Every option
replaces the pixels and re-encodes the file — the original region is not in the
export either way.

### After generation

The response carries the download URL, the report URL, the checksum, and an
`ExportReport`. Rather than only offering the report as a file, the dialog
shows a `ReportSummary` inline:

- Counts removed, by category.
- How many suggested items were *not* accepted and remain in the file
  (rejected + undecided), stated plainly: "3 suggested items were not accepted
  and remain in the file."
- Whether the detection was narrowed to a preset, with the caveat that
  anything outside it was never searched for.
- A note that the report records counts and checksums, never the values
  themselves.

`DocumentUsageSummary` (below) appears here too, showing what the analysis
cost.

### Cost display

`DocumentUsageSummary` (`components/documents/usage-summary.tsx`) fetches
per-document usage from `/api/documents/:id/usage`. Tokens, duration, and call
counts are always shown. A currency figure appears only when the operator has
configured `AI_PRICE_INPUT_PER_MTOK` and `AI_PRICE_OUTPUT_PER_MTOK` — an
invented price is worse than no price. When rates are unset, the component
shows duration instead and names the env vars to set.

### Downloads as links

The Download and Report buttons are `<a>` elements styled with
`buttonVariants`, not `Button` components. Base UI's `Button` would relabel a
link as a button and lose the link semantics a screen reader and a middle-click
both rely on.

---

## 9. `LiveAnnouncer`

`components/editor/live-announcer.tsx`

An `sr-only` paragraph with `role="status"` and `aria-live="polite"`. It
derives a single sentence from current state — counts plus processing status —
rather than narrating each delta. A live region announces its content whenever
that content changes, so describing the whole position is both simpler and more
useful: a screen-reader user who arrives late hears "7 of 12 suggestions
reviewed, 4 accepted, 5 left to review" rather than the last thing that
happened.

The message covers four states: failed, analyzing (with or without suggestions
so far), ready with no suggestions, and ready with suggestions in any review
state.

---

## 10. `editor/` support components

| Component | File | Role |
| --- | --- | --- |
| `WorkspaceHeader` | `workspace-header.tsx` | Top bar (see §4) |
| `PageNavigator` | `page-navigator.tsx` | Thumbnail rail; shows accepted redactions per page as a progress view; real navigation list for keyboard |
| `PageThumbnail` | `page-thumbnail.tsx` | One thumbnail, with redaction marks |
| `EditorToolbar` | `editor-toolbar.tsx` | Tool selection (select/redact), zoom, fit-page, undo/redo |
| `LiveAnnouncer` | `live-announcer.tsx` | a11y live region (see §9) |

`EditorToolbar` reads tool, zoom, and undo/redo availability from the store.
Undo/redo are wired through `Workspace` (which holds the `useRedactions` hook)
rather than dispatching directly, so the toolbar stays a presentational
component.

---

## 11. `batch/` — batch review and export

### `BatchView`

`components/batch/batch-view.tsx`

The batch page (`/batches/[id]`). Two sections:

1. **Documents.** Each row shows filename, status, and counts ("3 accepted · 5
   to review"), with a `StatusPill`, a Retry button (when the failure is
   retryable), and a Review link. While any document is still processing, the
   view polls `/api/batches/:id` every 4 seconds; once everything has settled,
   polling stops.

2. **Carried decisions.** The rules made in one document and applied across the
   batch, each showing pattern, category, how many documents it touched, and
   how many redactions it produced. Removing a rule undoes every redaction it
   produced — a rule that quietly redacts in files you have not opened has to
   be visible and removable.

### `BatchDownloadButton`

`components/batch/batch-download-button.tsx`

The one control for getting a batch out, rendered on the documents page, the
batch page, and the workspace header. It carries progress itself — the run is
durable and takes minutes, so a control that forgot the run the moment its
modal was dismissed would make closing the window feel like cancelling. The
button says "Exporting 3 of 8" while it works (with a clipped fill inside the
button as a progress bar), then "Archive ready" when there is something to
take.

### `BatchDownloadDialog`

`components/batch/batch-download-dialog.tsx`

The modal behind the button. It is a *view* of the server-side run, not the
thing keeping it alive — closing it does not stop anything. The dialog shows:

- A progress bar (per-document, or archive-assembly bytes once the run is done).
- A per-document list with state icons: exporting, exported (with count
  removed), or skipped. Skipped reasons are named: "had not finished
  processing," "failed verification and was withheld," "hit the export
  allowance," "did not fit in the archive," "could not be exported," "not
  reached."
- Stop (while active), Try again (after failure), Export again / Save again
  (after success).

The archive fetch is a separate wait from the run that produced it — assembling
tens of megabytes from verified artifacts takes time, and a bare link would
hide it. The archive is fetched with a streaming reader, handed to the browser
automatically, and the button stays for the case where the auto-download is
swallowed.

---

## 12. `documents/` — the session landing page

`components/documents/`

The `/documents` page. Documents uploaded together are shown together:
`groupByBatch` (`lib/documents/grouping.ts`) splits the list into singleton
`DocumentCard`s and `BatchGroup`s.

| Component | Role |
| --- | --- |
| `DocumentList` | Polls while anything is processing; groups by batch; handles delete and retry |
| `BatchGroup` | Collapsible group of documents from one upload; carries the batch archive button |
| `DocumentCard` | One document: icon, name, kind, size, age, batch link, review progress bar, retention, status, retry, open, delete |
| `LimitsCard` | Rate limits and daily quotas, as gauges; reads the same numbers the server enforces |
| `RetentionControl` | Dropdown extending the expiry window; options computed from creation time |
| `UsageSummary` | Per-document and session-wide analysis cost (see §8) |

### `DocumentList`

Refreshes on its own while anything is processing (4-second poll), then stops.
A failed document can be retried in place: the status is moved to `"queued"`
locally rather than waiting for the next poll, because that local change is
what restarts the polling that will report the rest.

### `BatchGroup`

A collapsible group with a heading ("Batch of N · 3 ready · 2 still processing
· 1 failed"), an "Open batch" link, and a `BatchDownloadButton`. Each document
inside is a `DocumentCard` with `showBatchLink={false}` — the card is already
under its batch heading.

### `LimitsCard`

Two different things side by side, because hitting either produces the same
refusal:

- **Rate limits** — pace: requests per window, refilling continuously, back to
  full within a minute of being left alone.
- **Quotas** — volume for the UTC day: pages, cells, uploads.

A self-hosted install has no quotas, and the card says so rather than drawing
empty bars for limits that do not exist. The endpoint it reads
(`/api/limits`) deliberately does not spend from the bucket it reports on.

### `RetentionControl`

The options offered are only the ones that would actually push the expiry out,
computed from creation time (`extendableOptions`). A document that has already
used most of its allowance has fewer choices; one at the 72-hour ceiling has
none. The limit is stated rather than discovered by trying. Windows are
measured from upload, not from now, so renewing repeatedly converges on the
ceiling instead of walking it forward.

### `UsageSummary`

Two exports in one file:

- `DocumentUsageSummary` — per-document, fetched on demand. Appears in
  `ExportDialog`.
- `AggregateUsageSummary` — session-wide, given by the server. Appears on the
  documents page.

Both show tokens, duration, and call counts. Cost appears only when
`AI_PRICE_*` rates are configured; otherwise the component names the env vars
and shows "rates not set."

---

## 13. `components/ui/` — shadcn primitives

`components/ui/`

The `ui/` directory is [shadcn/ui](https://ui.shadcn.com) — generated
primitives owned by the project, not a dependency. Each file is a Base UI
component styled with Tailwind tokens:

```
alert  badge  button  card  checkbox  dialog  dropdown-menu  input  label
popover  progress  scroll-area  select  separator  sonner  switch  tabs
tooltip
```

These are the building blocks every other component composes. The project does
not re-export or wrap them further — `Button`, `Dialog`, `Select`, etc. are
imported directly from `@/components/ui/*`. When a link is needed where a button
appears (download links, navigation), the pattern is an `<a>` styled with
`buttonVariants()` rather than a `Button` — because Base UI's `Button` assumes
it renders a real `<button>` and, told otherwise, swaps `type="button"` for
`role="button"`, losing link semantics.
