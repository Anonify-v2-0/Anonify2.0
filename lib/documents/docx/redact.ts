import {
  listParts,
  openPackage,
  packPackage,
  readPart,
  sanitizeOoxmlMetadata,
  writePart,
  WORD_TEXT_PARTS,
} from "@/lib/documents/ooxml/package"
import {
  applyRunEdits,
  groupEditsByPart,
  sweepValues,
  WORD_SCHEMA,
  type OoxmlRunPlan,
} from "@/lib/documents/ooxml/runs"

/**
 * DOCX redaction.
 *
 * Sensitive characters are removed from the XML that carries them. Nothing is
 * covered up, hidden, or recoloured: after this runs the string is not in
 * document.xml, and the sweep below makes sure it is not in a header, footer,
 * footnote or comment either.
 *
 * The run walking and the text-node surgery are shared with the PowerPoint
 * pipeline — `w:p/w:r/w:t` and `a:p/a:r/a:t` are the same structure under two
 * namespaces — and live in lib/documents/ooxml/runs.ts. What is Word-specific
 * is the list of parts that can hold text, which is the part of this that has
 * actually caused bugs.
 */

export type DocxRedactionPlan = OoxmlRunPlan

const REDACTION_LABEL = "[REDACTED]"

/** Addresses with no part prefix predate part qualification and mean the body. */
const DEFAULT_PART = "word/document.xml"

export function redactDocx(
  bytes: Uint8Array,
  plan: DocxRedactionPlan
): Uint8Array {
  const pkg = openPackage(bytes)
  const label = plan.label

  if (!readPart(pkg, "word/document.xml")) {
    throw new Error("word/document.xml is missing; the file is not a DOCX")
  }

  // Precise edits, applied to whichever part each address names.
  for (const [part, localEdits] of groupEditsByPart(plan.runEdits, DEFAULT_PART)) {
    const xml = readPart(pkg, part)
    if (!xml) continue
    writePart(pkg, part, applyRunEdits(xml, localEdits, label, WORD_SCHEMA))
  }

  // Safety net: the same values, everywhere else Word can keep text.
  for (const part of listParts(pkg, WORD_TEXT_PARTS)) {
    const xml = readPart(pkg, part)
    if (!xml) continue
    writePart(pkg, part, sweepValues(xml, plan.values, label, WORD_SCHEMA))
  }

  if (plan.sanitizeMetadata) sanitizeOoxmlMetadata(pkg)

  return packPackage(pkg)
}

export { REDACTION_LABEL, groupEditsByPart, sanitizeOoxmlMetadata }
