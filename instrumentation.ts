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

  console.log(
    JSON.stringify({
      level: "info",
      context: "workflow.world",
      world: process.env.WORKFLOW_TARGET_WORLD,
      message: "workflow worker started",
    })
  )
}
