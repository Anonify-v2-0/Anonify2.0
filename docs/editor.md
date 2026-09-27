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
 │    │    ├── RedactionLayer     boxes, spans, drag regions
 │    │    └── SearchBoxes        search hits, by geometry
 │    ├── DocxViewer              paginated runs  ── renderSpan
 │    ├── EmlViewer               foldable sections: headers, bodies,
 │    │                           attachments  ── renderSpan
 │    ├── TextViewer              txt / rtf / pptx  ── renderSpan
 │    ├── ImageCanvas             pixels + OCR words + regions + SearchBoxes
 │    └── SpreadsheetGrid         sheets, rows, columns, cells, search hits
 ├── SearchBar                    find across the document (§14)
 ├── RedactionInspector           tabs: Redactions | Rules (§15)
 │    └── RulesPanel              every rule in scope; toggle, edit, remove
 ├── MobileInspector              same tabs, as a bottom sheet
 ├── EditorToolbar                tools, search, Hush, shortcuts, zoom, undo
 ├── ExportDialog                 style, metadata, report, download
 ├── RuleDialog                   pattern, scope, live preview (§15)
 ├── HushPanel                    the review assistant (§16)
 ├── ShortcutSheet                every key binding, on `?` (§17)
 └── LiveAnnouncer                sr-only live regions: review, search
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
- **Keyboard shortcuts.** `useShortcuts` arms the bindings, only when the
  document is reviewable. What they are is not written here: the shortcut sheet
  (`?`, §17) is the one list, and this document points at it rather than
  keeping a copy that would drift.
- **Search, rules and Hush.** `useSearch` runs the search the bar describes
  (§14); `useRules` loads every rule in scope once, for both the rail and the
  mobile sheet (§15); `useLearnedShapeNudge` watches the reviewer's own
  redactions for a shape worth a rule (§16).

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
| `eml` | `EmlViewer` | container | paginated text + foldable sections |
| `txt`, `rtf`, `pptx` | `TextViewer` | container | paginated text |

CSV and TSV normalize to the same worksheet model a workbook does, so they are
reviewed in the same grid rather than as text that happens to have commas.

### `EmlViewer` — a message is not one document

A message is a header block, then the same body written twice (once as
`text/plain`, once as HTML), then whatever it carried, and then all of that
again for every message forwarded inside it. Drawn as one undifferentiated
stream it reads as a wall of near-duplicate text, which is how a reviewer came
to read the same paragraph twice without noticing it was the same paragraph.

So the extractor names those stretches — `NormalizedPage.sections`, a list of
`PageSection` — and the viewer draws each as a section that folds:

| Section | Default | Behaviour |
| --- | --- | --- |
| `headers` | open | Never closed by anything else; From/To/Subject is the orientation for everything below. Still foldable by hand, because twenty `Received` lines is a wall of its own. |
| `text` / `html` | one open | An accordion. The HTML body is what the sender composed and what the recipient saw, so it opens; `text/plain` is the fallback. Opening one closes the other. |
| `attachments` | folded | With a count. |

A section's `id` is its identity, not its position (`body:0.2`), so pagination
cutting a long body in half still leaves one section: folding it folds it on
every page rather than reopening as the reviewer pages through. `depth` steps a
forwarded message in, so a thread reads as the nest of messages it is.

**A folded section must never hide unreviewed work.** This is the one thing in
the viewer that is not a matter of taste. Folding the `text/plain` alternative
because an HTML body exists would hide a suggestion nobody has actioned, and a
reviewer who exports believing they have seen the message is precisely the
failure this product exists to prevent. So every folded section carries its
counts, and a section holding suggestions nobody has decided on **opens
regardless of the default**, folding only once the reviewer has folded it
themselves. A default this code chose is never the reason something went
unread.

