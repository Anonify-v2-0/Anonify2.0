import { activeProfile, type Profile } from "@/lib/config/profile"
import { maxBatchFiles } from "@/lib/documents/batch-config"

/**
 * What a mailbox is allowed to cost us.
 *
 * Every other format's limits bound one document. A mailbox is the first one
 * where the amplification factor *is* the point: a single 40 MiB upload is
 * nine hundred documents, nine hundred runs, nine hundred extractions and nine
 * hundred rows somebody has to look at. `emlLimits` bounds reading one message
 * and says nothing about how many of them there are, so this is a separate set
 * of numbers about a separate cost.
 *
 * Same style as the parser's and expansion's, on purpose: fail closed,
 * environment overridable, and exceeding one is a refusal with a reason rather
 * than a partial expansion presented as a complete one. A reviewer shown two
 * hundred of a mailbox's nine hundred messages and told nothing is in exactly
 * the position these limits exist to prevent.
 *
 * By deployment profile, like batch concurrency and the daily quotas, because
 * the question they answer differs by install. A shared demo is one endpoint
 * everybody's mailbox lands on; a self-hosted Anonify is one person's machine
 * exporting their own archive, and a limit there is indistinguishable from the
 * application being broken.
 */

export type MboxLimits = {
  /**
   * How many messages one mailbox may expand into.
   *
   * Deliberately its own number rather than `maxBatchFiles()`, which is what
   * the EML expansion's `maxChildren` uses. Those two answer different
   * questions: `maxBatchFiles` is how many files a person may drag into the
   * upload panel at once, and a mailbox is one file. Tying them would make the
   * large-dataset case — the entire reason this format exists — refuse a nine
   * hundred message archive on a cap that was chosen for a drag-and-drop.
   *
   * What is reconciled instead is the direction that could surprise somebody:
   * `mboxLimits()` floors this at `maxBatchFiles()`, so a mailbox can never
   * silently produce a *smaller* batch than the same person could have
   * assembled by hand.
   */
  maxMessages: number
  /** Total bytes across every message expanded out of one mailbox. */
  maxTotalBytes: number
  /** The largest single message that will be expanded. */
  maxMessageBytes: number
  /**
   * How deep expansion may recurse through mailboxes.
   *
   * A forwarded archive — a mailbox attached to a message inside a mailbox —
   * is a second recursion axis, orthogonal to both the MIME parser's
   * `maxNestedMessages` and the attachment expansion's `maxDepth`. Left
   * unbounded it turns one upload into an unbounded amount of work, and unlike
   * the others it multiplies rather than adds.
   */
  maxDepth: number
}

/**
 * A shared anonymous demo.
 *
 * Two hundred messages is enough to be the thing MBOX is for — a real archive,
 * carried decisions doing real work across it — while staying a demo somebody
 * watches rather than leaves running. The byte ceilings are half the
 * self-hosted ones because the host absorbs everyone's mailbox, not just one.
 */
const DEMO_DEFAULTS: MboxLimits = {
  maxMessages: 200,
  maxTotalBytes: 32 * 1024 * 1024,
  maxMessageBytes: 12 * 1024 * 1024,
  maxDepth: 2,
}

/**
 * Your own machine. A thousand messages is an ordinary Thunderbird folder, and
 * refusing one would be refusing the use case.
 *
 * The byte ceilings sit above what the 50 MiB upload limit can actually
 * deliver, and are stated rather than inferred from it: raising what a person
 * may upload is not the same decision as raising how much work one file may
 * turn into.
 */
const SELF_HOSTED_DEFAULTS: MboxLimits = {
  maxMessages: 1_000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxMessageBytes: 25 * 1024 * 1024,
  // Counted on the same axis attachment expansion uses, so one number bounds
  // the whole chain however it was reached. A mailbox somebody uploaded sits
  // at depth zero and expands; a mailbox reached through a message inside
  // another mailbox sits at two and is refused — present in the batch, named,
  // and explicitly not expanded. Past that the nesting is the point rather
  // than the content.
  maxDepth: 2,
}

export function mboxDefaultsFor(profile: Profile): MboxLimits {
  return { ...(profile === "demo" ? DEMO_DEFAULTS : SELF_HOSTED_DEFAULTS) }
}

/** `ANONIFY_MBOX_MAX_MESSAGES`, `ANONIFY_MBOX_MAX_TOTAL_BYTES`, … */
export function mboxEnvName(limit: keyof MboxLimits): string {
  return `ANONIFY_MBOX_${limit
    .replace(/^max/, "MAX_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()}`
}

/**
 * The limits in force.
 *
 * A malformed override is reported rather than ignored, for the same reason
 * the parser's and the rate limiter's are: a limit somebody believes they set
 * and which is not in force is worse than no setting at all.
 */
export function mboxLimits(profile: Profile = activeProfile()): MboxLimits {
  const limits = mboxDefaultsFor(profile)

  for (const key of Object.keys(limits) as (keyof MboxLimits)[]) {
    const raw = process.env[mboxEnvName(key)]?.trim()
    if (!raw) continue

    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      throw new Error(
        `${mboxEnvName(key)} must be a positive whole number, got "${raw}"`
      )
    }
    limits[key] = Number(raw)
  }

  // The floor, applied after the override so it holds however the number was
  // arrived at. A deployment that raised `ANONIFY_BATCH_MAX_FILES` to 200 and
  // left this alone must not find that dragging in 200 files works and a
  // 200-message mailbox does not — the two would then disagree about what a
  // batch is, which is the reconciliation this exists for.
  limits.maxMessages = Math.max(limits.maxMessages, maxBatchFiles())

  return limits
}

/**
 * A mailbox limit was exceeded.
 *
 * Separate from `EmlLimitError` and `ExpansionLimitError` because it means a
 * third thing: every message in here may be perfectly well formed and readable
 * on its own, and there are simply more of them, or more bytes behind them,
 * than this instance will turn into documents.
 *
 * The wording matches the other two on purpose — `describeFailure` reads all
 * three as `too-complex`, because to the person holding the file they are one
 * refusal with one remedy.
 */
export class MboxLimitError extends Error {
  constructor(
    readonly limit: keyof MboxLimits,
    readonly allowed: number
  ) {
    super(`Mailbox exceeds the ${limit} limit of ${allowed}`)
    this.name = "MboxLimitError"
  }
}
