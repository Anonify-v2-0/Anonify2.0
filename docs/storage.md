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
  put:       (key: string, data: Uint8Array) => Promise<StoredObject>
  get:       (key: string) => Promise<Buffer>
  getStream: (key: string) => Promise<Readable>
  getRange:  (key: string, start: number, end: number) => Promise<Buffer>
  putStream: (key: string, body: Readable) => Promise<StoredObject>
  size:      (key: string) => Promise<number>
  delete:    (key: string) => Promise<void>
  exists:    (key: string) => Promise<boolean>
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
- `getStream`, `getRange` and `putStream` are the streaming half, used by
  everything that should not hold a whole object: ingest, container
  expansion, text/CSV/TSV extraction and the source route. `getRange` is
  **half-open** — bytes `[start, end)` — like every other range in the
  codebase, whatever the backend's own convention. A backend that ignores a
  range and answers with the whole object is still answered correctly: the
  driver slices it. Only the efficiency varies, so callers never need to know
  which backend they are talking to.
- `size` reads the stored length without reading the object; ingest refuses an
  oversize upload with it before a byte is read, and chunked range reads use
  it to find the final chunk.

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
server-generated, but `localPath` still scrubs them: `..` segments are
stripped and leading slashes are trimmed, so a traversal-shaped key cannot
escape the store. `put` mkdirs the parent recursively; `exists` and `size` are
a `stat`. `putStream` writes beside the destination and renames into place, so
a stream that fails halfway leaves nothing under the real name.

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

`getRange` is a native `Range` GET. `putStream` is a multipart upload through
`@aws-sdk/lib-storage`: 5 MiB parts (S3's minimum), with as many in flight as
one document's share of the streaming budget holds (§8). `pnpm smoke:storage`
exercises both against RustFS.

### `vercelBlobDriver` — `lib/storage/drivers.ts:188`

`put` calls `@vercel/blob` `put` with `addRandomSuffix: true`, so the returned
URL is unique; that URL **is** the key — there is no `blob:` prefix, and
`driverForKey` returns the Blob driver for any key that is not `local:` or
`s3:`. `get` is a `fetch` with `cache: "no-store"`; `delete`, `exists` and
`size` use the Blob `del` / `head` helpers. `getRange` sends a `Range` header
and uses a `206`, slicing if the answer is a whole-object `200`; `putStream`
hands `put` a Node stream.

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
| `documents/:id/normalized.json.bin` | `normalizedKey` | the sealed normalized model |
| `documents/:id/redacted.<artifactId>.<ext>.bin` | `artifactKey` / `processedKey` | a sealed redacted export |
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

### Two envelopes, chosen by the document

Every document records which envelope its objects are sealed in, in
`Document.encryptionFormat`, and every object the document owns — source,
normalized model, exports, reports, vaults — is in that one format. Reads
dispatch on the record, through `lib/storage/sealed.ts`, and **never on the
bytes**: a `v0` object begins with a random IV, and a random IV can begin with
the `v1` magic like anything else can.

| Recorded | Envelope | Written by |
| --- | --- | --- |
| `null` / `v0` | one AES-256-GCM pass over the whole object | every document ingested before the chunked format |
| `v1` | chunked AES-256-GCM (below) | every document ingested since, including every child of a container |

A `v0` document keeps writing `v0` for the rest of its life and ages out through
the retention sweep; nothing is backfilled. Children of a `v0` container are new
documents and are sealed `v1`.

### The chunked envelope (`v1`)

`lib/storage/chunked.ts`

```
header   16 bytes, cleartext, bound into every chunk's AAD
  magic        4   "ANFY"
  version      1   0x01
  chunkShift   1   log2(chunkSize); 20 = 1 MiB
  reserved     2   zero
  noncePrefix  8   random, per object

chunk i
  ciphertext   chunkSize bytes (the final chunk is shorter, and an empty
               object is one empty final chunk)
  tag          16
```

- **Nonce** = `noncePrefix(8) || counter_be32(i)` — derived, never random per
  chunk, so it cannot repeat within an object. The counter fails closed rather
  than wrapping, and objects are write-once, so a nonce never seals two
  plaintexts.
- **AAD** = `header || logicalKey || finalFlag`. The final flag closes
  truncation (no prefix of an object is a valid object); the counter in the
  nonce closes reordering; the **logical key** — the `documents/:id/…` path the
  object was written under, supplied by the reader from the document and
  artifact it is reading — closes splicing between objects that share a data
  key. Before this, the source, model, exports and reports of one document
  were interchangeable as far as the cipher was concerned.
- Sealed size is exactly `16 + n·(chunkSize + 16)` less the final chunk's
  shortfall, so a plaintext range maps to a computable run of chunks and is
  served by one ranged read (`openSealedObject(...).range(start, end)`).
- The chunk size is read **from the header** when opening. Configuration only
  chooses what new objects are sealed with, so changing it never makes an
  existing object unreadable.
- No plaintext leaves a chunk before its tag verifies. A tampered chunk fails
  the stream at that chunk; a truncated object fails it at the end.

### The original envelope (`v0`)

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

---

## 8. The streaming budget

`lib/storage/streaming.ts`

Streaming bounds one document's footprint by the chunk size rather than the
file, but only if the chunks in flight are bounded too. The budget is stated
once, as the product that matters:

```
chunkBytes × maxInFlightChunks × processingConcurrency() <= memoryBudget
```

`processingConcurrency()` is the existing per-owner gate from
`lib/documents/admission.ts`, so this composes with it rather than being a
second limiter. `ANONIFY_ENCRYPTION_CHUNK_SIZE` (default `1MB`, a power of two
between `64KB` and `16MB`) and `ANONIFY_STREAM_MEMORY_BUDGET` (default 8 chunks
per processing document for a demo, 16 self-hosted) configure it. A budget that
cannot give every concurrent document two chunks is refused at startup, from
`instrumentation.ts`, rather than quietly exceeded.
