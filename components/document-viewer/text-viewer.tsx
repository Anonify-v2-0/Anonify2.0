"use client"

import type { ReactNode } from "react"

import type { NormalizedPage, TextSpan } from "@/types/document"

/**
 * Rendering a page of plain text.
 *
 * Every span is drawn as its own element carrying its id, which is what lets a
 * highlight or an accepted redaction sit over the exact characters a detector
 * matched — the same contract the DOCX renderer honours, for the same reason.
 *
 * The characters between spans belong to no span. They are the line breaks and
 * the padding the extractor inserted, and they are rendered as themselves so
 * the page reads as the file does. Nothing can be redacted there because there
 * is nothing there: a redaction addresses characters that came from the source.
 */

const PAGE_MARGIN = 72

type Piece =
  | { kind: "span"; span: TextSpan }
  | { kind: "gap"; text: string; key: string }

/** Walks the page's text stream, alternating spans and the gaps between them. */
function piecesOf(page: NormalizedPage): Piece[] {
  const ordered = [...page.spans].sort((a, b) => a.start - b.start)
  const pieces: Piece[] = []
  let cursor = 0

  for (const span of ordered) {
    if (span.start > cursor) {
      pieces.push({
        kind: "gap",
        text: page.text.slice(cursor, span.start),
        key: `gap-${cursor}`,
      })
    }
    pieces.push({ kind: "span", span })
    cursor = Math.max(cursor, span.end)
  }

  if (cursor < page.text.length) {
    pieces.push({
      kind: "gap",
      text: page.text.slice(cursor),
      key: `gap-${cursor}`,
    })
  }

  return pieces
}

export function TextViewer({
  page,
  zoom,
  renderSpan,
  children,
}: {
  page: NormalizedPage
  zoom: number
  renderSpan?: (spanId: string, children: ReactNode) => ReactNode
  children?: ReactNode
}) {
  return (
    <div
      className="relative shadow-document"
      style={{ width: page.width * zoom, minHeight: page.height * zoom }}
    >
      <div
        className="origin-top-left bg-document text-document-foreground"
        style={{
          width: page.width,
          minHeight: page.height,
          padding: PAGE_MARGIN,
          transform: `scale(${zoom})`,
          // Monospaced, because a text file has no typography of its own and
          // pretending otherwise moves the columns of anything aligned.
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "10.5pt",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {piecesOf(page).map((piece) => {
          if (piece.kind === "gap") {
            return <span key={piece.key}>{piece.text}</span>
          }

          const content = (
            <span data-span-id={piece.span.id}>{piece.span.text}</span>
          )
          return (
            <span key={piece.span.id}>
              {renderSpan ? renderSpan(piece.span.id, content) : content}
            </span>
          )
        })}
      </div>
      {children}
    </div>
  )
}
