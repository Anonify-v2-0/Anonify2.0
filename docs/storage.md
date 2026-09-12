# Storage

`lib/storage/`

Three backends sit behind one interface, and nothing above the storage layer
knows which one answered. This document covers the drivers, the key layout that
makes a backend change safe, and the encryption that seals every byte.

---

## 1. The `StorageDriver` interface

`lib/storage/drivers.ts:28`

```ts
export type StorageDriver = {
  name: StorageDriverName
  clientUpload: "vercel-blob" | "server-route"
  put:   (key: string, data: Uint8Array) => Promise<StoredObject>
  get:   (key: string) => Promise<Buffer>
  delete:(key: string) => Promise<void>
  exists:(key: string) => Promise<boolean>
}
```

- `put` returns a `StoredObject` whose `key` is the **opaque handle** used to
  read the object back. That handle is what gets persisted in the database; it is
  never handed to the browser.
- `get` / `delete` / `exists` take that same handle. `delete` is idempotent at
  the `blob.ts` layer — a missing object is a successful delete
  (`lib/storage/blob.ts:34`).
- `clientUpload` tells the upload panel how the browser should deliver bytes.
  Vercel Blob is the only driver that answers `"vercel-blob"`; the filesystem and
  S3 both answer `"server-route"`.

Everything above this file works in keys and `Uint8Array`s and never learns
which backend answered.

---

## 2. Per-key driver routing

`lib/storage/drivers.ts:285` — `driverForKey`

A stored key is either an absolute URL (Vercel Blob hands one back) or a
`driver:path` handle, and the prefix is what selects the driver on read:

| Key shape | Driver |
| --- | --- |
| `local:<path>` | `localDriver` |
| `s3:<path>` | `createS3Driver(config)` |
| anything else (a URL) | `vercelBlobDriver` |

Writes go to the configured driver (`selectStorageDriver`); reads go to the
driver named by the key (`driverForKey`). This is the mechanism that makes a
backend change safe: a document written to disk stays readable after the
deployment moves to S3, because the read picks the driver from the key's own
prefix rather than from the current global config.

`driverForKey` will throw if the key says S3 but S3 is no longer configured —
the one case where a configuration change can make a document unreachable. A
document stored on the local filesystem or in Blob has no such failure mode:
the local driver always exists, and a Blob URL is fetched over HTTP.

`blob.ts` is the only place that calls either selector; the rest of the system
calls `putObject` / `getObject` / `deleteObject` and stays ignorant of the
backend.

---

## 3. The three drivers

### `localDriver` — `lib/storage/drivers.ts:53`

Writes to `.anonify-storage/` under the process working directory. Keys are
server-generated, but `localPath` (`drivers.ts:46`) still scrubs them: `..`
segments are stripped and leading slashes are trimmed, so a traversal-shaped
key cannot escape the store. `put` mkdirs the parent recursively; `exists` is a
read that swallows its own error, so there is no `stat` import to maintain.

### S3-compatible storage — `createS3Driver` (`drivers.ts:122`)

Built from an `S3Config`. `s3ConfigFromEnv` (`drivers.ts:96`) reads
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (all required), plus
optional `S3_REGION` (default `us-east-1`) and `S3_ENDPOINT`. Returns `null` if
the required pieces are missing, which is how `selectStorageDriver` decides S3
is not configured.

`forcePathStyle` is inferred from the endpoint when
`S3_FORCE_PATH_STYLE` is unset: custom S3-compatible endpoints usually need
path-style addressing, while AWS does not. Setting
`S3_FORCE_PATH_STYLE=false` overrides that inference for an edge case.

### `vercelBlobDriver` — `lib/storage/drivers.ts:188`

`put` calls `@vercel/blob` `put` with `addRandomSuffix: true`, so the returned
URL is unique; that URL **is** the key — there is no `blob:` prefix, and
`driverForKey` returns the Blob driver for any key that is not `local:` or
`s3:`. `get` is a `fetch` with `cache: "no-store"`; `delete` and `exists` use
the Blob `del` / `head` helpers.

---

## 4. Lazy imports

Each driver dynamically imports its own SDK, so an unused backend never enters
the bundle:

- `createS3Driver` does `import("@aws-sdk/client-s3")` inside the factory and
  again inside each method (`PutObjectCommand`, `GetObjectCommand`, …).
- `vercelBlobDriver` does `import("@vercel/blob")` inside `put` / `delete` /
  `exists`.
- `localDriver` uses only `node:fs/promises`, so there is nothing to lazy-load.

A deployment on Vercel Blob therefore never pulls in `@aws-sdk/client-s3`, and a
self-hosted install on RustFS never pulls in `@vercel/blob`.

---

## 5. Selecting the write driver

`selectStorageDriver` — `lib/storage/drivers.ts:243`