An HTML body is drawn from the markdown the extractor wrote it as (see
`docs/pipelines.md`); everything else stays the fixed-width stream it arrived
as. Block structure is read off the **padding**, never off span text —
`lib/documents/eml/markdown.ts` — so a sender who types `- ` or `# ` gets a
paragraph containing those characters. That is also why nothing upstream
escapes markdown: there is nothing to escape against.

No message content ever reaches an `href`, a `src` or any other attribute a
browser would fetch, and there is no `dangerouslySetInnerHTML` anywhere in the
viewer, so a tracking pixel cannot phone home from a reviewer's screen.

`EmlViewer` also takes a `variant="preview"` used by the page rail, which draws
the message's body alone — no chrome, nothing folded, headers and attachment
lines left out. A rail of tiles all showing the same `From:` block says nothing
about which page you are looking for; the body is the part that differs.

### The dispatch contract

Every page-based viewer receives the same inputs: the current `NormalizedPage`,
a `zoom` factor, and — for text-bearing formats — a `renderSpan` callback. The
callback is defined once in `DocumentCanvas` and shared by `DocxViewer` and
`TextViewer`, because a DOCX run and a line of a text file are the same thing
to a reviewer: a piece of the document you can point at and remove. Two copies
of that logic would be two places for the highlight, the accepted state, and the
keyboard affordance to drift apart.

`renderSpan` makes each span a click target. It does **not** style the span
by the redactions on it: a span is a whole line of a text file, and styling it
blacked out the line to show one ID on it being removed. Redactions are
painted by their exact characters instead, with the CSS Custom Highlight API
(`useTextHighlights`, see §14): black for accepted, dashed red for suggested,
red underline for the selected one.

What a click does is decided by the character under the pointer, which the
browser's caret gives and the viewer's `data-offset` markers place in the
page's text (`pageOffsetOf`):

- inside an existing redaction, the click selects it;
- anywhere else, it redacts the token around that character (`wordAt` in
  `lib/redaction/words.ts`): letters and digits joined by the punctuation
  identifiers, emails and phone numbers use, without the sentence punctuation
  around them, so `EMP-10007`, `jane.doe1@example.com`, `Doe`.

Dragging a selection across the text redacts exactly the selection, across
lines if need be, with whitespace at either end trimmed. From the keyboard,
with no pointer to aim, Enter or Space on a span redacts the span, or selects
the redaction already in it.

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
| Word hit targets | `page.spans` with `boundingBox` | Transparent until hovered; a click redacts the token under the pointer, found from the run's measured character positions (`span.offsets`, `characterAtX`) and widened by `wordAt`. An OCR word is already the unit, as is a run whose characters were never measured. |
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
(`xl:flex`; hidden below). `MobileInspector` reuses the same `InspectorTabs` as
a bottom sheet for narrow screens. The rail has two tabs: **Redactions**, which
is `InspectorBody` and is what this section describes, and **Rules**, which is
the rules panel (§15).

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

Search has a second region of its own, on the same principle: "7 of 132
matches", or "No matches", whenever the position changes. It is separate so
moving between hits does not replace the review's position and then put it
back.

---

## 10. `editor/` support components

| Component | File | Role |
| --- | --- | --- |
| `WorkspaceHeader` | `workspace-header.tsx` | Top bar (see §4) |
| `PageNavigator` | `page-navigator.tsx` | Thumbnail rail; shows accepted redactions per page as a progress view; real navigation list for keyboard |
| `PageThumbnail` | `page-thumbnail.tsx` | One thumbnail, with redaction marks |
| `EditorToolbar` | `editor-toolbar.tsx` | Tool selection (select/redact), search, Hush, shortcuts, zoom, undo/redo |
| `ZoomControl` | `zoom-control.tsx` | Zoom out, a log-scale slider (100% in the middle, a native range input for the keyboard and screen readers), zoom in, a percentage that resets to 100%, fit width and fit page |
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

---

## 14. Search

