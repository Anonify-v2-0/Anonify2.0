# Postgres: connections, poolers and the budget

Postgres is the one stateful service every replica shares, so its connection
limit is the first ceiling a scaled-out Anonify meets (#169). This page says
what each replica opens, how to size it, and how to put a connection pooler in
front of the app without breaking the job queue.

## What one replica opens

| Pool | Used for | Size | Setting |
| --- | --- | --- | --- |
| App (Prisma) | every API request's queries | driver default 10 | `DATABASE_POOL_MAX` (1–100) |
| Workflow world | runs, steps, events, the job queue | world default 10 | `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (1–100) |
| Stream `LISTEN` client | live progress to the browser | 1, dedicated | none |

The worker's job concurrency, `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (derived
from the CPUs when unset, see [capacity.md](./capacity.md)), draws on the
world's pool: each running job holds one of its
connections. Keep the concurrency below the world pool's size, so the queue's
own `LISTEN` and the run bookkeeping always have a connection left.

`DATABASE_POOL_IDLE_TIMEOUT_MS` (default 10000) is how long an idle app
connection is kept, so a quiet replica gives its connections back.

A malformed value in any of these stops the server at start. A limit that
looks set and is not in force is worse than no limit.

### Per role

With `ANONIFY_ROLE` set (see [architecture.md §10](../architecture.md#10-process-roles)),
the world's pool defaults to what the role uses, unless
`WORKFLOW_POSTGRES_MAX_POOL_SIZE` is set:

| Role | World pool default | Why |
| --- | --- | --- |
| `all` | 10 (the world's own), or the job concurrency + 2 when more | As before, unless its jobs need more. |
| `web` | 4 | It only inserts jobs and reads run streams. |
| `worker` | the job concurrency + 2 (6 on two CPUs) | One per running job, and two for the queue's bookkeeping. |

So splitting does not have to cost connections: a web replica opens at most
`DATABASE_POOL_MAX` + 4 + 1.

## The budget

Per replica, at most:

```
DATABASE_POOL_MAX + WORKFLOW_POSTGRES_MAX_POOL_SIZE + 1
```

Across the deployment, multiply by the replicas, then leave room for
migrations (`pnpm db:migrate:deploy`, one connection), an admin session or
two, and whatever else shares the server. Postgres's default
`max_connections` is 100, and small managed tiers allow fewer.

| Replicas | App pool | World pool | Per replica | Total | Fits in 100? |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 10 | 10 | 21 | 21 | yes |
| 4 | 10 | 10 | 21 | 84 | barely: no headroom for migrations |
| 4 | 6 | 8 | 15 | 60 | yes |
| 20 | 10 | 10 | 21 | 420 | no: needs a pooler and a smaller world pool |
| 20 | 10, through a pooler | 4 | 5 direct | 100 direct, plus the pooler's own | only with the pooler, and `max_connections` above 100 |

With a transaction pooler in front of `DATABASE_URL`, the app pool's
connections go to the pooler, which multiplexes them onto a few server
connections. What counts against `max_connections` is then the pooler's
server pool plus every replica's direct world pool.

Once web and worker roles split (#179), a web replica runs no worker and needs
only a small world pool for starting runs. A worker replica needs its job
concurrency plus 2.

## A transaction pooler for the app, a direct connection for the queue

`DATABASE_URL` may point at a transaction-mode pooler. The job queue may not.
It uses graphile-worker, which needs `LISTEN/NOTIFY` and session-level advisory
locks, and neither survives transaction pooling. So:

- `DATABASE_URL`: the pooler.
- `WORKFLOW_POSTGRES_URL`: a direct, or session-mode, connection to the same
  database.

When `WORKFLOW_POSTGRES_URL` is unset, the server uses `DATABASE_URL` for both,
which is right for a single database with no pooler. If `DATABASE_URL` looks
like a pooler (a `-pooler.` host or port 6543) and `WORKFLOW_POSTGRES_URL` is
unset, the server logs a warning at start (`context: "database.pool"`).

| Pooler | For `DATABASE_URL` | Notes |
| --- | --- | --- |
| PgBouncer, transaction mode | yes, from 1.21 | Prisma's node-postgres adapter uses prepared statements; PgBouncer passes them through from 1.21 with `max_prepared_statements` above 0 |
| Neon's `-pooler` host | yes | the direct host, without `-pooler`, for `WORKFLOW_POSTGRES_URL` |
| Supabase pooler, port 6543 | yes | port 5432, or the session pooler, for `WORKFLOW_POSTGRES_URL` |
| Azure Flexible Server, built-in PgBouncer | yes | port 6432 for the app, 5432 direct for the queue |
| RDS Proxy | yes for the app | it pins a session that `LISTEN`s, so it gains nothing for the queue: point `WORKFLOW_POSTGRES_URL` at the instance |

## In Compose

`docker-compose.yml` states the defaults explicitly: an app pool of 10, a world
pool of 10 and a worker concurrency of 8, so one replica opens at most 21 of
the bundled Postgres's 100. Override any of them in `.env`.
