import { formatByteSize, readByteSizeEnv } from "@/lib/config/bytes"
import { activeProfile, type Profile } from "@/lib/config/profile"
import { JOB_CONCURRENCY_ENV, jobConcurrency } from "@/lib/runtime/capacity"

/**
 * How much memory streaming is allowed to use.
 *
 * Streaming bounds one document's footprint by the chunk size instead of by
 * the file — but only if the number of chunks in flight is bounded too.
 * Sixteen chunks buffered per document, times a megabyte, times however many
 * documents are processing at once, is a larger footprint than the
 * whole-file approach this replaced. So the budget is stated once, as the
 * product that actually matters:
 *
 * ```
 * chunkBytes × maxInFlightChunks × jobConcurrency() <= memoryBudget
 * ```
 *
 * `jobConcurrency()` answers "how many steps at once in this process"
 * (lib/runtime/capacity.ts), and this answers "how many chunks per step" by
 * dividing the budget by it, rather than being a second, independent limiter
 * that could disagree with the first.
 *
 * Per process (#181). It used to be divided by the per-*owner* processing
 * limit, which was only the process's real concurrency while one owner was
 * active: ten owners' documents shared a budget sized for one owner's six.
 *
 * Ingest of an upload the browser sealed runs one stage more than any other
 * read: a `ChunkOpener` in front of the sniff and the sealer, holding the
 * chunk it is authenticating and the one behind it. Those are upload chunks,
 * which are a fixed 1 MiB whatever this file configures, and ingest refuses an
 * upload that declares any other size (lib/storage/upload-encryption.ts), so
 * the opener adds at most two of them — 2 MiB per ingesting document, fixed,
 * and not something an upload can inflate by claiming a larger chunk.
 */

export type StreamingLimits = {
  /**
   * The chunk size new objects are sealed with. A power of two.
   *
   * Only what *new* objects use: every sealed object records its own chunk
   * size in its header and is opened with that, so changing this never makes
   * anything already stored unreadable.
   */
  chunkBytes: number
  /** The whole streaming footprint, across every step this process runs at once. */
  memoryBudget: number
}

/**
 * 1 MiB. At 64 KiB a 50 MiB file is 800 range-addressable units and as many
 * potential round-trips; at 4 MiB the floor per in-flight chunk is high enough
 * to defeat the purpose. At 1 MiB the same file is 50 chunks and 800 bytes of
 * tags.
 */
const DEFAULT_CHUNK_BYTES = 1024 * 1024

/**
 * How many chunks each running step gets when no budget is set, per profile.
 *
 * The default budget is this times the chunk size times the job concurrency —
 * 64 MiB self-hosted on two CPUs (`all`, four jobs) — rather than a fixed
 * number, so a process given more jobs gets a budget that grew with it instead
 * of one it suddenly does not fit in. Only a budget somebody set can be too
 * small.
 */
const DEFAULT_CHUNKS_PER_DOCUMENT: Record<Profile, number> = {
  demo: 8,
  "self-hosted": 16,
}

export const CHUNK_SIZE_ENV = "ANONIFY_ENCRYPTION_CHUNK_SIZE"
export const MEMORY_BUDGET_ENV = "ANONIFY_STREAM_MEMORY_BUDGET"

/** The chunk sizes configuration may choose; the format itself allows more. */
const MIN_CONFIGURED_CHUNK = 64 * 1024
const MAX_CONFIGURED_CHUNK = 16 * 1024 * 1024

/**
 * The smallest useful number of chunks per document: one being worked on and
 * one arriving behind it. The sealer and opener both need a chunk of
 * lookahead to know which one is final, so fewer than two is not a budget,
 * it is a stall.
 */
const MIN_IN_FLIGHT = 2

export function streamingLimits(
  profile: Profile = activeProfile()
): StreamingLimits {
  const chunkBytes = readByteSizeEnv(CHUNK_SIZE_ENV, DEFAULT_CHUNK_BYTES)
  if (
    chunkBytes < MIN_CONFIGURED_CHUNK ||
    chunkBytes > MAX_CONFIGURED_CHUNK ||
    (chunkBytes & (chunkBytes - 1)) !== 0
  ) {
    throw new Error(
      `${CHUNK_SIZE_ENV} must be a power of two between ` +
        `${formatByteSize(MIN_CONFIGURED_CHUNK)} and ` +
        `${formatByteSize(MAX_CONFIGURED_CHUNK)}, got ${formatByteSize(chunkBytes)}`
    )
  }

  const memoryBudget = readByteSizeEnv(
    MEMORY_BUDGET_ENV,
    chunkBytes * DEFAULT_CHUNKS_PER_DOCUMENT[profile] * jobConcurrency()
  )
  return { chunkBytes, memoryBudget }
}

/** log2 of the configured chunk size, as it is written into a header. */
export function chunkShift(
  limits: StreamingLimits = streamingLimits()
): number {
  return Math.log2(limits.chunkBytes)
}

/**
 * How many chunks one step may have in flight.
 *
 * A budget too small to give every concurrent document two chunks is refused
 * rather than quietly floored. A limit somebody believes they set and which is
 * not in force is worse than no setting at all; that is the rule every other
 * limit in this codebase follows, and a memory ceiling is the last one to
 * break it for.
 */
export function maxInFlightChunks(
  limits: StreamingLimits = streamingLimits(),
  concurrency: number = jobConcurrency()
): number {
  const perDocument = Math.floor(
    limits.memoryBudget / (limits.chunkBytes * concurrency)
  )
  if (perDocument < MIN_IN_FLIGHT) {
    throw new Error(
      `${MEMORY_BUDGET_ENV} of ${formatByteSize(limits.memoryBudget)} cannot ` +
        `hold ${MIN_IN_FLIGHT} chunks of ${formatByteSize(limits.chunkBytes)} ` +
        `for each of the ${concurrency} jobs this process runs at once. Raise ` +
        `it, lower ${CHUNK_SIZE_ENV}, or lower ${JOB_CONCURRENCY_ENV} (which ` +
        `defaults from the CPUs available and ANONIFY_ROLE).`
    )
  }
  return perDocument
}

/** One step's share of the budget, in bytes. */
export function perDocumentStreamBytes(
  limits: StreamingLimits = streamingLimits()
): number {
  return limits.chunkBytes * maxInFlightChunks(limits)
}
