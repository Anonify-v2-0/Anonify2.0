# The document pipelines

`lib/documents/{pdf,docx,xlsx,image,delimited,text,rtf,eml,pptx}`

Each format hides sensitive text somewhere different, so each pipeline is built
around the specific way that format can betray you. This document is about those
decisions and the reasoning behind them.

Every pipeline produces the same normalized model and answers the same question
at export time: **is the string actually gone?**

What a format *is* — its MIME types, its extensions, its quota unit, whether it
is a package — lives in one place, `lib/documents/formats.ts`. The upload
allow-list, the file picker's `accept`, the refusal message, the quota mapping
and the export output types all derive from it, and the table is typed so that
adding a kind without registering it does not compile.

## The supported formats

| Format | Redaction model | Verified by |
| --- | --- | --- |
| **PDF** | page/content redaction | extracted text, byte scan, re-open |
| **DOCX** | OOXML text replacement | package-wide XML scan |
| **XLSX** | cell/worksheet replacement | workbook package, every sheet |
| **Image** | pixel redaction | pixel sampling and metadata |
| **CSV** | cell replacement | CSV parse and re-read |
| **TSV** | cell replacement | TSV parse and re-read |
| **TXT** | offset replacement | exact text |
| **RTF** | parsed text replacement | RTF reparse |
| **EML** | headers/MIME text replacement, attachments as child documents | MIME reparse and scan, per-attachment checksum |
| **PPTX** | OOXML text replacement | package-wide scan |

Quota units differ because the work does. Pages for PDF and DOCX; filled cells
for XLSX, CSV and TSV; pages of extracted text for TXT and RTF; slides for
PPTX; kibibytes of decoded text for EML; one per image. Counting an email as a
page would charge a one-line reply the same as a forwarded thread.

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

A page whose extracted text is under 16 characters is flagged rather than
treated as empty — a scanned page is not a blank page, and conflating them means
silently redacting nothing. Those pages are then rasterized and read: the OCR
words become spans with real geometry, so a scanned document is reviewable
exactly like a born-digital one.

The boxes come back in raster pixels and are divided by the render scale once.
The raster is produced from the same top-down viewport the extractor uses, so
there is no second flip — flipping twice is how boxes end up mirrored. The
rasterizer itself is shared with redaction, because both need the identical
transform and two copies would drift.

A page the recognizer cannot read stays flagged rather than being presented as
successfully read and empty.

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

Every text-bearing part is walked in document order — the body, headers,
footers, footnotes, endnotes and comments — and each paragraph and run gets a
**positional address**: `word/header1.xml#p3r1` is the second run of the fourth
paragraph of that header.

The part prefix is load-bearing. Each part has its own paragraph numbering, so
`p0r0` exists in the header, the footer and the body simultaneously; an
unqualified address would edit whichever part the exporter happened to walk.

Headers and footers apply document-wide, so they are attached to the first page
rather than repeated on every one — repeating them would produce a duplicate
suggestion per page for the same underlying run.

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

## CSV and TSV — a grid, parsed rather than split

### The problem

`line.split(",")` is wrong for most real CSV, and wrong in the direction that
matters. A quoted field holding a comma, a doubled quote, a newline inside a
value: each shifts every subsequent field by one. A redaction addressed to row
4 column 2 then lands somewhere else in the file — a leak wearing the shape of
an off-by-one.

### Extraction

A state machine over the characters, producing the **same worksheet model a
workbook produces**. That is not a convenience: it means the detectors, the
column-level analysis, the review grid and the cell/row/column redaction units
all work on a CSV without a line of new code, and a redaction carries the
address it will be applied at rather than an offset into a shape that can move.

An unterminated quote is refused rather than guessed at, for the same reason.

CSV and TSV are one pipeline. They differ only in which character separates the
fields.

### Export

Re-parse, rewrite the addressed fields, serialize. The line ending, the
byte-order mark and the source's own quoting are preserved, and anything a
replacement made ambiguous is quoted. Nothing does a string replacement over
the file: a value that also appears inside another field would be edited by
accident, and a replacement containing a delimiter would silently change the
shape of every row after it.

### Verified by

Re-parsing the export as a grid and reading every cell. A value hiding in a
field the parser cannot reach would not be found by searching the file as one
blob — and an export that no longer parses is a failure in its own right.

