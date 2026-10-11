# Cloudflare Containers

> **Spike, desk research only (#193).** Everything below comes from
> Cloudflare's documentation as of 2026-10-11 and from a configuration that
> type-checks and bundles (`wrangler deploy --dry-run`). Nothing has run on
> Cloudflare yet. The hands-on half of the spike, with the verdict it is
> meant to produce, is tracked in the follow-up to #193. Do not run
> production on this.

**Verified on:** not yet.

## Verdict so far

| Role | Expected | Why | What would change it |
| --- | --- | --- | --- |
| web | ⚠️ likely works | The published amd64 image can be pulled from Docker Hub, the instance sizes fit, `SIGTERM` gets up to 15 minutes, outbound TCP is open by default | Progress streams (SSE) through the Worker in front, and upload sizes through it, are untested |
| worker | ⚠️ possible, unproven | A container has no maximum runtime, and overriding `onActivityExpired` without stopping keeps it awake; a Cron Trigger restarts it after a rollout | Whether a container stays up for days in practice, and whether `LISTEN/NOTIFY` connections survive Cloudflare's network |

If the worker role does not hold up, pair Cloudflare's web role with workers
on Fly, Cloud Run or a VM, sharing the same Postgres and R2: workers serve no
traffic, so they can run anywhere that reaches the database and the bucket.

## The questions, answered from the documentation

1. **The image.** Containers pull from Docker Hub, Amazon ECR, Google
   Artifact Registry or Cloudflare's own registry under the default
   scheduling policy, so `docker.io/nabeelwasif/anonify2.0:<version>` works
   as published. Images should be `linux/amd64`; ours is multi-arch, and the
   amd64 one is what runs. The image size limit is the instance's disk (up
   to 20 GB); ours is well under.
2. **Instance sizes.** Up to `standard-4`: 4 vCPU, 12 GiB, 20 GB disk; custom
   types allow 1–4 vCPU with at least 3 GiB per vCPU. A 2 vCPU / 4 GiB worker
   unit becomes `standard-3` (2 vCPU, 8 GiB), so memory is over-provisioned
   by the ratio rule, and billed.
3. **Web role.** A request reaches a Worker, which forwards it to a container
   through a Durable Object (`getRandom` over a fixed number of instances,
   since built-in autoscaling is "not today"). Still to test: an SSE response
   streamed back through the Worker for 300s and more, and a large upload
   passing through it. Presigned uploads straight to R2 avoid the second.
4. **Worker role.** "Cloudflare does not stop a container instance after a
   fixed maximum runtime." The default `sleepAfter` is 10 minutes, extended
   by requests; overriding `onActivityExpired` without calling `stop()` keeps
   the container awake. A worker gets no requests, so `deploy/cloudflare`
   starts each one from a Cron Trigger every two minutes, which also brings
   it back after a rollout or an eviction. `min=1` is therefore achievable,
   if it holds in practice.
5. **Shutdown.** `SIGTERM`, then up to 15 minutes, then `SIGKILL`, on a
   rollout as on any stop. The default `ANONIFY_DRAIN_SECONDS` (120) fits.
6. **Postgres.** "By default, a Container will allow internet access", and
   ports other than 80 and 443 are open while it does, so an external
   Postgres on 5432 is reachable. Still to measure: latency from wherever the
   container was placed, and whether long-lived `LISTEN` connections (the job
   queue, progress streams) survive. Hyperdrive is a Workers binding; the
   containers connect directly.
7. **Storage.** R2 through the S3 driver: `S3_ENDPOINT=https://<account
   id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, path style, presigned
   uploads with R2 CORS. Expected to work; check with `pnpm smoke:storage`.
8. **Sweep.** The built-in one, if workers stay up. Otherwise a Cron Trigger
   calling `/api/cron/cleanup` with `CRON_SECRET`.
9. **Scaling.** A fixed number of instances per class (`max_instances`),
   chosen by name or at random by the Worker. Nothing scales on load or on a
   queue today.
10. **Cost**, from the published prices, for one web (`standard-2`) and one
    worker (`standard-3`) running all month: memory and disk are billed on
    the instance size while running (14 GiB × 730 h ≈ $92; 28 GB disk ≈ $5),
    CPU on use (worker at half its 2 vCPU, web at a tenth of 1: about $58),
    plus the $5 Workers Paid plan: **about $160 a month**. Memory dominates,
    because of the 3 GiB-per-vCPU floor. The comparison with Cloud Run and
    Fly for the same unit is part of the hands-on follow-up.

## The configuration

[`deploy/cloudflare/`](../../deploy/cloudflare): `wrangler.jsonc` declares a
web class (`standard-2`, up to 4 instances) and a worker class (`standard-3`,
up to 2), both from the published image, and a Cron Trigger. `src/index.ts`
routes every request to a random web container, starts and keeps the
workers, and passes the secrets (`wrangler secret put`) to each container as
environment.

```sh
cd deploy/cloudflare
npm install
npx wrangler secret put ENCRYPTION_KEY     # FINGERPRINT_SECRET, CRON_SECRET,
                                           # DATABASE_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
npx wrangler deploy
```

Migrate first, from anywhere that reaches the database:
`docker run --rm -e DATABASE_URL=… nabeelwasif/anonify2.0 migrate`.

## Sources

- [Limits](https://developers.cloudflare.com/containers/platform-details/limits/),
  [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/),
  [image management](https://developers.cloudflare.com/containers/platform-details/image-management/),
  [outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
  [the Container class](https://developers.cloudflare.com/containers/container-package/),
  [FAQ](https://developers.cloudflare.com/containers/faq/),
  [pricing](https://developers.cloudflare.com/containers/pricing/)
