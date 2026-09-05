import {
  PART_SEPARATOR,
  parseSpanAddress,
  spanAddress,
} from "@/lib/documents/ooxml/runs"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import {
  attr,
  childrenOf,
  findChild,
  listParts,
  nodeName,
  openPackage,
  readPart,
  WORD_TEXT_PARTS,
  xmlParser,
  type XmlNode,
} from "@/lib/documents/ooxml/package"
import type {
  DocxBlock,
  DocxParagraph,
  DocxRegion,
  DocxRun,
  DocxTable,
  NormalizedDocument,
  NormalizedPage,
  TextStyle,
} from "@/types/document"

/**
 * DOCX extraction.
 *
 * Walks word/document.xml in document order and gives every paragraph and run a
 * positional address (p3r1). Export re-walks the identical order, so an address
 * captured here still points at the same run later — no markers are injected
 * into the user's file to make that work.
 */

const HALF_POINTS_PER_POINT = 2
const TWIPS_PER_POINT = 20

function textOfRun(runNode: XmlNode): string {
  let text = ""
  for (const child of childrenOf(runNode)) {
    const name = nodeName(child)
    if (name === "w:t") {
      const parts = childrenOf(child)
      for (const part of parts) {
        if ("#text" in part) text += String(part["#text"])
      }
    } else if (name === "w:tab") {
      text += "\t"
    } else if (name === "w:br") {
      text += "\n"
    } else if (name === "w:noBreakHyphen") {
      text += "-"
    }
  }
  return text
}

function runStyle(runNode: XmlNode): TextStyle | undefined {
  const properties = findChild(childrenOf(runNode), "w:rPr")
  if (!properties) return undefined

  const style: TextStyle = {}
  for (const child of childrenOf(properties)) {
    switch (nodeName(child)) {
      case "w:b":
        style.bold = attr(child, "w:val") !== "0"
        break
      case "w:i":
        style.italic = attr(child, "w:val") !== "0"
        break
      case "w:u":
        style.underline = attr(child, "w:val") !== "none"
        break
      case "w:sz": {
        const halfPoints = Number(attr(child, "w:val"))
        if (Number.isFinite(halfPoints)) {
          style.fontSize = halfPoints / HALF_POINTS_PER_POINT
        }
        break
      }
      case "w:color": {
        const value = attr(child, "w:val")
        if (value && value !== "auto") style.color = `#${value}`
        break
      }
      case "w:rFonts":
        style.fontFamily = attr(child, "w:ascii") ?? attr(child, "w:hAnsi")
        break
    }
  }

  return Object.keys(style).length > 0 ? style : undefined
}

type ParagraphProps = Pick<
  DocxParagraph,
  "headingLevel" | "listLevel" | "alignment" | "indent" | "spacingBefore" | "spacingAfter"
>

function paragraphProps(paragraphNode: XmlNode): ParagraphProps {
  const properties = findChild(childrenOf(paragraphNode), "w:pPr")
  const props: ParagraphProps = {}
  if (!properties) return props

  for (const child of childrenOf(properties)) {
    switch (nodeName(child)) {
      case "w:pStyle": {
        const value = attr(child, "w:val") ?? ""
        const heading = /^Heading(\d)$/i.exec(value)
        if (heading) props.headingLevel = Number(heading[1])
        break
      }
      case "w:jc": {
        const value = attr(child, "w:val")
        if (value === "center" || value === "right" || value === "justify") {
          props.alignment = value
        } else if (value === "left" || value === "start") {
          props.alignment = "left"
        }
        break
      }
      case "w:numPr": {
        const level = findChild(childrenOf(child), "w:ilvl")
        props.listLevel = level ? Number(attr(level, "w:val") ?? 0) : 0
        break
      }
      case "w:ind": {
        const left = Number(attr(child, "w:left") ?? attr(child, "w:start"))
        if (Number.isFinite(left)) props.indent = left / TWIPS_PER_POINT
        break
      }
      case "w:spacing": {
        const before = Number(attr(child, "w:before"))
        const after = Number(attr(child, "w:after"))
        if (Number.isFinite(before)) props.spacingBefore = before / TWIPS_PER_POINT
        if (Number.isFinite(after)) props.spacingAfter = after / TWIPS_PER_POINT
        break
      }
    }
  }

  return props
}

/**
 * Explicit page breaks, of which Word has two and they mean opposite things.
 *
 * `<w:br w:type="page"/>` is a run inside a paragraph: everything up to it
 * belongs to the page that is ending. `<w:pageBreakBefore/>` is a paragraph
 * property: the paragraph carrying it starts the next page. Reading only the
 * first — which is what this did — silently ignored every break made with
 * Word's "Page break before" formatting.
 */
