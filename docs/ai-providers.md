# Configuring AI providers

Run `pnpm setup`. Choose the provider, supply its credential without terminal
echo, select a discovered model, and verify it before saving. Discovery and
verification happen only in the operator's CLI. They send no documents.
Verification makes two small synthetic requests and hosted providers may bill
them. A passing probe establishes API compatibility, not redaction quality.

An existing installation with no `AI_PROVIDER` continues using AI Gateway,
including its existing `AI_MODEL`, OIDC authentication and usage identifiers.
Without a Gateway credential, deterministic detection, manual redaction and
export still work. Other providers require an explicit model and the capability
declaration produced by setup. Changes to the model or destination invalidate
that declaration. Unverified or unsupported calls produce a visible degradation.

## Providers

Only the official SDK adapters below and Ollama are supported. Generic compatible
URLs, OpenRouter, Synthetic, LM Studio, llama.cpp and subscription/CLI OAuth are
outside this release. Audio, image-generation and embedding-only adapters cannot
perform Anonify's structured text analysis and are not provider choices.

| `AI_PROVIDER` | Credentials / configuration | Discovery |
| --- | --- | --- |
| `gateway` | `AI_GATEWAY_API_KEY` or Vercel OIDC | Gateway models |
| `openai` | `OPENAI_API_KEY` | Account models |
| `anthropic` | `ANTHROPIC_API_KEY` | Account models, paginated |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini models, paginated |
| `xai` | `XAI_API_KEY` | Provider models |
| `mistral` | `MISTRAL_API_KEY` (also used by OCR) | Models with capability metadata |
| `togetherai` | `TOGETHER_API_KEY` | Provider models |
| `cohere` | `COHERE_API_KEY` | Models and supported endpoints, paginated |
| `fireworks` | `FIREWORKS_API_KEY`, optional `FIREWORKS_ACCOUNT_ID` | Account models; defaults to the public `fireworks` catalog |
| `deepinfra` | `DEEPINFRA_API_KEY` | Provider models |
| `deepseek` | `DEEPSEEK_API_KEY` | Provider models |
| `cerebras` | `CEREBRAS_API_KEY` | Provider models |
| `groq` | `GROQ_API_KEY` | Provider models |
| `perplexity` | `PERPLEXITY_API_KEY` | Typed Sonar model ID and verification; its Agent API catalog is a different transport |
| `baseten` | `BASETEN_API_KEY` | Shared Model APIs catalog |
| `azure` | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME` | Actual Azure deployments, using management credentials |
| `amazon-bedrock` | `AWS_REGION`, AWS credentials/profile/role or runtime bearer key | Foundation models and inference profiles |
| `google-vertex` | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, ADC or express-mode key | Google publisher catalog; Gemini models enabled for this adapter |
| `ollama` | `OLLAMA_BASE_URL`, default `http://localhost:11434` | Installed models from `/api/tags` and `/api/show` |

Model lists are live, not a checked-in shortlist. They can include inaccessible,
non-text or unsupported models. Known incompatibilities appear disabled with a
reason. Missing capability metadata is labelled as unverified and requires a
successful probe before saving. Manual entry uses the same verification and
cannot bypass a known disabled model. If discovery fails, setup reports it and
offers a verified manual ID or keeps the current configuration. Ollama requires
an installed, inspected model from discovery, including for typed IDs.

Choose **Text and images** for the full model pass. **Text only** allows a model
that passes structured-output verification but cannot read images. OCR still
extracts text; image-region analysis is skipped and reported in the usage panel.
Models that fail structured output cannot be newly selected in either mode.

`--yes` and non-interactive setup stay offline: existing AI settings are
preserved, with no model discovery or billable probes. Run interactive setup
once to verify a new direct or local provider before using scripted setup.

## Local Ollama

Start Ollama and pull a model using its CLI before running `pnpm setup --local`.
On a fresh configuration, a responding Ollama server is offered as the default.
An existing hosted provider is never silently replaced. Ollama cloud models are
disabled: this integration is for installed local inference. The connection uses
Ollama's OpenAI-compatible structured-output endpoint through the official
`@ai-sdk/openai-compatible` adapter.

For the app in Docker, Compose maps `localhost`, `127.0.0.1` and `::1` Ollama
addresses to `host.docker.internal` at connection time. The same `.env` remains
usable with `pnpm dev` on the host. On Linux, Ollama must listen on an interface
reachable from Docker (configure `OLLAMA_HOST` in the Ollama service); restrict
access to the trusted machine/network. A hostname on another server is used as
given. A refused connection is reported without repeated retries.

## Cloud credentials

Azure inference uses the resource's API key and **deployment name** as `AI_MODEL`.
Dynamic deployment discovery additionally requires `AZURE_SUBSCRIPTION_ID` and
`AZURE_RESOURCE_GROUP`, and a management credential available through Azure's
default credential chain, such as `az login` or managed identity. A resource key
alone does not grant management access; a typed deployment can still be verified.

Bedrock uses the AWS credential chain for both model discovery and signed
inference. Setup accepts `AWS_REGION` and an optional `AWS_PROFILE`; environment
credentials and deployment roles also work. Discovery needs
`bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles`; inference
needs access to the selected model/profile. `AWS_BEARER_TOKEN_BEDROCK` supports
runtime inference but is not a control-plane listing credential. A listed model
does not guarantee invocation access; the probe verifies that separately.

Vertex uses Google Application Default Credentials (`gcloud auth
application-default login`, a workload identity, or
`GOOGLE_APPLICATION_CREDENTIALS`) and the selected project/location. Its Google
publisher catalog may list models unavailable in that project or region, so
verification is still required. `GOOGLE_VERTEX_API_KEY` enables express-mode
inference; discovery requires ADC. Partner-model transports are not exposed by
this Gemini adapter.

Compose passes runtime environment credentials but does not mount your host's
credential stores. Mount the chosen AWS profile or Google credential file
read-only with a local Compose override, and set paths as seen **inside** the
container. Use workload roles where available. Setup stores API keys in `.env`
(gitignored); no keys or raw provider errors are printed or put in the web UI.

## Prices and limits

`AI_MODEL_PRICES` is a JSON object keyed by `provider:model` for direct providers
or the existing `vendor/model` Gateway identifier. Each entry has nonnegative
`inputPerMillion` and `outputPerMillion` USD rates. For example, using a model ID
returned by your provider:

```dotenv
AI_MODEL_PRICES='{"openai:your-model":{"inputPerMillion":1,"outputPerMillion":2}}'
```

These are operator-supplied estimates, not vendor prices. Without the table,
the legacy `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` pair applies
only to the currently selected usage model. Historical models need their own
entries; missing rates produce an unknown cost and an unenforceable spend cap
with an operator warning. The cap sums each model at its own rate.

Ollama rows have zero provider spend and `spendStatus` reports `local`. Its
default concurrency is one; hosted providers keep four. The existing
`ANONIFY_AI_CONCURRENCY`, `ANONIFY_AI_REQUESTS_PER_MINUTE` and
`ANONIFY_AI_MAX_ATTEMPTS` overrides apply to the one selected provider. One
process-wide gate is sufficient because an instance does not route among
providers or automatically fail over.

## Validation

The provider tests use synthetic models and local HTTP fixtures to check SDK
wire requests, structured output, image attachments, authentication, discovery,
disabled choices, capability invalidation, degradation and per-model prices.
They do not establish model quality or live vendor account access. Setup's probe
is the live account/model check; it must succeed on the operator's machine.
