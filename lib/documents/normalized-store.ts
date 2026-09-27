import type { Readable } from "node:stream"

import {
  parseNormalizedIndex,
  serializeNormalized,
  type NormalizedIndex,
} from "@/lib/documents/normalized-json"
import { normalizedKey } from "@/lib/storage/blob"
import {
  documentSeal,
  getSealed,
  openSealedObject,
  putSealed,
  putSealedStream,
  type DocumentSeal,
} from "@/lib/storage/sealed"
import { ByteQueue, type ByteSource } from "@/lib/storage/streams"
import type {
  NormalizedDocument,
  NormalizedOutline,
  NormalizedPage,
} from "@/types/document"

/**
 * The normalized model contains the document's text. It is therefore stored the
 * same way the source is: encrypted under the document's own data key, outside
 * the database, and bound to its own path so it cannot be swapped for another
 * of the document's objects.
 *
 * It is stored as one JSON document, and indexed: `NormalizedIndex` records the
 * byte range of every page, so a reader can take one page, a handful, or all
 * of them one at a time, instead of the whole model at once. See
 * lib/documents/normalized-json.ts.
 */

export type SavedNormalized = { key: string; index: NormalizedIndex }

export async function saveNormalized(
  documentId: string,
  seal: DocumentSeal,
  model: NormalizedDocument
): Promise<SavedNormalized> {
  const { json, index } = serializeNormalized(model)
  const stored = await putSealed(
    normalizedKey(documentId),
    Buffer.from(json, "utf8"),
    seal
  )
  return { key: stored.key, index }
}

/**
 * Stores a model that arrives as JSON text in pieces, for an extractor that
 * writes pages as it reads them rather than building the whole model first.
 * The pieces must concatenate to one JSON document; the index comes from the
 * extractor, which is the only thing that knows where its pages went.
 */
export async function saveNormalizedStream(
  documentId: string,
  seal: DocumentSeal,
  json: ByteSource
): Promise<string> {
  const stored = await putSealedStream(normalizedKey(documentId), json, seal)
  return stored.key
}

export async function loadNormalized(
  documentId: string,
  blobKey: string,
  seal: DocumentSeal
): Promise<NormalizedDocument> {
  const plaintext = await getSealed(blobKey, normalizedKey(documentId), seal)
  return JSON.parse(plaintext.toString("utf8")) as NormalizedDocument
}

// --- reading less than the whole ---------------------------------------------

/**
 * One document's model, opened for reading in whatever amount the caller needs.
 *
 * With an index, a page is one ranged read and the pages in sequence are one
 * streamed read that holds a page at a time. Without one — a model written
 * before the index existed — the model is read whole on first use and served
 * from memory, which is what every reader did before; the callers do not need
 * to know which they got.
 */
export type NormalizedReader = {
  /** Whether pages are read from storage one at a time. */
  readonly indexed: boolean
  /** Everything except the pages, with the page numbers that exist. */
  outline(): Promise<NormalizedOutline>
  /** One page, or null if the document has no page with that number. */
  page(number: number): Promise<NormalizedPage | null>
  /**
   * Pages in document order. Every page when `numbers` is absent, streamed so
   * no more than one is held; otherwise just those, read one range at a time.
   */
  pages(numbers?: Iterable<number>): AsyncGenerator<NormalizedPage>
  /** The whole model, for the callers that still need it all at once. */
  whole(): Promise<NormalizedDocument>
}

export type OpenNormalizedInput = {
  documentId: string
  blobKey: string
  seal: DocumentSeal
  index: NormalizedIndex | null
}

export function openNormalized(input: OpenNormalizedInput): NormalizedReader {
  return input.index
    ? indexedReader({ ...input, index: input.index })
    : wholeReader(input)
}

function outlineOf(model: NormalizedDocument): NormalizedOutline {
  return {
    ...model,
    pages: [],
    pageCount: model.pages.length,
    pageNumbers: model.pages.map((page) => page.number),
  }
}

function wholeReader(input: OpenNormalizedInput): NormalizedReader {
  let loaded: Promise<NormalizedDocument> | null = null
  const whole = () =>
    (loaded ??= loadNormalized(input.documentId, input.blobKey, input.seal))

  return {
    indexed: false,
    whole,
    outline: async () => outlineOf(await whole()),
    page: async (number) =>
      (await whole()).pages.find((page) => page.number === number) ?? null,
    async *pages(numbers) {
      const wanted = numbers ? new Set(numbers) : null
      for (const page of (await whole()).pages) {
        if (!wanted || wanted.has(page.number)) yield page
      }
    },
  }
}

