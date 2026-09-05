import {
  listParts,
  openPackage,
  packPackage,
  PPTX_TEXT_PARTS,
  readPart,
  sanitizeOoxmlMetadata,
  writePart,
} from "@/lib/documents/ooxml/package"
import {
  applyRunEdits,
  DRAWING_SCHEMA,
  groupEditsByPart,
  sweepValues,
  type OoxmlRunPlan,
} from "@/lib/documents/ooxml/runs"

/**
 * PPTX redaction.
 *
 * The same surgery the Word pipeline performs, on the other namespace: the
 * characters are removed from the `a:t` nodes that carry them, and every byte
 * outside those nodes stays exactly as PowerPoint wrote it, so themes,
 * animations, relationships and slide geometry survive untouched.
 *
 * The sweep is the part that matters most here, and it covers more parts than
 * a reviewer looked at. A deck keeps the same string in the notes nobody
 * printed, in a layout the template author wrote, and on the master that draws
 * the footer of every slide. Redacting the slides alone leaves three copies.
 */

export type PptxRedactionPlan = OoxmlRunPlan

/** An address with no part prefix cannot be resolved; slide one is the guess. */
const DEFAULT_PART = "ppt/slides/slide1.xml"

export function redactPptx(
  bytes: Uint8Array,
  plan: PptxRedactionPlan
): Uint8Array {
  const pkg = openPackage(bytes)
  const label = plan.label

  if (!readPart(pkg, "ppt/presentation.xml")) {
    throw new Error("ppt/presentation.xml is missing; the file is not a PPTX")
  }

  for (const [part, localEdits] of groupEditsByPart(plan.runEdits, DEFAULT_PART)) {
    const xml = readPart(pkg, part)
    if (!xml) continue
    writePart(pkg, part, applyRunEdits(xml, localEdits, label, DRAWING_SCHEMA))
  }

  for (const part of listParts(pkg, PPTX_TEXT_PARTS)) {
    const xml = readPart(pkg, part)
    if (!xml) continue
    writePart(pkg, part, sweepValues(xml, plan.values, label, DRAWING_SCHEMA))
  }

  if (plan.sanitizeMetadata) sanitizeOoxmlMetadata(pkg)

  return packPackage(pkg)
}
