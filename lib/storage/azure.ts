import type { Readable } from "node:stream"

import type {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob"

import { CorsRefusal, corsRefusal } from "@/lib/storage/cors"
import type { PresignedUpload, StorageDriver } from "@/lib/storage/drivers"
import {
  assertRange,
  counted,
  deleteEach,
  isMissingObject,
  sliceIfWhole,
} from "@/lib/storage/driver-utils"
import {
  perDocumentStreamBytes,
  streamingLimits,
} from "@/lib/storage/streaming"

/**
 * Azure Blob Storage (#176).
 *
 * Azure does not speak the S3 API, so an Azure deployment used to need an S3
 * gateway in front of it: one more service to run, secure and scale. This is
 * the same `StorageDriver` over the official SDK, imported lazily like the S3
 * client, so a deployment that never uses it does not load it.
 *
 * Authentication, first match wins:
 *
 * 1. `AZURE_STORAGE_CONNECTION_STRING`.
 * 2. `AZURE_STORAGE_ACCOUNT` with `AZURE_STORAGE_ACCOUNT_KEY`.
 * 3. `AZURE_STORAGE_ACCOUNT` alone: `DefaultAzureCredential`, which is a
 *    managed identity on Container Apps and workload identity on AKS. No
 *    secret anywhere, and the recommended path in production.
 *
 * Keys are stored as `azure:<path>` handles, so the driver is chosen per key
 * on read, as for the others.
 */

export const AZURE_PREFIX = "azure:"

export type AzureAuth =
  | { kind: "connection-string"; connectionString: string }
  | { kind: "account-key"; accountKey: string }
  | { kind: "default-credential" }

export type AzureConfig = {
  /** Absent only with a connection string, which names its own account. */
  account?: string
  container: string
  auth: AzureAuth
  /** Overrides `https://<account>.blob.core.windows.net`: Azurite, sovereign clouds. */
  endpoint?: string
  /** Browsers PUT straight to the container with a SAS. Needs CORS on the account. */
  presignedUploads: boolean
  /** The endpoint as a browser reaches it, when that differs from the server's. */
  publicEndpoint?: string
}

type Env = Record<string, string | undefined>

function url(name: string, raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http")
    }
  } catch {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`)
  }
  return value.replace(/\/+$/, "")
}

/**
 * The Azure configuration, or null when there is none. Something configured
 * but incomplete is an error naming what is missing.
 */
export function azureConfigFromEnv(env: Env = process.env): AzureConfig | null {
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING?.trim()
  const account = env.AZURE_STORAGE_ACCOUNT?.trim() || undefined
  const container = env.AZURE_STORAGE_CONTAINER?.trim()
  const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY?.trim()

  if (!connectionString && !account && !container) return null
  if (!container) {
    throw new Error("Azure Blob Storage needs AZURE_STORAGE_CONTAINER.")
  }
  if (!connectionString && !account) {
    throw new Error(
      "Azure Blob Storage needs AZURE_STORAGE_ACCOUNT, or AZURE_STORAGE_CONNECTION_STRING."
    )
  }

  const auth: AzureAuth = connectionString
    ? { kind: "connection-string", connectionString }
    : accountKey
      ? { kind: "account-key", accountKey }
      : { kind: "default-credential" }

  return {
    account,
    container,
    auth,
    endpoint: url("AZURE_STORAGE_ENDPOINT", env.AZURE_STORAGE_ENDPOINT),
    presignedUploads:
      env.AZURE_STORAGE_PRESIGNED_UPLOADS?.trim().toLowerCase() === "true",
    publicEndpoint: url(
      "AZURE_STORAGE_PUBLIC_ENDPOINT",
      env.AZURE_STORAGE_PUBLIC_ENDPOINT
    ),
  }
}

/** Whether the environment configures Azure at all, for driver inference. */
export function azureConfigured(env: Env = process.env): boolean {
  return Boolean(
    env.AZURE_STORAGE_CONTAINER?.trim() &&
    (env.AZURE_STORAGE_ACCOUNT?.trim() ||
      env.AZURE_STORAGE_CONNECTION_STRING?.trim())
  )
}

function blobPath(key: string): string {
  return key.startsWith(AZURE_PREFIX) ? key.slice(AZURE_PREFIX.length) : key
}

/** How long a SAS upload may be *started* within, as for S3. */
const PRESIGNED_UPLOAD_SECONDS = 15 * 60

/** Sub-requests one batch call may carry. */
const BATCH_LIMIT = 256

type Connection = {
  service: BlobServiceClient
  container: ContainerClient
  sharedKey?: StorageSharedKeyCredential
  account: string
}

async function connect(config: AzureConfig): Promise<Connection> {
  const sdk = await import("@azure/storage-blob")

  if (config.auth.kind === "connection-string") {
    const service = sdk.BlobServiceClient.fromConnectionString(
      config.auth.connectionString
    )
    const sharedKey =
      service.credential instanceof sdk.StorageSharedKeyCredential
        ? service.credential
        : undefined
    return {
      service,
      container: service.getContainerClient(config.container),
      sharedKey,
      account: service.accountName,
    }
  }

  const account = config.account as string
  const endpoint = config.endpoint ?? `https://${account}.blob.core.windows.net`

  if (config.auth.kind === "account-key") {
    const sharedKey = new sdk.StorageSharedKeyCredential(
      account,
      config.auth.accountKey
    )
    const service = new sdk.BlobServiceClient(endpoint, sharedKey)
    return {
      service,
      container: service.getContainerClient(config.container),
      sharedKey,
      account,
    }
  }

  const { DefaultAzureCredential } = await import("@azure/identity")
  const service = new sdk.BlobServiceClient(
    endpoint,
    new DefaultAzureCredential()
  )
  return {
    service,
    container: service.getContainerClient(config.container),
    account,
  }
}