function indexedReader(
  input: OpenNormalizedInput & { index: NormalizedIndex }
): NormalizedReader {
  const { index } = input
  const logicalKey = normalizedKey(input.documentId)
  // Opened on first use: a reader nobody reads from costs no request.
  let opened: ReturnType<typeof openSealedObject> | null = null
  const object = () =>
    (opened ??= openSealedObject(input.blobKey, logicalKey, input.seal))

  const parsePage = (bytes: Buffer, number: number): NormalizedPage => {
    const page = JSON.parse(bytes.toString("utf8")) as NormalizedPage
    // The bytes are authenticated; the offsets came from the database. A page
    // that parses and is not the one asked for means the two disagree, and a
    // wrong page is worse than a failed request.
    if (page.number !== number) {
      throw new Error("Normalized index does not match its model")
    }
    return page
  }

  const readPage = async (entry: [number, number, number]) => {
    const [number, start, end] = entry
    const sealed = await object()
    return parsePage(await sealed.range(start, end), number)
  }

  return {
    indexed: true,

    whole: () => loadNormalized(input.documentId, input.blobKey, input.seal),

    async outline() {
      const sealed = await object()
      const [head, tail] = await Promise.all([
        sealed.range(0, index.open + 1),
        sealed.range(index.close, index.size),
      ])
      const model = JSON.parse(
        Buffer.concat([head, tail]).toString("utf8")
      ) as NormalizedDocument
      return {
        ...model,
        pages: [],
        pageCount: index.pages.length,
        pageNumbers: index.pages.map(([number]) => number),
      }
    },

    async page(number) {
      const entry = index.pages.find(([candidate]) => candidate === number)
      return entry ? readPage(entry) : null
    },

    async *pages(numbers) {
      if (numbers) {
        const wanted = new Set(numbers)
        for (const entry of index.pages) {
          if (wanted.has(entry[0])) yield await readPage(entry)
        }
        return
      }
      if (index.pages.length === 0) return

      const stream = await (await object()).stream()
      try {
        yield* slicePages(stream, index, parsePage)
      } finally {
        stream.destroy()
      }
    },
  }
}

/**
 * Cuts a model's pages out of it as it streams past.
 *
 * Holds what arrived since the last page ended and nothing before it, so the
 * footprint is a page plus a storage chunk, whatever the model's size.
 */
async function* slicePages(
  stream: Readable,
  index: NormalizedIndex,
  parsePage: (bytes: Buffer, number: number) => NormalizedPage
): AsyncGenerator<NormalizedPage> {
  const queue = new ByteQueue()
  /** Absolute offset of the first byte in `queue`. */
  let position = 0
  let next = 0

  const drain = function* (): Generator<NormalizedPage> {
    while (next < index.pages.length) {
      const [number, start, end] = index.pages[next]
      if (position < start) {
        const skip = Math.min(start - position, queue.length)
        queue.take(skip)
        position += skip
        if (position < start) return
      }
      if (position + queue.length < end) return
      yield parsePage(queue.take(end - start), number)
      position = end
      next += 1
    }
  }

  for await (const piece of stream as AsyncIterable<Buffer>) {
    queue.push(piece)
    yield* drain()
    if (next === index.pages.length) return
  }
  yield* drain()

  if (next < index.pages.length) {
    throw new Error("Normalized model ended before its index did")
  }
}

/** The columns a document needs for its model to be opened. */
export type NormalizedRecord = {
  id: string
  encryptionKey: string | null
  encryptionFormat?: string | null
  normalizedBlobKey: string | null
  normalizedIndex?: unknown
}

/**
 * Opens a document's model from its database row.
 *
 * Throws when there is no model to open, which every caller has already ruled
 * out; the check is here so the types can say so.
 */
export function readNormalized(document: NormalizedRecord): NormalizedReader {
  if (!document.normalizedBlobKey || !document.encryptionKey) {
    throw new Error("Document has not been normalized")
  }
  return openNormalized({
    documentId: document.id,
    blobKey: document.normalizedBlobKey,
    seal: documentSeal(document),
    index: parseNormalizedIndex(document.normalizedIndex),
  })
}

/**
 * The model as analysis reads it: every page's text, and nothing it is drawn
 * with.
 *
 * Detection, classification, the contextual pass and occurrence expansion all
 * read `page.text` and never a span, a block or a section. Those are most of a
 * model — a PDF span carries a box and an offset per character — so leaving
 * them behind as the pages stream past is what keeps analysis to the size of
 * the text rather than the size of the model.
 */
export async function loadTextModel(
  reader: NormalizedReader
): Promise<NormalizedDocument> {
  const pages: NormalizedPage[] = []
  for await (const page of reader.pages()) {
    pages.push({
      number: page.number,
      width: page.width,
      height: page.height,
      text: page.text,
      spans: [],
      ...(page.ocr === undefined ? {} : { ocr: page.ocr }),
      ...(page.images === undefined ? {} : { images: page.images }),
    })
  }
  return withPages(await reader.outline(), pages)
}

/** An outline made back into a model, holding the pages given. */
export function withPages(
  outline: NormalizedOutline,
  pages: NormalizedPage[]
): NormalizedDocument {
  const model: NormalizedDocument & {
    pageCount?: number
    pageNumbers?: number[]
  } = { ...outline, pages }
  delete model.pageCount
  delete model.pageNumbers
  return model
}
