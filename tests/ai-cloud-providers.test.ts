import { afterEach, describe, expect, it, vi } from "vitest"
import { discoverCloudModels } from "@/lib/ai/providers/cloud"

const { send, destroy, token } = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
  token: vi.fn(),
}))
vi.mock("@aws-sdk/client-bedrock", () => ({
  BedrockClient: class {
    send = send
    destroy = destroy
  },
  ListFoundationModelsCommand: class {
    constructor(readonly input: unknown) {}
  },
  ListInferenceProfilesCommand: class {
    constructor(readonly input: unknown) {}
  },
}))
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    getToken = token
  },
}))
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getAccessToken = token
  },
}))

afterEach(() => {
  vi.resetAllMocks()
})

describe("cloud account discovery", () => {
  it("lists Azure deployment names, paginates and disables unready deployments", async () => {
    token.mockResolvedValue({ token: "management-secret" })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              id: "/subscriptions/sub/resourceGroups/group/providers/Microsoft.CognitiveServices/accounts/resource/deployments/my-deployment",
              name: "my-deployment",
              properties: { provisioningState: "Succeeded" },
            },
          ],
          nextLink: "https://management.azure.com/next",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [
            { name: "pending", properties: { provisioningState: "Creating" } },
          ],
        })
      )
    const models = await discoverCloudModels(
      {
        AI_PROVIDER: "azure",
        AZURE_SUBSCRIPTION_ID: "sub",
        AZURE_RESOURCE_GROUP: "group",
        AZURE_RESOURCE_NAME: "resource",
      },
      fetcher
    )
    expect(models.map((model) => model.id)).toEqual([
      "my-deployment",
      "pending",
    ])
    expect(models[1].unavailable).toContain("not ready")
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/subscriptions/sub/resourceGroups/group/"
    )
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer management-secret",
    })
  })

  it("refuses Azure pagination to another origin before forwarding its credential", async () => {
    token.mockResolvedValue({ token: "management-secret" })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        value: [],
        nextLink: "https://untrusted.example/steal",
      })
    )
    await expect(
      discoverCloudModels(
        {
          AI_PROVIDER: "azure",
          AZURE_SUBSCRIPTION_ID: "sub",
          AZURE_RESOURCE_GROUP: "group",
          AZURE_RESOURCE_NAME: "resource",
        },
        fetcher
      )
    ).rejects.toThrow("pagination")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("lists Vertex publisher models across pages and limits this adapter to Gemini", async () => {
    token.mockResolvedValue("adc-secret")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          publisherModels: [
            { name: "publishers/google/models/gemini-fixture" },
          ],
          nextPageToken: "next",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          publisherModels: [{ name: "publishers/google/models/image-fixture" }],
        })
      )
    const models = await discoverCloudModels(
      { AI_PROVIDER: "google-vertex" },
      fetcher
    )
    expect(models[0].id).toBe("gemini-fixture")
    expect(models[1].unavailable).toContain("Gemini")
    expect(String(fetcher.mock.calls[1][0])).toContain("pageToken=next")
  })

  it("lists Bedrock foundation models and paginated cross-region inference profiles", async () => {
    send
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "vendor.vision",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "vendor.embed",
            inputModalities: ["TEXT"],
            outputModalities: ["EMBEDDING"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "vendor.provisioned",
            inferenceTypesSupported: ["PROVISIONED"],
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          { inferenceProfileId: "us.vendor.vision", status: "ACTIVE" },
        ],
        nextToken: "next",
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          { inferenceProfileId: "custom-profile", status: "ACTIVE" },
        ],
      })
    const models = await discoverCloudModels(
      { AI_PROVIDER: "amazon-bedrock", AWS_REGION: "us-east-1" },
      vi.fn()
    )
    expect(models).toHaveLength(5)
    expect(models[0].vision).toBe(true)
    expect(models[1].textOutput).toBe(false)
    expect(models[2].unavailable).toContain("provisioned")
    expect(send.mock.calls[2][0].input.nextToken).toBe("next")
    expect(destroy).toHaveBeenCalled()
  })

  it("contains credential-chain errors without printing the raw secret-bearing cause", async () => {
    send.mockRejectedValue(new Error("secret credential material"))
    await expect(
      discoverCloudModels({ AI_PROVIDER: "amazon-bedrock" }, vi.fn())
    ).rejects.toThrow("Bedrock discovery failed")
    token.mockRejectedValue(new Error("secret credential material"))
    await expect(
      discoverCloudModels({ AI_PROVIDER: "google-vertex" }, vi.fn())
    ).rejects.toThrow("Application Default Credentials")
  })
})
