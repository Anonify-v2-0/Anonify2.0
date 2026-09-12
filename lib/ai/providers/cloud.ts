import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock"
import { providerId, type ProviderEnv } from "./config"
import { DiscoveryError, parseModel, readModelJson, type ModelDefinition } from "./discovery"

export function bedrockClient(env: ProviderEnv): BedrockClient {
  return new BedrockClient({ region: env.AWS_REGION, profile: env.AWS_PROFILE || undefined,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN,
    } } : {}), maxAttempts: 1 })
}

export async function discoverCloudModels(env: ProviderEnv, fetcher: typeof fetch): Promise<ModelDefinition[]> {
  const provider = providerId(env)
  if (provider === "amazon-bedrock") {
    const client = bedrockClient(env)
    try {
      const result = await client.send(new ListFoundationModelsCommand({}), { abortSignal: AbortSignal.timeout(15_000) })
      const models: ModelDefinition[] = (result.modelSummaries ?? []).map((row) => ({
        id: row.modelId!, label: row.modelId!, textOutput: row.outputModalities?.includes("TEXT"),
        vision: row.inputModalities?.includes("IMAGE"),
        unavailable: row.modelLifecycle?.status === "LEGACY" ? "Legacy model" :
          !row.inferenceTypesSupported?.includes("ON_DEMAND") ? "Requires provisioned throughput or an inference profile" : undefined,
      })).filter((model) => model.id)
      let nextToken: string | undefined
      const seen = new Set<string>()
      do {
        const page = await client.send(new ListInferenceProfilesCommand({ nextToken }), { abortSignal: AbortSignal.timeout(15_000) })
        for (const row of page.inferenceProfileSummaries ?? []) {
          if (row.inferenceProfileId) models.push({ id: row.inferenceProfileId, label: row.inferenceProfileName || row.inferenceProfileId,
            unavailable: row.status !== "ACTIVE" ? "Inactive inference profile" : undefined })
        }
        nextToken = page.nextToken
        if (nextToken && (seen.has(nextToken) || seen.size >= 100)) throw new Error("pagination")
        if (nextToken) seen.add(nextToken)
      } while (nextToken)
      return models
    } catch { throw new DiscoveryError("Bedrock discovery failed. Check AWS region, credentials, ListFoundationModels and ListInferenceProfiles permissions; a runtime-only key can still verify a typed model ID.") }
    finally { client.destroy() }
  }

  let next: string
  let headers: Record<string, string>
  if (provider === "azure") {
    if (!env.AZURE_SUBSCRIPTION_ID || !env.AZURE_RESOURCE_GROUP || !env.AZURE_RESOURCE_NAME) {
      throw new DiscoveryError("Deployment discovery needs AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP and AZURE_RESOURCE_NAME. A deployment ID can also be entered and verified directly.")
    }
    const { DefaultAzureCredential } = await import("@azure/identity")
    try {
      const token = await new DefaultAzureCredential().getToken("https://management.azure.com/.default", { abortSignal: AbortSignal.timeout(15_000) })
      headers = { Authorization: `Bearer ${token.token}` }
    } catch { throw new DiscoveryError("Azure discovery needs an Azure CLI login, managed identity or service principal with permission to list deployments.") }
    next = `https://management.azure.com/subscriptions/${encodeURIComponent(env.AZURE_SUBSCRIPTION_ID)}/resourceGroups/${encodeURIComponent(env.AZURE_RESOURCE_GROUP)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(env.AZURE_RESOURCE_NAME)}/deployments?api-version=2024-10-01`
  } else {
    const { GoogleAuth } = await import("google-auth-library")
    try {
      const token = await new GoogleAuth({ keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS || undefined, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getAccessToken()
      if (!token) throw new Error("no token")
      headers = { Authorization: `Bearer ${token}` }
    } catch { throw new DiscoveryError("Vertex model discovery needs Google Application Default Credentials with Model Garden access.") }
    next = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models"
  }
  const initial = next
  const models: ModelDefinition[] = []
  const seen = new Set<string>()
  while (next) {
    if (new URL(next).origin !== new URL(initial).origin || seen.has(next) || seen.size >= 100) throw new DiscoveryError("Invalid model-list pagination.")
    seen.add(next)
    const page = await readModelJson(next, { headers }, fetcher) as Record<string, unknown>
    const rows = page.value ?? page.publisherModels
    if (!Array.isArray(rows)) throw new DiscoveryError("The cloud provider did not return a model list.")
    for (const row of rows) {
      const model = parseModel(provider, row)
      if (!model) continue
      if (provider === "azure" && row.properties?.provisioningState !== "Succeeded") model.unavailable = "Deployment is not ready"
      if (provider === "google-vertex" && !model.id.startsWith("gemini-")) model.unavailable = "This Vertex adapter uses Gemini generateContent models"
      models.push(model)
    }
    if (typeof page.nextLink === "string" && page.nextLink) next = page.nextLink
    else if (typeof page.nextPageToken === "string" && page.nextPageToken) {
      const url = new URL(initial); url.searchParams.set("pageToken", page.nextPageToken); next = url.toString()
    } else next = ""
  }
  return models
}
