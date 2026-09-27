import { pipeline, Readable } from "node:stream"
import { createInflateRaw } from "node:zlib"

import type { RangeSource } from "@/lib/storage/range-source"

/**
 * A zip archive read by ranges, one entry at a time.
 *
 * The whole-file path hands the archive to `unzipSync` (fflate, for Word and
 * PowerPoint) or to JSZip (inside exceljs, for workbooks), and both inflate
 * every entry into memory before anything looks at one. This reads the
 * central directory with one ranged read from the end, and then inflates only
 * the entries asked for, a window at a time — so a deck's forty megabytes of
 * photographs are never inflated to read its slides.
 *
 * It exists to produce exactly what those parsers would, and zips are a
 * format where parsers famously disagree: a name in the central directory and
 * a different one in the local header, prepended bytes that shift every
 * offset, zip64 fields, an entry that inflates to a size other than the one
 * it declared. Each of those is a place the two whole-file parsers answer
 * differently from each other. So this reader does not pick an answer. It
 * refuses with `ZipFallback`, and the caller extracts the file the way it
 * always did. An archive a real office suite wrote passes every check here;
 * an archive that does not was never going to be a streaming win.
 */

export class ZipFallback extends Error {
  constructor(reason: string) {
    super(`Archive needs the whole-file path: ${reason}`)
    this.name = "ZipFallback"
  }
}

export type ZipEntry = {
  /** As stored; ASCII by the time it is here. */
  name: string
  /** 0 stored, 8 deflated. */
  method: 0 | 8
  compressedSize: number
  uncompressedSize: number
  /** Where the local header starts. */
  localOffset: number
  /**
   * Whether JSZip would call it a folder. fflate lists folders as ordinary,
   * usually empty, entries; which one a caller follows is the caller's call.
   */
  directory: boolean
}

const EOCD_SIGNATURE = 0x06054b50
const EOCD_BYTES = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const CENTRAL_SIGNATURE = 0x02014b50
const CENTRAL_BYTES = 46
const LOCAL_SIGNATURE = 0x04034b50
const LOCAL_BYTES = 30
/** The largest comment a zip can carry, which bounds where its end record is. */
const MAX_COMMENT = 0xffff
/** Info-ZIP's Unicode path field, which JSZip lets override a name. */
const UNICODE_PATH_FIELD = 0x7075

/** The bytes inflated per ranged read. */
const DEFAULT_WINDOW = 256 * 1024

export type ZipArchive = {
  entries: ZipEntry[]
  /** The entry with this exact name, if there is one. */
  entry(name: string): ZipEntry | undefined
  /** An entry's contents, inflated as they are read. */
  read(entry: ZipEntry): AsyncGenerator<Buffer>
  /** An entry's contents, whole. For the parts that are small by nature. */
  readAll(entry: ZipEntry): Promise<Buffer>
}