`components/search/search-bar.tsx`, `hooks/use-search.ts`,
`store/searchSlice.ts`, `lib/redaction/search.ts`

`Ctrl/⌘+F` or `/` opens a find strip docked across the top of the canvas. On
this screen it replaces the browser's find, which cannot read a PDF page (text
drawn on a canvas) and cannot see pages that are not loaded. On the one screen
where "not found" matters most, the browser would say it with confidence and
be wrong.

The strip is one row: the query with its options (match case, whole word,
RegEx) and an "N / M" counter inside the field, then previous/next, a split
**Redact this | Redact all M** button, the results toggle, "this batch", and
close. It is docked rather than floating, so the document never moves under
it or sits beneath it.

**Results.** A column docked beside the canvas lists the first 200 hits in
context, grouped by page (or by cell for a spreadsheet). It is docked rather
than floating over the page: a list over the right half of the page hid the
text it was listing. The current hit is marked, and
clicking any hit makes it current, which moves the canvas there. With "this
batch" on, a second tab lists every document with its count and a link. The
page rail shows each page's hit count as a badge on its thumbnail, so a long
document shows where its hits are at a glance.

**It runs on the server**, over the normalized document a page at a time, like
the rules do. A 400-page PDF is searched without 400 pages reaching the
browser. There are three requests, each only when needed:

| Request | When | Answer |
| --- | --- | --- |
| Summary | once per question (debounced) | hits per page, matching cells, total |
| Page hits | once per page shown, per question | `{ start, end }` offsets on that page |
| Batch | when "this batch" is on | a count per document, with links |

Every answer carries the key of the question it answers, so a slow answer to
"Smi" cannot be drawn over the answer to "Smith".

**Options:** match case, whole word (Unicode-aware, so `café` works), and
RegEx. All three use the same compiler as rules (`lib/redaction/patterns.ts`),
which is what lets "Redact all" promise the count on its button.

**Moving.** The counter reads "N of M". `Enter` and `Shift+Enter` in the box
step through hits in page order, then cells, wrapping at either end. A step
moves the page, or the sheet, to where the hit is, and scrolls it into view.
The first hit shown is the first one at or after the page the reviewer was on.

**Highlighting.** Hits are amber (`--search-hit`), and the current one is a
stronger amber with an edge (`--search-current`). Red means a suggestion and
black a decision; a hit is neither. Both colors are chosen against the
document surface, which is white in every theme. How a hit is painted depends
on the viewer:

- **Text flow** (DOCX, text, RTF, PPTX, EML): with the CSS Custom Highlight
  API, over the text nodes the viewer already drew. Each viewer marks where
  its text starts with `data-offset`. Splitting spans to wrap a hit would
  change the elements a click redacts, and a search must not change what a
  click does. `tests/search-offsets.test.tsx` holds the markers to the page
  text.
- **Geometry** (PDF, image and OCR): `SearchBoxes` resolves a hit to
  rectangles with `boxesForRange`, the same resolution a redaction gets. A hit
  and the redaction it would become cover the same place. The boxes never
  take pointer events.
- **Spreadsheets:** the matching cells, whole.

**From a hit to a decision.** *Redact this* makes the current hit a manual
redaction (a text range, or a cell) and moves to the next hit. *Redact all*
opens the rule dialog (§15) with the search already filled in.

`Esc` closes the box and clears the highlights. The query is kept for the next
time it opens. Closing is also what `Esc` does outside the box while search is
open. Otherwise `Esc` switches to the select tool, as it always did.

---

## 15. Rules

`components/rules/rule-dialog.tsx`, `components/rules/rules-panel.tsx`,
`hooks/use-rules.ts`, `lib/redaction/rules.ts`, `lib/redaction/owner-rules.ts`

A rule is **a pattern, a category, a scope and a kind**.

| Kind | Matches |
| --- | --- |
| `literal` | the text, case-insensitively unless asked otherwise, as rules always have |
| `regex` | an RE2 pattern: linear-time, with no lookaround and no backreferences |

