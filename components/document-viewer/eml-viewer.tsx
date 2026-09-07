"use client"

import { Fragment, useState, type CSSProperties, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import {
  activeBodyId,
  bodySections,
  cellsOf,
  inlineRuns,
  linesOf,
  piecesOf,
  sectionsOf,
  type InlineRole,
  type InlineRun,
  type MarkdownLine,
  type MarkdownPiece,
} from "@/lib/documents/eml/markdown"
import { cn } from "@/lib/utils"
import type { NormalizedPage, PageSection } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * Rendering a page of an email.
 *
 * A message is not one document. It is a header block, then the same body
 * written twice — once as `text/plain` and once as HTML — then whatever it
 * carried, and then all of that again for every message forwarded inside it.
 * Drawn as one undifferentiated stream it reads as a wall of near-duplicate
 * text, which is how a reviewer came to read the same paragraph twice without
 * noticing it was the same paragraph.
 *
 * So the extractor names those stretches (`PageSection`) and this draws them as
 * sections that fold:
 *
 *   headers      open, and stays open — From/To/Subject is the orientation for
 *                everything below it, so nothing here ever closes it. It can
 *                still be folded by hand, because a message with twenty
 *                `Received` lines is a wall of its own.
 *   bodies       an accordion. The HTML body is what the sender composed and
 *                what the recipient saw, so it is the one that opens; the
 *                `text/plain` alternative is the fallback, in both senses.
 *                Opening one closes the other, because they are the same
 *                message and reading both is reading it twice.
 *   attachments  folded, with a count.
 *
 * ## A folded section must never hide unreviewed work
 *
 * This is the hazard the whole feature introduces, and it is the one thing here
 * that is not a matter of taste. Folding the `text/plain` alternative because
 * an HTML body exists would hide a suggestion nobody has actioned, and a
 * reviewer who exports believing they have seen the message is exactly the
 * failure this product exists to prevent.
 *
 * So: every folded section carries its counts, and a section holding
 * suggestions nobody has decided on **opens regardless of the default**. It
 * folds only once the reviewer has folded it themselves — a default this code
 * chose is never allowed to be the reason something went unread.
 *
 * ## Safety
 *
 * Nothing here is ever handed raw markup. There is no `dangerouslySetInnerHTML`
 * and no URL from the message reaches an `href`, a `src` or any other attribute
 * a browser would fetch: a tracking pixel cannot phone home from a reviewer's
 * screen, because its markup became text long before it got here.
 */

const PAGE_MARGIN = 72

const MONOSPACE = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const BODY_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

type Renderer = (spanId: string, children: ReactNode) => ReactNode

// --- inline -----------------------------------------------------------------

function styleOf(run: InlineRun): CSSProperties {
  return {
    fontWeight: run.bold ? 600 : undefined,
    fontStyle: run.italic || run.role === "image" ? "italic" : undefined,
    fontFamily: run.code ? MONOSPACE : undefined,
    textDecoration: run.role === "link" ? "underline" : undefined,
    fontSize: run.role === "url" ? "0.85em" : undefined,
  }
}

function classOf(role: InlineRole): string | undefined {
  if (role === "link") return "text-primary"
  if (role === "url" || role === "image") return "text-neutral-500"
  return undefined
}

function Inline({
  pieces,
  renderSpan,
}: {
  pieces: MarkdownPiece[]
  renderSpan?: Renderer
}) {
  return (
    <>
      {inlineRuns(pieces).map((run) => {
        const content = (
          <span
            data-span-id={run.spanId ?? undefined}
            className={classOf(run.role)}
            style={styleOf(run)}
          >
            {run.role === "image" ? `🖼 ${run.text}` : run.text}
          </span>
        )

        return (
          <Fragment key={run.key}>
            {run.spanId && renderSpan ? renderSpan(run.spanId, content) : content}
          </Fragment>
        )
      })}
    </>
  )
}

// --- blocks -----------------------------------------------------------------

const HEADING_SIZES = ["1.5em", "1.3em", "1.15em", "1.05em", "1em", "0.95em"]

function Blocks({
  lines,
  renderSpan,
}: {
  lines: MarkdownLine[]
  renderSpan?: Renderer
}): ReactNode {
  const nodes: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.kind === "blank") {
      index += 1
      continue
    }

    if (line.quote > 0) {
      const end = quoteRunEnd(lines, index)
      nodes.push(
        <blockquote
          key={`q${line.start}`}
          className="my-2 border-l-2 border-neutral-300 pl-3 text-neutral-600"
        >
          <Blocks
            lines={lines.slice(index, end).map(stripQuote)}
            renderSpan={renderSpan}
          />
        </blockquote>
      )
      index = end
      continue
    }

    if (line.kind === "fence") {
      let end = index + 1
      while (end < lines.length && lines[end].kind !== "fence") end += 1
      nodes.push(
        <pre
          key={`f${line.start}`}
          className="my-2 overflow-x-auto rounded-[3px] bg-neutral-100 p-3 text-[0.9em]"
          style={{ fontFamily: MONOSPACE }}
        >
          {lines.slice(index + 1, end).map((inner) => (
            <div key={inner.start}>
              <Inline pieces={inner.pieces} renderSpan={renderSpan} />
            </div>
          ))}
        </pre>
      )
      index = end + 1
      continue
    }

    if (line.kind === "rule") {
      nodes.push(<hr key={`r${line.start}`} className="my-4 border-neutral-300" />)
      index += 1
      continue
    }

    if (line.kind === "heading") {
      nodes.push(
        <p
          key={`h${line.start}`}
          role="heading"
          aria-level={line.level}
          className="mt-4 mb-2 font-semibold"
          style={{ fontSize: HEADING_SIZES[line.level - 1] ?? "1em" }}
        >
          <Inline pieces={line.pieces} renderSpan={renderSpan} />
        </p>
      )
      index += 1
      continue
    }

    if (line.kind === "row" || line.kind === "separator") {
      const end = runEnd(
        lines,
        index,
        (candidate) => candidate.kind === "row" || candidate.kind === "separator"
      )
      nodes.push(
        <Table
          key={`b${line.start}`}
          lines={lines.slice(index, end)}
          renderSpan={renderSpan}
        />
      )
      index = end
      continue
    }

    if (line.kind === "item") {
      const end = runEnd(lines, index, (candidate) => candidate.kind === "item")
      nodes.push(
        <List
          key={`l${line.start}`}
          lines={lines.slice(index, end)}
          depth={line.indent}
          renderSpan={renderSpan}
        />
      )
      index = end
      continue
    }

    const end = runEnd(lines, index, (candidate) => candidate.kind === "paragraph")
    nodes.push(
      <p key={`p${line.start}`} className="my-2">
        {lines.slice(index, end).map((inner, offset) => (
          <Fragment key={inner.start}>
            {offset > 0 ? <br /> : null}
            <Inline pieces={inner.pieces} renderSpan={renderSpan} />
          </Fragment>
        ))}
      </p>
    )
    index = end
  }

  return <>{nodes}</>
}