type PageBreak = "after" | "before" | null

function pageBreakOf(paragraphNode: XmlNode): PageBreak {
  const properties = findChild(childrenOf(paragraphNode), "w:pPr")
  if (properties) {
    for (const child of childrenOf(properties)) {
      if (nodeName(child) !== "w:pageBreakBefore") continue
      // Present means on unless it says otherwise.
      const value = attr(child, "w:val")
      if (value !== "0" && value !== "false") return "before"
    }
  }

  for (const run of childrenOf(paragraphNode)) {
    if (nodeName(run) !== "w:r") continue
    for (const child of childrenOf(run)) {
      if (nodeName(child) === "w:br" && attr(child, "w:type") === "page") {
        return "after"
      }
    }
  }
  return null
}

/**
 * Paragraphs and runs are addressed by their position in document order, which
 * is exactly the order the exporter re-discovers them in. Both walks must agree
 * or an accepted redaction would land on the wrong run, so both count every
 * paragraph and every run, wherever they are nested.
 */
class Counter {
  private nextParagraph = 0
  private nextTable = 0

  paragraph(): number {
    return this.nextParagraph++
  }

  table(): number {
    return this.nextTable++
  }
}

/** Collects `w:r` descendants in document order (runs nest inside hyperlinks). */
function collectRuns(node: XmlNode, into: XmlNode[] = []): XmlNode[] {
  for (const child of childrenOf(node)) {
    const name = nodeName(child)
    if (name === "w:r") {
      into.push(child)
    } else if (name !== "w:pPr" && name !== "w:rPr") {
      collectRuns(child, into)
    }
  }
  return into
}

// Addresses are qualified by the part they live in, because each part is walked
// — and later re-walked by the exporter — independently. `word/header1.xml#p0r1`
// is the second run of the first paragraph of that header. The scheme is shared
// with the PowerPoint pipeline, so it lives with the run machinery.
export { PART_SEPARATOR, parseSpanAddress, spanAddress }

type PartContext = { part: string; region: DocxRegion; counter: Counter }

function buildParagraph(
  paragraphNode: XmlNode,
  context: PartContext
): DocxParagraph {
  const index = context.counter.paragraph()
  const runs: DocxRun[] = []

  collectRuns(paragraphNode).forEach((runNode, runIndex) => {
    const text = textOfRun(runNode)
    if (text.length === 0) return
    runs.push({
      id: spanAddress(context.part, index, runIndex),
      text,
      style: runStyle(runNode),
    })
  })

  return {
    id: `${context.part}${PART_SEPARATOR}p${index}`,
    type: "paragraph",
    region: context.region,
    part: context.part,
    runs,
    ...paragraphProps(paragraphNode),
  }
}

function buildTable(tableNode: XmlNode, context: PartContext): DocxTable {
  const id = `${context.part}${PART_SEPARATOR}tbl${context.counter.table()}`
  const rows: DocxParagraph[][][] = []

  for (const rowNode of childrenOf(tableNode)) {
    if (nodeName(rowNode) !== "w:tr") continue
    const cells: DocxParagraph[][] = []

    for (const cellNode of childrenOf(rowNode)) {
      if (nodeName(cellNode) !== "w:tc") continue
      const paragraphs: DocxParagraph[] = []
      for (const child of childrenOf(cellNode)) {
        const name = nodeName(child)
        if (name === "w:p") {
          paragraphs.push(buildParagraph(child, context))
        } else if (name === "w:tbl") {
          // A nested table still contributes its paragraphs in document order.
          for (const nested of buildTable(child, context).rows.flat(2)) {
            paragraphs.push(nested)
          }
        }
      }
      cells.push(paragraphs)
    }

    rows.push(cells)
  }

  return { id, type: "table", region: context.region, part: context.part, rows }
}

/**
 * Collects paragraphs and tables from anywhere in a part, in document order.
 *
 * Each part wraps its content differently — `w:body`, `w:hdr`, `w:ftr`,
 * `w:footnote`, `w:comment` — so rather than encode every wrapper this walks
 * through anything that is not itself a block. Tables are not descended into
 * here; `buildTable` handles their paragraphs so they are counted exactly once.
 */
function collectBlocks(
  node: XmlNode,
  context: PartContext,
  into: DocxBlock[] = [],
  onPageBreak?: (blockCount: number, kind: PageBreak) => void
): DocxBlock[] {
  for (const child of childrenOf(node)) {
    const name = nodeName(child)
    if (name === "w:p") {
      const breaks = pageBreakOf(child)
      into.push(buildParagraph(child, context))
      // Reported as a position rather than by handing the caller a new array:
      // the walker keeps pushing into `into`, so swapping it out here would
      // silently send the rest of the document to the previous page.
      if (breaks) onPageBreak?.(into.length, breaks)
    } else if (name === "w:tbl") {
      into.push(buildTable(child, context))
    } else if (name !== "w:sectPr" && name !== "w:pPr") {
      collectBlocks(child, context, into, onPageBreak)
    }
  }
  return into
}

