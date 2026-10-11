# Render, Railway, DigitalOcean App Platform

> **Draft.** Written from each platform's documentation and the
> [contract](./README.md#the-contract); not yet followed end to end on these
> platforms. Verification is tracked in the follow-up to #192.

**Verified on:** not yet.

These platforms share one model: a web service, a background worker, a
scheduled or pre-deploy job, and managed Postgres. Anonify maps onto it
directly, with the same image for each part.

| Part | Render | Railway | DigitalOcean App Platform |
| --- | --- | --- | --- |
| Web (`ANONIFY_ROLE=web`, `serve`, port 3000) | Web Service from an image | Service with a public domain | Service component |
| Worker (`ANONIFY_ROLE=worker`, `serve`, no public port) | Background Worker | Service with no domain | Worker component |
| Migrations (`migrate`) | Pre-deploy command | Pre-deploy command | Job, kind `PRE_DEPLOY` |
| Postgres | Render Postgres | Railway Postgres | Managed PostgreSQL |
| Storage | Any S3-compatible bucket (S3, R2, B2) | Any S3-compatible bucket | Spaces (S3-compatible) |

## The settings every one of them needs

- Image `nabeelwasif/anonify2.0:<version>`, command `serve` (or `migrate`).
- `ANONIFY_ROLE` per service, `STORAGE_DRIVER=s3` with `S3_ENDPOINT`,
  `S3_BUCKET`, `S3_REGION` and keys, and the three secrets from
  `docker run --rm nabeelwasif/anonify2.0 keys`.
- `DATABASE_URL`, and `WORKFLOW_POSTGRES_URL` if the platform hands you a
  pooled URL ([database.md](./database.md)).
- Health check path `/api/ready` for web.
- At least **one** worker: none of these scale on a queue, so nothing would
  start one for the first document.
- The sweep runs in the worker. Skip the platform's cron.

## What differs

- **Shutdown grace.** Set `ANONIFY_DRAIN_SECONDS` to the platform's grace
  period minus ten seconds. Where it is short or fixed, a step cut short runs
  again and a lost run is restarted by the sweep (#182).
- **Request timeouts.** Progress streams stay open for minutes between
  events. A platform that ends long responses makes the browser reconnect,
  which works but flickers.
- **Spaces** needs `S3_FORCE_PATH_STYLE=false` and the region's endpoint,
  for example `https://ams3.digitaloceanspaces.com`.
