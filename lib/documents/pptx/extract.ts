import {
  attr,
  childrenOf,
  listParts,
  nodeName,
  openPackage,
  PPTX_SLIDE_PARTS,
  PPTX_TEXT_PARTS,
  readPart,
  xmlParser,
  type OoxmlPackage,
  type XmlNode,
} from "@/lib/documents/ooxml/package"
import { spanAddress } from "@/lib/documents/ooxml/runs"
import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type { NormalizedDocument, NormalizedPage } from "@/types/document"

/**
 * PPTX extraction.
 *
 * A deck hides text in four places and only one of them is on the screen:
 *
 *   ppt/slides/*.xml        what the audience sees
 *   ppt/notesSlides/*.xml   the speaker notes, which is where people write
 *                           the things they did not want on the slide
 *   ppt/slideLayouts/*.xml  the template's placeholder text
 *   ppt/slideMasters/*.xml  the same, one level up — a client name in a
 *                           footer that appears on every slide lives here
 *
 * Extracting only the slides would leave three of the four unreviewed, and the
 * notes are the one people are most surprised by: they are not printed, not
 * projected, and shipped with the file.
 *
 * Each slide becomes a page, with its notes attached to it, because that is
 * how a reviewer thinks about a deck. Layouts and masters follow as their own
 * pages, labelled, since they belong to the deck rather than to any one slide.
 *
 * Runs are addressed exactly as Word's are — `ppt/slides/slide2.xml#p0r1` —
 * and the exporter re-walks each part in the same order, which is what makes
 * the address still name the same run later.
 */

/** Deck geometry at 72dpi: 16:9, which is what PowerPoint defaults to. */
const PAGE_WIDTH = 960
const PAGE_HEIGHT = 540

export type PptxExtraction = {
  document: NormalizedDocument
  /** Slide parts in presentation order. */
  slides: string[]
}

/** Text of one `a:r`, including the breaks that contribute characters. */
function textOfRun(runNode: XmlNode): string {
  let text = ""
  for (const child of childrenOf(runNode)) {
    const name = nodeName(child)
    if (name === "a:t") {
      for (const part of childrenOf(child)) {
        if ("#text" in part) text += String(part["#text"])
      }
    } else if (name === "a:br") {
      text += "\n"
    }
  }
  return text
}

/** Text of an `a:fld`, which carries slide numbers and dates. */
function textOfField(fieldNode: XmlNode): string {
  let text = ""
  for (const child of childrenOf(fieldNode)) {
    if (nodeName(child) !== "a:t") continue
    for (const part of childrenOf(child)) {
      if ("#text" in part) text += String(part["#text"])
    }
  }
  return text
}

type ParagraphContent = {
  runs: { index: number; text: string }[]
  /** Field text, which is not in a run and so cannot be run-addressed. */
  fields: { index: number; text: string }[]
}

/**
 * Collects a paragraph's runs in document order.
 *
 * Only `a:r` elements are counted, and the count has to match what the
 * exporter's `scanElements` finds — a field is not a run, so counting one
 * would shift every index after it and land an edit on the wrong text.
 */
function contentOfParagraph(paragraphNode: XmlNode): ParagraphContent {
  const runs: ParagraphContent["runs"] = []
  const fields: ParagraphContent["fields"] = []

  let runIndex = 0
  let fieldIndex = 0

  const walk = (node: XmlNode) => {
    for (const child of childrenOf(node)) {
      const name = nodeName(child)
      if (name === "a:r") {
        const text = textOfRun(child)
        const index = runIndex++
        if (text.length > 0) runs.push({ index, text })
      } else if (name === "a:fld") {
        const text = textOfField(child)
        const index = fieldIndex++
        if (text.length > 0) fields.push({ index, text })
      } else if (name !== "a:pPr" && name !== "a:endParaRPr") {
        walk(child)
      }
    }
  }

  walk(paragraphNode)
  return { runs, fields }
}

/** Every `a:p` in a part, in document order. */
function paragraphsOf(node: XmlNode, into: XmlNode[] = []): XmlNode[] {
  for (const child of childrenOf(node)) {
    if (nodeName(child) === "a:p") {
      into.push(child)
      continue
    }
    paragraphsOf(child, into)
  }
  return into
}

type PartText = { part: string; paragraphs: ParagraphContent[] }

function readPartText(pkg: OoxmlPackage, part: string): PartText | null {
  const xml = readPart(pkg, part)
  if (!xml) return null

  const parser = xmlParser()
  const paragraphs: ParagraphContent[] = []

  for (const node of parser.parse(xml) as XmlNode[]) {
    for (const paragraph of paragraphsOf(node)) {
      paragraphs.push(contentOfParagraph(paragraph))
    }
  }

  return { part, paragraphs }
}

/** Appends a part's text to a page's stream, with addressed spans. */
function appendPart(builder: TextStreamBuilder, content: PartText): void {
  content.paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const run of paragraph.runs) {
      builder.append(
        spanAddress(content.part, paragraphIndex, run.index),
        run.text
      )
    }
    for (const field of paragraph.fields) {
      // A field's text is not in a run, so it has no run address. It is still
      // shown — a reviewer should see it — and the package-wide sweep is what
      // removes it if they accept it.
      builder.append(
        `${content.part}#p${paragraphIndex}fld${field.index}`,
        field.text
      )
    }
    builder.pad("\n")
  })
}