| Scope | Reaches |
| --- | --- |
| Document | every match in this document |
| Batch | every document in the batch, including ones still processing |
| Global | this document, and every document the owner uploads from now on |

**The rule dialog** is the one way a rule is made or changed. It opens from
the search bar's *Redact all*, the rules panel, a Hush proposal, or a learned
offer. As the reviewer types, the pattern is checked in the browser by the
same compiler the server runs, then previewed: the count and the first matches
in context. For a batch rule it also shows the count in every other document.
The confirm button names the number of redactions it will write. Nothing is
written until it is pressed.

**The rules panel** is the Rules tab of the inspector. It lists every rule in
scope for the open document, grouped by scope, each with its kind, category
and reach ("12 here · 40 in 4 documents"). Each can be:

- **Switched off**: its redactions go and it stays listed, so switching it
  back on is one click. A batch or global rule that is off is not carried into
  documents that finish later.
- **Edited**: through the dialog, with a fresh preview. The edit replaces what
  the rule redacted everywhere it reached, in one transaction. A match the
  reviewer had rejected comes back accepted, because the edit is a new
  decision and its preview showed every match.
- **Removed**: after a confirmation that says how many redactions go with it,
  in how many documents.
- **Improved with Hush**: RegEx rules only (§16).

The global section also has **Export** and **Import**. They use a JSON rule
file, which is how a team shares one rule set across instances, and how
anybody keeps rules longer than the 30 days an unused global rule lives.

The existing per-suggestion **Everywhere** and **Whole batch** buttons are
unchanged. They make literal rules at those scopes without the dialog, as
before.

---

## 16. Hush, the review assistant

`components/assistant/hush-panel.tsx`, `components/assistant/hush-tool-part.tsx`,
`components/assistant/hush-markdown.tsx`, `lib/assistant/agent.ts`,
`lib/assistant/tools.ts`, `lib/assistant/learn.ts`

`Ctrl/⌘+K` opens Hush, the review assistant: an agent the reviewer talks to.
It is a model with tools running in a loop (the AI SDK's `ToolLoopAgent`,
streamed to `useChat`), with the reviewer in that loop. It reads and searches
the document, runs the detectors, looks at what the review has decided, and
previews rules. **When it wants to change anything, it stops and asks.**

On a wide screen Hush takes the right rail in place of the inspector, beside
the page rather than over it; closing Hush brings the inspector back. On a
narrow screen it opens as a sheet over the page.

In `find_occurrences` and `find_uncovered`, a place counts as covered only
when a redaction there is accepted or still suggested. A rejected redaction
means the reviewer chose to keep the value in the file, so it counts as
uncovered ("kept in file" in the panel). `uncovered` is counted over every
occurrence, not only the ones listed.

**Tools.** Reads run without asking, once reading is allowed (below). Changes
always wait for approval.

| Read | What it gives Hush |
| --- | --- |
| `get_document_overview` | Kind, pages or sheets, and redaction counts by status, source and category. No document text. |
| `read_page`, `read_sheet` | The text of a page (in 8,000-character parts), or rows of a sheet. |
| `find_occurrences` | Every place a value or pattern occurs: page, context, a ref to act on, and whether a redaction already covers it. |
| `find_uncovered` | The deterministic detectors over the whole document, minus what is already covered, grouped by category and value. |
| `list_suggestions`, `list_rules` | The review so far, grouped the way the inspector groups it, and every rule in scope. |
| `preview_rule`, `compare_patterns` | A rule's matches before it exists, and the matches a new pattern gains and loses against an old one. |

| Change (approval required) | Effect |
| --- | --- |
| `create_rule` | A literal or RegEx rule at document, batch or global scope. |
| `update_rule` | Switch a rule off or on, or change its pattern or category, everywhere it reaches. |
| `redact_occurrences` | Specific values, by the refs a read returned. |
| `set_suggestion_status` | Accept or reject whole suggestion groups. |

