/**
 * Runs the expiry sweep once, then exits.
 *
 *   pnpm cleanup
 *
 * On Vercel this work is driven by the cron entry in vercel.json hitting
 * /api/cron/cleanup. Nothing outside Vercel reads that file, so a self-hosted
 * install needs its own scheduler — and "temporary by default" stops being true
 * the moment nothing is deleting anything.
 *
 * This talks to the database directly rather than to the HTTP endpoint, so it
 * needs no secret and no running server. Point any scheduler at it:
 *
 *   crontab:        star/15 * * * *  cd /srv/anonify && pnpm cleanup
 *   systemd timer:  OnUnitActiveSec=15min
 *
 * A self-hosted worker already runs the sweep on its own timer (#183), so this
 * is for deployments whose workers are not long-lived. It shares the sweep's
 * lock with them and with /api/cron/cleanup. It runs the expiry only: it is
 * bundled without the workflow runtime, so restarting lost runs and admitting
 * queued documents is left to a worker's sweep or the route.
 *
 * Exits non-zero when a document could not be fully purged, so a scheduler that
 * reports failures actually reports this one.
 */

// Loaded first, so every module below sees the configured environment. A CLI
// gets no .env for free the way the Next server does, and without this the
// database simply appears to be unset.
import "dotenv/config"

import { sweep } from "@/lib/workflows/sweep"

async function main(): Promise<void> {
  const startedAt = Date.now()

  // No time budget: run from cron or a timer, it has no function limit to
  // stay inside, so it clears the whole backlog (#170).
  const result = await sweep({ budgetMs: Infinity })
  const { marked } = result
  if (result.skipped) {
    console.log(`\n  Expiry sweep skipped: ${result.skipped}.\n`)
    return
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log(
    [
      "",
      `  Expiry sweep finished in ${seconds}s`,
      "",
      `    marked expired      ${marked}`,
      `    documents deleted   ${result.documentsDeleted}`,
      `    objects deleted     ${result.objectsDeleted}`,
      `    global rules pruned ${result.ownerRulesPruned}`,
      `    rate limits pruned  ${result.rateLimitsPruned}`,
      result.failures > 0
        ? `    failures            ${result.failures}  (retried next run)`
        : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n"
  )

  // A document whose storage did not clear keeps its record on purpose, so the
  // next run retries it. Surfacing it here is what stops that being silent.
  if (result.failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  console.error(`\n  Expiry sweep failed: ${message}\n`)
  if (/DATABASE_URL|connect|ECONNREFUSED/i.test(message)) {
    console.error(
      "  Check DATABASE_URL, and that the database is running and migrated.\n"
    )
  }

  process.exitCode = 1
})
