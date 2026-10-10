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
  expansion, extraction of every format but images and RTF, the editor's
  page-at-a-time model, the source route and both download routes. What each
  of them reads, and why, is [streaming.md](./streaming.md). `getRange` is
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
| `azure:<path>` | `createAzureDriver(config)` |
| anything else (a URL) | `vercelBlobDriver` |

Writes go to the configured driver (`selectStorageDriver`); reads go to the
driver named by the key (`driverForKey`). This is the mechanism that makes a
backend change safe: a document written to disk stays readable after the
deployment moves to S3, because the read picks the driver from the key's own
prefix rather than from the current global config.

`driverForKey` will throw if the key says S3 or Azure but that backend is no
longer configured — the one case where a configuration change can make a document unreachable. A
document stored on the local filesystem or in Blob has no such failure mode:
the local driver always exists, and a Blob URL is fetched over HTTP.

`blob.ts` is the only place that calls either selector; the rest of the system
calls `putObject` / `getObject` / `deleteObject` and stays ignorant of the
backend.

---

## 3. The four drivers

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

`S3_PRESIGNED_UPLOADS=true` (and optionally `S3_PUBLIC_ENDPOINT`) lets
browsers upload straight to the bucket with a presigned PUT; see §6, *Direct
uploads to S3*. The presigning client turns the SDK's default request checksum
off (`requestChecksumCalculation: "WHEN_REQUIRED"`). Otherwise the SDK signs a
CRC32 of the empty body the URL was made from, and the browser's real PUT
fails it.

### Azure Blob Storage — `createAzureDriver` (`lib/storage/azure.ts`)

