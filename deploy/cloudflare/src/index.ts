/**
 * Anonify on Cloudflare Containers (#193): a spike, not a supported
 * deployment. See docs/deploy/cloudflare.md for what has and has not been
 * tested.
 *
 * A Worker in front routes every request to the web containers. The worker
 * containers serve nobody: a Cron Trigger starts them and keeps them started,
 * and they never go to sleep, because they have to poll the job queue with
 * no request to wake them.
 */

import { Container, getContainer, getRandom } from "@cloudflare/containers"

type Env = {
  WEB: DurableObjectNamespace<AnonifyWeb>
  WORKER: DurableObjectNamespace<AnonifyWorker>
  // Secrets (`wrangler secret put`): the image reads them as environment.
  ENCRYPTION_KEY: string
  FINGERPRINT_SECRET: string
  CRON_SECRET: string
  DATABASE_URL: string
  WORKFLOW_POSTGRES_URL?: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  // Vars (wrangler.jsonc).
  S3_ENDPOINT: string
  S3_BUCKET: string
  ANONIFY_PUBLIC_URL: string
  WEB_INSTANCES: string
  WORKER_INSTANCES: string
}

/** What every container is started with, from the Worker's own env. */
function environment(env: Env, role: "web" | "worker"): Record<string, string> {
  return {
    ANONIFY_ROLE: role,
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: env.DATABASE_URL,
    ...(env.WORKFLOW_POSTGRES_URL
      ? { WORKFLOW_POSTGRES_URL: env.WORKFLOW_POSTGRES_URL }
      : {}),
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    FINGERPRINT_SECRET: env.FINGERPRINT_SECRET,
    CRON_SECRET: env.CRON_SECRET,
    STORAGE_DRIVER: "s3",
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: "auto",
    S3_BUCKET: env.S3_BUCKET,
    S3_FORCE_PATH_STYLE: "true",
    S3_PRESIGNED_UPLOADS: "true",
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
    ANONIFY_PUBLIC_URL: env.ANONIFY_PUBLIC_URL,
    // Cloudflare waits up to 15 minutes after SIGTERM; the default drain fits.
    ANONIFY_DRAIN_SECONDS: "120",
  }
}

export class AnonifyWeb extends Container<Env> {
  defaultPort = 3000
  // A web container with nobody using it can sleep; a request wakes it.
  sleepAfter = "15m"

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env)
    this.envVars = environment(env, "web")
  }
}

export class AnonifyWorker extends Container<Env> {
  defaultPort = 3000

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env)
    this.envVars = environment(env, "worker")
  }

  // Never asleep: the queue has to be polled whether or not anyone asked.
  // Not calling stop() here is what keeps it running.
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout()
  }
}

export default {
  /** Every request, to one of the web containers. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const web = await getRandom(env.WEB, Number(env.WEB_INSTANCES || 2))
    return web.fetch(request)
  },

  /**
   * Starts the workers, and starts them again after a rollout or an
   * eviction. Asking each for /api/health is enough: a request to a stopped
   * container starts it.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const count = Number(env.WORKER_INSTANCES || 1)
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        getContainer(env.WORKER, `worker-${index}`).fetch(
          new Request("http://worker/api/health")
        )
      )
    )
  },
}
