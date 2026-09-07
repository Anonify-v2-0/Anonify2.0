"use client"

import { Fragment, type CSSProperties, type ReactNode } from "react"

import {
  cellsOf,
  inlineRuns,
  linesOf,
  piecesOf,
  sectionsOf,
  type InlineRole,
  type InlineRun,
  type MarkdownLine,
  type MarkdownPiece,
  type MarkdownSection,
} from "@/lib/documents/eml/markdown"
import { cn } from "@/lib/utils"
import type { NormalizedPage } from "@/types/document"

/**
 * Rendering a page of an email.
 *
 * A message is two things at once. Its headers, its `text/plain` alternative
 * and its attachment lines are a flat stream, and have always been drawn as
 * one: fixed-width, exactly as they arrived. Its HTML bodies are not — they
 * were authored with headings, lists and tables, and flattening those into the
 * same wall of text lost the only thing that made the message readable.
 *
 * So the extractor writes an HTML body out as markdown and the page says which
 * of its characters that covers. This draws those ranges as the document they
 * describe and leaves everything else alone.
 *
 * Reading the markdown is `lib/documents/eml/markdown.ts`; this file is the
 * drawing. Nothing here is ever handed raw markup: there is no
 * `dangerouslySetInnerHTML` and no URL from the message reaches an `href`, a
 * `src` or any other attribute a browser would fetch. A tracking pixel cannot
 * phone home from a reviewer's screen, because its markup became text long
 * before it got here.
 */

const PAGE_MARGIN = 72

const MONOSPACE = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

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

// --- the page ---------------------------------------------------------------

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
  section: MarkdownSection
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

export function EmlViewer({
  page,
  zoom,
  renderSpan,
  children,
}: {
  page: NormalizedPage
  zoom: number
  renderSpan?: Renderer
  children?: ReactNode
}) {
  return (
    <div
      className="relative shadow-document"
      style={{ width: page.width * zoom, minHeight: page.height * zoom }}
    >
      <div
        className={cn("origin-top-left bg-document text-document-foreground")}
        style={{
          width: page.width,
          minHeight: page.height,
          padding: PAGE_MARGIN,
          transform: `scale(${zoom})`,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
          fontSize: "10.5pt",
          lineHeight: 1.55,
          wordBreak: "break-word",
        }}
      >
        {sectionsOf(page).map((section) =>
          section.markdown ? (
            <Blocks
              key={`m${section.start}`}
              lines={linesOf(page, section.start, section.end)}
              renderSpan={renderSpan}
            />
          ) : (
            <Plain
              key={`t${section.start}`}
              page={page}
              section={section}
              renderSpan={renderSpan}
            />
          )
        )}
      </div>
      {children}
    </div>
  )
}