/** Maps a part path onto the region it represents. */
export function regionOfPart(part: string): DocxRegion {
  if (/^word\/header\d*\.xml$/.test(part)) return "header"
  if (/^word\/footer\d*\.xml$/.test(part)) return "footer"
  if (part === "word/footnotes.xml") return "footnote"
  if (part === "word/endnotes.xml") return "endnote"
  if (part === "word/comments.xml") return "comment"
  return "body"
}

/** Default Word page geometry (US Letter at 72dpi), used by the renderer. */
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

/**
 * Pagination.
 *
 * A DOCX does not record where its pages end. Word decides that while laying
 * the document out, and the file only ever contains the breaks an author typed
 * by hand — which most documents do not have at all. Splitting on those alone
 * produced a single page holding the entire document, and the workspace showed
 * one endless sheet with a page rail of one.
 *
 * So the height is estimated instead, from the same numbers the viewer renders
 * with (see components/document-viewer/docx-viewer.tsx — 11pt Calibri at
 * line-height 1.5 inside a 72pt margin). It is an estimate and it will not
 * agree with Word to the line: proportional glyph widths vary by font, and
 * nothing here does kerning or widow control. It does not need to. Pages are a
 * unit of *review* — somewhere to be in a long document, and something for a
 * redaction to be filed under — and the export addresses runs by id, so where
 * a boundary falls cannot move a redaction or change a byte of the output.
 *
 * Being wrong is therefore visible and harmless: a page that runs slightly long
 * grows, because the viewer's box has a minimum height and no maximum.
 */
const PAGE_MARGIN = 72
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2
const CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_MARGIN * 2

const BASE_FONT_PT = 11
const LINE_HEIGHT = 1.5
/** Heading sizes as a multiple of the base, matching the viewer's scale. */
const HEADING_SCALE = [1.6, 1.35, 1.18, 1.08, 1, 0.95]
/** Average glyph advance as a fraction of the font size, for proportional text. */
const GLYPH_ADVANCE = 0.5
/** Paragraph spacing the viewer applies when the document specifies none. */
const PARAGRAPH_GAP = BASE_FONT_PT * 0.6
/** Vertical padding a table row costs beyond its text. */
const ROW_PADDING = 8
/** The viewer's `my-3` around a table. */
const TABLE_MARGIN = 12

function paragraphHeight(paragraph: DocxParagraph): number {
  const scale = paragraph.headingLevel
    ? (HEADING_SCALE[paragraph.headingLevel - 1] ?? 1)
    : 1
  const fontSize =
    paragraph.runs.reduce(
      (largest, run) => Math.max(largest, run.style?.fontSize ?? 0),
      0
    ) || BASE_FONT_PT * scale

  const indent =
    (paragraph.indent ?? 0) +
    (paragraph.listLevel !== undefined ? (paragraph.listLevel + 1) * 24 : 0)
  const width = Math.max(72, CONTENT_WIDTH - indent)

  const characters = paragraph.runs.reduce(
    (total, run) => total + run.text.length,
    0
  )
  const perLine = Math.max(1, Math.floor(width / (fontSize * GLYPH_ADVANCE)))
  // An empty paragraph is a blank line the author put there on purpose, and it
  // occupies one.
  const lines = Math.max(1, Math.ceil(characters / perLine))

  const before =
    paragraph.spacingBefore ?? (paragraph.headingLevel ? BASE_FONT_PT : 0)
  const after =
    paragraph.spacingAfter ??
    (paragraph.headingLevel ? BASE_FONT_PT * 0.4 : PARAGRAPH_GAP)

  return lines * fontSize * LINE_HEIGHT + before + after
}

function tableHeight(table: DocxTable): number {
  const rows = table.rows.reduce((total, row) => {
    const tallest = row.reduce(
      (highest, cell) =>
        Math.max(
          highest,
          cell.reduce((sum, paragraph) => sum + paragraphHeight(paragraph), 0)
        ),
      0
    )
    return total + tallest + ROW_PADDING
  }, 0)

  return rows + TABLE_MARGIN * 2
}

function blockHeight(block: DocxBlock): number {
  return block.type === "paragraph" ? paragraphHeight(block) : tableHeight(block)
}