The driver for **new** objects is chosen once, at write time. Inference order:

1. **Explicit `STORAGE_DRIVER`.** If set, it must be one of `vercel-blob`,
   `s3`, `local` (`configuredDriverName`, `drivers.ts:229`); anything else
   throws. Each value is then validated against its own env —
   `vercel-blob` needs `BLOB_READ_WRITE_TOKEN`, `s3` needs the three S3 vars.
2. **Blob token present.** `BLOB_READ_WRITE_TOKEN` selects `vercelBlobDriver`.
3. **S3 config present.** `s3ConfigFromEnv()` returning non-null selects
   `createS3Driver`.
4. **Otherwise `localDriver`.** A fresh clone with nothing configured at all
   still works — on the filesystem.

`configuredDriverName()` is the small helper that parses and validates
`STORAGE_DRIVER` into a `StorageDriverName | null`, used both here and wherever
the rest of the system wants to report which backend is active
(`storageDriverName` in `blob.ts:56`).

---

## 6. The `blob.ts` key layout

`lib/storage/blob.ts` is the only place that constructs keys, and the layout is
fixed so `purgeDocument` (see [workflow.md](./workflow.md) §6) can find every
artifact a document owns by prefix:

| Path | Built by | What it is |
| --- | --- | --- |
| `documents/:id/upload/<filename>` | `uploadKey` (`blob.ts:61`) | the plaintext browser upload, before ingest re-seals it |
| `documents/:id/source.bin` | `sourceKey` (`blob.ts:66`) | the sealed original |
| `documents/:id/redacted.<ext>.bin` | `processedKey` (`blob.ts:70`) | a sealed redacted export |
| `documents/:id/report.<artifactId>.json.bin` | `reportKey` (`blob.ts:75`) | the export report that accompanies one generated artifact |
| `documents/:id/render/<name>.bin` | `renderKey` (`blob.ts:79`) | a sealed rendered page or preview |

`uploadKey` sanitises the filename to `[^A-Za-z0-9._-]` → `_` and truncates to
the last 80 chars, so a user-supplied name cannot inject path segments.

`purgeDocument` walks this tree and deletes everything under
`documents/:id/` — source, the upload if ingest never reached it, the
normalized model, every export and render — and only deletes the database row
once storage has cleared. The row is the only thing that knows where the bytes
are, so it goes last; a blob already gone counts as deleted, which is what
makes the sweep idempotent. The explicit "delete now" goes through the same
function so there is one list of what a document owns.

`clientUploadMode()` (`blob.ts:52`) returns `"vercel-blob"` or `"server-route"`
by asking the configured driver. The upload panel reads it to decide whether
to request a scoped Blob token and upload straight to Vercel, or to POST the
bytes to our own route. See the upload path in [architecture.md](./architecture.md)
§2.

---

## 7. Encryption

`lib/storage/encryption.ts`

Envelope encryption, everywhere bytes are stored. Every document gets its own
random 256-bit data key; the payload is sealed with AES-256-GCM under that data
key, and the data key itself is sealed under the server-held master key
(`ENCRYPTION_KEY`). See [architecture.md](./architecture.md) §4 for the picture.

Keys are random — never derived from an IP, a MAC, browser behaviour or
network activity, all of which are attacker-controlled and unstable.

### Ciphertext layout

`sealWithKey` (`encryption.ts:49`) returns `iv || tag || ciphertext`:

```
| 12 bytes  | 16 bytes  | N bytes    |
| iv        | auth tag  | ciphertext |
```

- The IV is 12 bytes (`IV_BYTES`), randomly generated per seal.
- The GCM auth tag is 16 bytes (`TAG_BYTES`), appended before the body.
- The ciphertext is the rest.

`openWithKey` (`encryption.ts:57`) splits on those fixed offsets, feeds the tag
to `setAuthTag`, and throws if authentication fails — GCM means tampering is
detected rather than silently decrypted into garbage. A payload shorter than
`IV_BYTES + TAG_BYTES` is rejected as "too short to be valid" before any
crypto runs.

### `assertMasterKey` — fail on the way up

`encryption.ts:44`. Reads and validates `ENCRYPTION_KEY` — it must decode to 32
bytes (64 hex chars or base64) — and throws otherwise.

`instrumentation.ts:23` calls it in `register()`, at boot. The master key is
otherwise only touched deep inside the pipeline, so a malformed one used to
present as a workflow step exhausting its retries three layers away from the
line of configuration that caused it — by which point the upload had already
been accepted. CI spent a run on exactly that failure: a YAML config quietly
turned the key into the integer `0`, which passed type checks and broke far
from its origin.

Failing on the way up means a bad key is reported at startup, next to the env
line that caused it, and before any document is accepted — not on the first
document through the door.
