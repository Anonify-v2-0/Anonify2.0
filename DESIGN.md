# Visual Design System: Dark Editorial Redaction Workspace

The visual identity of the application must be derived from the supplied reference CSS.

The product should feel like a combination of:

* editorial/document software
* dark creative tooling
* security/redaction software
* minimalist developer tooling

The interface should be visually bold but not overloaded.

The central visual concept is:

**charcoal black workspace + pure red action/redaction accent + white document surfaces + muted gray typography.**

Do not turn the application into a generic purple-gradient AI SaaS dashboard. Avoid the standard "AI startup" aesthetic of gradients, glassmorphism everywhere, excessive rounded cards, and floating blobs.

---

# 1. Core Color Palette

Use CSS variables/Tailwind theme tokens derived from the supplied CSS.

Primary:

```css
--primary: #ff0000;
```

Secondary/background:

```css
--background: #212429;
```

Text:

```css
--text-primary: #ffffff;
--text-secondary: #d1d5db;
--text-muted: #a3a0a7;
```

Document surface:

```css
--document: #ffffff;
```

Dark surface variations:

```css
--surface-1: #212429;
--surface-2: #181a1d;
--surface-3: #111214;
```

Borders:

```css
--border-dark: rgba(255, 255, 255, 0.10);
--border-light: rgba(255, 255, 255, 0.18);
```

Red variations:

```css
--red: #ff0000;
--red-hover: #e60000;
--red-soft: rgba(255, 0, 0, 0.12);
--red-border: rgba(255, 0, 0, 0.55);
```

Do not use many unrelated colors.

The visual hierarchy should primarily come from:

* brightness
* spacing
* typography
* borders
* red accents

---

# 2. Typography

The reference uses Poppins for the primary visual language.

Use:

```text
Poppins
```

as the primary interface font where practical.

For large editorial headings, use a clean modern sans-serif fallback:

```text
Helvetica Neue
Roboto
Helvetica
Arial
sans-serif
```

Typography should be:

* bold
* clean
* slightly geometric
* high contrast
* spacious

Suggested hierarchy:

```text
Hero title:
48–64px / bold

Workspace document title:
20–28px / semibold

Section headings:
16–20px / semibold

Body:
14–16px

Metadata:
12–13px

Micro labels:
11–12px
```

Avoid excessively tiny UI text.

---

# 3. Global Visual Language

The application should default to a dark interface.

The document itself remains white/light because users need to inspect the actual document.

Therefore:

```text
Application chrome = dark

Document canvas = white

Redaction controls = red

Redaction preview = red

Secondary information = muted gray
```

This contrast should make the document feel like a physical/light artifact sitting inside a dark editing environment.

Conceptually:

```text
┌──────────────────────────────────────────────────────────────┐
│ DARK APPLICATION CHROME                                      │
│                                                              │
│    ┌──────────────────────────────────────────────┐          │
│    │                                              │          │
│    │              WHITE DOCUMENT                 │          │
│    │                                              │          │
│    │      text text text █████████               │          │
│    │                         ↑                    │          │
│    │                    redaction                │          │
│    │                                              │          │
│    └──────────────────────────────────────────────┘          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

# 4. Navbar

The navbar should inherit the reference's strong, simple structure.

Use:

* dark background
* red logo/brand
* minimal navigation
* generous horizontal spacing
* approximately 64–80px desktop height

Example:

```text
┌──────────────────────────────────────────────────────────────┐
│ REDACTR                         Document.pdf     Export       │
└──────────────────────────────────────────────────────────────┘
```

The logo should use the primary red.

Do not create a large marketing navigation once the user is inside the editor.

Workspace navigation should be functional.

Suggested controls:

```text
Logo

← Documents

Document name

Processing status

Save status

Export
```

---

# 5. Landing Page

The landing page should use the same visual language as the reference.

Dark charcoal background.

Large red headline.

Muted gray explanatory text.

Large dashed red upload boundary.

Example composition:

```text
                     REDACT SENSITIVE DATA
                       WITHOUT THE DRAMA

              PDF · DOCX · XLSX · IMAGE

        ┌─────────────────────────────────────┐
        │                                     │
        │          Drop your document         │
        │                                     │
        │              ↓                      │
        │                                     │
        │        [ Select File ]              │
        │                                     │
        └─────────────────────────────────────┘

                  Temporary by default
                  Automatic expiration
