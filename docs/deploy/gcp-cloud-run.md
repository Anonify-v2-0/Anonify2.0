# Google Cloud: Cloud Run

> **Draft.** Written from the Google Cloud documentation and the
> [contract](./README.md#the-contract); not yet followed end to end on a
> Google Cloud project. Verification is tracked in the follow-up to #192.

**Verified on:** not yet.

## Architecture

```
 browser ─► Cloud Run service "anonify-web" (request-based billing, ANONIFY_ROLE=web)
                     │ starts runs
 Cloud SQL (Postgres) ◄── Cloud Run service "anonify-worker" (instance-based billing,
                     │                         min 1, internal ingress, ANONIFY_ROLE=worker)
              Cloud Storage (S3 interoperability, HMAC keys)
 Cloud Run job "anonify-migrate" (args: migrate), run before each deploy
```

## Prerequisites

A project with Cloud Run, Cloud SQL Admin and Secret Manager enabled, a
Cloud SQL for PostgreSQL 15+ instance, a Cloud Storage bucket, and a service
account for the services with `roles/cloudsql.client` and
`roles/secretmanager.secretAccessor`.

## Database

Attach the instance with `--add-cloudsql-instances PROJECT:REGION:INSTANCE`
and connect over its Unix socket:

```
DATABASE_URL=postgresql://anonify:PASSWORD@/anonify?host=/cloudsql/PROJECT:REGION:INSTANCE
```

The connector is a direct connection, so the job queue can use it too (no
`WORKFLOW_POSTGRES_URL` needed). Size `max_connections` for 21 per instance.

## Storage

Cloud Storage through its S3 interoperability API, with an HMAC key for the
service account:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_BUCKET=my-anonify
S3_ACCESS_KEY_ID=<HMAC access id>      # Secret Manager
S3_SECRET_ACCESS_KEY=<HMAC secret>     # Secret Manager
```

For presigned uploads (V4 signatures work against the XML API), set
`S3_PRESIGNED_UPLOADS=true` and the bucket's CORS:

```json
[{ "origin": ["https://anonify.example.com"], "method": ["PUT"],
   "responseHeader": ["Content-Type", "Content-Length"], "maxAgeSeconds": 3600 }]
```

`gcloud storage buckets update gs://my-anonify --cors-file=cors.json`.

## Secrets

Secret Manager, mounted as environment with `--set-secrets
ENCRYPTION_KEY=anonify-encryption-key:latest,…`. Pin a version rather than
`latest` for `ENCRYPTION_KEY`, so a new version cannot quietly replace it.

## Deploy web

```sh
gcloud run deploy anonify-web --image docker.io/nabeelwasif/anonify2.0:1.18.0 \
  --args serve --port 3000 --region europe-west1 \
  --set-env-vars ANONIFY_ROLE=web,ANONIFY_DRAIN_SECONDS=8,ANONIFY_DRAIN_READY_DELAY_MS=0 \
  --concurrency 40 --timeout 3600 --min-instances 0 --max-instances 10 \
  --cpu 1 --memory 2Gi --add-cloudsql-instances PROJECT:REGION:INSTANCE \
  --set-secrets ENCRYPTION_KEY=…,FINGERPRINT_SECRET=…,CRON_SECRET=…,DATABASE_URL=…
```

Startup probe `/api/health`, liveness `/api/health`; Cloud Run has no
readiness probe, so `/api/ready` is for your uptime check.

## Deploy worker

A second service, always allocated, never scaled to zero, and reachable from
nothing:

```sh
gcloud run deploy anonify-worker --image docker.io/nabeelwasif/anonify2.0:1.18.0 \
  --args serve --port 3000 --no-cpu-throttling --min-instances 1 --max-instances 5 \
  --ingress internal --no-allow-unauthenticated \
  --set-env-vars ANONIFY_ROLE=worker,ANONIFY_DRAIN_SECONDS=8,ANONIFY_DRAIN_READY_DELAY_MS=0 \
  --cpu 2 --memory 4Gi …
```

`--no-cpu-throttling` (instance-based billing) is what lets it poll the
queue with no request in flight; with request-based billing the CPU is
throttled between requests and the worker would stall. Where available,
Cloud Run worker pools fit this role better: no port, no ingress.

## Migrations

A Cloud Run job from the same image, executed before each deploy:

```sh
gcloud run jobs deploy anonify-migrate --image … --args migrate \
  --add-cloudsql-instances … --set-secrets DATABASE_URL=…
gcloud run jobs execute anonify-migrate --wait
```

## Sweep

Built into the worker. Or Cloud Scheduler calling `/api/cron/cleanup` on the
web service with `Authorization: Bearer $CRON_SECRET`.

## Autoscaling

- **web:** Cloud Run's own, on concurrency and CPU. Scale to zero is fine:
  a progress stream that is cut reconnects to whichever instance answers.
- **worker:** `min-instances 1`. Cloud Run scales an always-allocated service
  on CPU between min and max; it cannot see the queue, so queue-based scaling
  would need a custom controller. Size `max-instances` for the backlog you
  expect.

## Timeouts and progress streams

- **Request timeout:** set `--timeout 3600` (the maximum) on web, so streams
  are not cut at the default 300s.
- **Scale-in grace:** Cloud Run gives a container 10 seconds after
  `SIGTERM`, far less than a long step. Set `ANONIFY_DRAIN_SECONDS=8` and
  `ANONIFY_DRAIN_READY_DELAY_MS=0`. A step cut short is run again: every step
  is idempotent, and a lost run is restarted by the sweep after
  `ANONIFY_STUCK_RUN_MINUTES` (#182).

## Upgrades

Execute the migrate job, then `gcloud run deploy` both services. Cloud Run
shifts traffic to the new revision once it starts.

## Costs to watch

The always-allocated worker bills for every second it runs, busy or not.
Cloud SQL instance hours, and Cloud Storage operations (each ranged read is
one).
