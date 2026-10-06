/**
 * Server start-up hook.
 *
 * The Workflow SDK needs somewhere durable to keep runs, steps and streams. On
 * Vercel that backend is provided automatically and needs no setup. Anywhere
 * else — a container, a VM — it has to be told, and the Postgres world needs a
 * long-lived worker polling for jobs, which only exists if something starts it.
 *
 * Without this, a self-hosted deployment accepts uploads and never processes
 * them: the run is created and nothing ever picks it up.
 */
export async function register() {
  // The edge runtime has no long-lived process to poll from.
  if (process.env.NEXT_RUNTIME === "edge") return

  // Fail on the way up, not on the first document.
  //
  // ENCRYPTION_KEY is read lazily, deep in the pipeline, so a malformed one
  // used to present as a workflow step exhausting its retries — by which point
  // the upload had been accepted and the cause was several layers away from the
  // message. CI spent a run on exactly that, over a key YAML had quietly turned
  // into the integer zero.
  const { assertMasterKey } = await import("@/lib/storage/encryption")
  assertMasterKey()

  // The same for the streaming budget: a chunk size nobody can use, or a
  // budget too small for the documents allowed to process at once, is a line
  // of configuration — and it should be reported next to it.
  const { maxInFlightChunks } = await import("@/lib/storage/streaming")
  maxInFlightChunks()

  // And a misspelt ANONIFY_UPLOAD_ENCRYPTION, which would otherwise surface as
  // every upload failing at reservation.
  const { uploadEncryptionPolicy } =
    await import("@/lib/storage/upload-encryption")
  uploadEncryptionPolicy()

  // ANONIFY_PUBLIC_URL is read per request by the root layout. Read it once
  // here too, so a malformed value stops the server now rather than failing
  // every page view (#168).
  const { publicUrl } = await import("@/lib/config/public-url")
  publicUrl()

  // The readiness probe's per-check timeout, if one is set (#167).
  const { readyTimeoutMs } = await import("@/lib/health/ready")
  readyTimeoutMs()

  // Unset on Vercel, where the platform's own world is selected for us. Calling
  // start() there is harmless, but skipping makes the intent explicit.
  if (!process.env.WORKFLOW_TARGET_WORLD) return

  // The Postgres world reads its own connection string and, when that is unset,
  // silently falls back to postgres://world:world@localhost:5432/world — which
  // on a self-hosted install means a worker that connects to nothing. One
  // database is the normal case, so default it from the one already configured.
  process.env.WORKFLOW_POSTGRES_URL ||= process.env.DATABASE_URL

  // The world is chosen by WORKFLOW_TARGET_WORLD and loaded with a dynamic
  // `require(targetWorld)`, which no bundler can follow. Naming it here is what
  // puts the package — and its Postgres driver — into the standalone build's
  // traced dependencies; without it the container starts and then cannot load
  // its own world.
  await import("@workflow/world-postgres")

  const { getWorld } = await import("workflow/runtime")
  await getWorld().start?.()

  // /api/ready waits on this: until the worker runs, a replica that accepts
  // documents would never process them (#167).
  const { markWorldStarted } = await import("@/lib/health/state")
  markWorldStarted()

  console.log(
    JSON.stringify({
      level: "info",
      context: "workflow.world",
      world: process.env.WORKFLOW_TARGET_WORLD,
      message: "workflow worker started",
    })
  )
}
