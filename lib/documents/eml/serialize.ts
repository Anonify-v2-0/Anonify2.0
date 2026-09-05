/**
 * Writing pieces of a message back out.
 *
 * The export does not rebuild the message. It replaces byte ranges in the
 * original, so every part nobody edited — every boundary, every nested
 * message, every attachment — comes out identical to the byte. What this file
 * provides is the small set of things that *are* rewritten: a header line, a
 * text part's body, a filename parameter.
 *
 * Two deliberate choices, both about not producing a file that only looks
 * right:
 *
 * A rewritten body is re-encoded as quoted-printable (or base64, if that is
 * what the part already used) and its charset parameter is set to UTF-8. The
 * alternative — writing the redacted text back in the part's original
 * encoding — means either being able to encode every charset in the world, or
 * quietly mangling the characters we did not remove. It also means a body that
 * could, after a removal, start a line with `--` and collide with the
 * multipart boundary that contains it. Re-encoding costs a changed header on
 * the parts we touched and removes both problems.
 *
 * A rewritten header is folded and, where it is no longer pure ASCII, encoded
 * per RFC 2047 — but only the phrases that need it, never the whole value,
 * because encoding `John <john@example.com>` as one word destroys the address.
 */

const MAX_LINE = 76

/** Bytes quoted-printable may write literally. */
function isLiteralQp(byte: number): boolean {
  return (byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126)
}

export function encodeQuotedPrintable(bytes: Buffer): string {
  const lines: string[] = []
  let line = ""

  const flush = (soft: boolean) => {
    lines.push(soft ? `${line}=` : line)
    line = ""
  }

  const push = (piece: string) => {
    if (line.length + piece.length > MAX_LINE) flush(true)
    line += piece
  }

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]

    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      flush(false)
      index += 1
      continue
    }
    if (byte === 0x0a) {
      flush(false)
      continue
    }

    // A line that begins `--` could be read as the boundary of the multipart
    // this part sits in. Removing characters can create one where there was
    // none, so the first character of every line is escaped when it is a
    // hyphen or a dot.
    if (line.length === 0 && (byte === 0x2d || byte === 0x2e)) {
      push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      continue
    }

    if (byte === 0x20 || byte === 0x09) {
      // Trailing whitespace does not survive transport, so it is escaped when
      // it would end the line.
      const next = bytes[index + 1]
      if (next === undefined || next === 0x0d || next === 0x0a) {
        push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`)
        continue
      }
      push(String.fromCharCode(byte))
      continue
    }

    if (isLiteralQp(byte) && byte !== 0x3d) {
      push(String.fromCharCode(byte))
      continue
    }

    push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`)
  }

  if (line.length > 0) lines.push(line)
  return lines.join("\r\n")
}

export function encodeBase64Body(bytes: Buffer): string {
  const encoded = bytes.toString("base64")
  const lines: string[] = []
  for (let index = 0; index < encoded.length; index += MAX_LINE) {
    lines.push(encoded.slice(index, index + MAX_LINE))
  }
  return lines.join("\r\n")
}

const ASCII_PRINTABLE = /^[\t\x20-\x7e]*$/

export function isAscii(value: string): boolean {
  return ASCII_PRINTABLE.test(value)
}

/**
 * RFC 2047, applied per phrase.
 *
 * Address headers are structured: `John Smith <john@example.com>` has a
 * display name and an address, and the angle brackets are syntax. Encoding the
 * whole value as one word turns the syntax into payload and the header stops
 * being an address header. So only the runs that actually contain non-ASCII
 * are encoded, and the ASCII around them — including every bracket, comma and
 * address — is left exactly as it is.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value

  return value
    .split(/(\s+)/)
    .map((token) => {
      if (token.length === 0 || isAscii(token)) return token
      const encoded = Buffer.from(token, "utf8").toString("base64")
      return `=?utf-8?B?${encoded}?=`
    })
    .join("")
}

/** Folds a header line so no line runs past the conventional 78 characters. */
export function foldHeader(
  name: string,
  value: string,
  eol: string
): string {
  const first = `${name}: `
  const words = value.split(" ")

  const lines: string[] = []
  let line = first

  for (const word of words) {
    if (line !== first && line.length + 1 + word.length > 78) {
      lines.push(line)
      line = ` ${word}`
      continue
    }
    line += line === first ? word : ` ${word}`
  }
  lines.push(line)

  return lines.join(eol) + eol
}

/** A `filename=` parameter, in whichever form the value needs. */
export function encodeFilenameParameter(
  parameter: "filename" | "name",
  value: string
): string {
  if (isAscii(value)) {
    return `${parameter}="${value.replace(/(["\\])/g, "\\$1")}"`
  }

  // RFC 2231's charset-tagged form, which is what mail clients write for a
  // filename with an accent in it.
  const encoded = Buffer.from(value, "utf8")
    .toString("latin1")
    .replace(/[^A-Za-z0-9!#$&+\-.^_`|~]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    )
  return `${parameter}*=utf-8''${encoded}`
}