---

## TXT — offsets, and nothing invented

### The problem

There is no difficulty finding the text. The difficulty is addressing it. Pages
here are *ours*, invented for review, and treating an invented coordinate as
the source of truth is how a redaction ends up pointing at a place that exists
nowhere in the file.

### Extraction

Every span carries the offset of its first character in the source, in its id:
`text#1042` is the line that starts at character 1042. Pagination is
deterministic and breaks on line boundaries, so a redaction filed under page 3
is on page 3 next time — but nothing downstream depends on that, because the
exporter works in source offsets. The page size could change tomorrow and every
existing redaction would still name the same characters.

### Export

The original string with ranges cut out of it. Everything outside a redacted
range survives byte for byte: line endings, trailing whitespace, the
byte-order mark.

### Verified by

The exact resulting text.

---

## RTF — visible text is not contiguous

### The problem

A word processor splits a value at every formatting change, writes accented
characters as escapes, and drops control words between the halves of a word.
`john@example.com` can be four fragments, none of which is the string.
Searching the source finds nothing; replacing in the source is as likely to
delete half a control word as a character, and the result no longer opens.

### Extraction

The source is tokenized once into **atoms**, each contributing a known slice of
visible text and remembering the byte range it came from. Font tables, colour
tables, stylesheets, generator strings, pictures and binary destinations are
skipped entirely — walking into them would offer the reviewer a font name to
redact.

Three kinds of atom, and the distinction is the whole rule:

| Kind | Behaviour |
| --- | --- |
| **literal** | one source byte per character, so a partial cut is exact |
| **escape** | several bytes for one character; goes whole or not at all, because half an escape corrupts everything after it |
| **structural** | a paragraph or tab mark: contributes text so offsets line up with what a reviewer reads, and is *never* removed |

### Export

Re-parse — the parse is deterministic, so the atoms are identical — translate
the accepted ranges back to byte ranges, and remove only those bytes. A brace,
a control word and a paragraph mark are never touched, so the output is the
input with some characters missing, which is still RTF.

The atom machinery is shared with the HTML inside an email
(`lib/documents/shared/atoms.ts`): the problems are the same one.

### Verified by

Reparsing the exported document, which also proves it still opens — a file that
does not throws there rather than passing for want of a match.

---

## EML — a tree, not a text file with a header

### The problem

The same person's name is almost never in one place. It is in `From`, in the
greeting, in the HTML alternative of that greeting, in the quoted reply three
messages down, and in the attachment called `2026-review-John Smith.pdf`.
Extracting "the body" finds one of those five and lets the reviewer believe
they have seen the message — which is worse than no support at all, because it
is trusted.

### Extraction

The MIME tree is preserved and everything text-bearing is reviewable: every
header, every text part, the *visible* text of every HTML part, quoted replies
as themselves, attachment filenames, and all of it again recursively for each
nested `message/rfc822`.

Each gets a stable address, and this is what makes a detection actionable:

```
part:0/header:from[0]        the root message's From
part:0/header:received[2]    its third Received line
part:0.1/body#248            character 248 of the first part's decoded text
part:0.3/filename            the third part's attachment filename
part:0.2.msg/header:to[0]    the To of the message nested in part two
```

"The subject" is not a location when a forwarded message has a subject too.

HTML bodies go through their own atom map, the same idea RTF uses:
`jo<span>hn</span>&#64;example.com` is one address to a reader and no substring
of the markup, and editing the markup directly destroys a tag or leaves half an
entity behind. Script and style content is skipped. `href` and `src` are
collected separately — not shown as reviewable text, because nobody reads a
link target, but reached by the accepted-value sweep, because a `mailto:` link
is a copy of the address.

### Export

The message is **not rebuilt**. Everything is a byte-range replacement on the
original, so a part nobody edited comes out identical to the byte: boundaries,
carried-through attachments, nested messages.

Four rewrites, four hazards:

- **Headers.** Cutting characters out of `John Smith <john@example.com>` has to
  leave something that is still an address header. RFC 2047 is applied per
  phrase, never to the whole value: encoding the brackets turns syntax into
  payload.