async function readAll(
  stream: NodeJS.ReadableStream | undefined
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export function createAzureDriver(config: AzureConfig): StorageDriver {
  const connection = connect(config)
  // A rejected connection is reported by whichever call awaits it.
  connection.catch(() => {})

  const blob = async (key: string) =>
    (await connection).container.getBlockBlobClient(blobPath(key))

  const driver: StorageDriver = {
    name: "azure-blob",
    // The browser flow is the same as S3's: PUT the sealed bytes to a URL the
    // server signed, with the headers it names.
    clientUpload: config.presignedUploads ? "s3-presigned" : "server-route",

    async presignUpload(key: string): Promise<PresignedUpload> {
      const sdk = await import("@azure/storage-blob")
      const { service, sharedKey, account } = await connection
      const startsOn = new Date(Date.now() - 5 * 60 * 1000)
      const expiresOn = new Date(Date.now() + PRESIGNED_UPLOAD_SECONDS * 1000)
      const values = {
        containerName: config.container,
        blobName: blobPath(key),
        // Create and write this one blob, and nothing else.
        permissions: sdk.BlobSASPermissions.parse("cw"),
        startsOn,
        expiresOn,
      }
      // A SAS cannot sign a length the way S3 signs Content-Length, so the
      // size the browser declared is not enforced here. Ingest holds it: it
      // refuses an upload whose stored size is not the size reserved
      // (lib/documents/ingest.ts), and the reservation was checked against
      // the ceiling. See docs/storage.md.
      const sas = sharedKey
        ? sdk.generateBlobSASQueryParameters(values, sharedKey)
        : sdk.generateBlobSASQueryParameters(
            values,
            await service.getUserDelegationKey(startsOn, expiresOn),
            account
          )

      const blobUrl = new URL(
        (await connection).container.getBlockBlobClient(blobPath(key)).url
      )
      if (config.publicEndpoint) {
        const target = new URL(config.publicEndpoint)
        blobUrl.protocol = target.protocol
        blobUrl.host = target.host
      }
      blobUrl.search = sas.toString()

      const contentType = "application/octet-stream"
      return {
        url: blobUrl.toString(),
        headers: { "content-type": contentType, "x-ms-blob-type": "BlockBlob" },
        handle: `${AZURE_PREFIX}${key}`,
        expiresAt: expiresOn,
      }
    },

    async put(key, data) {
      await (
        await blob(key)
      ).uploadData(Buffer.from(data), {
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      })
      return { key: `${AZURE_PREFIX}${key}`, size: data.byteLength }
    },

    async get(key) {
      return (await blob(key)).downloadToBuffer()
    },

    async getStream(key) {
      const response = await (await blob(key)).download(0)
      if (!response.readableStreamBody) {
        throw new Error(`Stored object is empty: ${key}`)
      }
      return response.readableStreamBody as unknown as Readable
    },

    async getRange(key, start, end) {
      assertRange(start, end)
      if (end === start) return Buffer.alloc(0)
      // Offset and count, where every range here is half-open.
      const response = await (await blob(key)).download(start, end - start)
      const bytes = await readAll(response.readableStreamBody)
      return sliceIfWhole(bytes, Boolean(response.contentRange), start, end)
    },

    async putStream(key, body) {
      // Blocks of the streaming chunk size, and as many in flight as this
      // document's share of the streaming budget holds, as for S3.
      const bufferSize = streamingLimits().chunkBytes
      const concurrency = Math.max(
        1,
        Math.floor(perDocumentStreamBytes() / bufferSize)
      )
      const counter = counted(body)
      await (
        await blob(key)
      ).uploadStream(counter, bufferSize, concurrency, {
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      })
      return { key: `${AZURE_PREFIX}${key}`, size: counter.bytes }
    },

    async size(key) {
      const properties = await (await blob(key)).getProperties()
      if (typeof properties.contentLength !== "number") {
        throw new Error(`Stored object has no length: ${key}`)
      }
      return properties.contentLength
    },

    async delete(key) {
      await (await blob(key)).deleteIfExists()
    },

    async deleteMany(keys) {
      const { container } = await connection
      const failed: string[] = []
      for (let i = 0; i < keys.length; i += BATCH_LIMIT) {
        const batch = keys.slice(i, i + BATCH_LIMIT)
        try {
          const result = await container
            .getBlobBatchClient()
            .deleteBlobs(
              batch.map((key) => container.getBlobClient(blobPath(key)))
            )
          // One sub-response per key, in the order they were sent. A blob
          // that was already gone is a delete that succeeded.
          result.subResponses.forEach((answer, index) => {
            if (answer.status >= 300 && answer.status !== 404) {
              failed.push(batch[index])
            }
          })
        } catch (error) {
          // A batch the account refused as a whole: one key at a time.
          if (isMissingObject(error)) continue
          failed.push(...(await deleteEach(driver, batch)).failed)
        }
      }
      return { failed }
    },

    async exists(key) {
      try {
        return await (await blob(key)).exists()
      } catch {
        return false
      }
    },

    async probe() {
      await (await connection).container.getProperties()
    },

    // CORS is a property of the account's blob service, not the container.
    async probeUploadCors(origin) {
      let properties
      try {
        properties = await (await connection).service.getProperties()
      } catch (error) {
        // An identity with data access only, or Azurite's older versions.
        const status = (error as { statusCode?: number }).statusCode
        if (status === 403 || status === 501) return "unreadable"
        throw error
      }
      const split = (list: string | undefined) =>
        (list ?? "").split(",").filter((item) => item.trim())
      const refusal = corsRefusal(
        (properties.cors ?? []).map((rule) => ({
          origins: split(rule.allowedOrigins),
          methods: split(rule.allowedMethods),
          headers: split(rule.allowedHeaders),
        })),
        origin,
        ["content-type", "x-ms-blob-type"]
      )
      if (refusal) throw new CorsRefusal(refusal)
      return "allowed"
    },
  }

  return driver
}
