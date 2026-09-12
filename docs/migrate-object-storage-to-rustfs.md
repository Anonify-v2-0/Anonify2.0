# Migrating object storage to RustFS

The Compose stack replaces its S3 server with RustFS 1.0.0-rc.6 and its bucket
client with `rustfs/rc` 0.1.35. Application storage settings remain the standard
`S3_*` variables, and stored database keys remain `s3:<object-key>` handles.

## Why RustFS

The MinIO server repository was archived by its owner on April 25, 2026 and is
read-only. Its Community Edition had already moved to source-only distribution,
with historical binary releases explicitly left unmaintained. The separate
MinIO Client repository was archived on July 14, 2026. Keeping those images in
the default stack would leave local and CI deployments dependent on archived
container tooling.

RustFS is the closest small change for Anonify because it keeps the S3 boundary:

- the server and `rc` client are actively released and Apache-2.0 licensed;
- RustFS tests the `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`,
  `ListObjectsV2`, metadata, multipart, and presigned URL behavior used or
  validated by this project;
- Anonify keeps its AWS SDK driver and every application-facing `S3_*` setting;
- `rc bucket create --ignore-existing` replaces bucket setup without a
  vendor-specific application API; and
- RustFS 1.0.0-rc.6 includes the one-way on-disk import used by the default
  Anonify volume.

RustFS has not published a 1.0 GA server release as of this migration. Compose
pins the newest published release candidate, `1.0.0-rc.6`, instead of following
`latest`; upgrades therefore remain deliberate and reviewable. The client image
is pinned independently to the stable `v0.1.35` release.

## Default Anonify installations

Anonify encrypts document bytes before it sends a normal S3 `PutObject`; it does
not ask the storage server to apply SSE, tiering, versioning, or a bucket policy.
RustFS 1.0.0-rc.6 documents read compatibility for that unencrypted MinIO
`xl.meta` layout and imports bucket metadata from `.minio.sys` into
`.rustfs.sys` at startup. The Compose file therefore mounts the existing
`anonify_minio-data` volume at `/data` instead of creating an empty replacement.

The import is one-way. Once RustFS has written to the volume, do not point an old
MinIO server at it: MinIO does not understand RustFS's `.rustfs.sys` metadata or
RustFS-written objects. A rollback requires restoring the pre-migration volume
backup and the previous application version together.

Before upgrading:

1. Stop writes and stop the old stack.

   ```bash
   docker compose down
   ```

2. Back up the named volume. This command only reads the object-storage volume
   and writes `anonify-object-storage-before-rustfs.tgz` in the current folder.

   ```bash
   docker run --rm \
     -v anonify_minio-data:/source:ro \
     -v "${PWD}:/backup" \
     alpine:3.22.1 \
     sh -c "cd /source && tar czf /backup/anonify-object-storage-before-rustfs.tgz ."
   ```

3. Update the checkout, rename any host-port overrides in `.env`, and start the
   stack.

   ```env
   RUSTFS_PORT=9000
   RUSTFS_CONSOLE_PORT=9001
   ```

   The application-facing `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE` settings
   keep their existing names and values.

   ```bash
   docker compose up -d --build --wait
   pnpm smoke:storage http://127.0.0.1:9000
   docker compose logs --no-color rustfs rustfs-init app
   ```

`rustfs-volume-init` changes ownership of the existing volume to RustFS's
container UID/GID `10001:10001`; it does not remove or rewrite objects.
`rustfs-init` then creates the configured bucket with `--ignore-existing`, so
both an empty install and a volume that already contains `anonify` start cleanly.

## Installations with storage-server features

Do not use the in-place path without first inventorying storage-server
configuration. RustFS's released default image does not read MinIO objects
encrypted with SSE-S3, SSE-KMS, or SSE-C, and compatibility is not established
for transitioned/tiered objects or every custom bucket feature. This is separate
from Anonify's own envelope encryption, which is only opaque object content to
the S3 server.

For any such installation, copy through the S3 API so the old server decrypts
and reconstructs each object before RustFS ingests it:

1. Keep an immutable backup of the old volume and run the old service from the
   previous checkout on a private migration endpoint.
2. Start RustFS with a new empty volume and create the destination bucket.
3. Configure two `rclone` S3 remotes with `provider = Other`, the respective
   endpoints and credentials, `region = us-east-1`, and
   `force_path_style = true`.
4. Copy and verify every object through the APIs.

   ```bash
   rclone copy legacy:anonify rustfs:anonify --checksum --progress
   rclone check legacy:anonify rustfs:anonify --checksum
   ```

5. Point Anonify's `S3_ENDPOINT` and credentials at RustFS only after the check
   succeeds. Keep the source and its backup read-only until the normal retention
   window has passed.

The upstream compatibility contract is maintained in
[RustFS's on-disk format documentation](https://github.com/rustfs/rustfs/blob/1.0.0-rc.6/docs/architecture/minio-file-format-compat.md).
The archival and distribution status comes from the
[MinIO server repository](https://github.com/minio/minio),
[MinIO server security page](https://github.com/minio/minio/security), and
[MinIO Client repository](https://github.com/minio/mc). RustFS publishes its
[S3 compatibility matrix](https://docs.rustfs.com/en/reference/s3-compatibility)
and [release history](https://github.com/rustfs/rustfs/releases).
