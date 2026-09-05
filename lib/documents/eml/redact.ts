import { parseHtmlText } from "@/lib/documents/eml/html"
import { emlLimits, type EmlLimits } from "@/lib/documents/eml/limits"
import {
  decodeEml,
  encodeEml,
  parseEml,
  parseParameters,
  type MimeHeader,
  type MimeNode,
} from "@/lib/documents/eml/parse"
import {
  encodeBase64Body,
  encodeFilenameParameter,
  encodeHeaderValue,
  encodeQuotedPrintable,
  foldHeader,
} from "@/lib/documents/eml/serialize"
import { applyCuts, sourceCutsFor } from "@/lib/documents/shared/atoms"
import {
  cutRanges,
  mergeRanges,
  valueMatcher,
  type CharRange,
  type ValueMatcher,
} from "@/lib/documents/shared/text"

/**
 * Email redaction.
 *
 * The message is not rebuilt. Everything is expressed as byte-range
 * replacements on the original, so a part nobody edited comes out identical to
 * the byte — every boundary, every attachment, every nested message. That is
 * both the safest thing to do and the only way to answer "did anything else
 * change?" with a straight yes or no.
 *
 * Three kinds of thing get rewritten, and each has its own hazard:
 *
 *   headers    a value is structured. Cutting characters out of
 *              `John Smith <john@example.com>` has to leave something that is
 *              still an address header, and re-encoding it has to leave the
 *              brackets alone.
 *   text       the offsets a reviewer worked in are offsets into the *decoded*
 *              text, so the body is decoded, cut, and re-encoded. HTML goes
 *              through its own atom map first, because the visible text and
 *              the markup are not the same string.
 *   filenames  live in header parameters, so they are a header rewrite with a
 *              different shape.
 *   attachments a part's *body* is replaced with bytes that did not come from
 *              the original — the redacted export of the child document that
 *              attachment became. This is the one rewrite that is not a
 *              transformation of what was already there, which is why it is
 *              the one verified against a checksum rather than a search.
 *
 * An attachment is only ever rewritten when the plan says so. The plan is
 * built from the children the message was expanded into, and it has an answer
 * for every attachment: the redacted bytes, a removal, or nothing at all for a
 * format this cannot read. What it never has is silence — once a redacted
 * child exists, an archive holding a clean PDF beside an `.eml` that still
 * carries the original is worse than the honest carry-through it replaced,
 * because it is trusted.
 */

export type EmlRedactionPlan = {
  /** Ranges within each part's decoded text, keyed by MIME path. */
  bodies: Record<string, CharRange[]>
  /** Ranges within a header's decoded value, keyed by `path|name|index`. */
  headers: Record<string, CharRange[]>
  /** Ranges within an attachment filename, keyed by MIME path. */
  filenames: Record<string, CharRange[]>
  /**
   * What to do with each attachment part's body, keyed by MIME path. A part
   * with no entry is carried through exactly as it arrived.
   */
  attachments: Record<string, AttachmentAction>
  /** Accepted values, removed wherever else they appear in the message. */
  values: string[]
  label: string | null
}

/**
 * What happens to one attachment's bytes.
 *
 * `remove` rather than "leave it": every case where a child is not redacted —
 * not ready, failed, skipped for quota — has to end somewhere other than
 * quietly shipping the original. The part stays, so the message still says an
 * enclosure was here and what became of it, and the export report names it.
 */
export type AttachmentAction =
  | { action: "replace"; bytes: Uint8Array }
  | { action: "remove"; note: string }

export function headerKey(path: string, name: string, index: number): string {
  return `${path}|${name}|${index}`
}

/**
 * Headers the sweep must not touch.
 *
 * These carry the message's structure rather than its content. A boundary
 * string that happened to contain an accepted value, or a transfer encoding
 * with a name in it, would take the whole message apart. Filenames live in two
 * of them and are handled separately, through the parameter rewriter.
 */
const STRUCTURAL_HEADERS = new Set([
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "mime-version",
])

type Edit = { start: number; end: number; text: string }

/** The line ending this message uses, taken from the bytes rather than assumed. */
function eolOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n"
}

