# Fly.io

> **Draft.** Written from the Fly.io documentation and the
> [contract](./README.md#the-contract); not yet followed end to end on a Fly
> account. Verification is tracked in #247.

**Verified on:** not yet.

## Architecture

One app, two process groups from the same image: `web` behind Fly's proxy,
`worker` with no service. `release_command` migrates before each deploy.
Postgres from Fly or anywhere else; storage on Tigris (S3-compatible).

## Prerequisites

`flyctl`, a Fly organization, a Postgres database (Fly Managed Postgres or
external), and a Tigris bucket (`fly storage create`).

## Database

`DATABASE_URL` as a secret. Fly Managed Postgres offers a pooled and a
direct URL: the pooled one for `DATABASE_URL`, the direct one for
`WORKFLOW_POSTGRES_URL` ([database.md](./database.md)).

## Storage

`fly storage create` sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3` and `BUCKET_NAME`. Anonify reads its own names, so set
them from those values:

```sh
fly secrets set S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
```

and in `fly.toml`: `S3_ENDPOINT = "https://fly.storage.tigris.dev"`,
`S3_REGION = "auto"`, `S3_BUCKET`, `STORAGE_DRIVER = "s3"`.

## Secrets

`fly secrets set ENCRYPTION_KEY=… FINGERPRINT_SECRET=… CRON_SECRET=…
DATABASE_URL=…`, from `docker run --rm nabeelwasif/anonify2.0 keys`.

## fly.toml

```toml
app = "anonify"
primary_region = "ams"

[build]
  image = "nabeelwasif/anonify2.0:1.18.0"

[env]
  STORAGE_DRIVER = "s3"
  S3_ENDPOINT = "https://fly.storage.tigris.dev"
  S3_REGION = "auto"
  S3_BUCKET = "anonify"
  ANONIFY_PUBLIC_URL = "https://anonify.fly.dev"
  ANONIFY_DRAIN_SECONDS = "110"

# Fly has no per-process environment, so each process sets its role through
# `env`; the image runs a command that names a program as given.
[processes]
  web = "env ANONIFY_ROLE=web anonify serve"
  worker = "env ANONIFY_ROLE=worker anonify serve"

[deploy]
  release_command = "migrate"

[http_service]
  processes = ["web"]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
  [[http_service.checks]]
    path = "/api/ready"
    interval = "15s"
    timeout = "5s"
    grace_period = "60s"

kill_signal = "SIGTERM"
kill_timeout = 120

[[vm]]
  processes = ["web"]
  size = "shared-cpu-2x"
  memory = "2gb"

[[vm]]
  processes = ["worker"]
  size = "performance-2x"
  memory = "4gb"
```

## Deploy web and worker

`fly deploy`, then `fly scale count web=2 worker=1`. The worker group has no
service, so Fly's proxy never stops it for being idle.

## Migrations

`release_command = "migrate"` runs `anonify migrate` on a temporary machine
before the new version is rolled out; a failure stops the deploy.

## Sweep

Built into the workers.

## Autoscaling

- **web:** Fly's proxy starts and stops machines with traffic
  (`auto_stop_machines`), down to `min_machines_running`.
- **worker:** fixed count, **at least 1** (`fly scale count worker=N`). Fly
  does not scale on a queue.

## Timeouts and progress streams

Fly's proxy closes connections that stay idle too long. Progress streams
send a keep-alive comment after 15 quiet seconds (#244), so they are never
idle that long. `kill_timeout = 120` with `ANONIFY_DRAIN_SECONDS = 110` gives
the drain its time on deploys.

## Upgrades

`fly deploy` with a new image tag: release command first, then a rolling
replacement per process group.

## Costs to watch

The always-on worker machine, and Tigris storage and requests.