Azure Blob Storage does not speak the S3 API, so before this driver an Azure
deployment needed an S3 gateway in front of it (#176). Handles are
`azure:<path>`.

| Setting | Meaning |
| --- | --- |
| `AZURE_STORAGE_ACCOUNT` | The storage account. Required unless a connection string names it. |
| `AZURE_STORAGE_CONTAINER` | The container. Required. |
| `AZURE_STORAGE_CONNECTION_STRING` | Credential, first choice. |
| `AZURE_STORAGE_ACCOUNT_KEY` | Credential, second choice. |
| `AZURE_STORAGE_ENDPOINT` | Overrides `https://<account>.blob.core.windows.net`: Azurite, sovereign clouds. |
| `AZURE_STORAGE_PRESIGNED_UPLOADS` | `true` lets browsers PUT straight to the container with a SAS. |
| `AZURE_STORAGE_PUBLIC_ENDPOINT` | The endpoint as a browser reaches it, when that differs. |

With neither a connection string nor a key, the driver authenticates with
`DefaultAzureCredential`: a managed identity on Container Apps, workload
identity on AKS. That needs no secret at all, and is the recommended path in
production. Give the identity the **Storage Blob Data Contributor** role on
the container (or the account). With browser uploads on, the SAS is a user
delegation SAS, which needs the same role; with a key it is a service SAS.

Each method maps onto one SDK call: `put` is `uploadData`, `getStream` is
`download(0)`, `getRange(start, end)` is `download(start, end - start)` (an
offset and a count), `size` is `getProperties`, `delete` is `deleteIfExists`,
`exists` is `exists`, `deleteMany` is a blob batch of up to 256 deletes per
request, and `probe` (for `/api/ready`) is the container's `getProperties`.
`putStream` is `uploadStream` in blocks of the streaming chunk size, with as
many in flight as one document's share of the streaming budget holds (§8).

**Browser uploads and exact length.** A presigned S3 PUT signs
`Content-Length`, so the bucket refuses any other number of bytes. A SAS
cannot sign a length. The SAS allows create and write on one blob for 15
minutes and requires `x-ms-blob-type: BlockBlob`; the length is held by
ingest instead, which refuses an upload whose stored size is not the size the
document was reserved with (`lib/documents/ingest.ts`). That check runs for
every backend. The account needs a CORS rule allowing `PUT` from the app's
origin with the `content-type` and `x-ms-blob-type` headers.

**Turn lifecycle management off for the container.** Anonify deletes its own
objects when a document expires, and a lifecycle rule could delete a source
that is still inside its retention window.

The container is the operator's to create; the app never creates one.
`pnpm smoke:driver` runs the driver through every method, a SAS upload
included. CI runs it against Azurite, the official emulator, and then runs the
whole app on it (`docker-compose.azure.yml`). Managed identity is not covered
by CI, because the emulator has none.

### `vercelBlobDriver` — `lib/storage/drivers.ts:188`

`put` calls `@vercel/blob` `put` with `addRandomSuffix: true`, so the returned
URL is unique. Browser uploads get a random suffix too, from the token route;
the path check there runs on the requested pathname, before the suffix is
added. Objects stay `public`, because this driver reads everything by plain
URL: moving to private access would change every read, and it needs a store
created as private. With sealed uploads, what a public URL exposes is
ciphertext. The returned URL **is** the key — there is no `blob:` prefix, and
`driverForKey` returns the Blob driver for any key that is not `local:` or
`s3:`. `get` is a `fetch` with `cache: "no-store"`; `delete`, `exists` and
`size` use the Blob `del` / `head` helpers. `getRange` sends a `Range` header
and uses a `206`, slicing if the answer is a whole-object `200`; `putStream`
hands `put` a Node stream. `pnpm smoke:blob` asks a real store for a range
directly and fails on anything but a `206`, because the driver's slicing would
otherwise hide a store that ignores ranges; run against Vercel Blob on
2026-09-27, ranges are honoured.

---

## 4. Lazy imports

Each driver dynamically imports its own SDK, so an unused backend never enters
the bundle:

- `createS3Driver` does `import("@aws-sdk/client-s3")` inside the factory and
  again inside each method (`PutObjectCommand`, `GetObjectCommand`, …).
- `createAzureDriver` does `import("@azure/storage-blob")`, and
  `import("@azure/identity")` only for the default credential.
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
   `s3`, `azure-blob`, `local` (`configuredDriverName`, `drivers.ts:229`); anything else
   throws. Each value is then validated against its own env —
   `vercel-blob` needs `BLOB_READ_WRITE_TOKEN`, `s3` needs the three S3 vars,
   `azure-blob` needs a container and an account or connection string.
2. **Blob token present.** `BLOB_READ_WRITE_TOKEN` selects `vercelBlobDriver`.
3. **S3 config present.** `s3ConfigFromEnv()` returning non-null selects
   `createS3Driver`.
4. **Azure config present.** `AZURE_STORAGE_CONTAINER` with an account or a
   connection string selects `createAzureDriver`. After S3, so an install that
   has both keeps the backend it had.
5. **Otherwise `localDriver`.** A fresh clone with nothing configured at all
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
| `documents/:id/upload/<filename>` | `uploadKey` | the browser upload before ingest re-seals it: sealed under the upload key when `uploadFormat` is set (§7, *Sealed uploads*), plaintext otherwise. On Vercel Blob the stored URL carries a random suffix after the name |
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

`clientUploadMode()` returns `"vercel-blob"`, `"s3-presigned"` or
`"server-route"` by asking the configured driver. The upload panel reads it to
decide whether to request a scoped Blob token and upload straight to Vercel,
request a presigned PUT and upload straight to the bucket, or PUT the bytes to
our own route. See the upload path in [architecture.md](./architecture.md) §2.

Whichever path is used, the handle `/process` is given has to be this
document's own upload: `isUploadHandleFor` accepts `local:` or `s3:` followed
by exactly `uploadKey(id, name)`, or an `https` URL on
`*.blob.vercel-storage.com` whose path is under `documents/:id/upload/`. A
handle the server recorded itself wins over the one the client names. The
local route records the handle when it writes, and Vercel's completion webhook
records it in production. Ingest reads that handle and then deletes it, so an
unchecked one would let a caller point their document at another object and
have it removed.

### Through the app: `PUT /api/upload/local`

Without direct uploads, the browser PUTs the file to `/api/upload/local` as
the raw request body with its `Content-Length`. The route checks the session,
the document, and the declared length against the ceiling before it reads a
byte, then streams the body into `putObjectStream` through a guard that fails
the moment more bytes arrive than were declared, or the body ends with fewer.
Memory per upload is the streaming chunk, not the file (#185).

A failed stream leaves nothing under the final key, on every driver: the local
driver writes to a `.partial` file beside it and renames only on success, S3's
multipart upload is aborted, and Azure never commits its block list. So a
client that disconnects half-way leaves no object for ingest to find.

The multipart `POST` this replaced is kept for API scripts until 1.17.0, with a
`Deprecation` header on every answer. It holds the whole file in memory first.

### Direct uploads

With `S3_PRESIGNED_UPLOADS=true` (S3) or `AZURE_STORAGE_PRESIGNED_UPLOADS=true`
(Azure), the driver's `clientUpload` is `s3-presigned`. `POST
/api/upload/presign` then returns a PUT URL for the document's upload path,
valid for 15 minutes. The URL is issued only for a sealed upload. On S3 its
signature covers `Content-Length`, so the bucket refuses any other number of
bytes; the server checks that number against the plaintext ceiling before
signing. The server never handles the upload, not even as ciphertext.

**Turn it on in production** where browsers can reach the bucket. The upload
then costs the web tier nothing at all. Docker Compose keeps the default,
uploads through the app, because CORS for `localhost` is fiddly and a laptop
has bandwidth to spare.

It needs two things only an operator can provide:

- **an endpoint browsers can reach.** Set `S3_PUBLIC_ENDPOINT` (or
  `AZURE_STORAGE_PUBLIC_ENDPOINT`) when it differs from the one the server
  uses: inside Docker Compose the app reaches RustFS at `http://rustfs:9000`,
  and a browser reaches it at `http://localhost:9000`. A managed service
  (AWS, R2, GCS, Azure) has one public endpoint and needs neither.
- **a CORS rule** allowing `PUT` from the app's origin, the origin of
  `ANONIFY_PUBLIC_URL`, with the headers the URL is signed with. Below.

**When it goes wrong, uploads still work.** A browser whose PUT to the bucket
gets no answer, which is what a missing CORS rule looks like from a page,
uploads once more through `PUT /api/upload/local` and says so. The server logs
each one:

```json
{"level":"warn","context":"upload.presigned-fallback","reason":"presigned-network-error","origin":"https://redact.example.org","message":"A browser could not upload straight to the bucket and fell back to the app. ..."}
```

`/api/ready` reads the bucket's rules too, with presigned uploads on, and
reports `presigned-cors` under `degraded` when no rule would let a browser at
`ANONIFY_PUBLIC_URL` make the PUT. It stays 200: the replica works, through
the fallback. The warning names what is missing, for example
`The CORS rule for https://redact.example.org does not allow PUT.` The rules
are read again every five minutes. Where they cannot be read (a service without
the API, or credentials without permission to read them, which is how a
least-privilege key should be), the check passes and logs a note once; the
fallback log is then the signal.

#### CORS, per provider

Every example allows `https://redact.example.org`; use your
`ANONIFY_PUBLIC_URL`'s origin, scheme and port included, with no path. `GET`
is not needed: downloads go through the app.

| Provider | Where the rule lives | Headers to allow | Readiness reads it |
| --- | --- | --- | --- |
| AWS S3 | the bucket | `content-type` | yes (`s3:GetBucketCORS`) |
| Cloudflare R2 | the bucket | `content-type` | through its S3 API, where offered |
| Google Cloud Storage (interop) | the bucket, set with `gcloud` | `content-type` | no: GCS answers in its own format, so the check is skipped |
| RustFS | the bucket | `content-type` | yes |
| Azure Blob Storage | the account's blob service | `content-type`, `x-ms-blob-type` | yes, with a key or a role that may read service properties |

**AWS S3**, and any S3 API that takes `PutBucketCors`, with `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://redact.example.org"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

```sh
aws s3api put-bucket-cors --bucket anonify --cors-configuration file://cors.json
```

**Cloudflare R2**: the same file through R2's S3 endpoint.

```sh
aws s3api put-bucket-cors --bucket anonify --cors-configuration file://cors.json \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

**Google Cloud Storage** through the interoperability (HMAC) API: CORS is set
with `gcloud`, in its own format, as `gcs-cors.json`:

```json
[
  {
    "origin": ["https://redact.example.org"],
    "method": ["PUT"],
    "responseHeader": ["content-type"],
    "maxAgeSeconds": 3600
  }
]
```

```sh
gcloud storage buckets update gs://anonify --cors-file=gcs-cors.json
```

**RustFS** takes the AWS file and command, at its own endpoint. For the
Compose stack opened at `http://localhost:3000`, the origin is that:

```sh
aws s3api put-bucket-cors --bucket anonify --cors-configuration file://cors.json   --endpoint-url http://localhost:9000
```

Then set `S3_PRESIGNED_UPLOADS=true` in `.env` and recreate the app
(`docker compose up -d app`). `S3_PUBLIC_ENDPOINT` already defaults to the
published port.

**Azure Blob Storage**: CORS is a property of the account's blob service, not
of a container.

```sh
az storage cors add --services b --account-name anonifyprod \
  --methods PUT --origins https://redact.example.org \
  --allowed-headers content-type x-ms-blob-type --max-age 3600
```

A page that cannot seal (see *Sealed uploads*) uploads through the app either
way.

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

### Sealed uploads

`lib/storage/upload-encryption.ts` (server), `lib/storage/chunked-web.ts`
(browser)

The upload is sealed in the browser in the same v1 envelope, under a key of
its own, so nothing lands in storage in the clear. The key's life:

1. **Reservation** (`POST /api/documents`, `POST /api/batches` with
   `"uploadEncryption": "v1"`) mints 32 random bytes. The row keeps them
   wrapped under the master key in `Document.uploadEncryptionKey` and
   records `uploadFormat: "v1"`. The raw key goes back in the response once,
   with the chunk shift to seal with.
2. **The browser** imports the key into WebCrypto as non-extractable, seals
   the file a `File.slice()` at a time, zeroes the decoded key bytes, and
   sends only the ciphertext. The logical key in the AAD is the reserved
   `pathname`, which is `uploadKey(id, name)`.
3. **Ingest** wraps the stored stream in a `ChunkOpener` bound to that
   logical key, taken from the row and never from the handle. Everything
   after it (sniff, hash, `putSealedStream(sourceKey, …)` under a fresh data
   key) is unchanged. Then it deletes the upload and nulls
   `uploadEncryptionKey`. A replay that finds the source already recorded
   finishes that cleanup if a crash interrupted it.
4. **An upload that does not open** is refused with `upload-unreadable`,
   which is not retryable, and nothing is stored as the source. That covers a
   failed tag, truncation, reordered chunks, a different key or path, a
   different chunk size, or plaintext sent where ciphertext was promised.
   The upload stays for the expiry sweep; it is ciphertext under a key that
   dies with the row.

It is a separate key rather than the document's data key because the data key
never leaves the server and is still minted at ingest, so `encryptionFormat`,
`documentSeal` and every object after ingest are untouched. The owner's
browser already holds the plaintext, so a key that protects only its own
transient upload discloses nothing new.

**The chunk size is fixed at 1 MiB** (`UPLOAD_CHUNK_SHIFT = 20`), whatever
`ANONIFY_ENCRYPTION_CHUNK_SIZE` says, and ingest refuses an upload that
declares any other size. A client therefore cannot make the opener buffer the
format's 16 MiB maximum, and every ceiling is exact: the ceiling is on the
plaintext everywhere, and a sealed upload of exactly `MAX_UPLOAD_BYTES` is
`sealedSizeOf(MAX_UPLOAD_BYTES, 1 MiB)` bytes on every path (the token's
`maximumSizeInBytes`, `/api/upload/local`, the presigned length, and ingest's
pre-check).

**Plaintext uploads.** A row with no `uploadFormat` is read as plaintext,
exactly as before. That covers documents reserved before this existed, API
clients that do not ask for a key, and pages that cannot seal. WebCrypto's
`subtle` exists only in a secure context (HTTPS or localhost), so the panel
asks for a key only when it can use one.
`ANONIFY_UPLOAD_ENCRYPTION=required` refuses reservations that do not ask for
a key. Leave it at `optional` (the default) until every client that talks to
the install seals, and until the install is served over HTTPS.

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
chunkBytes × maxInFlightChunks × jobConcurrency() <= memoryBudget
```

`jobConcurrency()` is the steps this process runs at once
(`lib/runtime/capacity.ts`), so the budget is per process (#181). It used to be
divided by the per-owner processing limit, which was the process's real
concurrency only while one owner was active. `ANONIFY_ENCRYPTION_CHUNK_SIZE`
(default `1MB`, a power of two between `64KB` and `16MB`) and
`ANONIFY_STREAM_MEMORY_BUDGET` (default 8 chunks per job for a demo, 16
self-hosted) configure it. A budget that cannot give every concurrent job two
chunks is refused at startup, from `instrumentation.ts`, rather than quietly
exceeded. See [deploy/capacity.md](./deploy/capacity.md).

---

## 9. Reading less than the whole object

The streaming budget bounds what is in flight; the readers built on it are what
keep it small. [streaming.md](./streaming.md) walks through each, with the
reasoning and the figures:

| Reader | Where | Holds |
| --- | --- | --- |
| page index over the normalized model | `lib/documents/normalized-json.ts`, `normalized-store.ts` | one page, or a page and a chunk while streaming the rest |
| ranged zip reader | `lib/documents/ooxml/zip.ts` | the central directory and one entry's window; refuses any archive two zip parsers could read differently (`ZipFallback`) |
| chunk cache | `lib/storage/range-source.ts` | the last four chunks read, so small neighbouring reads cost one fetch |
| workbook, a sheet at a time | `lib/documents/xlsx/stream.ts` | shared strings, styles, and one worksheet |
| PDF range transport | `lib/documents/pdf/render.ts` | what pdf.js asks for |
| forward MIME scan | `lib/documents/eml/scan.ts` | header blocks and text parts, never attachments |
| verified download | `lib/storage/integrity.ts` (`ChecksumVerifier`) | one piece, held until the checksum matches |
