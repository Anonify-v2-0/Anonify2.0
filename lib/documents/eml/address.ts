/**
 * Where a piece of an email came from.
 *
 * A detection has to be traceable to an exact place in the message or the
 * export cannot act on it safely. "The subject" is not enough when a forwarded
 * message has a subject too; "the body" is not enough when there is a
 * plain-text body, an HTML alternative and a quoted reply inside each.
 *
 * So every span carries an address:
 *
 *   part:0/header:from[0]      the root message's From
 *   part:0/header:received[2]  its third Received line
 *   part:0.1/body#248          character 248 of the first part's decoded text
 *   part:0.3/filename          the third part's attachment filename
 *   part:0.2.msg/header:to[0]  the To of the message nested in part two
 *
 * These are stable across a re-parse — the parse is deterministic and the
 * paths come from the message's own structure — which is what lets an address
 * captured during review still name the same bytes at export time.
 */

export type EmlAddress =
  | { kind: "header"; path: string; name: string; index: number }
  | { kind: "body"; path: string; offset: number }
  | { kind: "filename"; path: string }

export function headerAddress(
  path: string,
  name: string,
  index: number
): string {
  return `part:${path}/header:${name.toLowerCase()}[${index}]`
}

export function bodyAddress(path: string, offset: number): string {
  return `part:${path}/body#${offset}`
}

export function filenameAddress(path: string): string {
  return `part:${path}/filename`
}

const PATH = "([0-9]+(?:\\.(?:[0-9]+|msg))*)"

const HEADER = new RegExp(`^part:${PATH}/header:([^\\[]+)\\[(\\d+)\\]$`)
const BODY = new RegExp(`^part:${PATH}/body#(\\d+)$`)
const FILENAME = new RegExp(`^part:${PATH}/filename$`)

export function parseEmlAddress(id: string): EmlAddress | null {
  const header = HEADER.exec(id)
  if (header) {
    return {
      kind: "header",
      path: header[1],
      name: header[2],
      index: Number(header[3]),
    }
  }

  const body = BODY.exec(id)
  if (body) {
    return { kind: "body", path: body[1], offset: Number(body[2]) }
  }

  const filename = FILENAME.exec(id)
  if (filename) return { kind: "filename", path: filename[1] }

  return null
}
