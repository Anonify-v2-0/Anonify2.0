import sharp from "sharp"

import { TextStreamBuilder } from "@/lib/documents/shared/text"
import type {
  ImageRegion,
  NormalizedDocument,
  NormalizedPage,
} from "@/types/document"

/**
 * Image extraction.
 *
 * An image is either a picture of a document, a photograph, or both, and the
 * distinction changes what the editor should offer. OCR gives selectable text
 * regions to snap to; faces and other visual regions come from the vision
 * analysis. Either way the user can always draw their own rectangle — detection
 * is an assist, never the last word.
 */

export type ImageClass = "document" | "photograph" | "mixed"

/** Words below this OCR confidence are noise more often than text. */
const MIN_WORD_CONFIDENCE = 40
/** Above this share of the frame covered by text, it reads as a document scan. */
const DOCUMENT_TEXT_COVERAGE = 0.04

type OcrWord = {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

export async function ocrImage(
  bytes: Uint8Array
): Promise<{ words: OcrWord[]; text: string }> {
  const { createWorker } = await import("tesseract.js")

  // Serverless filesystems are read-only apart from /tmp.
  const worker = await createWorker("eng", undefined, {
    cachePath: process.env.VERCEL ? "/tmp" : undefined,
  })

  try {
    const { data } = await worker.recognize(
      Buffer.from(bytes),
      {},
      { blocks: true }
    )

    const words: OcrWord[] = []
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          for (const word of line.words ?? []) {
            words.push({
              text: word.text,
              confidence: word.confidence,
              bbox: word.bbox,
            })
          }
        }
      }
    }

    return { words, text: data.text ?? "" }
  } finally {
    await worker.terminate()
  }
}

export type ImageExtraction = {
  document: NormalizedDocument
  imageClass: ImageClass
}

export async function extractImage(
  documentId: string,
  bytes: Uint8Array
): Promise<ImageExtraction> {
  const metadata = await sharp(Buffer.from(bytes)).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width === 0 || height === 0) {
    throw new Error("Image has no readable dimensions")
  }

  const { words } = await ocrImage(bytes)
  const usable = words.filter(
    (word) =>
      word.confidence >= MIN_WORD_CONFIDENCE && word.text.trim().length > 0
  )

  const builder = new TextStreamBuilder()
  const regions: ImageRegion[] = []

  usable.forEach((word, index) => {
    const box = {
      x: word.bbox.x0,
      y: word.bbox.y0,
      width: word.bbox.x1 - word.bbox.x0,
      height: word.bbox.y1 - word.bbox.y0,
    }

    const id = `ocr${index}`
    builder.append(id, word.text, { boundingBox: box })
    builder.pad(" ")

    regions.push({
      id,
      kind: "ocr-text",
      boundingBox: box,
      text: word.text,
      confidence: word.confidence / 100,
    })
  })

  const textArea = regions.reduce(
    (total, region) =>
      total + region.boundingBox.width * region.boundingBox.height,
    0
  )
  const coverage = textArea / (width * height)

  const imageClass: ImageClass =
    usable.length === 0
      ? "photograph"
      : coverage >= DOCUMENT_TEXT_COVERAGE
        ? "document"
        : "mixed"

  const page: NormalizedPage = {
    number: 1,
    width,
    height,
    text: builder.text,
    spans: builder.spans,
    ocr: usable.length > 0 ? true : undefined,
  }

  return {
    document: {
      documentId,
      kind: "image",
      pages: [page],
      regions,
      metadata: {
        width,
        height,
        format: metadata.format,
        imageClass,
        hasExif: Boolean(metadata.exif),
      },
    },
    imageClass,
  }
}