- **Text.** Offsets are into the decoded text, so a body is decoded, cut and
  re-encoded — as quoted-printable in UTF-8, with the charset parameter
  rewritten. Writing it back in the original charset would mean being able to
  encode every charset that exists; writing it back raw means a removal could
  leave a line starting with two hyphens, colliding with the boundary that
  contains it. This happens only to a part that was actually edited.
- **Filenames.** They live in header parameters, so they are a header rewrite
  with a different shape.
- **Attachments.** A part's *body* is replaced with bytes that did not come
  from this message at all — see below.

### Attachments are documents, and a message with them is a batch

A reviewer's mental model is not "the message". It is "this email". Someone who
uploads a message with `2026-review-John Smith.pdf` attached, watches the
filename get redacted and downloads the result must not be handed a covering
letter that is clean and an enclosure that is not — the name gone from five
places and intact in the sixth, in the one format where documents actually
travel.

So **a message that carries attachments in supported formats is expanded into a
batch.** The message is one document; each supported attachment is another. If
the `.eml` arrived on its own a batch is created for it; if it arrived in a
batch already, the children join that one — the reviewer's decisions already
span it, and "this recurring name is a colleague, not a subject", answered in
the covering letter, is the same answer in the enclosure.

Expansion is a step of its own, between ingest and extraction, because that is
the first moment the tree is knowable: reservation runs before the browser has
uploaded anything, so there are no bytes to parse and the declared MIME type is
a guess. Each attachment's kind is decided from **its bytes**, never from its
filename or its declared content type, both of which a stranger chose.

Two columns carry provenance: the parent document, and the MIME part path the
bytes came from (`0.3`). The part path rather than the filename — filenames
collide, filenames get redacted, and only the path is actually unique and
actually stable. It is also unique in the database against the parent, which is
what makes a retried expansion unable to produce a second copy of a part.

From there a child is a first-class document: its own run, its own extraction,
its own detectors, its own review, its own export. Nothing downstream can tell
that it arrived inside a message rather than off a desktop, and that
indistinguishability is what keeps this from becoming a second, weaker
pipeline.

**Quota.** An attachment costs what the same file would cost uploaded on its
own: one `uploads` count, plus its own per-kind allowance when its extraction
knows the real size. A message is not a discount, for the same reason a batch
is not one. Two differences follow from the bytes already existing by the time
we charge. The `uploads` charge is a pre-check at reservation and there is
nothing to refuse in advance here, so an attachment the allowance does not
cover becomes a child that is **present, named and explicitly skipped**,
carrying the reason the reviewer would have got at upload time — never a silent
drop, because an attachment missing from the batch with no row for it is a
reviewer believing they have seen everything. And the charge is written in the
same transaction as the child row, so a retry that re-parses the message from
scratch cannot bill it twice.

**Its own limits.** `emlLimits` bounds parsing; expansion is a different cost
with a different amplification factor, so it has its own bounds in the same
fail-closed style with the same environment overrides: how many children one
message may produce (the same ceiling as a batch a person can upload — a
message must not be a way to make a larger one), total expanded bytes, the
largest single attachment, and **expansion depth**, which is a second recursion
axis: a `message/rfc822` attached as raw bytes is sniffed as a message, becomes
a child and expands its own attachments in turn, orthogonally to
`maxNestedMessages`. Exceeding one refuses the whole message with a reason,
never a partial expansion presented as a complete one.

### What that does to the message's own export

Once a redacted child exists, an archive holding a clean PDF *and* an `.eml`
that still carries the original PDF is worse than the honest carry-through it
replaced: before, the documentation told you the enclosure was untouched;
after, the archive shows you a redacted enclosure while shipping the
unredacted one inside the message. Trusted, and wrong.

So the redacted bytes are **substituted back into the message** — a byte-range
replacement of the attachment part's body, re-encoded as base64, with the
transfer encoding and any `Content-Length` rewritten to match. This is the one
rewrite here whose content did not come from the message, which is why it is
the one verified by equality rather than by absence: a replacement that landed
one part over produces a message that parses, opens and contains none of the
accepted values while carrying the wrong file. Each substituted part is decoded
again and required to hash to exactly the child artifact, and `postal-mime` is
asked whether an independent reader sees those bytes at all.

Every attachment gets one of three answers, and the export report names which:

