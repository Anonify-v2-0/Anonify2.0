"use client"

import type { CSSProperties, ReactNode } from "react"

import type {
  DocxBlock,
  DocxParagraph,
  DocxRegion,
  DocxRun,
  NormalizedPage,
  TextStyle,
} from "@/types/document"

/**
 * Editorial rendering of a DOCX page.
 *
 * The document keeps its own formatting — headings, weights, alignment, tables
 * — on a white surface inside the dark workspace. Every run carries its span id
 * so highlights and accepted redactions can be drawn over the exact characters
 * the detector matched.
 */

const PAGE_MARGIN = 72

/**
 * Headers, footers, footnotes and comments are shown as labelled bands around
 * the body. They used to be swept at export but never displayed, which meant a
 * name appearing only in a header could never be reviewed — the user was
 * trusting a removal they could not see.
 */
const REGION_LABELS: Partial<Record<DocxRegion, string>> = {
  header: "Header",
  footer: "Footer",
  footnote: "Footnotes",
  endnote: "Endnotes",
  comment: "Comments",
}

function styleOf(style: TextStyle | undefined): CSSProperties | undefined {
  if (!style) return undefined
  return {
    fontWeight: style.bold ? 600 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
    fontSize: style.fontSize ? `${style.fontSize}pt` : undefined,
    fontFamily: style.fontFamily,
    color: style.color,
  }
}

function Run({
  run,
  renderSpan,
}: {
  run: DocxRun
  renderSpan?: (spanId: string, children: ReactNode) => ReactNode
}) {
  const content = (
    <span data-span-id={run.id} style={styleOf(run.style)}>
      {run.text}
    </span>
  )
  return <>{renderSpan ? renderSpan(run.id, content) : content}</>
}

function Paragraph({
  paragraph,
  renderSpan,
}: {
  paragraph: DocxParagraph
  renderSpan?: (spanId: string, children: ReactNode) => ReactNode
}) {
  const children = paragraph.runs.map((run) => (
    <Run key={run.id} run={run} renderSpan={renderSpan} />
  ))

  const style: CSSProperties = {
    textAlign: paragraph.alignment,
    marginLeft: paragraph.indent ? `${paragraph.indent}pt` : undefined,
    marginTop: paragraph.spacingBefore ? `${paragraph.spacingBefore}pt` : undefined,
    marginBottom: paragraph.spacingAfter ? `${paragraph.spacingAfter}pt` : "0.6em",
  }

  if (paragraph.headingLevel) {
    const sizes = ["1.6em", "1.35em", "1.18em", "1.08em", "1em", "0.95em"]
    return (
      <p
        role="heading"
        aria-level={paragraph.headingLevel}
        style={{
          ...style,
          fontSize: sizes[paragraph.headingLevel - 1] ?? "1em",
          fontWeight: 600,
          marginTop: "1em",
          marginBottom: "0.4em",
        }}
      >
        {children}
      </p>
    )
  }

  if (paragraph.listLevel !== undefined) {
    return (
      <p style={{ ...style, marginLeft: `${(paragraph.listLevel + 1) * 24}pt` }}>
        <span aria-hidden className="mr-2">
          •
        </span>
        {children}
      </p>
    )
  }

  // A paragraph with no runs is a blank line the author put there on purpose.
  return <p style={style}>{children.length > 0 ? children : " "}</p>
}

function Block({
  block,
  renderSpan,
}: {
  block: DocxBlock
  renderSpan?: (spanId: string, children: ReactNode) => ReactNode
}) {
  if (block.type === "paragraph") {
    return <Paragraph paragraph={block} renderSpan={renderSpan} />
  }

  return (
    <table className="my-3 w-full border-collapse text-[0.95em]">
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className="border border-neutral-300 px-2 py-1 align-top"
              >
                {cell.map((paragraph) => (
                  <Paragraph
                    key={paragraph.id}
                    paragraph={paragraph}
                    renderSpan={renderSpan}
                  />
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Groups consecutive blocks by region, preserving extraction order. */
function groupByRegion(
  blocks: DocxBlock[]
): { region: DocxRegion; blocks: DocxBlock[] }[] {
  const groups: { region: DocxRegion; blocks: DocxBlock[] }[] = []

  for (const block of blocks) {
    const region = block.region ?? "body"
    const last = groups[groups.length - 1]
    if (last && last.region === region) last.blocks.push(block)
    else groups.push({ region, blocks: [block] })
  }

  return groups
}

export function DocxViewer({
  page,
  zoom,
  renderSpan,
  width = page.width,
  padding = PAGE_MARGIN,
  children,
}: {
  page: NormalizedPage
  zoom: number
  renderSpan?: (spanId: string, children: ReactNode) => ReactNode
  /**
   * The width to lay the page out at, before `zoom`. Defaults to the page's
   * own, which is what the canvas wants. The page rail overrides it: `612 x
   * 792` is invented by the extractor rather than measured off anything, so a
   * thumbnail is free to reflow the same content into a narrower page instead
   * of reducing this one until the type is smaller than a pixel.
   */
  width?: number
  padding?: number
  children?: ReactNode
}) {
  const height = (page.height / page.width) * width

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
          padding,
          transform: `scale(${zoom})`,
          fontFamily: "Calibri, Carlito, Helvetica, Arial, sans-serif",
          fontSize: "11pt",
          lineHeight: 1.5,
        }}
      >
        {groupByRegion(page.blocks ?? []).map((group) =>
          group.region === "body" ? (
            <div key={group.region}>
              {group.blocks.map((block) => (
                <Block key={block.id} block={block} renderSpan={renderSpan} />
              ))}
            </div>
          ) : (
            <section
              key={group.region}
              aria-label={REGION_LABELS[group.region] ?? group.region}
              className="my-3 border-y border-dashed border-neutral-300 py-2"
            >
              <p className="mb-1 text-[8pt] tracking-[0.14em] text-neutral-500 uppercase">
                {REGION_LABELS[group.region] ?? group.region}
              </p>
              {group.blocks.map((block) => (
                <Block key={block.id} block={block} renderSpan={renderSpan} />
              ))}
            </section>
          )
        )}
        {children}
      </div>
    </div>
  )
}