function cut(
  value: string,
  ranges: CharRange[],
  label: string | null
): string {
  const merged = mergeRanges(ranges)
  if (merged.length === 0) return value

  let first = true
  return cutRanges(value, merged, () => {
    if (!label) return ""
    if (first) {
      first = false
      return label
    }
    return ""
  })
}

// --- headers ----------------------------------------------------------------

function rewriteHeader(
  header: MimeHeader,
  value: string,
  source: string,
  eol: string
): Edit {
  // Keep the message's own line ending rather than the file's, in case the
  // two disagree; a mixed-ending message is unusual but it is not ours to fix.
  const original = source.slice(header.start, header.end)
  const lineEnding = original.endsWith("\r\n")
    ? "\r\n"
    : original.endsWith("\n")
      ? "\n"
      : eol

  return {
    start: header.start,
    end: header.end,
    text: foldHeader(header.rawName, encodeHeaderValue(value), lineEnding),
  }
}

// --- bodies -----------------------------------------------------------------

/**
 * The redacted text of one part, or null when nothing in it changed.
 *
 * HTML is cut through its atom map so a removal lands on characters rather
 * than on a tag or half an entity, and the sweep additionally reaches
 * attribute values — a `mailto:` link is a copy of the address whatever the
 * page shows.
 */
function redactPartText(
  node: MimeNode,
  ranges: CharRange[],
  matcher: ValueMatcher,
  label: string | null
): string | null {
  if (node.text === null) return null

  if (node.contentType === "text/html") {
    const { text, atoms, attributes } = parseHtmlText(node.text)
    const cuts = sourceCutsFor(atoms, [...ranges, ...matcher.find(text)])

    let html = node.text
    let changed = false

    if (cuts.length > 0) {
      html = applyCuts(html, cuts, label ?? "")
      changed = true
    }

    // Attribute values, edited on the *current* string, so the offsets are
    // recomputed rather than carried across the edit above.
    const attributeEdits: Edit[] = []
    for (const attribute of changed ? parseHtmlText(html).attributes : attributes) {
      const hits = matcher.find(attribute.value)
      if (hits.length === 0) continue
      attributeEdits.push({
        start: attribute.start,
        end: attribute.end,
        text: cut(attribute.value, hits, label),
      })
    }

    if (attributeEdits.length > 0) {
      for (const edit of attributeEdits.sort((a, b) => b.start - a.start)) {
        html = html.slice(0, edit.start) + edit.text + html.slice(edit.end)
      }
      changed = true
    }

    return changed ? html : null
  }

  const all = mergeRanges([...ranges, ...matcher.find(node.text)])
  if (all.length === 0) return null

  return cut(node.text, all, label)
}

/**
 * Rewrites a text part: its body, its transfer encoding and its charset.
 *
 * The last two are not gratuitous. Writing the redacted text back in the
 * part's original charset would mean being able to encode every charset that
 * exists; writing it back as raw 7-bit means a removal could leave a line
 * starting `--` and colliding with the boundary of the multipart around it.
 * Re-encoding as quoted-printable in UTF-8 removes both problems, and it only
 * ever happens to a part that was actually edited.
 */
function rewriteTextPart(
  node: MimeNode,
  text: string,
  source: string,
  eol: string,
  filename: string | null
): Edit[] {
  const bytes = Buffer.from(text, "utf8")
  const useBase64 = node.encoding === "base64"
  const body = useBase64 ? encodeBase64Body(bytes) : encodeQuotedPrintable(bytes)

  const edits: Edit[] = [
    { start: node.bodyStart, end: node.end, text: `${body}${eol}` },
  ]

  const typeHeader = node.headers.find(
    (header) => header.name === "content-type"
  )
  const parameters: Record<string, string> = {
    ...node.parameters,
    charset: "utf-8",
  }
  // A `name` parameter is a second copy of the filename, so it takes the
  // redacted one rather than being written back with the original.
  if (filename !== null && parameters.name !== undefined) {
    parameters.name = filename
  }
  const typeValue = [
    node.contentType,
    ...Object.entries(parameters).map(([name, value]) =>
      name === "filename" || name === "name"
        ? encodeFilenameParameter(name as "filename" | "name", value)
        : `${name}="${value}"`
    ),
  ].join("; ")

  if (typeHeader) {
    edits.push(rewriteHeader(typeHeader, typeValue, source, eol))
  } else {
    edits.push({
      start: node.start,
      end: node.start,
      text: foldHeader("Content-Type", typeValue, eol),
    })
  }

  const encodingHeader = node.headers.find(
    (header) => header.name === "content-transfer-encoding"
  )
  const encodingValue = useBase64 ? "base64" : "quoted-printable"

  if (encodingHeader) {
    edits.push(rewriteHeader(encodingHeader, encodingValue, source, eol))
  } else {
    edits.push({
      start: node.start,
      end: node.start,
      text: foldHeader("Content-Transfer-Encoding", encodingValue, eol),
    })
  }

  return edits
}

