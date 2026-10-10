import { randomBytes } from "node:crypto"

import { processingConcurrency } from "@/lib/documents/batch-config"
import { prisma } from "@/lib/database/prisma"

/**
 * How many of one owner's documents may be processing at once.
 *
 * There used to be no answer to that question. Every upload called
 * `/api/documents/:id/process`, which started a durable run the moment the
 * bytes landed, so twenty files meant twenty concurrent extractions, OCR
 * passes and model calls. The rate limiter looked like it bounded this and did
 * not: it bounds how often a run may be *started*, and a run that takes ninety
 * seconds is still running long after its slot in the window has refilled.
 * Rate is not concurrency, and only one of them bounds memory, database
 * connections and spend at a model provider.
 *
 * So a document is now *queued* rather than started, and admitted when there is
 * room. The queue is not a table: a document with `status: "queued"` and no
 * `workflowRunId` is one waiting to start, which is a state the schema already
 * had and the interface already renders as "in progress" — because it is.
 *
 * Admission is called from three places, and the third is what makes it a
 * queue rather than a throttle:
 *
 *   - the process route, when bytes have just landed;
 *   - the retry route, for the same reason;
 *   - the end of a processing run, which is what admits the next document.
 *
 * Bounded per owner rather than globally. A shared demo has many visitors and
 * one host, but a global bound would let one reviewer's twenty-file batch stall
 * everybody else's single document — the thing being rationed is one person's
 * share, and the host's own ceiling is the rate limit above this.
 *
 * A shared deployment can add a global ceiling too,
 * `ANONIFY_PROCESSING_GLOBAL_MAX` (#181): documents in flight across every
 * owner. With one set, a slot that frees goes to whichever owner has waited
 * longest, one document per owner per turn, so one large batch cannot starve
 * everybody else's.
 */

type Env = Record<string, string | undefined>

/**
 * What `workflowRunId` holds while a claimed document's run is being started:
 * counted as in flight, and never a run anyone can read or cancel.
 */
export const PENDING_RUN_PREFIX = "pending_"

function pendingRunId(): string {
  return `${PENDING_RUN_PREFIX}${randomBytes(12).toString("hex")}`
}

/** A claim whose run is still being started, or was never started. */
export function isPendingRun(runId: string | null | undefined): boolean {
  return Boolean(runId?.startsWith(PENDING_RUN_PREFIX))
}

export const PROCESSING_GLOBAL_MAX_ENV = "ANONIFY_PROCESSING_GLOBAL_MAX"

/**
 * `ANONIFY_PROCESSING_GLOBAL_MAX` (1–100000): documents processing at once
 * across every owner, or undefined for no cap (the default). Malformed throws.
 */
export function processingGlobalMax(
  env: Env = process.env
): number | undefined {
  const raw = env[PROCESSING_GLOBAL_MAX_ENV]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 100_000)
    throw new Error(
      `${PROCESSING_GLOBAL_MAX_ENV} must be a whole number from 1 to 100000, got "${raw}"`
    )
  return value
}

/**
 * Starting one document's run, supplied by the caller.
 *
 * Passed in rather than imported, and not for taste: this module is reached
 * from inside the processing workflow, and importing the workflow it starts
 * would be a cycle the workflow compiler refuses — it follows the graph out of
 * a workflow function and finds this module's database client sitting at the
 * top of a module it now believes is part of one. Taking the starter as an
 * argument keeps the queue logic free of both.
 *
 * Returns the run id.
 */
export type StartRun = (documentId: string) => Promise<string>

/** A run exists and has not reached a terminal state. */
const WORKING_STATUSES = ["queued", "extracting", "normalizing", "analyzing"]

/**
 * Documents this owner has in flight right now.
 *
 * A run that exists is in flight whatever stage it reports, and a document with
 * no run is not — which is exactly the distinction `workflowRunId` draws.
 */
async function inFlight(ownerKey?: string): Promise<number> {
  return prisma.document.count({
    where: {
      ...(ownerKey !== undefined ? { userFingerprint: ownerKey } : {}),
      workflowRunId: { not: null },
      status: { in: WORKING_STATUSES },
      expiresAt: { gt: new Date() },
    },
  })
}

/** Room under the global cap: unbounded when none is set. */
async function globalRoom(): Promise<number> {
  const cap = processingGlobalMax()
  if (cap === undefined) return Number.POSITIVE_INFINITY
  return cap - (await inFlight())
}

/** Documents waiting for a slot, as a query. */
function waitingWhere(ownerKey?: string) {
  return {
    ...(ownerKey !== undefined ? { userFingerprint: ownerKey } : {}),
    workflowRunId: null,
    status: "queued",
    // Bytes have to have landed. A reserved document whose upload never
    // arrived is not waiting for a slot, it is waiting for a file.
    uploadBlobKey: { not: null },
    expiresAt: { gt: new Date() },
  }
}

