import { afterEach, describe, expect, it, vi } from "vitest"

import { azureConfigFromEnv, azureConfigured } from "@/lib/storage/azure"
import { driverForKey, selectStorageDriver } from "@/lib/storage/drivers"

/**
 * Azure Blob Storage's configuration (#176): which credential is used, what
 * is required, and where it sits among the other backends.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

const ACCOUNT = {
  AZURE_STORAGE_ACCOUNT: "anonifyprod",
  AZURE_STORAGE_CONTAINER: "documents",
}

describe("azureConfigFromEnv", () => {
  it("is null when nothing Azure is set", () => {
    expect(azureConfigFromEnv({})).toBeNull()
    expect(azureConfigured({})).toBe(false)
  })

  it("prefers a connection string, then an account key, then the default credential", () => {
    expect(
      azureConfigFromEnv({
        ...ACCOUNT,
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=a2V5",
        AZURE_STORAGE_ACCOUNT_KEY: "key",
      })?.auth.kind
    ).toBe("connection-string")
    expect(
      azureConfigFromEnv({ ...ACCOUNT, AZURE_STORAGE_ACCOUNT_KEY: "key" })?.auth
    ).toEqual({ kind: "account-key", accountKey: "key" })
    // No secret at all: a managed identity, which is the production path.
    expect(azureConfigFromEnv(ACCOUNT)?.auth).toEqual({
      kind: "default-credential",
    })
  })

  it("names what is missing", () => {
    expect(() => azureConfigFromEnv({ AZURE_STORAGE_ACCOUNT: "a" })).toThrow(
      /AZURE_STORAGE_CONTAINER/
    )
    expect(() => azureConfigFromEnv({ AZURE_STORAGE_CONTAINER: "c" })).toThrow(
      /AZURE_STORAGE_ACCOUNT, or AZURE_STORAGE_CONNECTION_STRING/
    )
  })

  it("takes an endpoint override, and refuses one that is not a URL", () => {
    expect(
      azureConfigFromEnv({
        ...ACCOUNT,
        AZURE_STORAGE_ENDPOINT: "http://127.0.0.1:10000/devstoreaccount1/",
      })?.endpoint
    ).toBe("http://127.0.0.1:10000/devstoreaccount1")
    expect(() =>
      azureConfigFromEnv({
        ...ACCOUNT,
        AZURE_STORAGE_ENDPOINT: "azurite:10000",
      })
    ).toThrow(/AZURE_STORAGE_ENDPOINT must be an http\(s\) URL/)
    expect(() =>
      azureConfigFromEnv({
        ...ACCOUNT,
        AZURE_STORAGE_PUBLIC_ENDPOINT: "ftp://x",
      })
    ).toThrow(/AZURE_STORAGE_PUBLIC_ENDPOINT/)
  })

  it("hands out browser uploads only when asked", () => {
    expect(azureConfigFromEnv(ACCOUNT)?.presignedUploads).toBe(false)
    expect(
      azureConfigFromEnv({
        ...ACCOUNT,
        AZURE_STORAGE_PRESIGNED_UPLOADS: "TRUE",
      })?.presignedUploads
    ).toBe(true)
  })
})

describe("choosing Azure", () => {
  function clearStorageEnv() {
    for (const name of [
      "STORAGE_DRIVER",
      "BLOB_READ_WRITE_TOKEN",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURE_STORAGE_ACCOUNT",
      "AZURE_STORAGE_ACCOUNT_KEY",
      "AZURE_STORAGE_CONTAINER",
      "VERCEL",
    ]) {
      vi.stubEnv(name, "")
    }
  }

  it("is selected by STORAGE_DRIVER=azure-blob, and refused without its settings", () => {
    clearStorageEnv()
    vi.stubEnv("STORAGE_DRIVER", "azure-blob")
    expect(() => selectStorageDriver()).toThrow(/AZURE_STORAGE_CONTAINER/)

    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "anonifyprod")
    vi.stubEnv("AZURE_STORAGE_CONTAINER", "documents")
    expect(selectStorageDriver().name).toBe("azure-blob")
  })

  it("is inferred when configured, after S3, and before the local disk", () => {
    clearStorageEnv()
    expect(selectStorageDriver().name).toBe("local")

    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "anonifyprod")
    vi.stubEnv("AZURE_STORAGE_CONTAINER", "documents")
    expect(selectStorageDriver().name).toBe("azure-blob")

    vi.stubEnv("S3_BUCKET", "b")
    vi.stubEnv("S3_ACCESS_KEY_ID", "k")
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "s")
    expect(selectStorageDriver().name).toBe("s3")
  })

  it("reads an azure: handle with Azure whatever new objects are written with", () => {
    clearStorageEnv()
    expect(() => driverForKey("azure:documents/a/source.bin")).toThrow(
      /stored in Azure Blob Storage, but Azure is no longer configured/
    )
    vi.stubEnv("AZURE_STORAGE_ACCOUNT", "anonifyprod")
    vi.stubEnv("AZURE_STORAGE_CONTAINER", "documents")
    expect(driverForKey("azure:documents/a/source.bin").name).toBe("azure-blob")
    expect(driverForKey("local:documents/a/source.bin").name).toBe("local")
  })
})