// --- filenames --------------------------------------------------------------

/** The Content-Disposition rewrite alone, for a part whose body is also going. */
function rewriteDisposition(
  node: MimeNode,
  filename: string,
  source: string,
  eol: string
): Edit[] {
  const disposition = node.headers.find(
    (header) => header.name === "content-disposition"
  )
  if (!disposition) return []

  const parsed = parseParameters(disposition.value)
  const rest = Object.entries(parsed.parameters).filter(
    ([name]) => name !== "filename"
  )
  const value = [
    parsed.value || "attachment",
    ...rest.map(([name, parameterValue]) => `${name}="${parameterValue}"`),
    encodeFilenameParameter("filename", filename),
  ].join("; ")

  return [rewriteHeader(disposition, value, source, eol)]
}

function rewriteFilename(
  node: MimeNode,
  filename: string,
  source: string,
  eol: string
): Edit[] {
  const edits: Edit[] = [
    ...rewriteDisposition(node, filename, source, eol),
  ]

  const typeHeader = node.headers.find(
    (header) => header.name === "content-type"
  )
  if (typeHeader && node.parameters.name !== undefined) {
    const rest = Object.entries(node.parameters).filter(
      ([name]) => name !== "name"
    )
    const value = [
      node.contentType,
      ...rest.map(([name, parameterValue]) => `${name}="${parameterValue}"`),
      encodeFilenameParameter("name", filename),
    ].join("; ")
    edits.push(rewriteHeader(typeHeader, value, source, eol))
  }

  return edits
}

// --- attachment bodies ------------------------------------------------------

/** Rebuilds a Content-Type value from a type and its parameters. */
function typeValue(
  contentType: string,
  parameters: Record<string, string>
): string {
  return [
    contentType,
    ...Object.entries(parameters).map(([name, value]) =>
      name === "filename" || name === "name"
        ? encodeFilenameParameter(name as "filename" | "name", value)
        : `${name}="${value}"`
    ),
  ].join("; ")
}

/** Sets a header, rewriting it in place or adding it above the part. */
function setHeader(
  node: MimeNode,
  name: string,
  value: string,
  source: string,
  eol: string
): Edit {
  const header = node.headers.find(
    (candidate) => candidate.name === name.toLowerCase()
  )
  if (header) return rewriteHeader(header, value, source, eol)
  return { start: node.start, end: node.start, text: foldHeader(name, value, eol) }
}

/**
 * Replaces an attachment part's body.
 *
 * The bytes going in did not come from this message — they are the redacted
 * export of the document this attachment became — so everything the old body's
 * headers asserted about it has to be rewritten with them: the transfer
 * encoding, and the length if the part declared one. A `Content-Length` left
 * saying what the original measured is a part that some readers will truncate
 * and others will refuse, and both of those look like corruption rather than
 * like redaction.
 *
 * Always base64, whatever the part used before. The input is arbitrary binary;
 * quoted-printable would encode most of it anyway, and 7-bit or 8-bit would
 * let a redacted PDF grow a line that reads as the boundary containing it.
 */
