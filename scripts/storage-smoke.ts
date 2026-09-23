import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import {
  chunkOffset,
  openChunkedRange,
  parseHeader,
  plaintextSizeOf,
  sealChunked,
  sealedRangeFor,
} from "@/lib/storage/chunked"
import { createS3Driver } from "@/lib/storage/drivers"

const endpoint =
  process.argv[2] ?? process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000"
const bucket = process.env.S3_BUCKET ?? "anonify"
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "anonify"
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "anonify-dev-secret"
const region = process.env.S3_REGION ?? "us-east-1"
const key = `storage-smoke/${Date.now()}-${randomBytes(6).toString("hex")}.txt`
const payload = Buffer.from("Anonify RustFS S3 integration check\n")

const client = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
})

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }))

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: "text/plain; charset=utf-8",
        Metadata: { check: "rustfs" },
      })
    )

    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    )
    assert(
      head.ContentLength === payload.byteLength,
      "HEAD returned the wrong object size"
    )
    assert(
      head.ContentType === "text/plain; charset=utf-8",
      "HEAD lost the content type"
    )
    assert(head.Metadata?.check === "rustfs", "HEAD lost custom metadata")

    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    )
    assert(object.Body, "GET returned no body")
    const downloaded = Buffer.from(await object.Body.transformToByteArray())
    assert(downloaded.equals(payload), "GET returned different bytes")

    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: key })
    )
    assert(
      listed.Contents?.some((item) => item.Key === key),
      "LIST did not return the object"
    )

    const signedUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 60 }
    )
    const signedResponse = await fetch(signedUrl)
    assert(
      signedResponse.ok,
      `Presigned GET returned HTTP ${signedResponse.status}`
    )
    const signedBytes = Buffer.from(await signedResponse.arrayBuffer())
    assert(
      signedBytes.equals(payload),
      "Presigned GET returned different bytes"
    )
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  }

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    throw new Error("DELETE left the object accessible")
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode
    assert(
      status === 404,
      `HEAD after DELETE returned HTTP ${status ?? "unknown"}`
    )
  }

  await streamingChecks()

  console.log(`RustFS S3 smoke passed against ${endpoint}/${bucket}`)
}

/**
 * The streaming half of the driver, against a real S3 implementation.
 *
 * A multipart upload large enough to need more than one part, a ranged GET
 * that the server must honour rather than answering with the whole object,
 * and a chunked-envelope object opened by range — the read the mailbox
 * expansion makes once per message.
 */
async function streamingChecks(): Promise<void> {
  const driver = createS3Driver({
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  })
  const name = `storage-smoke/${Date.now()}-${randomBytes(6).toString("hex")}.bin`
  // Past the 5 MiB minimum part, so the upload is genuinely multipart.
  const large = randomBytes(12 * 1024 * 1024 + 123)

  let stored: { key: string; size: number } | null = null
  try {
    async function* pieces(): AsyncGenerator<Buffer> {
      for (let at = 0; at < large.byteLength; at += 256 * 1024) {
        yield large.subarray(at, at + 256 * 1024)
      }
    }
    stored = await driver.putStream(name, Readable.from(pieces()))
    assert(
      stored.size === large.byteLength,
      "putStream reported the wrong size"
    )
    assert(
      (await driver.size(stored.key)) === large.byteLength,
      "size() disagrees with what was written"
    )

    const downloaded: Buffer[] = []
    for await (const piece of await driver.getStream(stored.key)) {
      downloaded.push(piece as Buffer)
    }
    assert(
      Buffer.concat(downloaded).equals(large),
      "getStream returned different bytes"
    )

    const start = 5 * 1024 * 1024 - 7
    const range = await driver.getRange(stored.key, start, start + 4096)
    assert(
      range.equals(large.subarray(start, start + 4096)),
      "getRange returned different bytes"
    )

    // The driver would quietly slice a whole-object answer, which is correct
    // and would make every ranged read a full download. Asked directly, so a
    // server that ignores ranges is a failure here rather than a slowdown.
    const ranged = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: stored.key.replace(/^s3:/, ""),
        Range: `bytes=${start}-${start + 4095}`,
      })
    )
    assert(ranged.ContentRange, "the server ignored a Range request")
    const rangedBytes = await ranged.Body?.transformToByteArray()
    assert(
      rangedBytes?.byteLength === 4096,
      "the server answered a range with the wrong length"
    )
  } finally {
    if (stored) await driver.delete(stored.key)
  }

  // A chunked-envelope object, opened one range at a time.
  const key = randomBytes(32)
  const logical = "documents/smoke/source.bin"
  const plaintext = randomBytes(3 * 1024 * 1024 + 11)
  const sealedName = `storage-smoke/${Date.now()}-${randomBytes(6).toString("hex")}.bin`
  const sealedObject = await driver.put(
    sealedName,
    sealChunked(plaintext, key, logical, 20)
  )
  try {
    const header = parseHeader(await driver.getRange(sealedObject.key, 0, 16))
    const size = plaintextSizeOf(
      await driver.size(sealedObject.key),
      header.chunkSize
    )
    assert(
      size === plaintext.byteLength,
      "chunked size arithmetic disagrees with the store"
    )

    const start = header.chunkSize - 100
    const end = 2 * header.chunkSize + 100
    const covering = sealedRangeFor(start, end, size, header.chunkSize)
    assert(
      covering.start === chunkOffset(0, header.chunkSize),
      "range covers the wrong chunks"
    )
    const opened = openChunkedRange({
      header,
      key,
      logicalKey: logical,
      plaintextSize: size,
      start,
      end,
      sealed: await driver.getRange(
        sealedObject.key,
        covering.start,
        covering.end
      ),
    })
    assert(
      opened.equals(plaintext.subarray(start, end)),
      "chunked range opened to different bytes"
    )
  } finally {
    await driver.delete(sealedObject.key)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