**Human in the loop.** A change arrives as a card that shows what it will do
and the evidence for it:
- a rule shows its live preview: the count here, across the batch, and the
  first matches;
- a redaction shows the exact values and where they are;
- a bulk decision shows the groups, resolved from the store.

Nothing on a card has happened until **Approve**. A declined change is
reported back to the agent, which is told not to retry it.

Approvals are HMAC-signed by the server when issued (the key is derived from
`FINGERPRINT_SECRET`). A replayed approval whose tool, call or input has been
altered is refused before anything runs.

Every change is re-validated when it runs. A rule must compile and fit its
budget. A reference must still hold the exact text the reviewer approved, so
a model that copied the wrong text for a place redacts nothing there. After a
change, the canvas, the inspector and the rules panel reload from the server.

**Reading, asked once.** The first read in a document is itself an approval:
"Let Hush read this document?" It sends what it reads to the configured
provider, the same one that analysed the document. Allowed, it holds for the
session, and every later read is listed in the conversation as it happens. The
shield in the header revokes it.

**The header** shows where answers come from as badges: the provider, the
model, and whether the provider is a hosted API, a local model, a ChatGPT plan
or the gateway. That last one changes what "sent to the provider" means, and
each badge explains itself on hover. A local model also gets a "Stays on this
machine" badge. The icons describe the kind of provider, not a vendor's logo.

**The conversation.** Each tool call is drawn as it runs:
- a read is a line of activity ("Found `EMP-\d{5}` · 12 times on 4 pages, 3
  not covered") that opens into its result;
- every location in a result is a button that moves the canvas there;
- "Show all in the document" runs the pattern as a search.

Replies are Markdown, rendered as they stream by Streamdown and hardened: no
link or image in a reply can make the browser fetch anything, and raw HTML is
not rendered. A reply can quote the document, so this is the same rule the
email viewer keeps. The model is told that tool results are document content
and must never be followed as instructions.

**Noticed in your redactions.** After three hand-made redactions of the same
anchored shape, Hush offers a rule for it: "You've redacted 4 values like
`EMP-00xxx`. Make a batch rule for `EMP-00\d{3}`?"
- The shape is learned in the browser, with no model and nothing sent, so this
  works with no provider.
- It is only offered when the shape has digits or a literal every example
  shares. Two capitalised words is a shape too, and a rule for it would redact
  prose.
- A toast announces a new offer once, and the toolbar's Hush button carries a
  dot while there is one.

**Improve with Hush**, on a RegEx rule in the rules panel, opens the
conversation with that request. Hush looks at what the rule matched and what
was rejected, tests a tighter pattern with `compare_patterns`, and proposes it
as an `update_rule` card for the reviewer to approve or decline.

**Cost and limits.**
- Hush uses the configured analysis provider and stops at the same daily spend
  cap.
- Every model step is an `AiUsage` row against the document (`assistant`).
- A run is at most 12 steps, and a conversation at most 80 messages.
- It needs a model verified for structured output, which is the same
  capability as tool calling in every provider supported here.
- With no provider, or at the cap, the panel says so. Learned offers, search,
  shortcuts and hand-written rules keep working, because none of them needs a
  model.

---

## 17. Keyboard shortcuts

`lib/editor/shortcuts.ts`, `hooks/use-shortcuts.ts`,
`components/editor/shortcut-sheet.tsx`

Press `?` for the shortcut sheet. It is rendered from `SHORTCUTS`, the only
list of bindings there is, and the toolbar tooltips read their hints from the
same list. So this section deliberately does not repeat them.

Two rules hold for every binding, and `tests/shortcuts.test.ts` holds them:

- nothing fires while the reviewer is typing in a field, and
- nothing destructive is bound to a bare key. Accept and reject act on the
  current selection only, and undo is one keystroke away.