function rewriteAttachmentBody(
  node: MimeNode,
  action: AttachmentAction,
  filename: string | null,
  source: string,
  eol: string
): Edit[] {
  const edits: Edit[] = []

  const removing = action.action === "remove"
  const bytes = removing
    ? Buffer.from(action.note, "utf8")
    : Buffer.from(action.action === "replace" ? action.bytes : new Uint8Array())

  const body = removing
    ? encodeQuotedPrintable(bytes)
    : encodeBase64Body(bytes)

  edits.push({ start: node.bodyStart, end: node.end, text: `${body}${eol}` })

  // A removed attachment stops claiming to be a PDF. Saying `application/pdf`
  // over a sentence of English is the same category of lie the whole tool
  // exists to refuse, in miniature.
  const renaming = filename !== null && node.parameters.name !== undefined

  if (removing || renaming) {
    const parameters = { ...node.parameters }
    if (renaming) parameters.name = filename as string
    if (removing) {
      delete parameters.boundary
      parameters.charset = "utf-8"
    }

    edits.push(
      setHeader(
        node,
        "Content-Type",
        typeValue(removing ? "text/plain" : node.contentType, parameters),
        source,
        eol
      )
    )
  }

  edits.push(
    setHeader(
      node,
      "Content-Transfer-Encoding",
      removing ? "quoted-printable" : "base64",
      source,
      eol
    )
  )

  const length = node.headers.find(
    (header) => header.name === "content-length"
  )
  if (length) {
    edits.push(rewriteHeader(length, String(body.length), source, eol))
  }

  if (filename !== null) {
    edits.push(...rewriteDisposition(node, filename, source, eol))
  }

  return edits
}

// --- the pass ---------------------------------------------------------------

export function redactEml(
  bytes: Uint8Array,
  plan: EmlRedactionPlan,
  limits: EmlLimits = emlLimits()
): Uint8Array {
  const source = decodeEml(bytes)
  const { nodes } = parseEml(source, limits)
  const eol = eolOf(source)

  const edits: Edit[] = []
  // One automaton for the whole message: a long thread reaches every header of
  // every part, and searching each value in each of them is a product.
  const matcher = valueMatcher(plan.values)

  for (const node of nodes) {
    // 1. Headers. Addressed edits, plus the sweep over everything that is not
    //    structural — a value in a header nobody displayed is still a leak.
    for (const header of node.headers) {
      const addressed =
        plan.headers[headerKey(node.path, header.name, header.index)] ?? []

      const sweep = STRUCTURAL_HEADERS.has(header.name)
        ? []
        : matcher.find(header.value)

      const ranges = mergeRanges([...addressed, ...sweep])
      if (ranges.length === 0) continue

      edits.push(
        rewriteHeader(header, cut(header.value, ranges, plan.label), source, eol)
      )
    }

    // 2. Filenames, which live in header parameters.
    let filename: string | null = null
    if (node.filename) {
      const addressed = plan.filenames[node.path] ?? []
      const sweep = matcher.find(node.filename)
      const ranges = mergeRanges([...addressed, ...sweep])
      if (ranges.length > 0) {
        filename = cut(node.filename, ranges, plan.label)
      }
    }

    // 3. Attachment bodies, which are the only rewrite whose content did not
    //    come from this message. Handled as one block so the Content-Type,
    //    Content-Transfer-Encoding and Content-Disposition edits this needs
    //    cannot collide with the filename rewrite below, which touches the
    //    same two headers.
    const substitution = plan.attachments[node.path]
    if (node.attachment && substitution) {
      edits.push(
        ...rewriteAttachmentBody(node, substitution, filename, source, eol)
      )
      continue
    }

    // 4. Bodies. An attachment with no substitution is carried through
    //    untouched by construction: `node.text` is null for anything that is
    //    not a text part.
    const redacted = redactPartText(
      node,
      plan.bodies[node.path] ?? [],
      matcher,
      plan.label
    )

    if (redacted !== null) {
      // One rewrite of this part's Content-Type, carrying both the new charset
      // and the redacted `name` parameter, rather than two edits over the same
      // bytes.
      edits.push(...rewriteTextPart(node, redacted, source, eol, filename))
      if (filename !== null) {
        edits.push(...rewriteDisposition(node, filename, source, eol))
      }
      continue
    }

    if (filename !== null) {
      edits.push(...rewriteFilename(node, filename, source, eol))
    }
  }

  if (edits.length === 0) return bytes

  // Applied back to front, so every offset ahead of an edit stays valid. Two
  // edits never overlap: a header edit is inside its part's header block and a
  // body edit is inside its body, and only leaf text parts get body edits.
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)

  let result = source
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }

  return encodeEml(result)
}
