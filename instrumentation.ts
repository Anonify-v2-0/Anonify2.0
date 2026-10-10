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
/** Where a web process's idle job runner is told to deliver; see below. */
const WEB_ROLE_EXECUTOR = "http://127.0.0.1:1"

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

  // What this process may take on at once (#181): its CPU slots and its job
  // concurrency, from its CPUs and its role unless set.
  const { capacitySummary } = await import("@/lib/runtime/capacity")
  const capacity = capacitySummary()

  // The same for the streaming budget: a chunk size nobody can use, or a
  // budget too small for the jobs this process runs at once, is a line of
  // configuration — and it should be reported next to it.
  const { maxInFlightChunks } = await import("@/lib/storage/streaming")
  maxInFlightChunks()

  // The global processing cap, when one is set (#181).
  const { processingGlobalMax } = await import("@/lib/documents/admission")
  processingGlobalMax()

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

  // The connection budget: the app's pool, and the world's own settings,
  // which the world itself would ignore if malformed (#169).
  const { assertWorkflowPoolSettings, databasePoolConfig, looksLikePooler } =
    await import("@/lib/database/pool-config")
  databasePoolConfig()
  assertWorkflowPoolSettings()

  // The expiry sweep's time budget and concurrency (#170).
  const { cleanupSettings } = await import("@/lib/workflows/cleanup")
  cleanupSettings()

  // Which version this replica is, for whoever is watching a rollout (#178).
  const { buildId } = await import("@/lib/config/build")
  console.log(
    JSON.stringify({
      level: "info",
      context: "server",
      build: buildId(),
      ...capacity,
      message: "server starting",
    })
  )

  // What this process is for (#179). A misspelt role stops it here, and a
  // split deployment on one machine's disk is refused before it accepts a
  // document its workers could never read.
  const { anonifyRole, assertRoleStorage, runsWorker } =
    await import("@/lib/config/role")
  const { applyJobConcurrency, workflowPoolDefault } =
    await import("@/lib/runtime/capacity")
  const role = anonifyRole()
  if (role !== "all") {
    const { storageDriverName } = await import("@/lib/storage/blob")
    assertRoleStorage(storageDriverName())
  }
  // A worker answers its runner and its probes, and 404s everything else.
  if (role === "worker") {
    const { installWorkerGate } = await import("@/lib/config/worker-gate")
    installWorkerGate()
  }

  // Unset on Vercel, where the platform's own world is selected for us. Calling
  // start() there is harmless, but skipping makes the intent explicit.
  if (!process.env.WORKFLOW_TARGET_WORLD) return

  // The world reads its job concurrency once, when it is created, and
  // defaults to 10 whatever the machine: put the derived value in force
  // before anything calls getWorld() (#181).
  applyJobConcurrency()

  // The world's pool, sized for the role unless it was set (#179).
  const poolDefault = workflowPoolDefault()
  if (poolDefault !== undefined) {
    process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE ||= String(poolDefault)
  }

  // The Postgres world reads its own connection string and, when that is unset,
  // silently falls back to postgres://world:world@localhost:5432/world — which
  // on a self-hosted install means a worker that connects to nothing. One
  // database is the normal case, so default it from the one already configured.
  //
  // Through a transaction pooler that default cannot work: the job queue
  // needs LISTEN/NOTIFY and session locks. Say so, rather than leave a worker
  // that never hears about a job (#169).
  if (
    !process.env.WORKFLOW_POSTGRES_URL &&
    looksLikePooler(process.env.DATABASE_URL)
  ) {
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "database.pool",
        message:
          "DATABASE_URL looks like a transaction pooler, and WORKFLOW_POSTGRES_URL is unset, so the job queue will use it too. The queue needs a direct or session-mode connection: set WORKFLOW_POSTGRES_URL. See docs/deploy/database.md.",
      })
    )
  }
  process.env.WORKFLOW_POSTGRES_URL ||= process.env.DATABASE_URL

  // The world is chosen by WORKFLOW_TARGET_WORLD and loaded with a dynamic
  // `require(targetWorld)`, which no bundler can follow. Naming it here is what
  // puts the package — and its Postgres driver — into the standalone build's
  // traced dependencies; without it the container starts and then cannot load
  // its own world.
  //
  // Kept in every role: it is there for the bundler, and a web process still
  // needs the world to start runs, which only inserts a job.
  await import("@workflow/world-postgres")

  // A web process starts runs and reads their streams, and never executes a
  // step: no runner, and no relay for one (#179).
  //
  // Not starting the world is not enough. @workflow/world-postgres 4.x has no
  // setting for "enqueue only": its queue() starts the job runner itself, the
  // first time a run is started. What it does have is patience: it starts the
  // runner only once the address it delivers steps to accepts a connection,
  // and checks again every 50 ms until then. So the web process gives it a
  // loopback port nothing in this container can listen on (a port below 1024,
  // and the image runs as a user that cannot bind one), and the runner waits
  // for good. CI's split-roles job proves it: with the workers stopped, a
  // document uploaded through the web container is not processed at all.
  if (!runsWorker()) {
    process.env.WORKFLOW_LOCAL_BASE_URL = WEB_ROLE_EXECUTOR
    console.log(
      JSON.stringify({
        level: "info",
        context: "workflow.world",
        world: process.env.WORKFLOW_TARGET_WORLD,
        role,
        worker: false,
        message:
          "workflow worker not started: this process serves traffic only",
      })
    )
    return
  }

  // The runner delivers each step over HTTP to this server. It does so
  // through a loopback relay that adds this process's token, and proxy.ts
  // refuses a workflow route without it: the Postgres world's deliveries
  // carry nothing else to check (#179, lib/security/workflow-guard.ts).
  const { startWorkflowRelay } = await import("@/lib/security/workflow-relay")
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    console.warn(
      JSON.stringify({
        level: "warn",
        context: "workflow.relay",
        message:
          "WORKFLOW_LOCAL_BASE_URL is set and is being replaced: the workflow runner has to deliver through this process's relay.",
      })
    )
  }
  process.env.WORKFLOW_LOCAL_BASE_URL = await startWorkflowRelay(
    Number(process.env.PORT) || 3000
  )

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
      role,
      worker: true,
      message: "workflow worker started",
    })
  )
}