```

The upload area should use:

```css
border: 1px dashed #ff0000;
border-radius: 10px;
```

The upload area should have subtle hover behavior.

On hover:

```text
border becomes brighter
background gains subtle red tint
```

Do not use huge glowing effects.

---

# 6. Buttons

Buttons should be inspired directly by:

```css
border-radius: 5rem;
background: #ff0000;
color: #ffffff;
```

Primary buttons should be pill-shaped.

Example:

```text
[ Export Redacted Document ]
```

Primary button:

```css
background: #ff0000;
color: #ffffff;
border-radius: 9999px;
```

Hover:

```css
background: #ffffff;
color: #ff0000;
```

This red/white inversion should become a recognizable interaction pattern throughout the product.

Secondary buttons should use:

```text
transparent/dark background
white or gray border
white text
```

Destructive actions can use red but should not become visually indistinguishable from normal actions.

---

# 7. Redaction Visual Language

Red should be the visual language of "sensitive."

This is extremely important.

Use red consistently for:

* AI-detected sensitive text
* active redaction
* redaction handles
* sensitive spreadsheet cells
* selected image regions
* warnings
* export redaction actions
* sensitive entity badges

However, distinguish between:

```text
AI suggestion
```

and

```text
accepted redaction
```

Suggested visual states:

AI suggestion:

```css
background: rgba(255, 0, 0, 0.10);
border: 1px dashed rgba(255, 0, 0, 0.6);
```

Accepted redaction:

```css
background: #ff0000;
color: #ffffff;
```

Rejected/ignored:

```text
neutral gray
```

User-created:

```text
solid red outline
```

Global rule:

```text
red + small global/rule icon
```

This should make the canvas immediately understandable.

---

# 8. Workspace Layout

Use a dark full-screen editor.

Recommended desktop layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ REDACTR     document.pdf       ● Processing       EXPORT    │
├───────────────┬─────────────────────────────┬───────────────┤
│               │                             │               │
│ PAGES         │                             │ REDACTIONS    │
│               │                             │               │
│ ┌───────────┐ │       DOCUMENT CANVAS       │ 23 found      │
│ │ Page 1    │ │                             │               │
│ └───────────┘ │       ┌─────────────┐       │ Email         │
│               │       │             │       │ Person        │
│ ┌───────────┐ │       │   DOCUMENT  │       │ Phone         │
│ │ Page 2    │ │       │             │       │ Address       │
│ └───────────┘ │       │             │       │               │
│               │       └─────────────┘       │               │
│ ┌───────────┐ │                             │               │
│ │ Page 3    │ │                             │               │
│ └───────────┘ │                             │               │
│               │                             │               │
├───────────────┴─────────────────────────────┴───────────────┤
│ SELECT   REDACT   ZOOM −   100%   ZOOM +      UNDO   REDO   │
└─────────────────────────────────────────────────────────────┘
```

Use dark panels rather than floating white cards.

---

# 9. Canvas

The document canvas should be the visual focal point.

The surrounding editor should be dark charcoal.

The document should be:

```text
white
slightly elevated
subtle shadow
```

Example:

```css
box-shadow:
  0 8px 30px rgba(0, 0, 0, 0.30);
```

Do not apply shadows excessively to every UI component.

The document itself should appear tangible against the dark workspace.

---

# 10. Page Thumbnails

The page navigator should be dark.

Each page thumbnail should look like a miniature white document.

Selected page:

```css
border: 1px solid #ff0000;
```

Unselected page:

```css
border: 1px solid rgba(255,255,255,0.1);
```

Page numbers should use muted gray.

Hover should subtly brighten the thumbnail.

---

# 11. Redaction Inspector

The inspector should be dark rather than white.

Example:

```text
REDACTIONS

23 suggestions

FILTER
[ All ] [ AI ] [ Manual ]

────────────────────

EMAIL
john@example.com

98% confidence

[ Accept ] [ Ignore ]

────────────────────

PERSON
John Smith

94% confidence

[ Accept ] [ Ignore ]
```

Use red sparingly to identify active elements.

Do not put a red background behind the entire inspector.

---

# 12. AI Processing Animation

The supplied CSS contains a strong cinematic loading animation.

Adapt that idea into the product.

Instead of a generic spinner, use:

```text
ANALYZING DOCUMENT
```

with subtle character/word transitions.

Example:

```text
READING
UNDERSTANDING
DETECTING
REVIEWING
PREPARING
```

Use:

* opacity transitions
* slight blur
* vertical movement
* subtle rotation where appropriate

Do not make the animation slow enough that users wonder whether the server has died.

---

# 13. Progress UI

Processing should visually resemble:

```text
EXTRACTING          ✓
STRUCTURING         ✓
ANALYZING           ●
PREPARING CANVAS    ○
```

The active stage should use red.

Completed stages should use muted/white.