/** Relationship targets of a part, resolved against `ppt/`. */
function relationships(
  pkg: OoxmlPackage,
  part: string
): { id: string; target: string }[] {
  const slash = part.lastIndexOf("/")
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
  const xml = readPart(pkg, relsPath)
  if (!xml) return []

  const parser = xmlParser()
  const found: { id: string; target: string }[] = []

  const walk = (node: XmlNode) => {
    if (nodeName(node) === "Relationship") {
      const id = attr(node, "Id")
      const target = attr(node, "Target")
      if (id && target) found.push({ id, target })
    }
    for (const child of childrenOf(node)) walk(child)
  }

  for (const node of parser.parse(xml) as XmlNode[]) walk(node)
  return found
}

/** Normalizes `../slides/slide1.xml` against the part that referenced it. */
function resolveTarget(from: string, target: string): string {
  const base = from.slice(0, from.lastIndexOf("/"))
  const stack = base.split("/")

  for (const piece of target.split("/")) {
    if (piece === "..") stack.pop()
    else if (piece !== ".") stack.push(piece)
  }
  return stack.join("/")
}

/**
 * The deck's slides in presentation order.
 *
 * File numbering is not the order: reordering slides in PowerPoint rewrites
 * `sldIdLst` and leaves the filenames alone, so a deck whose slides were moved
 * would be reviewed out of order. The rels are the authority; numeric order is
 * the fallback for a package that has lost them.
 */
export function slideOrder(pkg: OoxmlPackage): string[] {
  const numeric = listParts(pkg, PPTX_SLIDE_PARTS).sort((a, b) => {
    const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
    return number(a) - number(b)
  })

  const presentation = readPart(pkg, "ppt/presentation.xml")
  if (!presentation) return numeric

  const targets = new Map(
    relationships(pkg, "ppt/presentation.xml").map((relationship) => [
      relationship.id,
      resolveTarget("ppt/presentation.xml", relationship.target),
    ])
  )

  const ordered: string[] = []
  const pattern = /<p:sldId\b[^>]*r:id="([^"]+)"/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(presentation)) !== null) {
    const target = targets.get(match[1])
    if (target && numeric.includes(target)) ordered.push(target)
  }

  // Anything the list did not name is still in the package and still has text.
  for (const slide of numeric) {
    if (!ordered.includes(slide)) ordered.push(slide)
  }

  return ordered
}

/** The notes part belonging to a slide, via that slide's relationships. */
function notesFor(pkg: OoxmlPackage, slide: string): string | null {
  for (const relationship of relationships(pkg, slide)) {
    const target = resolveTarget(slide, relationship.target)
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(target)) return target
  }
  return null
}

function pageFrom(
  number: number,
  sections: { label: string | null; content: PartText | null }[]
): NormalizedPage {
  const builder = new TextStreamBuilder()

  for (const section of sections) {
    if (!section.content) continue
    if (section.label) builder.pad(`[${section.label}]\n`)
    appendPart(builder, section.content)
    builder.pad("\n")
  }

  return {
    number,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    text: builder.text,
    spans: builder.spans,
  }
}

export function extractPptx(
  documentId: string,
  bytes: Uint8Array
): PptxExtraction {
  const pkg = openPackage(bytes)

  if (!readPart(pkg, "ppt/presentation.xml")) {
    throw new Error("ppt/presentation.xml is missing; the file is not a PPTX")
  }

  const slides = slideOrder(pkg)
  const pages: NormalizedPage[] = []

  for (const slide of slides) {
    const notes = notesFor(pkg, slide)
    pages.push(
      pageFrom(pages.length + 1, [
        { label: null, content: readPartText(pkg, slide) },
        {
          label: "speaker notes",
          content: notes ? readPartText(pkg, notes) : null,
        },
      ])
    )
  }

  // Layouts and masters belong to the deck rather than to any one slide, so
  // they get their own pages instead of being repeated under every slide that
  // uses them — which would offer the same run for review a dozen times.
  const templates = listParts(pkg, PPTX_TEXT_PARTS)
    .filter((part) => /^ppt\/(slideLayouts|slideMasters|notesMasters|handoutMasters)\//.test(part))
    .sort()

  for (const part of templates) {
    const content = readPartText(pkg, part)
    if (!content || content.paragraphs.every((p) => p.runs.length === 0)) continue
    pages.push(
      pageFrom(pages.length + 1, [
        { label: `template: ${part.split("/")[1]}`, content },
      ])
    )
  }

  return {
    slides,
    document: {
      documentId,
      kind: "pptx",
      pages,
      metadata: {
        pageCount: pages.length,
        // What the quota is charged on: the deck's slides. Notes, layouts and
        // masters are processed with the slide they belong to.
        slideCount: slides.length,
        parts: listParts(pkg, PPTX_TEXT_PARTS).sort(),
      },
    },
  }
}