export async function openZip(
  source: RangeSource,
  window = DEFAULT_WINDOW
): Promise<ZipArchive> {
  const tailStart = Math.max(0, source.size - (EOCD_BYTES + MAX_COMMENT))
  const tail = await source.range(tailStart, source.size)

  // The last end-of-central-directory signature, which is the one both
  // whole-file parsers settle on; a comment that happens to hold the
  // signature is then caught by the length check below.
  let at = -1
  for (let index = tail.byteLength - EOCD_BYTES; index >= 0; index--) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      at = index
      break
    }
  }
  if (at < 0) throw new ZipFallback("no end of central directory")

  const eocd = tail.subarray(at, at + EOCD_BYTES)
  const eocdOffset = tailStart + at
  const disk = eocd.readUInt16LE(4)
  const centralDisk = eocd.readUInt16LE(6)
  const onDisk = eocd.readUInt16LE(8)
  const total = eocd.readUInt16LE(10)
  const centralSize = eocd.readUInt32LE(12)
  const centralOffset = eocd.readUInt32LE(16)
  const commentLength = eocd.readUInt16LE(20)

  if (eocdOffset + EOCD_BYTES + commentLength !== source.size) {
    throw new ZipFallback("trailing bytes after the end record")
  }
  if (
    at >= 20 &&
    tail.readUInt32LE(at - 20) === ZIP64_LOCATOR_SIGNATURE
  ) {
    throw new ZipFallback("zip64")
  }
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    onDisk !== total ||
    total === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new ZipFallback("multi-disk or zip64 fields")
  }
  // Nothing between the directory and its end record, and nothing in front of
  // the first entry that would shift every offset: the two parsers compensate
  // for prepended bytes differently, and only one of them compensates at all.
  if (centralOffset + centralSize !== eocdOffset) {
    throw new ZipFallback("central directory is not where it says")
  }

  const central = await source.range(centralOffset, eocdOffset)
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let cursor = 0

  for (let count = 0; count < total; count++) {
    if (
      cursor + CENTRAL_BYTES > central.byteLength ||
      central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw new ZipFallback("malformed central directory")
    }
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentBytes = central.readUInt16LE(cursor + 32)
    const external = central.readUInt32LE(cursor + 38)
    const localOffset = central.readUInt32LE(cursor + 42)

    const nameStart = cursor + CENTRAL_BYTES
    const extraStart = nameStart + nameLength
    const next = extraStart + extraLength + commentBytes
    if (next > central.byteLength) throw new ZipFallback("malformed central directory")

    const nameBytes = central.subarray(nameStart, extraStart)
    if (nameBytes.some((byte) => byte >= 0x80)) {
      // Decoded as UTF-8 by one parser and as Latin-1 by the other.
      throw new ZipFallback("a name outside ASCII")
    }
    if (hasField(central.subarray(extraStart, extraStart + extraLength), UNICODE_PATH_FIELD)) {
      throw new ZipFallback("a Unicode path field")
    }
    if (flags & 0x1) throw new ZipFallback("an encrypted entry")
    if (method !== 0 && method !== 8) throw new ZipFallback("an unknown compression method")
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new ZipFallback("zip64 fields")
    }
    if (localOffset + LOCAL_BYTES + compressedSize > centralOffset) {
      throw new ZipFallback("an entry that overlaps the directory")
    }

    const name = nameBytes.toString("latin1")
    // exceljs strips a leading slash, so `a` and `/a` are one part to it.
    const canonical = name.replace(/^\//, "")
    if (names.has(canonical)) throw new ZipFallback("a duplicated name")
    names.add(canonical)

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      directory: name.endsWith("/") || (external & 0x10) !== 0,
    })
    cursor = next
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  /** Where an entry's data begins, having checked its local header agrees. */
  async function dataStart(entry: ZipEntry): Promise<number> {
    const header = await source.range(
      entry.localOffset,
      Math.min(source.size, entry.localOffset + LOCAL_BYTES + entry.name.length)
    )
    if (
      header.byteLength < LOCAL_BYTES + entry.name.length ||
      header.readUInt32LE(0) !== LOCAL_SIGNATURE
    ) {
      throw new ZipFallback("a missing local header")
    }
    const localName = header.readUInt16LE(26)
    const localExtra = header.readUInt16LE(28)
    // JSZip takes the name from here and fflate from the directory; they only
    // agree when the two do.
    if (
      localName !== entry.name.length ||
      header.subarray(LOCAL_BYTES, LOCAL_BYTES + localName).toString("latin1") !==
        entry.name
    ) {
      throw new ZipFallback("local and central names disagree")
    }
    const start = entry.localOffset + LOCAL_BYTES + localName + localExtra
    if (start + entry.compressedSize > source.size) {
      throw new ZipFallback("an entry that runs past the archive")
    }
    return start
  }

  async function* compressed(entry: ZipEntry): AsyncGenerator<Buffer> {
    const start = await dataStart(entry)
    const end = start + entry.compressedSize
    for (let offset = start; offset < end; offset += window) {
      yield await source.range(offset, Math.min(end, offset + window))
    }
  }

  async function* read(entry: ZipEntry): AsyncGenerator<Buffer> {
    let produced = 0
    const check = (piece: Buffer) => {
      produced += piece.byteLength
      if (produced > entry.uncompressedSize) {
        throw new ZipFallback("an entry larger than it declared")
      }
      return piece
    }

    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new ZipFallback("a stored entry with two sizes")
      }
      for await (const piece of compressed(entry)) yield check(piece)
    } else {
      // Fed a window at a time and drained as it goes, so what is held is a
      // window in and whatever it inflated to, never the entry. `pipeline`
      // carries a stop in either direction: a reader that has what it needs
      // stops the range reads behind it.
      const inflate = createInflateRaw()
      pipeline(Readable.from(compressed(entry)), inflate, () => {})
      try {
        for await (const piece of inflate as AsyncIterable<Buffer>) {
          yield check(piece)
        }
      } catch (error) {
        if (error instanceof ZipFallback) throw error
        // Corrupt deflate data. Both whole-file parsers refuse it too, in
        // their own words; they are the ones to say so.
        throw new ZipFallback("corrupt compressed data")
      } finally {
        inflate.destroy()
      }
    }

    if (produced !== entry.uncompressedSize) {
      throw new ZipFallback("an entry smaller than it declared")
    }
  }

  return {
    entries,
    entry: (name) => byName.get(name),
    read,
    async readAll(entry) {
      const pieces: Buffer[] = []
      for await (const piece of read(entry)) pieces.push(piece)
      return Buffer.concat(pieces)
    },
  }
}

function hasField(extra: Buffer, id: number): boolean {
  let at = 0
  while (at + 4 <= extra.byteLength) {
    if (extra.readUInt16LE(at) === id) return true
    at += 4 + extra.readUInt16LE(at + 2)
  }
  return false
}