Avoid rainbow progress bars.

---

# 14. Cards and Panels

Do not overuse rounded cards.

Preferred:

```text
border-radius: 8px–12px
```

for panels.

Use larger pill radius only for:

* buttons
* filters
* tags
* compact controls

This keeps the interface editorial rather than toy-like.

---

# 15. Borders

Borders should be subtle.

Use:

```css
border: 1px solid rgba(255,255,255,0.08);
```

for dark UI boundaries.

Use red borders for:

* selected tools
* redaction candidates
* upload zones
* active states

Do not outline every component in red.

---

# 16. Shadows

Use shadows primarily for:

* document pages
* floating menus
* dialogs
* elevated editor controls

Reference:

```css
box-shadow: -8px 8px 20px rgba(0, 0, 0, 0.4);
```

Adapt this more subtly for modern UI.

Avoid shadows around every button.

---

# 17. Background

The supplied reference uses a background image.

For the first implementation, reproduce the visual effect without requiring a specific image asset.

Use a dark charcoal background with optional subtle texture.

If a background image is later introduced, it should be:

* very dark
* abstract
* low contrast
* non-distracting

The document must remain the strongest visual element.

---

# 18. Motion

Use motion sparingly.

Reference behaviors worth retaining:

### Hero entrance

Text can subtly slide/fade into position.

### Floating artwork

Illustrations can have extremely subtle vertical motion.

### Loading

Use:

```text
opacity
blur
transform
```

for processing states.

### UI interactions

Use 150–250ms transitions.

Avoid:

* excessive bouncing
* parallax everywhere
* spinning cards
* animated gradients
* unnecessary 3D

The product is a document editor, not a theme park.

---

# 19. Icons

Use Lucide.

Icons should generally be:

* 16px
* 18px
* 20px
* occasionally 24px

Use icons for:

* upload
* document types
* redaction
* eye/preview
* undo/redo
* zoom
* export
* settings
* delete
* check
* X
* warning
* AI processing

The reference's Bootstrap icons can therefore be replaced with Lucide equivalents.

---

# 20. File Type Visual Identity

Use small red file-type indicators.

Examples:

```text
PDF
DOCX
XLSX
IMG
```

Do not introduce four completely different color schemes.

They should all belong to the same red/white/charcoal system.

---

# 21. Spreadsheet Editor Styling

The spreadsheet should retain the same dark application chrome.

The spreadsheet itself can remain white/light.

Sensitive cells:

```text
red border
red tint
```

Selected cells:

```text
red outline
```

Sensitive column:

```text
red header indicator
```

Example:

```text
             EMAIL          PHONE          NAME
          ┌───────────┐
  1       │███████████│
          └───────────┘
  2       │███████████│
  3       │███████████│
```

The editor should clearly show whether the user is redacting:

```text
Cell
Row
Column
```

---

# 22. Image Editor Styling

Image editing should retain the same dark canvas.

Use:

```text
dark background
image centered
red selection rectangle
red handles
```

Detected faces:

```text
red bounding box
FACE
98%
```

Detected text:

```text
subtle red outline
```

When accepted, the preview becomes the actual redaction appearance.

---

# 23. Mobile Design

Adapt the editor to a phone rather than shrinking the desktop one. The document
stays the strongest element on screen, and black still means exactly what the
export will produce. As built (see docs/editor.md §18):

```text
header            logo · back · filename · Export
search strip      (when open) field, then a row of options and Redact this / Redact all
canvas            the page at the width of the screen
                  ‹ 3 / 12 ›  page stepper floating over its bottom edge
action bar        Redact · Search · Review · Hush · More
```

Everything else is a **bottom sheet**: the review list, the pages grid, the
search results, Hush, the More menu, and every dialog. One sheet component, one
behaviour everywhere: a drag handle, snap points (peek, half, full), swipe down
to close, focus trapped inside and returned on close, and inert while closed.

- **Action bar.** Icons with visible labels, never tooltips: a tooltip never
  appears on a touch screen. The pressed item is red on a soft red pill.
  Review carries its count as a red badge.
- **Sheets** are `surface-2` with a 14 px top radius and a short white/25 handle.
  Sheets that leave the page usable (Review, results, Hush) rest on top of the
  action bar. Menus (More, Pages) cover it, over a black/50 backdrop.
- **Hush** opens full height for typing. When a reply points at a place in the
  document, it drops to half so the place is visible above it.
- **Canvas chrome** is thinner: 12 px of padding rather than 32.
- **Touch targets** are at least 44 × 44 CSS px on a coarse pointer. A
  redaction's painted box never grows to meet that. A tap resolves to the
  nearest word or redaction instead.
