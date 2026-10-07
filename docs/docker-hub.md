# Anonify

Self-hosted document redaction. Upload a PDF, Word document, spreadsheet,
deck, email, mailbox, CSV, text file or image; Anonify proposes what looks like
personal data; you decide; the export removes it, and is re-opened and checked
before it is handed back.

Source, documentation and issues:
[github.com/Anonify-v2-0/Anonify2.0](https://github.com/Anonify-v2-0/Anonify2.0).

## Tags

Every release is published for `linux/amd64` and `linux/arm64`.

| Tag | Points at |
| --- | --- |
| `1.16.0` | That release, and never moves |
| `1.16` | The newest `1.16.x` |
| `1` | The newest `1.x.y` |
| `latest` | The newest release |
| `sha-<commit>` | The release built from that commit |

For anything you deploy, use a full version, or better its digest, which is in
each [release's notes](https://github.com/Anonify-v2-0/Anonify2.0/releases).

## Running it

One image does every job. What it does is the command:

```sh
docker run IMAGE            # serve on :3000 (the default)
docker run IMAGE migrate    # apply database migrations, then exit
docker run IMAGE cleanup    # run the expiry sweep once, then exit
docker run IMAGE help
```

It needs Postgres and S3-compatible storage (or Azure Blob Storage). The
repository's Compose file starts both alongside it. To run it from this image
rather than building from source, clone the repository and:

```sh
cat > .env <<EOF
ANONIFY_IMAGE=nabeelwasif/anonify2.0:1
ENCRYPTION_KEY=$(openssl rand -hex 32)
FINGERPRINT_SECRET=$(openssl rand -hex 32)
EOF
docker compose pull
docker compose up -d --no-build
```

Then open <http://localhost:3000>. `ENCRYPTION_KEY` encrypts every stored
document: keep it, because a new one cannot read what the old one wrote.

The image runs as a non-root user and works on a read-only root filesystem,
with `/tmp` and `/data` writable. Configuration, platforms and migrations:
[docs/deploy/image.md](https://github.com/Anonify-v2-0/Anonify2.0/blob/main/docs/deploy/image.md).

## Verifying an image

Each image carries build provenance and an SBOM, and a signed attestation that
it was built by this repository's release workflow:

```sh
gh attestation verify oci://docker.io/nabeelwasif/anonify2.0:1.16.0 --repo Anonify-v2-0/Anonify2.0
```

## Licence

Apache-2.0. The licence and notice files are in the image, at `/app/LICENSE`
and `/app/NOTICE`.
