import { randomBytes } from "node:crypto"

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

  console.log(`RustFS S3 smoke passed against ${endpoint}/${bucket}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
