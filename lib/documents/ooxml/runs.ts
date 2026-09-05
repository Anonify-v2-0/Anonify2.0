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
} from "@/lib/documents/ooxml/xml-text"

/**
 * Editing the runs of an OOXML part.
 *
 * Word and PowerPoint disagree about almost everything except this: text lives
 * in runs, runs live in paragraphs, and a value the user sees is split across
 * however many runs the application felt like creating. `w:p/w:r/w:t` and
 * `a:p/a:r/a:t` are the same structure under two namespaces, so the machinery
 * that walks them, addresses them and rewrites them is written once and told
 * which tags to look for.
 *
 * The invariant every format using this depends on: extraction and export walk
 * the part in the *same* order and count the *same* elements, so `p3r1`
 * captured during review still names the same run at export time. Nothing is
 * written into the user's file to make that work — no markers, no ids — which
 * is why the two walks have to agree by construction rather than by luck.
 */

export type OoxmlTextSchema = {
  /** Paragraph element, e.g. `w:p` or `a:p`. */
  paragraph: string
  /** Run element, e.g. `w:r` or `a:r`. */
  run: string
  /** Text element, e.g. `w:t` or `a:t`. */
  text: string
  /**
   * Empty elements inside a run that still contribute characters. A tab is a
   * character to a reader and to an offset, so a run containing one has to
   * account for it or every edit after it lands one place to the left.
   */
  breaks: { tag: string; text: string }[]
}

/** WordprocessingML. */
export const WORD_SCHEMA: OoxmlTextSchema = {
  paragraph: "w:p",
  run: "w:r",
  text: "w:t",
  breaks: [
    { tag: "w:tab", text: "\t" },
    { tag: "w:br", text: "\n" },
    { tag: "w:noBreakHyphen", text: "-" },
  ],
}

/**
 * DrawingML, which is what PowerPoint stores text in — on a slide, in the
 * speaker notes, on a layout and on a master alike.
 */
export const DRAWING_SCHEMA: OoxmlTextSchema = {
  paragraph: "a:p",
  run: "a:r",
  text: "a:t",
  breaks: [{ tag: "a:br", text: "\n" }],
}

export type OoxmlRunPlan = {
  /**
   * Precise edits, addressed by the run ids extraction assigned — part
   * qualified, e.g. `word/header1.xml#p3r1` or `ppt/slides/slide2.xml#p0r1`,
   * because each part has its own paragraph numbering.
   */
  runEdits: Record<string, CharRange[]>
  /** Accepted values, removed wherever else they appear in the package. */
  values: string[]
  /** Visible marker left behind, or null to close the gap silently. */
  label: string | null
  sanitizeMetadata: boolean
}

export const PART_SEPARATOR = "#"

export function spanAddress(
  part: string,
  paragraph: number,
  run: number
): string {
  return `${part}${PART_SEPARATOR}p${paragraph}r${run}`
}

/** Splits an address back into the part and the local `p{n}r{m}` key. */
export function parseSpanAddress(
  address: string
): { part: string; local: string } | null {
  const index = address.indexOf(PART_SEPARATOR)
  if (index === -1) return null
  return { part: address.slice(0, index), local: address.slice(index + 1) }
}

/**
 * Splits addresses into per-part edit maps.
 *
 * `fallbackPart` is where an address with no part prefix belongs. Older
 * normalized models addressed DOCX runs relative to the body without naming
 * it, and those documents are still in storage.
 */
export function groupEditsByPart(
  runEdits: Record<string, CharRange[]>,
  fallbackPart: string
): Map<string, Record<string, CharRange[]>> {
  const grouped = new Map<string, Record<string, CharRange[]>>()

  for (const [address, ranges] of Object.entries(runEdits)) {
    const parsed = parseSpanAddress(address)
    const part = parsed?.part ?? fallbackPart
    const local = parsed?.local ?? address

    const existing = grouped.get(part) ?? {}
    existing[local] = ranges
    grouped.set(part, existing)
  }

  return grouped
}

