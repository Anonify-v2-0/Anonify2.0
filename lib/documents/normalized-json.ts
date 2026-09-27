import type { NormalizedDocument, NormalizedPage } from "@/types/document"

/**
 * Where each page of a normalized model sits in its stored JSON.
 *
 * The model is stored as one JSON document, exactly as `JSON.stringify` would
 * write it, so a reader that wants the whole of it still parses it in one go.
 * This index is what lets a reader want less: every page is a byte range of
 * that JSON, and one page is one ranged read of the chunks that cover it.
 *
 * It holds offsets and page numbers and nothing else — no text, no geometry —
 * which is why it can sit in the database beside the key of the object it
 * describes. The model itself never does.
 */
export type NormalizedIndex = {
  version: 1
  /** Byte length of the whole JSON. */
  size: number
  /** Offset of the `[` that opens the pages array. */
  open: number
  /** Offset of the `]` that closes it. */
  close: number
  /** `[pageNumber, start, end)` for each page, in the order it was written. */
  pages: [number, number, number][]
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/**
 * Writes a normalized model as JSON pieces, recording where each page lands.
 *
 * Both writers use it — the whole-model serializer below and the extractors
 * that stream a model out a page at a time — so the offsets are counted the
 * same way whichever path wrote the model. Pieces are UTF-8 once stored, and
 * offsets are counted in UTF-8 bytes to match.
 */
export class NormalizedJsonWriter {
  private pieces: string[] = []
  private offset = 0
  private open = -1
  private close = -1
  private entries: [number, number, number][] = []

  /** Appends raw JSON. */
  push(json: string): void {
    if (json.length === 0) return
    this.pieces.push(json)
    this.offset += byteLength(json)
  }

  /** Writes `"pages":[`; the caller writes any separator before it. */
  beginPages(): void {
    this.push(`"pages":`)
    this.open = this.offset
    this.push("[")
  }

  page(page: NormalizedPage): void {
    if (this.entries.length > 0) this.push(",")
    const start = this.offset
    this.push(JSON.stringify(page))
    this.entries.push([page.number, start, this.offset])
  }

  endPages(): void {
    this.close = this.offset
    this.push("]")
  }

  /** Removes and returns everything written since the last call. */
  take(): string {
    const json = this.pieces.join("")
    this.pieces = []
    return json
  }

  /** The index, once the whole model has been written. */
  get index(): NormalizedIndex {
    if (this.open < 0 || this.close < 0) {
      throw new Error("The model was written without a pages array")
    }
    return {
      version: 1,
      size: this.offset,
      open: this.open,
      close: this.close,
      pages: this.entries,
    }
  }
}

/**
 * Serializes a model and indexes it.
 *
 * The JSON is exactly `JSON.stringify(model)`: keys in the model's own order,
 * a key whose value serializes to nothing left out. Only the pages array is
 * written element by element, which is where the offsets come from.
 */
export function serializeNormalized(model: NormalizedDocument): {
  json: string
  index: NormalizedIndex
} {
  const writer = new NormalizedJsonWriter()
  writer.push("{")
  let first = true

  for (const [key, value] of Object.entries(model)) {
    if (key === "pages") {
      if (!first) writer.push(",")
      writer.beginPages()
      for (const page of value as NormalizedPage[]) writer.page(page)
      writer.endPages()
      first = false
      continue
    }
    const json = JSON.stringify(value)
    if (json === undefined) continue
    writer.push(`${first ? "" : ","}${JSON.stringify(key)}:${json}`)
    first = false
  }

  writer.push("}")
  return { json: writer.take(), index: writer.index }
}

/**
 * Reads an index back from the database, or null if there is none to trust.
 *
 * A document written before the index existed has none, and one that does not
 * hold together — offsets out of order, a page outside the array — is treated
 * the same way: read whole, as every model was before. The offsets are only
 * ever used to cut a model that is itself authenticated, so a bad index can
 * cost a failed parse, never a wrong page; this keeps it to neither.
 */
export function parseNormalizedIndex(value: unknown): NormalizedIndex | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<NormalizedIndex>
  if (candidate.version !== 1) return null

  const { size, open, close, pages } = candidate
  if (
    !isOffset(size) ||
    !isOffset(open) ||
    !isOffset(close) ||
    !Array.isArray(pages) ||
    open >= close ||
    close >= size
  ) {
    return null
  }

  let previous = open + 1
  for (const entry of pages) {
    if (!Array.isArray(entry) || entry.length !== 3) return null
    const [number, start, end] = entry
    if (!Number.isInteger(number) || !isOffset(start) || !isOffset(end)) {
      return null
    }
    if (start < previous || end <= start || end > close) return null
    previous = end
  }

  return { version: 1, size, open, close, pages }
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