function runEnd(
  lines: MarkdownLine[],
  from: number,
  matches: (line: MarkdownLine) => boolean
): number {
  let end = from
  while (end < lines.length && lines[end].quote === 0 && matches(lines[end])) {
    end += 1
  }
  return end
}

/**
 * Where a quoted run ends.
 *
 * Blank lines inside it are absorbed: the extractor puts one between the
 * paragraphs of a quote, and ending the block there would draw one reply as
 * two.
 */
function quoteRunEnd(lines: MarkdownLine[], from: number): number {
  let end = from
  let last = from

  while (end < lines.length) {
    if (lines[end].quote > 0) {
      end += 1
      last = end
      continue
    }
    if (lines[end].kind === "blank") {
      end += 1
      continue
    }
    break
  }

  return last
}

/** One level of quoting removed, so the block inside can be read normally. */
function stripQuote(line: MarkdownLine): MarkdownLine {
  return line.quote > 0 ? { ...line, quote: line.quote - 1 } : line
}

function List({
  lines,
  depth,
  renderSpan,
}: {
  lines: MarkdownLine[]
  depth: number
  renderSpan?: Renderer
}) {
  const items: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    // A deeper run belongs to the item above it rather than to this list.
    if (line.indent > depth) {
      let end = index
      while (end < lines.length && lines[end].indent > depth) end += 1
      items.push(
        <List
          key={`n${line.start}`}
          lines={lines.slice(index, end)}
          depth={line.indent}
          renderSpan={renderSpan}
        />
      )
      index = end
      continue
    }

    items.push(
      <li key={line.start} className="my-1">
        <Inline pieces={line.pieces} renderSpan={renderSpan} />
      </li>
    )
    index += 1
  }

  return lines[0]?.ordered ? (
    <ol className="my-2 list-decimal pl-6">{items}</ol>
  ) : (
    <ul className="my-2 list-disc pl-6">{items}</ul>
  )
}