/**
 * Starts as many of this owner's waiting documents as there is room for.
 *
 * Oldest first, so a batch is processed in the order it was uploaded and a
 * reviewer watching the list sees it move top to bottom rather than at random.
 *
 * Two callers arriving together can admit one document more than the limit
 * says, because the count and the start are not one atomic act. That is
 * deliberate: the alternative is a lock held across `start()`, which is a
 * network call to the workflow runtime, and holding a database lock across one
 * of those to save an occasional off-by-one is a worse trade. The limit bounds
 * sustained concurrency, and is documented as doing that rather than as a
 * mutex. The global cap, when one is set, is the same kind of bound.
 *
 * `max` admits at most that many, for the fair pass below.
 */
export async function admitQueued(
  ownerKey: string | undefined,
  startRun: StartRun,
  { max = Number.POSITIVE_INFINITY }: { max?: number } = {}
): Promise<number> {
  if (!ownerKey) return 0

  const limit = processingConcurrency()
  const room = Math.min(
    max,
    limit - (await inFlight(ownerKey)),
    await globalRoom()
  )
  if (room <= 0) return 0

  const waiting = await prisma.document.findMany({
    where: waitingWhere(ownerKey),
    orderBy: { createdAt: "asc" },
    take: room,
    select: { id: true },
  })

  let admitted = 0

  for (const document of waiting) {
    // Claimed before the run is started, and only if nothing else claimed it
    // first. It used to be started first and claimed after, so two admissions
    // racing on one document (an upload landing as a sweep ran) both started
    // a run, and the loser's kept working on a document that was not its own,
    // failing once the document was gone. The built-in scheduler (#183) made
    // that race a regular one.
    const pending = pendingRunId()
    const claimed = await prisma.document.updateMany({
      where: { id: document.id, workflowRunId: null },
      data: { workflowRunId: pending },
    })
    if (claimed.count === 0) continue

    let runId: string
    try {
      runId = await startRun(document.id)
    } catch (error) {
      // Back to waiting, for the next admission to try.
      await prisma.document.updateMany({
        where: { id: document.id, workflowRunId: pending },
        data: { workflowRunId: null },
      })
      throw error
    }
    await prisma.document.updateMany({
      where: { id: document.id, workflowRunId: pending },
      data: { workflowRunId: runId },
    })
    admitted += 1

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.admission",
        documentId: document.id,
        workflowId: runId,
        inFlightLimit: limit,
      })
    )
  }

  return admitted
}

/**
 * The owner of a document, for a caller that has an id and nothing else.
 *
 * The processing run knows which document it just finished and not whose it
 * was, and the next document to admit is the next of *that owner's* rather
 * than the next of anyone's.
 */
export async function ownerOf(documentId: string): Promise<string | undefined> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { userFingerprint: true },
  })
  return document?.userFingerprint
}

/**
 * Admits whatever is waiting behind the document that has just finished.
 *
 * Failures here are swallowed on purpose. This runs at the end of a run that
 * has already done its work and recorded its result; throwing would retry a
 * completed document to fix a queue, which is the wrong repair. The next
 * upload, retry or sweep admits what this call missed.
 */
export async function admitAfter(
  documentId: string,
  startRun: StartRun
): Promise<void> {
  try {
    // Under a global cap the slot just freed is everybody's, so it goes to
    // whoever has waited longest rather than to the next of this owner's.
    if (processingGlobalMax() !== undefined) await admitFairly(startRun)
    else await admitQueued(await ownerOf(documentId), startRun)
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        context: "documents.admission",
        documentId,
        errorCategory: "admit-failed",
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }
}

/**
 * Every owner with something waiting, admitted as far as their limit allows.
 *
 * The safety net, run by the cleanup cron. Admission is otherwise driven by
 * events — an upload, a retry, a run finishing — and an event that never
 * arrives is a document queued forever: a run killed between claiming a slot
 * and finishing, a deploy in the middle of a batch. This is what makes that a
 * delay rather than a document nobody will ever look at again.
 */
export async function admitStalled(startRun: StartRun): Promise<number> {
  return admitFairly(startRun)
}

/**
 * Every owner with something waiting, in turns (#181).
 *
 * Owners are taken in the order of their oldest waiting document. With no
 * global cap each is admitted as far as their own limit allows, as before.
 * With one, each turn admits one document per owner, round and round until
 * the cap is reached or nobody has room, so the first owner's batch of fifty
 * does not take every slot before the second owner's one document is looked
 * at.
 */
export async function admitFairly(startRun: StartRun): Promise<number> {
  const owners = await prisma.document.groupBy({
    by: ["userFingerprint"],
    where: waitingWhere(),
    _min: { createdAt: true },
    orderBy: { _min: { createdAt: "asc" } },
  })

  const capped = processingGlobalMax() !== undefined
  let turn = owners.map((owner) => owner.userFingerprint)
  let admitted = 0

  while (turn.length > 0) {
    const again: string[] = []
    for (const owner of turn) {
      if (capped && (await globalRoom()) <= 0) return admitted
      const started = await admitQueued(owner, startRun, {
        max: capped ? 1 : Number.POSITIVE_INFINITY,
      })
      admitted += started
      // Uncapped, one call has already taken all this owner had room for.
      if (capped && started > 0) again.push(owner)
    }
    turn = again
  }
  return admitted
}
