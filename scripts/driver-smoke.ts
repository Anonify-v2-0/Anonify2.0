/**
 * Exercises the configured storage driver through the interface the app uses.
 *
 *   STORAGE_DRIVER=azure-blob AZURE_STORAGE_CONNECTION_STRING=… \
 *     AZURE_STORAGE_CONTAINER=anonify pnpm smoke:driver --create-container
 *
 * `pnpm smoke:storage` checks an S3 service with the AWS SDK directly. This
 * checks whichever driver is selected, the way the app calls it: probe, put
 * and get, a stream in and out, ranged reads, size and existence, a browser
 * upload through the presigned URL when the driver hands them out, and bulk
 * deletes. CI runs it against Azurite (#176).
 *
 * `--create-container` creates the Azure container first, for an emulator
 * that starts empty. A real deployment's container is the operator's to make.
 */
import "dotenv/config"

import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import { azureConfigFromEnv } from "@/lib/storage/azure"
import { selectStorageDriver } from "@/lib/storage/drivers"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function createContainer(): Promise<void> {
  const config = azureConfigFromEnv()
  assert(config, "--create-container needs an Azure configuration")
  const sdk = await import("@azure/storage-blob")
  assert(
    config.auth.kind !== "default-credential",
    "--create-container needs a connection string or an account key"
  )
  const service =
    config.auth.kind === "connection-string"
      ? sdk.BlobServiceClient.fromConnectionString(config.auth.connectionString)
      : new sdk.BlobServiceClient(
          config.endpoint ?? `https://${config.account}.blob.core.windows.net`,
          new sdk.StorageSharedKeyCredential(
            config.account as string,
            config.auth.accountKey
          )
        )
  await service.getContainerClient(config.container).createIfNotExists()
}

async function main(): Promise<void> {
  if (process.argv.includes("--create-container")) await createContainer()

  const driver = selectStorageDriver()
  const prefix = `driver-smoke/${Date.now()}-${randomBytes(4).toString("hex")}`
  const written: string[] = []
  console.log(`\n  Driver: ${driver.name}\n`)

  await driver.probe()
  console.log("  ✓ probe")

  try {
    // put, get, size, exists
    const small = randomBytes(1000)
    const put = await driver.put(`${prefix}/small.bin`, small)
    written.push(put.key)
    assert(put.size === small.byteLength, "put reported the wrong size")
    assert(
      (await driver.get(put.key)).equals(small),
      "get returned other bytes"
    )
    assert((await driver.size(put.key)) === small.byteLength, "size is wrong")
    assert(await driver.exists(put.key), "exists is false for a written object")
    console.log("  ✓ put, get, size, exists")

    // A stream in several blocks, and back out as a stream.
    const large = randomBytes(3 * 1024 * 1024 + 4321)
    const streamed = await driver.putStream(
      `${prefix}/large.bin`,
      Readable.from(
        (function* () {
          for (let at = 0; at < large.byteLength; at += 256 * 1024) {
            yield large.subarray(at, at + 256 * 1024)
          }
        })()
      )
    )
    written.push(streamed.key)
    assert(streamed.size === large.byteLength, "putStream counted wrong")
    const back = await readAll(await driver.getStream(streamed.key))
    assert(back.equals(large), "getStream returned other bytes")
    console.log("  ✓ putStream, getStream")

    // Ranged reads, half-open: the middle, the tail, and nothing.
    const middle = await driver.getRange(streamed.key, 1_000_000, 1_000_123)
    assert(
      middle.equals(large.subarray(1_000_000, 1_000_123)),
      "middle range is wrong"
    )
    const tail = await driver.getRange(
      streamed.key,
      large.byteLength - 7,
      large.byteLength
    )
    assert(
      tail.equals(large.subarray(large.byteLength - 7)),
      "tail range is wrong"
    )
    assert(
      (await driver.getRange(streamed.key, 5, 5)).byteLength === 0,
      "empty range is not empty"
    )
    console.log("  ✓ getRange")

    // A browser upload, through the URL the driver signs.
    if (driver.presignUpload && driver.clientUpload === "s3-presigned") {
      const body = randomBytes(2048)
      const presigned = await driver.presignUpload(
        `${prefix}/browser.bin`,
        body.byteLength
      )
      const response = await fetch(presigned.url, {
        method: "PUT",
        headers: presigned.headers,
        body,
      })
      assert(response.ok, `presigned PUT answered ${response.status}`)
      written.push(presigned.handle)
      assert(
        (await driver.get(presigned.handle)).equals(body),
        "presigned upload stored other bytes"
      )
      assert(
        (await driver.size(presigned.handle)) === body.byteLength,
        "presigned upload has the wrong size"
      )
      console.log("  ✓ presigned upload")
    } else {
      console.log("  - presigned upload (not enabled for this driver)")
    }

    // Bulk delete, with one key that never existed: that is not a failure.
    const missing = `${put.key.slice(0, put.key.lastIndexOf("/"))}/never-written.bin`
    const { failed } = await driver.deleteMany([...written, missing])
    assert(failed.length === 0, `deleteMany failed for ${failed.join(", ")}`)
    for (const key of written) {
      assert(!(await driver.exists(key)), `${key} survived deleteMany`)
    }
    written.length = 0
    console.log("  ✓ deleteMany")

    // A single delete of something already gone succeeds.
    await driver.delete(put.key)
    console.log("  ✓ delete\n")
  } finally {
    if (written.length > 0) await driver.deleteMany(written)
  }
}

main().catch((error: unknown) => {
  console.error(
    `\n  Driver smoke failed: ${error instanceof Error ? error.message : error}\n`
  )
  process.exitCode = 1
})
