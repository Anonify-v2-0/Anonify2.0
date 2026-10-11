# Deploying Anonify

The app is the same everywhere: one image, `nabeelwasif/anonify2.0`, whose
role and settings come from its environment. What differs per platform is a
short recipe: what to run, how it scales, and which of the platform's limits
matter (#192).

## The contract

What every recipe relies on, and what the image guarantees (#163):

| | |
| --- | --- |
| **One image, three roles** | `ANONIFY_ROLE=all` (the default: everything in one process), `web` (pages, the API, progress streams; starts runs, executes none) or `worker` (the job queue, the steps, the built-in sweep; give it no ingress). `anonify migrate` and `anonify cleanup` are commands of the same image ([image.md](./image.md)). |
| **Configured at runtime** | Everything comes from the environment when the process starts. One digest goes from staging to production. |
| **State outside the process** | Postgres holds the rows, the job queue, progress streams and rate limits ([database.md](./database.md)). Object storage holds the documents: S3 or S3-compatible, Azure Blob, or Vercel Blob ([storage.md](../storage.md)). The local disk is a cache: `/tmp` and the OCR model in `/data`. A split deployment refuses local storage. |
| **Health** | `GET /api/health`: liveness, touches nothing else. `GET /api/ready`: database, storage and, on a worker, the job runner; 503 from the first moment of a drain (#167). |
| **Signals** | On `SIGTERM`: not ready, stop claiming jobs, finish the ones held, close streams so clients reconnect elsewhere, exit 0, all within `ANONIFY_DRAIN_SECONDS` (120). Give the platform's grace period that plus ten seconds ([workflow.md](../workflow.md#8-shutdown-and-lost-workers)). |
| **Bounded per process** | CPU slots, job concurrency, pools and the streaming memory budget all derive from the CPUs the container may use, so N replicas are N times the capacity ([capacity.md](./capacity.md)). |
| **Scaling signals** | `/api/metrics` (#188): queue depth and age for workers, CPU for web ([operations.md](../operations.md)). |

## How each role scales

| Role | Scale on | To zero? |
| --- | --- | --- |
| `web` | CPU (about 60%) or request concurrency. Progress streams are long-lived and mostly idle; do not count them as load. | Where the platform starts a container on a request. A client whose stream is cut reconnects to any replica and resumes. |
| `worker` | Queue depth and the oldest job's age; CPU second. | **Only with KEDA or Azure Container Apps**, which watch the queue from outside. Everywhere else, **at least one worker**: with none, nothing notices the first document (#163). |
| `migrate` | Run once before each rollout: a Helm hook, an ECS task, a Cloud Run job, a Container Apps job, a `release_command`. | n/a |
| sweep | Inside every worker, under a lock (#183). Or the platform's cron calling `/api/cron/cleanup` with `CRON_SECRET`. | n/a |

## Which recipe

| You have | Use | Scale to zero | Verified |
| --- | --- | --- | --- |
| One machine, or a few | [Compose](./compose.md), scaled with separate workers | no | yes, 2026-10-11 |
| Kubernetes, anywhere | [The Helm chart](./kubernetes.md) | workers, with KEDA | yes, 2026-10-11, kind + KEDA; and in CI |
| AWS | [ECS on Fargate](./aws-ecs.md) | no | **draft** |
| Google Cloud | [Cloud Run](./gcp-cloud-run.md) | web only | **draft** |
| Azure | [Container Apps](./azure-container-apps.md) | web and workers | **draft** |
| Fly.io | [Fly Machines](./fly.md) | web only | **draft** |
| Render, Railway, DigitalOcean App Platform | [Generic PaaS](./generic-paas.md) | no | **draft** |
| Cloudflare | [Containers](./cloudflare.md) | see the page | **spike, not tested** |
| Vercel | [Vercel](./vercel.md), the platform's own model | yes | yes (Hobby) |

A **draft** page is written from the platform's documentation and the
contract above, and has not yet been followed end to end on a real account.
Each one says so at the top. Until it is, expect to adjust details; the
contract parts (roles, probes, drain, migrations, storage) are what the
image does everywhere and will hold.

Every page has the same sections: architecture, prerequisites, database,
storage, secrets, the two roles, migrations, the sweep, autoscaling,
timeouts and progress streams, upgrades, costs to watch, and when it was
last verified.
