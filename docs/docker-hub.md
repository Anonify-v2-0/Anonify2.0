# Anonify

**Self-hosted, AI-assisted document redaction.** Upload a PDF, Word document,
spreadsheet, deck, email, mailbox, CSV, text file or image. Anonify proposes
what looks like personal data; a person decides; the export removes it. Then
it re-opens the export and reads it the way an adversary would, and a value
that survived fails the export rather than shipping.

> AI proposes, the application applies, and only what a person accepted is
> removed. A black rectangle over text that is still in the file is not a
> redaction.

Source, documentation and issues:
[github.com/Anonify-v2-0/Anonify2.0](https://github.com/Anonify-v2-0/Anonify2.0)

## What it redacts

| Format | What is removed |
| --- | --- |
| PDF | Text on any page. Scanned pages are read with OCR so they can be reviewed. |
| Word (.docx) | Text in place, including headers, footers, footnotes and comments. |
| Excel (.xlsx) | Cells, hidden sheets included. Formulas that still reference a redacted cell are dropped. |
| PowerPoint (.pptx) | Slides, speaker notes, layouts and the master. |
| Email (.eml) | Headers, every body part, quoted replies and attachment names. Supported attachments become documents of their own. |
| Mailbox (.mbox) | Split into one document per message, and rebuilt as a mailbox on export. |
| CSV, TSV | Cells, parsed as a grid. |
| Text (.txt), Rich text (.rtf) | Text, with RTF parsed rather than searched. |
| Images (PNG, JPEG, WebP) | Pixels, re-encoded, with EXIF and GPS metadata removed. |

It looks for names, addresses, phone numbers, email addresses, government IDs,
bank and financial details, dates of birth, customer and case numbers,
credentials, faces, health information and anything else that identifies a
person. Pattern detection, manual redaction and export work with no AI
provider at all; a model (OpenAI, Anthropic, Google, Bedrock, Azure, Ollama and
others) adds a contextual pass when one is configured.

## Quick start

It needs Postgres and S3-compatible storage. The Compose file attached to each
release runs both alongside the app, with local OCR, and needs no accounts
anywhere. No clone, no Node, no build:

```sh
mkdir anonify && cd anonify
curl -LO https://github.com/Anonify-v2-0/Anonify2.0/releases/latest/download/docker-compose.yml
[ -e .env ] || docker run --rm nabeelwasif/anonify2.0 keys > .env
docker compose up -d
```

Then open <http://localhost:3000>. This starts Postgres, RustFS (S3), creates
the bucket, applies the migrations and starts Anonify. Every port is bound to
localhost.

**Keep `.env`.** `keys` prints a new `ENCRYPTION_KEY` each time, and it
encrypts every stored document: a new key cannot read what the old one wrote.

**Pin a version** for anything you keep, with `ANONIFY_VERSION=X.Y.Z` in
`.env`; the file follows `latest` otherwise. **Upgrade** with
`docker compose pull && docker compose up -d`: migrations run before the app
starts.

## One image, several jobs

```sh
docker run IMAGE            # serve on :3000 (the default)
docker run IMAGE migrate    # apply database migrations, then exit
docker run IMAGE cleanup    # run the expiry sweep once, then exit
docker run IMAGE keys       # print new secrets for a .env file
docker run IMAGE help
```

Run `migrate` with the image you are about to deploy, before rolling it out.
It is idempotent and takes a Postgres advisory lock, so it is safe on every
deploy and from several replicas at once.

## The container

| | |
| --- | --- |
| Port | `3000` (`PORT`) |
| User | `nextjs`, UID 1001, GID 1001 |
| Writable paths | `/tmp`, and `/data` (the OCR cache, `/data/tesseract`); the root filesystem can be read-only |
| Required settings | `DATABASE_URL`, `ENCRYPTION_KEY`, `FINGERPRINT_SECRET`, and storage (`STORAGE_DRIVER` with its settings) |
| Liveness / readiness | `GET /api/health` / `GET /api/ready` |
| Stopping | Drains on `SIGTERM`: readiness drops, running steps finish, then it exits. Give it a 130s grace period |
| Init | `tini` as PID 1 |

## Running it in production

- **Storage:** any S3-compatible service (AWS S3, RustFS, Cloudflare R2, …) or
  Azure Blob Storage. Browsers can upload straight to the bucket.
- **Database:** Postgres. It also holds the durable processing queue, so there
  is no separate worker service to run unless you want one.
- **OCR:** Tesseract inside the image, with the English model baked in, so
  scans are read with no outbound internet. Mistral OCR is an option.
- **Hardened:** runs as a non-root user, works on a read-only root filesystem
  with `/tmp` and `/data` writable, and runs under `tini` as PID 1.
- **Health:** `/api/health` for liveness, `/api/ready` for readiness (database,
  storage and worker).
- **Scaling:** several replicas share one database and bucket, with
  `ANONIFY_ROLE=web` or `worker` to split serving from processing. Each sizes
  itself from its CPUs, and AI and OCR budgets can be shared through Postgres
  or Redis/Valkey.
- **No scheduler to run:** workers delete expired documents themselves, with
  one replica leading at a time.

Configuration, platforms and migrations:
[docs/deploy/image.md](https://github.com/Anonify-v2-0/Anonify2.0/blob/main/docs/deploy/image.md).
Every setting:
[.env.example](https://github.com/Anonify-v2-0/Anonify2.0/blob/main/.env.example).

## Tags

Every release is published for `linux/amd64` and `linux/arm64`.

| Tag | Points at |
| --- | --- |
| `X.Y.Z` | That release. Never moves. |
| `X.Y` | The newest `X.Y.z` |
| `X` | The newest `X.y.z` |
| `latest` | The newest release |
| `sha-<commit>` | The release built from that commit |

For anything you deploy, pin a full version, or better its digest, which is in
each [release's notes](https://github.com/Anonify-v2-0/Anonify2.0/releases).

## Verifying an image

Each image carries build provenance and an SBOM, and a signed attestation that
this repository's release workflow built it:

```sh
gh attestation verify oci://docker.io/nabeelwasif/anonify2.0:X.Y.Z --repo Anonify-v2-0/Anonify2.0
```

## Licence

Apache-2.0. The licence and notice files are in the image, at `/app/LICENSE`
and `/app/NOTICE`.