function Table({
  lines,
  renderSpan,
}: {
  lines: MarkdownLine[]
  renderSpan?: Renderer
}) {
  const rows = lines
    .filter((line) => line.kind === "row")
    .map((line) => cellsOf(line.pieces))
  if (rows.length === 0) return null

  // The extractor writes the header rule under the first row, so a table that
  // has one is a table whose first row is its header.
  const header = lines.some((line) => line.kind === "separator")
  const [first, ...rest] = rows

  return (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[0.95em]">
        {header ? (
          <thead>
            <tr>
              {first.map((cell, column) => (
                <th
                  key={column}
                  className="border border-neutral-300 px-2 py-1 text-left align-top font-semibold"
                >
                  <Inline pieces={cell} renderSpan={renderSpan} />
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {(header ? rest : rows).map((cells, row) => (
            <tr key={row}>
              {cells.map((cell, column) => (
                <td
                  key={column}
                  className="border border-neutral-300 px-2 py-1 align-top"
                >
                  <Inline pieces={cell} renderSpan={renderSpan} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The flat stream: headers, `text/plain` parts, attachment lines.
 *
 * Fixed-width and drawn as itself, because none of it has typography of its own
 * and reflowing a header block moves the things a reader uses to orient.
 */
function Plain({
  page,
  section,
  renderSpan,
}: {
  page: NormalizedPage
  section: { start: number; end: number }
  renderSpan?: Renderer
}) {
  return (
    <div
      style={{
        fontFamily: MONOSPACE,
        fontSize: "10pt",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {piecesOf(page, section.start, section.end).map((piece) => {
        if (!piece.span) return <span key={`g${piece.start}`}>{piece.text}</span>

        const span = piece.span
        const content = <span data-span-id={span.id}>{piece.text}</span>
        return (
          <Fragment key={`s${piece.start}`}>
            {renderSpan ? renderSpan(span.id, content) : content}
          </Fragment>
        )
      })}
    </div>
  )
}

function Body({
  page,
  section,
  renderSpan,
}: {
  page: NormalizedPage
  section: PageSection
  renderSpan?: Renderer
}) {
  return section.markdown ? (
    <Blocks
      lines={linesOf(page, section.start, section.end)}
      renderSpan={renderSpan}
    />
  ) : (
    <Plain page={page} section={section} renderSpan={renderSpan} />
  )
}

// --- sections ---------------------------------------------------------------

type Counts = { accepted: number; suggested: number }

/** What is inside a section, so a folded one can still say so. */
function countsIn(section: PageSection, redactions: Redaction[]): Counts {
  let accepted = 0
  let suggested = 0

  for (const redaction of redactions) {
    if (redaction.start === undefined || redaction.end === undefined) continue
    if (redaction.end <= section.start || redaction.start >= section.end) continue
    if (redaction.status === "accepted") accepted += 1
    else if (redaction.status === "suggested") suggested += 1
  }

  return { accepted, suggested }
}

function SectionHeader({
  section,
  counts,
  open,
  onToggle,
}: {
  section: PageSection
  counts: Counts
  open: boolean
  onToggle: () => void
}) {
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`section-${section.id}`}
      className={cn(
        "flex w-full items-center gap-1.5 border-b py-1 text-left",
        "border-neutral-200 text-neutral-500 hover:text-neutral-800",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
      )}
    >
      <Chevron aria-hidden className="size-3 shrink-0" />
      <span className="text-[8pt] tracking-[0.12em] uppercase">
        {section.label}
      </span>

      <span className="ml-auto flex items-center gap-2 text-[8pt] tabular-nums">
        {counts.suggested > 0 ? (
          <span className="text-primary">{counts.suggested} to review</span>
        ) : null}
        {counts.accepted > 0 ? <span>{counts.accepted} redacted</span> : null}
      </span>
    </button>
  )
}

/**
 * Which sections start open.
 *
 * A section holding suggestions nobody has decided on opens whatever the
 * default says, and stays open until the reviewer folds it themselves. See the
 * note at the top of this file: a default must never be the reason something
 * went unread.
 */
function defaultOpen(
  section: PageSection,
  active: string | null,
  counts: Counts
): boolean {
  if (counts.suggested > 0) return true
  if (section.kind === "headers") return true
  if (section.kind === "attachments") return false
  return section.id === active
}

export function EmlViewer({
  page,
  zoom,
  renderSpan,
  redactions = [],
  variant = "editor",
  width = page.width,
  padding,
  children,
}: {
  page: NormalizedPage
  zoom: number
  renderSpan?: Renderer
  redactions?: Redaction[]
  /**
   * The width to lay the page out at, before `zoom`. Defaults to the page's
   * own, which is what the canvas wants. The page rail overrides it: `612 x
   * 792` is invented by the extractor rather than measured off anything, so a
   * thumbnail is free to reflow the same content into a narrower page instead
   * of reducing this one until the type is smaller than a pixel.
   */
  width?: number
  padding?: number
  /**
   * `preview` is the page rail: the message's body alone, at thumbnail size,
   * with no chrome and nothing folded. Headers and attachment lines are left
   * out — a column of tiles all showing `From:` tells a reviewer nothing about
   * which page they are looking for.
   */
  variant?: "editor" | "preview"
  children?: ReactNode
}) {
  const sections = sectionsOf(page)
  const bodies = bodySections(page)
  const active = activeBodyId(page)

  // What the reviewer has opened or closed by hand, which always wins.
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const isOpen = (section: PageSection): boolean =>
    touched[section.id] ??
    defaultOpen(section, active, countsIn(section, redactions))

  const toggle = (section: PageSection) => {
    const opening = !isOpen(section)
    setTouched((current) => {
      const next = { ...current, [section.id]: opening }
      // The bodies are one accordion: they are the same message written twice,
      // so reading both is reading it twice.
      if (opening && section.kind !== "headers" && section.kind !== "attachments") {
        for (const other of bodies) {
          if (other.id !== section.id) next[other.id] = false
        }
      }
      return next
    })
  }

  const height = (page.height / page.width) * width

  if (variant === "preview") {
    // Markdown if the message had an HTML body, the plain body otherwise. A
    // plain-text email is ordinary, and rendering nothing for one puts back the
    // column of blank rectangles this rail exists to avoid.
    const markdown = bodies.filter((section) => section.markdown)
    const shown = markdown.length > 0 ? markdown : bodies

    return (
      <div
        className="origin-top-left bg-document text-document-foreground"
        style={{
          width,
          minHeight: height,
          padding: padding ?? PAGE_MARGIN / 2,
          transform: `scale(${zoom})`,
          fontFamily: BODY_FONT,
          fontSize: "10.5pt",
          lineHeight: 1.55,
          wordBreak: "break-word",
        }}
      >
        {shown.map((section) => (
          <Body
            key={section.id}
            page={page}
            section={section}
            renderSpan={renderSpan}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="relative shadow-document"
      style={{ width: width * zoom, minHeight: height * zoom }}
    >
      <div
        className="origin-top-left bg-document text-document-foreground"
        style={{
          width,
          minHeight: height,
          padding: padding ?? PAGE_MARGIN,
          transform: `scale(${zoom})`,
          fontFamily: BODY_FONT,
          fontSize: "10.5pt",
          lineHeight: 1.55,
          wordBreak: "break-word",
        }}
      >
        {sections.map((section) => {
          const counts = countsIn(section, redactions)
          const open = isOpen(section)

          return (
            <section
              key={`${section.id}-${section.start}`}
              className="mb-5"
              // A message forwarded inside this one is stepped in, so a thread
              // reads as the nest of messages it is.
              style={{ marginLeft: (section.depth ?? 0) * 16 }}
            >
              <SectionHeader
                section={section}
                counts={counts}
                open={open}
                onToggle={() => toggle(section)}
              />

              <div id={`section-${section.id}`} hidden={!open} className="pt-2">
                <Body page={page} section={section} renderSpan={renderSpan} />
              </div>
            </section>
          )
        })}
      </div>
      {children}
    </div>
  )
}