| Disposition | When | What the message carries |
| --- | --- | --- |
| `redacted` | the child exported and verified | the child's own artifact |
| `carried-through` | a format this cannot read — a `.zip`, an `.exe` | the original bytes, unchanged and *stated* |
| `removed` | not ready, failed, or skipped for quota | a short note in place of the bytes |

Silently carrying through is the one option that is off the table. A removal
leaves the part rather than deleting it, so a reader can still see that
something was enclosed and what became of it, and it stops claiming to be a
PDF.

Inline `cid:` images take the same road as everything else: they are
attachments in the MIME sense and body content to a reader, so they are
redacted as image children and substituted back, which is what keeps the
rendered body coherent.

What remains deliberately unclaimed: an attachment in a format Anonify does not
read is carried through with nothing inside it redacted, and an attachment more
than `maxDepth` messages deep is refused rather than expanded.

### Resource limits

An email is the one format here that arrives from strangers by design, and MIME
is a recursive container with no natural bound. The parser is therefore bounded
and **fails closed**: MIME depth, part count, decoded text, header block size,
attachment count and nested-message depth, each overridable by environment
variable (see `.env.example`). Exceeding one is a refusal with a reason, never
a truncated document presented as a complete one — a reviewer shown eight of a
message's twelve parts and told nothing has been handed a redaction they cannot
trust.

These are deliberately independent of the upload ceiling. Raising the size a
message may be must never be the same decision as allowing unlimited
complexity.

### Verified by

**Two parsers.** Ours can enumerate the tree — every header, every decoded
body, every filename, at every depth — but a redaction system checking its own
work with its own parser is grading its own homework, and the failure that
matters is an output only this code can read. `postal-mime` is the independent
reader: if it cannot parse the export, the export failed, whatever happened to
the sensitive string.

---

## PPTX — four places, one of them on the screen

### The problem

A deck keeps text in `ppt/slides/`, `ppt/notesSlides/`, `ppt/slideLayouts/` and
`ppt/slideMasters/`. The speaker notes are the ones people are most surprised
by — not projected, not printed, shipped with the file — and a client name in a
template footer lives on the master, which no slide contains. Reading only the
slides leaves three of the four in the exported document.

### Extraction

Each slide becomes a page with its notes attached, because that is how a
reviewer thinks about a deck. Layouts and masters get their own pages rather
than being repeated under every slide that uses one, which would offer the same
run for review a dozen times.

Slide order comes from the deck's own `sldIdLst` through the relationships, not
from the filenames: reordering slides in PowerPoint rewrites the list and leaves
the filenames alone, so numeric order would review a rearranged deck backwards.

Runs are addressed exactly as Word's are — `ppt/slides/slide2.xml#p0r1` — and
the machinery is the same code. `w:p/w:r/w:t` and `a:p/a:r/a:t` are one
structure under two namespaces, so `lib/documents/ooxml/` holds the package
access, the text-node surgery, the run walking and the addressing, and each
format supplies its tag names.

### Export

The `a:t` nodes are rewritten in place and every text-bearing part is swept —
which is where the notes, the layout and the master are caught.

### Verified by

The whole package rather than the visible slide text, and reopening the export
as an OOXML package to confirm every part is still there.

---

## What they share

Every pipeline produces the same shape:

```ts
NormalizedDocument {
  pages:   NormalizedPage[]     // pdf, docx, image, txt, rtf, eml, pptx
  sheets?: SpreadsheetSheet[]   // xlsx, csv, tsv
  regions?: ImageRegion[]       // image
}
```

`NormalizedPage` carries a flat `text` stream plus `spans` whose offsets index
into it. That single convention is why one detector, one entity expander, one
inspector and one review flow serve ten formats — and why a detection made
against the normalized text can always be traced back to a run, a glyph box, a
cell, a character offset or a MIME header.

The span's `id` *is* the source address, and each format decides what that
means: `word/header1.xml#p3r1` for a Word run, `ppt/slides/slide2.xml#p0r1` for
a slide, `text#1042` for a character offset, `part:0.1/body#248` for a place in
a message. The exporter parses the address rather than searching for the value,
which is what keeps "the second occurrence of this email" from being a question
anybody has to answer.

And every pipeline ends the same way: the artifact is re-opened, read
adversarially, and refused if an accepted value survived.
