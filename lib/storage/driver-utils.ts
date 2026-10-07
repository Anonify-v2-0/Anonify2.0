import { Transform, type Readable } from "node:stream"

import { chain } from "@/lib/storage/streams"
import type { StorageDriver } from "@/lib/storage/drivers"

/**
 * Pieces every storage driver shares. Kept apart from drivers.ts so a driver
 * in a file of its own (lib/storage/azure.ts) can use them without importing
 * the module that imports it.
 */

/** An error that means the object was already gone: a delete that succeeded. */
export function isMissingObject(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|404|NoSuchKey/i.test(message)
}

/** `delete` once per key, for a backend with no bulk call. */
export async function deleteEach(
  driver: Pick<StorageDriver, "delete">,
  keys: string[]
): Promise<{ failed: string[] }> {
  const failed: string[] = []
  for (const key of keys) {
    try {
      await driver.delete(key)
    } catch (error) {
      if (!isMissingObject(error)) failed.push(key)
    }
  }
  return { failed }
}

/** Counts what passes through, for a `StoredObject.size` nobody precomputed. */
export class ByteCounter extends Transform {
  bytes = 0

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.bytes += chunk.byteLength
    callback(null, chunk)
  }
}

/** Pipes a body through a counter; see `chain` for why not plain `pipe`. */
export function counted(body: Readable): ByteCounter {
  return chain(body, new ByteCounter())
}

/**
 * The requested slice of a response that may or may not have honoured the
 * range. A backend that ignored it sent the whole object, which is still an
 * answer — just a more expensive one.
 */
export function sliceIfWhole(
  bytes: Buffer,
  honoured: boolean,
  start: number,
  end: number
): Buffer {
  const slice = honoured ? bytes : bytes.subarray(start, end)
  if (slice.byteLength !== end - start) {
    throw new Error(
      `Ranged read returned ${slice.byteLength} bytes, expected ${end - start}`
    )
  }
  return slice
}

export function assertRange(start: number, end: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new RangeError(`Invalid byte range ${start}-${end}`)
  }
}
