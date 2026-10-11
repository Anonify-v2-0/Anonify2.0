# Docker Compose, scaled

One machine, or a few, with web and workers as separate containers that
scale on their own. The same `docker-compose.yml` as a single-box install,
with an overlay.

**Verified on:** 2026-10-11, the image built from this repository after
1.17.0, Docker 27 on a 16-CPU host: `pnpm smoke` passed through every
format, and `pnpm load scale-in` (one worker stopped, another killed
mid-run) finished every document.

## Architecture

```
            ┌──────────── TLS proxy (Caddy) :443 ─────────────┐
 browser ──►│                                                  │
            └──────────────┬───────────────────────────────────┘
                           ▼
                  app (ANONIFY_ROLE=web) :3000
                           │  starts runs, serves streams
                           ▼
          postgres ◄── worker × N (ANONIFY_ROLE=worker, no ports)
                           │
                        rustfs (S3)
```

`migrate` runs before `app` and the workers start, every `up`. The workers
sweep expired documents themselves (#183).

## Prerequisites

Docker with Compose v2.20 or later (for `extends` and `!reset`). For the
recipe as written, nothing else: Postgres and RustFS run in the stack.

## From one container to several

A default install is `ANONIFY_ROLE=all`: one container serves people and
runs the pipeline. Split it with the overlay that ships in the repository and
with each release:

```sh
docker compose -f docker-compose.yml -f docker-compose.split.yml up -d --scale worker=2
```

`app` becomes the web role; `worker` containers run the queue, publish no
port, and answer 404 to anything but their probes and metrics. Nothing
migrates: both roles read the same database and bucket.

## Database

The bundled Postgres 17 allows 100 connections and each replica opens up to
21 ([database.md](./database.md)). Past four replicas, raise it:

```yaml
# docker-compose.override.yml
services:
  postgres:
    command: ["postgres", "-c", "max_connections=300"]
```

or lower `DATABASE_POOL_MAX` and `WORKFLOW_POSTGRES_MAX_POOL_SIZE`. For an
external database, set `DATABASE_URL` (and `WORKFLOW_POSTGRES_URL` if
`DATABASE_URL` is a pooler) in `.env` and drop the `postgres` service.

## Storage

RustFS in the stack, or any S3-compatible service through `S3_ENDPOINT`,
`S3_BUCKET` and the keys in `.env` ([storage.md](../storage.md)). A split
deployment refuses `STORAGE_DRIVER=local`: the workers would not see what
`app` wrote.

## Secrets

`.env`, made once:

```sh
[ -e .env ] || docker run --rm nabeelwasif/anonify2.0 keys > .env
```

Keep a copy of `ENCRYPTION_KEY` somewhere other than this machine. Without it
nothing stored can be read.

## Web

`app`, on `127.0.0.1:${APP_PORT:-3000}`. Put a TLS proxy in front, on the same
Compose network:

```yaml
# docker-compose.override.yml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

```
# Caddyfile
anonify.example.com {
	reverse_proxy app:3000 {
		# Progress streams: send each event as it is written.
		flush_interval -1
	}
}
```

Set `ANONIFY_PUBLIC_URL=https://anonify.example.com` in `.env`. Traefik works
the same way with its Docker labels; it streams responses without
configuration.

## Workers

`docker compose … up -d --scale worker=N`. Each worker sizes itself from the
CPUs it may use, so cap them to make a known unit
([capacity.md](./capacity.md)):

```yaml
# docker-compose.override.yml
services:
  worker:
    cpus: 2
    mem_limit: 4g
```

## Migrations

The `migrate` service runs `anonify migrate` and exits, and `app` and
`worker` wait for it. Every `up` after a pull migrates first.

## Sweep

Built in: each worker runs it every `ANONIFY_SCHEDULER_INTERVAL_SECONDS`
(300), under a lock. Nothing to set up. The `scheduler` service in older
files is deprecated (removed in 1.18.0).

## Autoscaling

Compose does not autoscale. Watch `anonify_queue_oldest_ready_seconds` with
`ANONIFY_METRICS=on` ([operations.md](../operations.md)) and add workers when
it stays above a minute. Scale to zero is not available here: keep at least
one worker.

## Timeouts and progress streams

The proxy must not buffer `text/event-stream` (Caddy's `flush_interval -1`
above), and must allow a response to stay open for minutes. Compose itself
has no timeouts to raise.

## Upgrades

```sh
docker compose -f docker-compose.yml -f docker-compose.split.yml pull
docker compose -f docker-compose.yml -f docker-compose.split.yml up -d --scale worker=2
```

Compose gives each container `stop_grace_period: 130s`, so a replaced worker
finishes its steps first (#182). Containers are recreated together rather
than rolled, so expect a short gap in serving during the recreate; for zero
downtime, use Kubernetes.

## Costs to watch

The machine. Scanned documents are the heavy part: about 300 MiB of memory
per CPU for OCR workers ([capacity.md](./capacity.md)).

## Load testing it

`docker-compose.load.yml` turns this topology into the one the load harness
measures ([benchmarks/README.md](../../benchmarks/README.md#load-testing)).
