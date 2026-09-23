import { Readable, type Transform } from "node:stream"

/**
 * Small, dependency-free helpers for moving bytes through the pipeline without
 * holding all of them at once.
 */

/** Anything bytes can be pulled from, one piece at a time. */
export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>

/**
 * A FIFO of byte pieces that can hand back an exact number of bytes.
 *
 * Concatenating every incoming piece onto one growing buffer is quadratic in
 * the object's size, and the whole point of streaming is that the object can
 * be large. Pieces are kept as they arrived and only joined when a caller asks
 * for a run of them.
 */
export class ByteQueue {
  private pieces: Buffer[] = []
  private total = 0

  get length(): number {
    return this.total
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.pieces.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    this.total += bytes.byteLength
  }

  /** Removes and returns exactly `count` bytes. Throws if there are fewer. */
  take(count: number): Buffer {
    if (count > this.total) {
      throw new RangeError(`Asked for ${count} bytes, ${this.total} queued`)
    }
    if (count === 0) return Buffer.alloc(0)

    const first = this.pieces[0]
    if (first.byteLength === count) {
      this.pieces.shift()
      this.total -= count
      return first
    }
    if (first.byteLength > count) {
      this.pieces[0] = first.subarray(count)
      this.total -= count
      return first.subarray(0, count)
    }

    const out = Buffer.allocUnsafe(count)
    let written = 0
    while (written < count) {
      const piece = this.pieces[0]
      const wanted = count - written
      if (piece.byteLength <= wanted) {
        piece.copy(out, written)
        written += piece.byteLength
        this.pieces.shift()
      } else {
        piece.copy(out, written, 0, wanted)
        this.pieces[0] = piece.subarray(wanted)
        written += wanted
      }
    }
    this.total -= count
    return out
  }

  /** Removes and returns everything queued. */
  drain(): Buffer {
    return this.take(this.total)
  }
}

/** Reads a source to the end. For the paths that genuinely need every byte. */
export async function collect(source: ByteSource): Promise<Buffer> {
  const pieces: Buffer[] = []
  for await (const piece of source) {
    pieces.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece))
  }
  return Buffer.concat(pieces)
}

/**
 * The first `count` bytes of a source, and a source for everything after them.
 *
 * Content sniffing needs the head of a file and nothing else, so ingest reads
 * that much, decides, and then lets the rest flow straight through to the
 * sealer without it ever landing in one place. `head` may be shorter than
 * `count` when the whole source is.
 */
export async function readHead(
  source: ByteSource,
  count: number
): Promise<{ head: Buffer; rest: AsyncIterable<Buffer> }> {
  const iterator = toAsyncIterator(source)
  const queue = new ByteQueue()
  let done = false

  while (queue.length < count) {
    const next = await iterator.next()
    if (next.done) {
      done = true
      break
    }
    queue.push(next.value)
  }

  const head = queue.take(Math.min(count, queue.length))
  const overflow = queue.drain()

  async function* rest(): AsyncGenerator<Buffer> {
    if (overflow.byteLength > 0) yield overflow
    if (done) return
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
    }
  }

  return { head, rest: rest() }
}

function toAsyncIterator(source: ByteSource): AsyncIterator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    return (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  }
  const iterator = (source as Iterable<Uint8Array>)[Symbol.iterator]()
  return {
    next: async () => iterator.next(),
  }
}

/**
 * Holds a stream's failure until its consumer is listening.
 *
 * A piped stream starts flowing at once, and its consumer — a storage driver,
 * say — often attaches only after an `await` of its own: a directory to make,
 * an SDK to import. A source that fails in that gap emits `error` with nobody
 * listening, and an unheard `error` takes the process down. With this the
 * failure is kept as the stream's errored state instead, which is exactly
 * what `pipeline` and async iteration report to whoever reads it next.
 */
export function holdErrors<T extends Readable>(stream: T): T {
  stream.on("error", () => {})
  return stream
}

/**
 * Pipes a source into a transform, carrying the source's failure across.
 *
 * `pipe` does not forward errors, so without this a source that fails midway
 * leaves the transform — and whatever reads it — waiting for an end that will
 * never come.
 */
export function chain<T extends Transform>(source: Readable, transform: T): T {
  holdErrors(transform)
  source.on("error", (error) => transform.destroy(error))
  return source.pipe(transform)
}

/** A Node stream over any byte source, for the APIs that insist on one. */
export function toReadable(source: ByteSource | Readable): Readable {
  if (source instanceof Readable) return source
  return Readable.from(source, { objectMode: false })
}