/**
 * Splits blocks into pages, honouring every explicit break and estimating the
 * rest. `forcedAfter` holds block counts, so a value of 3 ends a page after the
 * third block — the shape the walker reports breaks in.
 *
 * A block is never split across pages. One taller than a whole page gets a page
 * to itself and overflows it, which is the honest rendering of a table that
 * genuinely does not fit.
 */
function paginate(
  blocks: DocxBlock[],
  forcedAfter: Set<number>,
  forcedBefore: Set<number>,
  firstPageReserved = 0
): DocxBlock[][] {
  const pages: DocxBlock[][] = []
  let current: DocxBlock[] = []
  let height = 0
  let budget = CONTENT_HEIGHT - firstPageReserved

  const flush = () => {
    pages.push(current)
    current = []
    height = 0
    budget = CONTENT_HEIGHT
  }

  blocks.forEach((block, index) => {
    const blockSize = blockHeight(block)
    if (current.length > 0 && (forcedBefore.has(index) || height + blockSize > budget)) {
      flush()
    }

    current.push(block)
    height += blockSize

    if (forcedAfter.has(index + 1)) flush()
  })

  if (current.length > 0 || pages.length === 0) pages.push(current)
  return pages
}

function pageFrom(number: number, blocks: DocxBlock[]): NormalizedPage {
  const builder = new TextStreamBuilder()

  const emitParagraph = (paragraph: DocxParagraph) => {
    for (const run of paragraph.runs) {
      builder.append(run.id, run.text, { blockId: paragraph.id, style: run.style })
    }
    builder.pad("\n")
  }

  for (const block of blocks) {
    if (block.type === "paragraph") {
      emitParagraph(block)
      continue
    }
    for (const row of block.rows) {
      for (const cell of row) {
        for (const paragraph of cell) emitParagraph(paragraph)
      }
    }
  }

  return {
    number,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    text: builder.text,
    spans: builder.spans,
    blocks,
  }
}

export type DocxExtraction = {
  document: NormalizedDocument
}

/**
 * Order the regions appear in on page one. Headers and footers apply to the
 * whole document, so they are attached to the first page rather than repeated
 * on every one — repeating them would produce a duplicate suggestion per page
 * for the same underlying run.
 */
const REGION_ORDER: DocxRegion[] = [
  "header",
  "body",
  "footnote",
  "endnote",
  "comment",
  "footer",
]

export function extractDocx(
  documentId: string,
  bytes: Uint8Array
): DocxExtraction {
  const pkg = openPackage(bytes)
  const bodyXml = readPart(pkg, "word/document.xml")
  if (!bodyXml) {
    throw new Error("word/document.xml is missing; the file is not a DOCX")
  }

  const parser = xmlParser()

  const blocksOfPart = (
    part: string,
    onPageBreak?: (blockCount: number, kind: PageBreak) => void
  ): DocxBlock[] => {
    const xml = readPart(pkg, part)
    if (!xml) return []

    const context: PartContext = {
      part,
      region: regionOfPart(part),
      counter: new Counter(),
    }

    const blocks: DocxBlock[] = []
    for (const node of parser.parse(xml) as XmlNode[]) {
      collectBlocks(node, context, blocks, onPageBreak)
    }
    return blocks
  }

  // The body is the only part that paginates.
  const breakAfter = new Set<number>()
  const breakBefore = new Set<number>()
  const bodyBlocks = blocksOfPart("word/document.xml", (count, kind) => {
    if (kind === "before") breakBefore.add(count - 1)
    else breakAfter.add(count)
  })

  // Headers, footers, footnotes and comments carry text the exporter already
  // sweeps. Extracting them is what makes that text reviewable, so what the
  // user sees matches what the export touches.
  const surrounding = listParts(pkg, WORD_TEXT_PARTS)
    .filter((part) => part !== "word/document.xml")
    .sort()
    .flatMap((part) => blocksOfPart(part))

  // Those bands are rendered above the body on page one, so page one has less
  // room for body text than the others.
  const bodyPages = paginate(
    bodyBlocks,
    breakAfter,
    breakBefore,
    surrounding.reduce((total, block) => total + blockHeight(block), 0)
  )

  const pages = bodyPages.map((blocks, index) => {
    const combined =
      index === 0 ? orderRegions([...surrounding, ...blocks]) : blocks
    return pageFrom(index + 1, combined)
  })

  return {
    document: {
      documentId,
      kind: "docx",
      pages,
      metadata: {
        pageCount: pages.length,
        parts: listParts(pkg, WORD_TEXT_PARTS).sort(),
      },
    },
  }
}

function orderRegions(blocks: DocxBlock[]): DocxBlock[] {
  return [...blocks].sort(
    (a, b) =>
      REGION_ORDER.indexOf(a.region ?? "body") -
      REGION_ORDER.indexOf(b.region ?? "body")
  )
}
