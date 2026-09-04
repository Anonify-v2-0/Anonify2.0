import {
  listParts,
  openPackage,
  packPackage,
  readPart,
  writePart,
  WORD_TEXT_PARTS,
  type OoxmlPackage,
} from "@/lib/documents/docx/ooxml"
import {
  applyTextEdits,
  cutRanges,
  findOccurrences,
  mergeRanges,
  scanElements,
  scanTextNodes,
  type CharRange,
  type TextEdit,
  type TextNode,
} from "@/lib/documents/docx/xml-text"

/**
 * DOCX redaction.
 *
 * Sensitive characters are removed from the XML that carries them. Nothing is
 * covered up, hidden, or recoloured: after this runs the string is not in
 * document.xml, and the sweep below makes sure it is not in a header, footer,
 * footnote or comment either.
 */

export type DocxRedactionPlan = {
  /** Precise edits, addressed by the run ids extraction assigned (p3r1). */
  runEdits: Record<string, CharRange[]>
  /** Accepted values, removed wherever else they appear in the package. */
  values: string[]
  /** Visible marker left behind, or null to close the gap silently. */
  label: string | null
  sanitizeMetadata: boolean
}

const REDACTION_LABEL = "[REDACTED]"

function replacementFor(label: string | null): (length: number) => string {
  return () => (label ?? "")
}

/** One piece of a run: either a real text node or synthesized whitespace. */
type RunSegment = {
  node: TextNode | null
  text: string
}

function segmentsOfRun(xml: string, start: number, end: number): RunSegment[] {
  const segments: RunSegment[] = []
  const region = { start, end }

  const textNodes = scanTextNodes(xml, "w:t", region)
  const tabs = scanElements(xml, "w:tab").filter(
    (range) => range.start >= start && range.end <= end
  )
  const breaks = scanElements(xml, "w:br").filter(
    (range) => range.start >= start && range.end <= end
  )
  const hyphens = scanElements(xml, "w:noBreakHyphen").filter(
    (range) => range.start >= start && range.end <= end
  )

  const ordered = [
    ...textNodes.map((node) => ({ at: node.tagStart, segment: { node, text: node.text } })),
    ...tabs.map((range) => ({ at: range.start, segment: { node: null, text: "\t" } })),
    ...breaks.map((range) => ({ at: range.start, segment: { node: null, text: "\n" } })),
    ...hyphens.map((range) => ({ at: range.start, segment: { node: null, text: "-" } })),
  ].sort((a, b) => a.at - b.at)

  for (const entry of ordered) segments.push(entry.segment)
  return segments
}

/** Maps ranges expressed over concatenated segment text back onto text nodes. */
function editsForSegments(
  segments: RunSegment[],
  ranges: CharRange[],
  label: string | null
): TextEdit[] {
  const merged = mergeRanges(ranges)
  if (merged.length === 0) return []

  const edits: TextEdit[] = []
  let offset = 0
  let labelPlaced = false

  for (const segment of segments) {
    const segmentStart = offset
    const segmentEnd = offset + segment.text.length
    offset = segmentEnd

    if (!segment.node) continue

    const local = merged
      .filter((range) => range.start < segmentEnd && range.end > segmentStart)
      .map((range) => ({
        start: Math.max(0, range.start - segmentStart),
        end: Math.min(segment.text.length, range.end - segmentStart),
      }))

    if (local.length === 0) continue

    // The marker is written once per redaction, not once per run it spans.
    const marker = label && !labelPlaced ? label : null
    if (marker) labelPlaced = true

    edits.push({
      node: segment.node,
      text: cutRanges(segment.text, local, replacementFor(marker)),
    })
  }

  return edits
}

function applyRunEdits(xml: string, runEdits: Record<string, CharRange[]>, label: string | null): string {
  const paragraphs = scanElements(xml, "w:p")
  const edits: TextEdit[] = []

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const runs = scanElements(xml, "w:r").filter(
      (run) => run.start >= paragraph.start && run.end <= paragraph.end
    )

    runs.forEach((run, runIndex) => {
      const ranges = runEdits[`p${paragraphIndex}r${runIndex}`]
      if (!ranges || ranges.length === 0) return
      edits.push(
        ...editsForSegments(segmentsOfRun(xml, run.start, run.end), ranges, label)
      )
    })
  })

  return applyTextEdits(xml, edits)
}

/**
 * Removes accepted values wherever they survive in a part, including text split
 * across runs and text in parts the editor never displayed.
 */
function sweepValues(xml: string, values: string[], label: string | null): string {
  if (values.length === 0) return xml

  const containers = scanElements(xml, "w:p")
  const regions =
    containers.length > 0 ? containers : [{ start: 0, end: xml.length }]
  const edits: TextEdit[] = []

  for (const region of regions) {
    const nodes = scanTextNodes(xml, "w:t", region)
    if (nodes.length === 0) continue

    const combined = nodes.map((node) => node.text).join("")
    const ranges = values.flatMap((value) => findOccurrences(combined, value))
    if (ranges.length === 0) continue

    const segments: RunSegment[] = nodes.map((node) => ({ node, text: node.text }))
    edits.push(...editsForSegments(segments, ranges, label))
  }

  return applyTextEdits(xml, edits)
}

const CORE_PROPERTY_TAGS = [
  "dc:creator",
  "cp:lastModifiedBy",
  "cp:lastPrinted",
  "dc:description",
  "dc:subject",
  "cp:keywords",
  "cp:category",
  "cp:contentStatus",
  "dc:title",
]

const APP_PROPERTY_TAGS = ["Company", "Manager", "Application", "Template"]

/** Empties an element's content while keeping the element and its attributes. */
function blankTags(xml: string, tags: string[]): string {
  let result = xml
  for (const tag of tags) {
    result = result.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"),
      (_match, attributes: string | undefined) =>
        `<${tag}${attributes ?? ""}></${tag}>`
    )
  }
  return result
}

/** Strips authorship and other identifying document properties. */
export function sanitizeDocxMetadata(pkg: OoxmlPackage): void {
  const core = readPart(pkg, "docProps/core.xml")
  if (core) writePart(pkg, "docProps/core.xml", blankTags(core, CORE_PROPERTY_TAGS))

  const app = readPart(pkg, "docProps/app.xml")
  if (app) writePart(pkg, "docProps/app.xml", blankTags(app, APP_PROPERTY_TAGS))

  for (const part of listParts(pkg, /^docProps\/thumbnail\./)) {
    delete pkg.files[part]
  }
}

export function redactDocx(
  bytes: Uint8Array,
  plan: DocxRedactionPlan
): Uint8Array {
  const pkg = openPackage(bytes)
  const label = plan.label

  const documentXml = readPart(pkg, "word/document.xml")
  if (!documentXml) {
    throw new Error("word/document.xml is missing; the file is not a DOCX")
  }

  writePart(
    pkg,
    "word/document.xml",
    applyRunEdits(documentXml, plan.runEdits, label)
  )

  // Safety net: the same values, everywhere else Word can keep text.
  for (const part of listParts(pkg, WORD_TEXT_PARTS)) {
    const xml = readPart(pkg, part)
    if (!xml) continue
    writePart(pkg, part, sweepValues(xml, plan.values, label))
  }

  if (plan.sanitizeMetadata) sanitizeDocxMetadata(pkg)

  return packPackage(pkg)
}

export { REDACTION_LABEL }