- **Tap feedback.** What a tap redacts flashes red for half a second, because
  there is no hover state to show what it will take. With reduced motion the
  flash is a still outline.
- **Tap a redaction** for a small `surface-2` menu anchored to it. Accept is
  the red soft button and always a separate press.
- **Safe areas.** `viewport-fit=cover`, and every fixed edge (header, action
  bar, sheets, toasts) steps in by `env(safe-area-inset-*)`.

---

# 24. Responsive Breakpoints

Use Tailwind's breakpoints for **layout**, and the pointer for **input**:

```text
Phone:        < 640px    (sm)   dialogs become bottom sheets
              < 768px    (md)   search results become a sheet
Tablet:       640–1024px (lg)   page rail and Hush rail appear at lg
Desktop:      > 1024px          inspector rail at xl (1280px)
```

Two custom variants combine the two (`app/globals.css`, mirrored for scripts in
`lib/editor/layout.ts`):

```text
compact   width < 768px, or a coarse pointer and width < 1024px
          → action bar, sheets, second search row
roomy     everything else
          → desktop toolbar, retention in the header
```

So a touch tablet in portrait gets the phone layout, and the same tablet in
landscape, or with a trackpad, gets the desktop one. Use `pointer-coarse:` for
target sizes, never a width.

Do not use fixed viewport dimensions such as:

```css
width: 100vw;
```

throughout the application. Heights that must fit the screen use `svh` (the
smallest viewport, with the browser's bars shown), so nothing hides behind a
toolbar that has not collapsed yet.

Prefer:

```text
w-full
min-h-screen
max-w-screen-*
```

and flex/grid layouts. No page scrolls horizontally, apart from the canvas and
the spreadsheet grid.

The reference CSS can inspire the visual proportions but should not be copied literally.

---

# 25. Landing Page Responsive Composition

Desktop:

```text
Hero content     60%
Hero illustration 40%
```

Tablet/mobile:

```text
Illustration
Title
Description
Upload
```

The visual hierarchy should remain:

```text
Brand
 ↓
Red headline
 ↓
Short explanation
 ↓
Upload interaction
 ↓
Privacy/TTL information
```

---

# 26. Empty States

Empty states should follow the same aesthetic.

Example:

```text
NO DOCUMENT

Your workspace is waiting.

[ Upload Document ]
```

Use red for the primary action and muted gray for explanation.

---

# 27. Error States

Use restrained red rather than huge warning banners.

Example:

```text
PROCESSING FAILED

We couldn't analyze this document.

Your original file was not modified.

[ Retry ]
```

Use the red accent around the important action.

---

# 28. Success State

After export:

```text
REDACTION COMPLETE

Your document has been permanently redacted.

23 sensitive items removed
Metadata sanitized
Integrity verified

[ Download ]
```

Use a white/gray success presentation with red primary action.

Do not introduce green unless absolutely necessary.

The product's palette should remain disciplined.

---

# 29. Overall Visual Personality

The finished interface should communicate:

```text
Precise
Serious
Editorial
Technical
Secure
Minimal
Bold
```

It should NOT communicate:

```text
Corporate enterprise dashboard
Generic AI chatbot
Cyberpunk hacker interface
Overly playful productivity app
Glassmorphism template
```

The red accent should feel intentional and editorial.

The dark charcoal environment should frame the document.

The white document should remain the source of truth visually.

---

# 30. Design Token Implementation

Implement the palette as Tailwind/shadcn-compatible CSS variables.

Example:

```css
:root {
  --background: 220 7% 15%;
  --foreground: 0 0% 100%;

  --card: 220 7% 12%;
  --card-foreground: 0 0% 100%;

  --primary: 0 100% 50%;
  --primary-foreground: 0 0% 100%;

  --secondary: 220 7% 20%;
  --secondary-foreground: 0 0% 100%;

  --muted: 220 6% 24%;
  --muted-foreground: 220 13% 82%;

  --border: 0 0% 100% / 0.10;

  --destructive: 0 100% 50%;
}
```

Adjust the exact HSL values as necessary to make the resulting UI visually match the reference.

The application should remain accessible with sufficient contrast.

---

# 31. Final Design Principle

Treat the red accent as a semantic color:

```text
RED = ACTION / SENSITIVE / ATTENTION
```

Treat charcoal as:

```text
CHARCOAL = WORKSPACE / CHROME
```

Treat white as:

```text
WHITE = DOCUMENT / PRIMARY CONTENT
```

Treat gray as:

```text
GRAY = SECONDARY INFORMATION
```
