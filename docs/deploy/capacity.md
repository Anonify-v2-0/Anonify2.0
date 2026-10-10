# Capacity: what one replica takes on

Scaling out works only if one replica has a known ceiling. N replicas then
give N times the capacity, and no replica takes on more than its CPU and
memory can hold (#181). Three settings set that ceiling. All three default
from the CPUs the process can use, so most deployments set none of them.

| Setting | Default | What it bounds |
| --- | --- | --- |
| `ANONIFY_CPU_CONCURRENCY` (1–64) | the CPUs available, quota included | CPU-heavy work running at once: page rendering, OCR, image redaction, export |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (1–100) | `worker`: 2 × CPUs. `all`: CPUs + 2. At most 64 when derived | workflow steps one replica runs at once |
| `ANONIFY_STREAM_MEMORY_BUDGET` | chunk size × 16 × the job concurrency (× 8 for a demo) | the streaming footprint of every step in the replica |

A malformed value stops the server at start. So does a memory budget too small
to give every job two chunks. The start-up log line `"server starting"` shows
the CPU and job concurrency in force.

## CPU slots

Rendering a PDF page, encoding its raster, reading it with Tesseract,
compositing an image redaction and rebuilding an exported document all take a
**CPU slot** first. There are `ANONIFY_CPU_CONCURRENCY` slots per process,
handed out first come, first served. A slot is never held across a model call
or a storage read, so a step waiting on a provider holds none.

Without the slots, ten jobs on two CPUs all rendered at once. Every page took
five times as long, every raster was alive at the same moment, and every
deadline slipped together. With them, the same work finishes in arrival order,
and only as many rasters are alive as there are slots.

### How the CPUs are counted

The CPUs counted are the ones the container is allowed, not the host's. Node
22's `os.availableParallelism()` honours a CPU quota already, and Anonify reads
the cgroup quota itself as well (`/sys/fs/cgroup/cpu.max`, or
`cpu.cfs_quota_us` on cgroup v1) for runtimes that do not, taking the smaller
answer. A fractional quota rounds down, never below one: `docker run
--cpus=1.5` is 1 slot (measured in the image), `--cpus=2.5` is 2, and a
Kubernetes limit of `500m` is 1.

A CPU *request* without a limit sets no quota. On such a pod, set
`ANONIFY_CPU_CONCURRENCY` to the request.

## Job concurrency

The job concurrency is how many workflow steps the replica's job runner takes
at once. The workflow world reads it once, when it starts, and used to default
to 10 whatever the machine. Anonify now sets it before the world starts:

- **`worker`:** twice the CPUs. A step is as often waiting on a model provider
  as it is rendering, and the CPU slots keep the rendering in check.
- **`all`:** the CPUs plus two, leaving room for the requests this process
  also serves.
- **`web`:** runs no steps.

Each running step holds a connection from the world's pool, so the pool
defaults to the job concurrency plus two for a worker. It does the same for
`all` when that is more than the world's own default of 10. See
[database.md](./database.md).

## The memory budget is per process

The streaming budget is divided among the steps the process runs at once:

```
chunkBytes × maxInFlightChunks × jobConcurrency <= ANONIFY_STREAM_MEMORY_BUDGET
```

It used to be divided by `ANONIFY_BATCH_PROCESSING`, which is a limit per
*owner*. That held only while one owner was active: ten owners' documents
shared a budget sized for one owner's six.

**Upgrading:** an `ANONIFY_STREAM_MEMORY_BUDGET` you set yourself keeps
working, but is now checked against the job concurrency. On a machine with
many CPUs it can be refused at start, with a message naming the three settings.
Raise the budget, or set `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` lower.

## A global cap, for shared deployments

`ANONIFY_BATCH_PROCESSING` bounds each owner's documents. Ten owners can
therefore have ten times that many in flight. `ANONIFY_PROCESSING_GLOBAL_MAX`
(unset by default) bounds documents in flight across every owner. With it set,
a slot that frees goes to whichever owner has waited longest, one document per
owner per turn. A batch of fifty cannot take every slot before somebody
else's single document is looked at.

Like the per-owner limit, two admissions racing can start one document more
than the cap. It bounds sustained concurrency; it is not a mutex.

## Sizing

Starting points per replica, until the load test (#190) replaces them with
measured numbers. Memory is the container limit; the budget is the streaming
share of it, and the rest is pdf.js, rasters, Tesseract's models and Node.

| Instance | `ANONIFY_CPU_CONCURRENCY` | `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (worker) | Memory limit | `ANONIFY_STREAM_MEMORY_BUDGET` |
| --- | ---: | ---: | ---: | ---: |
| 1 vCPU | 1 (default) | 2 (default) | 1.5 GiB | 32MB (default) |
| 2 vCPU | 2 (default) | 4 (default) | 2–3 GiB | 64MB (default) |
| 4 vCPU | 4 (default) | 8 (default) | 4–6 GiB | 128MB (default) |
| 8 vCPU | 8 (default) | 16 (default) | 8–12 GiB | 256MB (default) |

Rules of thumb:

- **Scanned documents dominate.** Allow about 300 MiB per CPU slot for a
  replica that reads scans with Tesseract: each slot can have a warm OCR
  worker with its own copy of the model (#189), stopped after
  `ANONIFY_OCR_IDLE_SECONDS` idle. A replica that mostly sees born-digital
  documents needs far less.
- **Scale workers out before up.** Two 2-vCPU workers survive one being
  replaced, and one 4-vCPU worker does not.
- **Lower the job concurrency, not the CPU slots,** if memory is tight. The
  slots bound CPU-heavy work, and the jobs bound everything else held per
  step.
