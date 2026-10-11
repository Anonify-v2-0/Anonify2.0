# Operations: metrics, autoscaling and alerts

Anonify's logs are structured JSON, one line per event, but you cannot
autoscale on logs. This page covers the Prometheus metrics, the query to scale
workers on, traces, and three alerts worth having (#188).

## Metrics

Off by default. Turn them on with:

| Setting | Default | |
| --- | --- | --- |
| `ANONIFY_METRICS` | `off` | `on` serves `GET /api/metrics` in the Prometheus text format |
| `ANONIFY_METRICS_TOKEN` | unset | When set (16+ characters), a scrape needs `Authorization: Bearer <token>` |

Without a token, the endpoint answers only a **direct** peer on loopback or a
private network (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, `fc00::/7`)
and refuses anything that came through a proxy, meaning any request carrying
`X-Forwarded-For`, `Forwarded` or `X-Real-IP`. Behind an ingress, every
visitor arrives from the proxy's private address, so the forwarding header is
what gives them away. The process logs which of the two it is doing at start.
If your scraper itself goes through a proxy, set a token.

A worker (`ANONIFY_ROLE=worker`) serves `/api/metrics` alongside its probes,
and nothing else.

### What is measured

Every name starts with `anonify_`. Labels come only from fixed vocabularies:
a step function's name, a document status, a queue kind, an outcome. No
document id, owner, filename or category appears in any metric, and a test
checks the rendered output for them.

| Metric | Type | Labels | What |
| --- | --- | --- | --- |
| `queue_jobs_ready` | gauge | `queue` (`workflow`, `step`) | Jobs that could run now: unlocked, attempts left, due |
| `queue_jobs_locked` | gauge | `queue` | Jobs a worker has claimed |
| `queue_oldest_ready_seconds` | gauge | `queue` | How long the oldest ready job has waited |
| `documents_by_status` | gauge | `status` | Documents in each status |
| `steps_in_flight` | gauge | `step` | Steps this process is running |
| `step_duration_seconds` | histogram | `step`, `outcome` (`completed`, `retry`, `error`) | Each step attempt |
| `step_retries_total` | counter | `step` | Attempts after the first |
| `cpu_slots_in_use`, `cpu_slots_waiting` | gauge | | The CPU semaphore ([capacity.md](./deploy/capacity.md)) |
| `service_requests_total` | counter | `service` (`ai`, `ocr`), `outcome` | Provider calls, by how each attempt ended |
| `service_throttle_wait_seconds` | histogram | `service` | Time spent waiting for a turn under the AI/OCR limits |
| `db_pool_total`, `db_pool_idle`, `db_pool_waiting` | gauge | `pool` (`app`) | The app's Postgres pool (not reported with the Neon driver) |
| `scheduler_last_success_timestamp_seconds` | gauge | | When this process last finished a sweep tick |
| `build_info` | gauge, always 1 | `version`, `build_id`, `role` | What is running |
| `process_*`, `nodejs_*` | | | The client library's defaults |

The queue and status gauges come from SQL, run at most once every 15 seconds
per process however often you scrape. The step metrics are recorded by the
process that ran the step, so sum them across replicas.

The workflow world's own pool has no counters it exposes, so it is not
reported; `db_pool_*` is the app's pool only.

### Scraping

```yaml
# prometheus.yml
scrape_configs:
  - job_name: anonify
    metrics_path: /api/metrics
    scrape_interval: 30s
    authorization:
      credentials: <ANONIFY_METRICS_TOKEN>   # omit when scraping directly on a private network
    static_configs:
      - targets: ["anonify-worker:3000", "anonify-web:3000"]
```

On Kubernetes, scrape the pods, not the Service, so each replica's own
counters are read.

## Autoscaling workers

Web replicas scale well on CPU and request concurrency, which every platform
measures already. **Workers should scale on the backlog:** how many jobs are
ready and how long the oldest has waited.

With Prometheus in the loop, use `anonify_queue_jobs_ready` (for example,
target 5 ready step jobs per worker) or `anonify_queue_oldest_ready_seconds`
(scale out above 60 seconds).

A platform that scales to zero cannot ask a process that is not running. Use
the same query the metric does, straight against Postgres. It reads
graphile-worker's `jobs` view, and only columns that view has kept across
versions; a test in Anonify runs it against the migrated schema, so a change
there fails in CI before it reaches you.

```sql
SELECT task_identifier,
  count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts AND run_at <= now())::int AS ready,
  count(*) FILTER (WHERE locked_at IS NOT NULL)::int AS locked,
  COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts AND run_at <= now())), 0)::float8 AS oldest_ready_seconds
FROM "graphile_worker".jobs
GROUP BY task_identifier
```

`task_identifier` is `workflow_steps` for steps and `workflow_flows` for
workflow invocations (the prefix is `WORKFLOW_POSTGRES_JOB_PREFIX`). Scale on
the steps.

KEDA's `postgresql` scaler wants a single number:

```yaml
triggers:
  - type: postgresql
    metadata:
      targetQueryValue: "5"          # ready step jobs per worker
      activationTargetQueryValue: "1"
      query: >-
        SELECT count(*) FROM graphile_worker.jobs
        WHERE task_identifier = 'workflow_steps'
          AND locked_at IS NULL AND attempts < max_attempts AND run_at <= now()
    authenticationRef:
      name: anonify-postgres         # a TriggerAuthentication with the connection string
```

Azure Container Apps takes the same query in a KEDA `postgresql` custom scale
rule. Give the scaler a direct or session connection, like the job queue
itself ([deploy/database.md](./deploy/database.md)).

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and
traces are exported over OTLP/HTTP: Next.js's spans for each request and
route, and the workflow runtime's span for each step and attempt.

| Setting | |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector, e.g. `http://otel-collector:4318`; `/v1/traces` is added |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, for a hosted backend's API key |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`. gRPC is not supported |
| `OTEL_SERVICE_NAME` | Default `anonify` |

Every span is scrubbed before it leaves: error messages, exception messages,
stack traces and status messages are dropped, and URLs lose their query
strings. A step's error message can contain the text a parser choked on, and
a signed URL carries its token in the query.

The metrics are not exported over OTLP. Point the OpenTelemetry Collector's
`prometheus` receiver at `/api/metrics` to send them on with the traces.

## Alerts

Three to start with:

```yaml
groups:
  - name: anonify
    rules:
      # Work is waiting and nothing is taking it: workers down, or too few.
      - alert: AnonifyQueueBacklog
        expr: max(anonify_queue_oldest_ready_seconds{queue="step"}) > 300
        for: 5m

      # Nobody has swept for three intervals (300s by default): expired
      # documents are not being deleted.
      - alert: AnonifySweepStalled
        expr: time() - max(anonify_scheduler_last_success_timestamp_seconds) > 900
        for: 5m

      # More than 5% of step attempts are failing outright.
      - alert: AnonifyStepFailures
        expr: >
          sum(rate(anonify_step_duration_seconds_count{outcome="error"}[15m]))
          / sum(rate(anonify_step_duration_seconds_count[15m])) > 0.05
        for: 15m
```

`AnonifySweepStalled` needs at least one process running the scheduler. Where
the sweep is driven from outside (`ANONIFY_SCHEDULER=off`), alert on that
job's own failures instead.