function replacementFor(label: string | null): (length: number) => string {
  return () => label ?? ""
}

/** One piece of a run: either a real text node or a synthesized character. */
export type RunSegment = {
  node: TextNode | null
  text: string
}

export function segmentsOfRun(
  xml: string,
  start: number,
  end: number,
  schema: OoxmlTextSchema
): RunSegment[] {
  const textNodes = scanTextNodes(xml, schema.text, { start, end })

  const ordered = [
    ...textNodes.map((node) => ({
      at: node.tagStart,
      segment: { node, text: node.text } as RunSegment,
    })),
    ...schema.breaks.flatMap((entry) =>
      scanElements(xml, entry.tag)
        .filter((range) => range.start >= start && range.end <= end)
        .map((range) => ({
          at: range.start,
          segment: { node: null, text: entry.text } as RunSegment,
        }))
    ),
  ].sort((a, b) => a.at - b.at)

  return ordered.map((entry) => entry.segment)
}

/** Maps ranges expressed over concatenated segment text back onto text nodes. */
export function editsForSegments(
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

/**
 * Applies one part's addressed edits. The paragraph and run indices are
 * re-derived by walking this part in document order — the same walk extraction
 * used, which is what makes an address captured then still point at the same
 * run now.
 */
export function applyRunEdits(
  xml: string,
  localEdits: Record<string, CharRange[]>,
  label: string | null,
  schema: OoxmlTextSchema
): string {
  const paragraphs = scanElements(xml, schema.paragraph)
  const runs = scanElements(xml, schema.run)
  const edits: TextEdit[] = []

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const inside = runs.filter(
      (run) => run.start >= paragraph.start && run.end <= paragraph.end
    )

    // Ranges are lifted into the paragraph's own coordinates before anything is
    // cut, so a value split across three runs is one range rather than three.
    // Applying each run separately produced the right characters and the wrong
    // marker: `[REDACTED][REDACTED][REDACTED]` where one value used to be,
    // because each run believed it was the first to place one.
    const segments: RunSegment[] = []
    const ranges: CharRange[] = []
    let offset = 0

    inside.forEach((run, runIndex) => {
      const runSegments = segmentsOfRun(xml, run.start, run.end, schema)
      const length = runSegments.reduce(
        (total, segment) => total + segment.text.length,
        0
      )

      for (const range of localEdits[`p${paragraphIndex}r${runIndex}`] ?? []) {
        ranges.push({ start: offset + range.start, end: offset + range.end })
      }

      segments.push(...runSegments)
      offset += length
    })

    if (ranges.length === 0) return
    edits.push(...editsForSegments(segments, ranges, label))
  })

  return applyTextEdits(xml, edits)
}

/**
 * Removes accepted values wherever they survive in a part, including text
 * split across runs and text in parts the editor never displayed.
 *
 * The search runs over a paragraph's concatenated text rather than over each
 * run, because that is exactly where the value hides: `john@ex` in one run and
 * `ample.com` in the next is invisible to a per-run search.
 */
export function sweepValues(
  xml: string,
  values: string[],
  label: string | null,
  schema: OoxmlTextSchema
): string {
  if (values.length === 0) return xml

  const containers = scanElements(xml, schema.paragraph)
  const regions =
    containers.length > 0 ? containers : [{ start: 0, end: xml.length }]
  const edits: TextEdit[] = []

  for (const region of regions) {
    const nodes = scanTextNodes(xml, schema.text, region)
    if (nodes.length === 0) continue

    const combined = nodes.map((node) => node.text).join("")
    const ranges = values.flatMap((value) => findOccurrences(combined, value))
    if (ranges.length === 0) continue

    const segments: RunSegment[] = nodes.map((node) => ({
      node,
      text: node.text,
    }))
    edits.push(...editsForSegments(segments, ranges, label))
  }

  return applyTextEdits(xml, edits)
}
