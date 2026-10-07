# The container image

One image runs every part of a self-hosted Anonify. What it does is the
command you give it (#175):

| Command | What it does |
| --- | --- |
| `serve` (the default) | Starts the web server on `$PORT` (3000). |
| `migrate` | Applies the database migrations and the workflow schema, then exits. |
| `cleanup` | Runs the expiry sweep once, then exits. |
| `help` | Lists these. |

```sh
docker run IMAGE                 # serve
docker run IMAGE migrate         # migrate, then exit
docker run IMAGE cleanup         # sweep, then exit
```

A command that names a program runs as given, so `docker run IMAGE node
server.js` still starts the server. A misspelt command exits with status 64
and the list above.

## Migrations

Run `migrate`, with the image you are about to deploy, **before** rolling it
out. On each platform that is the same image with a different command:

| Platform | Where `migrate` runs |
| --- | --- |
| Docker Compose | the `migrate` service, which `app` waits for |
| Kubernetes (Helm) | a `pre-install,pre-upgrade` hook Job |
| ECS | a one-off task before the service update |
| Cloud Run | a Cloud Run Job, executed before the new revision |
| Container Apps | a Container Apps Job |
| Fly.io | `release_command = "migrate"` |

`migrate` is idempotent: it applies only what the database has not recorded,
so it is safe on every deploy. It is also safe from several replicas at once.
The whole run holds a Postgres advisory lock, so a second `migrate` waits for
the first and then finds nothing to do. Give it a direct `DATABASE_URL`, not
one through a transaction pooler: a session lock does not hold through one,
and Prisma's migrations need a direct connection anyway (see
[database.md](database.md)).

Migrations are forward-only, and the release before a migration keeps working
against the schema after it, so replicas of the old and the new version can
run side by side during a rollout. The rule contributors follow for that is in
[CONTRIBUTING.md](../../CONTRIBUTING.md#migrations).

## The expiry sweep

`cleanup` talks to the database and storage directly, so a scheduler that
runs a job (a Kubernetes CronJob, a scheduled ECS task, a Cloud Run Job on a
schedule) needs no web replica up and no `CRON_SECRET`. It exits non-zero when
a document could not be fully purged, so a scheduler that reports failures
reports that one. A scheduler that calls a URL can call
`/api/cron/cleanup` instead, as the Compose `scheduler` service does.

