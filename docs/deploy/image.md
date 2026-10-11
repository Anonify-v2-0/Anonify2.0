# The container image

One image runs every part of a self-hosted Anonify. What it does is the
command you give it (#175):

| Command | What it does |
| --- | --- |
| `serve` (the default) | Starts the web server on `$PORT` (3000). |
| `migrate` | Applies the database migrations and the workflow schema, then exits. |
| `cleanup` | Runs the expiry sweep once, then exits. |
| `keys` | Prints new secrets for a `.env` file (#186). |
| `help` | Lists these. |

The image sets `NEXT_MANUAL_SIG_HANDLE=true`, so a stopped container
finishes the steps it is running before it exits, for up to
`ANONIFY_DRAIN_SECONDS` (#182). Give it a grace period to match; see
[workflow.md](../workflow.md#8-shutdown-and-lost-workers).

```sh
docker run IMAGE                 # serve
docker run IMAGE migrate         # migrate, then exit
docker run IMAGE cleanup         # sweep, then exit
docker run IMAGE keys            # print new secrets for .env
```

A command that names a program runs as given, so `docker run IMAGE node
server.js` still starts the server. A misspelt command exits with status 64
and the list above.

## The published image

Every release is published to Docker Hub as
[`nabeelwasif/anonify2.0`](https://hub.docker.com/r/nabeelwasif/anonify2.0),
for `linux/amd64` and `linux/arm64` (#180):

| Tag | Points at |
| --- | --- |
| `X.Y.Z` | That release. Never moves. |
| `X.Y`, `X` | The newest release in that line. |
| `latest` | The newest release. |
| `sha-<commit>` | The release built from that commit. |

Each release's notes give its index digest. Deploy by digest, or at least by
`X.Y.Z`: a floating tag changes what a restart runs.

### With Compose, and no clone (#186)

`docker-compose.yml` runs the published image by default,
`nabeelwasif/anonify2.0:${ANONIFY_VERSION:-latest}`, and each release has it
attached, with `env.example`, so an install needs neither the repository nor
Node:

```sh
curl -LO https://github.com/Anonify-v2-0/Anonify2.0/releases/latest/download/docker-compose.yml
[ -e .env ] || docker run --rm nabeelwasif/anonify2.0 keys > .env
docker compose up -d
```

| Setting in `.env` | Default | |
| --- | --- | --- |
| `ANONIFY_VERSION` | `latest` | The tag to run. Pin `X.Y.Z` for anything you keep. |
| `ANONIFY_IMAGE` | `nabeelwasif/anonify2.0:$ANONIFY_VERSION` | The whole reference, for a mirror or a digest (`…@sha256:…`). |
| `ANONIFY_PULL_POLICY` | `missing` | Compose's `pull_policy`. `never` runs only a local image, as CI does. |

Upgrading is `docker compose pull && docker compose up -d`: the `migrate`
service runs the new image's migrations before the app starts.

From a clone, `docker compose up -d --build` builds the checkout and tags it
with the same name, so what runs is your code; without `--build` Compose pulls
the published image.

`anonify keys` prints new `ENCRYPTION_KEY`, `FINGERPRINT_SECRET` and
`CRON_SECRET` lines, 32 random bytes each, as hex. They are different every
time: never redirect it over a `.env` that already has keys, because a new
`ENCRYPTION_KEY` cannot read what the old one wrote.

Each image carries BuildKit's provenance (`mode=max`) and an SBOM per
architecture, and the index has a signed GitHub attestation, so you can check
it was built by this repository's release workflow and from which commit:

```sh
gh attestation verify oci://docker.io/nabeelwasif/anonify2.0:X.Y.Z --repo Anonify-v2-0/Anonify2.0
docker buildx imagetools inspect nabeelwasif/anonify2.0:X.Y.Z --format '{{json .Provenance}}'
```

`.github/workflows/publish-image.yml` builds it. Each architecture builds on
a native runner and is pushed by digest; the tags move only once both exist;
then each architecture pulls the image back by digest and runs the Compose
stack and the smoke test against it. A failure there opens an issue and moves
no tag, since the image may already have been pulled. A publish that failed
can be re-run from the Actions tab ("Publish image", with the version) without
cutting a new release; re-publishing an older version does not move `latest`.
A version that is already on Docker Hub is not rebuilt: the re-run reuses that
image, so `X.Y.Z` keeps its digest.

Release builds pass `ANONIFY_BUILD_ID=X_Y_Z-<short commit>` (underscores,
because Next.js accepts only letters, digits, `-` and `_` in a
`deploymentId`) and the
`OCI_*` labels described below.

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

A container that runs workers (`ANONIFY_ROLE` `all` or `worker`) runs the
sweep itself, every five minutes, with one replica leading at a time (#183).
You need an external schedule only when no worker is long-lived.

`cleanup` talks to the database and storage directly, so a scheduler that
runs a job (a Kubernetes CronJob, a scheduled ECS task, a Cloud Run Job on a
schedule) needs no web replica up and no `CRON_SECRET`. It exits non-zero when
a document could not be fully purged, so a scheduler that reports failures
reports that one. A scheduler that calls a URL can call
`/api/cron/cleanup` instead. All three share one lock.

## Building and running it (#178)

**Writable paths.** The image runs as a non-root user (`nextjs`, uid 1001) and
needs only two writable paths, so it runs with a read-only root filesystem
(`readOnlyRootFilesystem: true` on Kubernetes):

| Path | What writes there |
| --- | --- |
| `/tmp` | Next.js's image-optimisation cache (`.next/cache` points here) and temporary files. A `tmpfs`, or an `emptyDir`, is enough. |
| `/data` | The OCR model cache (`TESSERACT_CACHE_PATH=/data/tesseract`), only when the model needed is not the one baked in. A volume keeps it across restarts. |

CI runs the whole stack this way (`docker-compose.readonly.yml`).

**The OCR model is in the image.** The default model (English, `standard`)
is fetched when the image is built, so scans are read with no outbound
internet. A replica reads it where it is when it holds the configured
language and variant. When more languages are configured, the baked ones are
copied into the cache and only the rest are downloaded. To bake others in:

```sh
docker build --build-arg OCR_PRELOAD_LANGUAGES=eng+deu --build-arg OCR_PRELOAD_MODEL=standard -t anonify .
```

About 3 MB per language at `standard`, more at `best`.

**PID 1 is tini.** It reaps zombie processes and forwards `SIGTERM` to the
server, so a `docker stop` or a pod deletion stops it promptly.

**Labels and build identity.** Build arguments the release job supplies:

| Argument | Becomes |
| --- | --- |
| `ANONIFY_BUILD_ID` | `ENV ANONIFY_BUILD_ID`, the Next.js `deploymentId`, the `build` field of `/api/health` and of the startup log line. `dev` locally. Letters, digits, `-` and `_` only, or `next build` fails. |
| `OCI_VERSION`, `OCI_REVISION`, `OCI_CREATED`, `OCI_SOURCE` | The `org.opencontainers.image.*` labels, with `licenses=Apache-2.0`, `title` and `description`. |

The `deploymentId` matters during a rolling update: a browser that loaded one
version and reaches a replica running another is reloaded rather than handed
assets that replica does not have.

**The base image is pinned by digest.** Rebuilding the same commit cannot
silently change it; Dependabot opens a pull request when the digest moves.
