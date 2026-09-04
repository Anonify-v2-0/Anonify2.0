# The four document pipelines

`lib/documents/{pdf,docx,xlsx,image}`

Each format hides sensitive text somewhere different, so each pipeline is built
around the specific way that format can betray you. This document is about those
decisions and the reasoning behind them.

Every pipeline produces the same normalized model and answers the same question
at export time: **is the string actually gone?**

---

## PDF — the format that cannot be faked

### The problem

A PDF page is a content stream of drawing operators. Text is a `Tj` operator with
a font and a position. Drawing a black rectangle over it adds *another* operator;
the text object is untouched underneath — still selectable, still searchable,
still returned by any extraction library, and recoverable by deleting an
annotation.

This is the single most common way redaction is done wrong, and it is why "add a
black box" was never on the table here.

### Extraction

pdf.js gives text items with a transform matrix. Each becomes a span carrying:

- its text and its offsets into the page's flat text stream,
- its bounding box, flipped **once** from PDF's bottom-up space into the
  top-down space the canvas and exporter both use — flipping in two places and
  forgetting one is how boxes end up mirrored,
- font family, size, and inferred weight/style.

A page whose extracted text is under 16 characters is flagged `ocr: true` rather
than treated as empty — a scanned page is not a blank page, and conflating them
means silently redacting nothing.

### Export

```
page has accepted redactions?
  ├── no  → copy the page through untouched (vector text survives)
  └── yes → render to raster at 2× → paint the boxes onto the pixels
            → rebuild the page from that image
```

The characters are gone because the text objects are gone. There is nothing left
to un-cover.

**The trade, stated plainly:** a redacted page loses its text layer. It is no
longer selectable, searchable, or screen-reader accessible. That is a real cost,
and it is why only affected pages are rasterized — a hundred-page document with
one redacted page keeps ninety-nine pages of real text.

The alternative — content-stream surgery to delete just the covered glyphs —
preserves the text layer but is far harder to get right across arbitrary fonts,
encodings and positioning, and getting it *nearly* right means leaking. For a
tool whose entire claim is that the value is gone, the guaranteed method wins.

### Verified by

Extracted text; a raw byte scan with whitespace, parens and escapes stripped (so
glyph-spaced text cannot slip through); the absence of `/Annots` and `/Redact`
objects; and re-extraction confirming the redacted page now has zero spans.

---

## DOCX — surgery, not reconstruction

### The problem

The obvious approach is to parse the document into a model and write a new one.
It destroys formatting: numbering restarts, styles drift, section properties and
relationships are approximated. Users notice immediately, and a redaction tool
that mangles the document is one people route around.

The second problem is that Word keeps text in more places than the body:
headers, footers, footnotes, endnotes, comments. Redacting `document.xml` alone
leaves the value sitting in `header1.xml`.

### Extraction

`word/document.xml` is walked in document order, and every paragraph and run gets
a **positional address** — `p3r1` is the second run of the fourth paragraph.

The critical property: the exporter re-walks the identical order later, so the
address still points at the same run. That requires both walks to agree exactly,
which is why both count *every* paragraph and *every* run wherever nested —
inside hyperlinks, inside table cells, inside nested tables. An early version
counted only direct children in one walk and all descendants in the other; the
addresses drifted and a redaction would have landed on the wrong run.

No markers are injected into the user's file to make this work. Invisible
characters in a real document break font shaping, corrupt extraction, survive
copy/paste, and defeat search.

### Export

Text nodes are edited **in place** in the XML string. Everything outside the
edited `<w:t>` content stays byte-identical, so styles, numbering, relationships
and section properties survive exactly.

A value split across runs (Word splits at every formatting change) gives each run
exactly the slice it contributed, and the `[REDACTED]` marker is written once for
the redaction rather than once per run it spans.

Then a **package-wide sweep** removes the accepted values from every text-bearing
part — the header, the footer, the footnote, the comment.

### Verified by

Concatenating every `.xml` and `.rels` part and searching it; confirming the
package still opens and still has its heading, its table, and its bold run.

---

## XLSX — the format with the most hiding places

### The problem

A workbook can hold the same value in a startling number of places:

- a visible cell,
- a hidden row, or a hidden column,
- a **hidden sheet** the user has never seen,
- a formula referencing the cell,
- the **cached result** of that formula,
- the shared string table.

Clearing the visible cell addresses one of six.

### Extraction

ExcelJS reads the grid structurally: headers, used ranges, merges, formulas,
number formats, and explicitly the hidden rows, columns and sheets. Hidden data
is extracted like everything else — data the user cannot see is exactly the data
they are most likely to leak.

### Export

Three units, because they are three different decisions:

| Unit | Behaviour |
| --- | --- |
| **Cell** | That cell only. |
| **Row** | Every cell in the row. |
| **Column** | Every cell below the header — the header itself survives, so the sheet stays readable. |

Cells are **rewritten**, not styled to look blank. Then:

- **Dependent formulas are dropped.** Any formula still naming a redacted address
  is cleared, because a cached result is a second copy of the value the user just
  asked to remove.
- **The value sweep covers every sheet**, hidden ones included.

ExcelJS regenerates the shared string table from the model, so the value does not
survive there either.

### Verified by

Re-reading every cell of every sheet including hidden ones; scanning every XML
part; asserting `<f>B2</f>` is gone; checking the shared string table directly.

---

## Images — pixels, or it did not happen

### The problem

Overlaying a rectangle in the browser and saving the page is not redaction; the
original file is unchanged. The exported image must be a *different image*.

### Extraction

Sharp reads the dimensions; Tesseract reads the text and its word boxes.

The ratio of text area to image area classifies the image as **document**,
**photograph**, or **mixed**, which changes what the editor offers. OCR words
become snappable regions, so covering a line of text is one gesture.

Faces and other sensitive regions come from the vision pass rather than a bundled
face-detection model — one fewer heavy native dependency, and the same model can
also flag a licence plate, a badge, or a screen showing personal data, which a
face detector cannot.

### Export

Regions are composited onto the source and the image is **re-encoded**. The
output never contains the original region's data.

Three appearances:

| Style | How | Note |
| --- | --- | --- |
| **Solid** (default) | Black fill | Irreversible. The default for a reason. |
| **Blur** | Blur the crop, composite it back | Reads better on photographs; heavy blur can in principle be attacked. |
| **Pixelate** | Downscale to blocks, scale back with nearest-neighbour | Detail is averaged away, not smoothed over. |

Pixelation needs **two sharp pipelines**. Sharp honours only one `resize` per
pipeline, so chaining downscale and upscale silently skips the downscale — the
step that does the actual destroying — and returns something that looks
pixelated at a glance while retaining full detail. A test caught this by
checking that a known 8×8 white square inside the redacted band no longer reads
as white.

EXIF and GPS are stripped when metadata sanitization is on.

### Verified by

Sampling the redacted region's mean colour; confirming untouched areas are
unchanged; confirming the output differs from the source; confirming EXIF is
absent and the copyright string is not in the bytes.

---

## What they share

Every pipeline produces the same shape:

```ts
NormalizedDocument {
  pages:   NormalizedPage[]     // pdf, docx, image
  sheets?: SpreadsheetSheet[]   // xlsx
  regions?: ImageRegion[]       // image
}
```

`NormalizedPage` carries a flat `text` stream plus `spans` whose offsets index
into it. That single convention is why one detector, one entity expander, one
inspector and one review flow serve four formats — and why a detection made
against the normalized text can always be traced back to a run, a glyph box, or
a cell.

And every pipeline ends the same way: the artifact is re-opened, read
adversarially, and refused if an accepted value survived.
