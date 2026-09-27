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

The official SDK adapters below, Ollama, a table of OpenAI-compatible
profiles, and a ChatGPT subscription signed in with `pnpm ai login`. Audio,
image-generation and embedding-only adapters cannot perform Anonify's
structured text analysis and are not provider choices.

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
| `openrouter` | `OPENROUTER_API_KEY` | `/models`, with list prices and capability metadata |
| `synthetic` | `SYNTHETIC_API_KEY` | `/models` |
| `lm-studio` | Optional `AI_BASE_URL`, default `http://localhost:1234/v1` | Loaded models from `/v1/models` |
| `llama-cpp` | Optional `AI_BASE_URL`, default `http://localhost:8080/v1` | The served model from `/v1/models` |
| `openai-compatible` | `AI_BASE_URL` (required), optional `AI_API_KEY` | `/models` at that URL |
| `openai-subscription` | `pnpm ai login --provider openai`; nothing in `.env` | The signed-in plan's models, or a typed ID |

Model lists are live, not a checked-in shortlist. They can include inaccessible,
non-text or unsupported models. Known incompatibilities appear disabled with a
reason. Missing capability metadata is labelled as unverified and requires a
successful probe before saving. Manual entry uses the same verification and
cannot bypass a known disabled model. If discovery fails, setup reports it and
offers a verified manual ID or keeps the current configuration. Ollama requires
an installed, inspected model from discovery, including for typed IDs.

Choose **Text and images** for the full model pass. **Text (image support
optional)** also allows a model that passes structured-output verification but
cannot read images. For those models, OCR still extracts text; image-region
analysis is skipped and reported in the usage panel.
Models that fail structured output cannot be newly selected in either mode.

`--yes` and non-interactive setup stay offline: existing AI settings are
preserved, with no model discovery or billable probes. Run interactive setup
once to verify a new direct or local provider before using scripted setup.

## Local Ollama

Start Ollama and pull a model using its CLI before running `pnpm setup --local`.
On a fresh configuration, the first local server that responds is offered as
the default: Ollama, then LM Studio, then llama.cpp, each on its usual port.
An existing hosted provider is never silently replaced. Ollama cloud models are
disabled: this integration is for installed local inference. The connection uses
Ollama's OpenAI-compatible structured-output endpoint through the official
`@ai-sdk/openai-compatible` adapter.

For the app in Docker, Compose maps `localhost`, `127.0.0.1` and `::1` Ollama
addresses, and the same `AI_BASE_URL` addresses, to `host.docker.internal` at
connection time. The same `.env` remains
usable with `pnpm dev` on the host. On Linux, Ollama must listen on an interface
reachable from Docker (configure `OLLAMA_HOST` in the Ollama service); restrict
access to the trusted machine/network. A hostname on another server is used as
given. A refused connection is reported without repeated retries.

## OpenAI-compatible endpoints

A vendor or server that speaks only the OpenAI chat-completions protocol is a
row in `lib/ai/providers/compatible.ts`: an ID, a label, a base URL and the name
of its key variable. Every row goes through the official
`@ai-sdk/openai-compatible` adapter, the same one Ollama uses. Each row gets the
same discovery, setup probe and visible `unsupported` degradation as every other
provider. To add a vendor, add a row, then a line in `.env.example` and in the
Compose file's pass-through list, and a row in the table above.

- **Hosted profiles** (OpenRouter, Synthetic) have fixed URLs. `AI_BASE_URL`
  does not move them, so a leftover value cannot send a hosted key somewhere
  else.
- **Local profiles** (LM Studio, llama.cpp) default to the server's usual port.
  `AI_BASE_URL` overrides it. They are treated like Ollama: no provider spend,
  `spendStatus` reports `local`, one request at a time by default, model lists
  are read live, and Compose maps a loopback URL to the Docker host.
- **`openai-compatible`** is any other endpoint, such as vLLM or a company
  proxy, named by `AI_BASE_URL`. `AI_API_KEY` is sent as a bearer token when
  set. Because the URL could belong to anyone, it is never assumed to be
  local. Price it with `AI_MODEL_PRICES` (key `openai-compatible:<model>`), and
  set `ANONIFY_AI_CONCURRENCY` if it is a single GPU.

`AI_BASE_URL` is the URL that `/chat/completions` and `/models` sit under,
usually ending in `/v1`. It must not carry credentials or a query string. The
capability declaration is bound to it, so pointing the same model ID at a
different server needs a new verification.

Structured output is requested as a JSON schema. A server or model that cannot
honour one fails setup's probe, and the model is not enabled. For llama.cpp,
start `llama-server` with a chat template. It needs a multimodal projector
(`--mmproj`) for image analysis. Without one, choose text-only analysis.

## ChatGPT subscription sign-in

For a step-by-step guide to both OpenAI routes, an API key or a ChatGPT
sign-in, including headless servers and troubleshooting, see
[Connecting to OpenAI](connect-openai.md).

```bash
pnpm ai login --provider openai     # sign in, then choose, verify and price a model
pnpm ai verify --provider openai-subscription   # choose another model later
pnpm ai status                      # account, plan, the plan's usage limits, this instance's usage
pnpm ai logout --provider openai    # deletes the stored token
```

**Read this first.** OpenAI does not register OAuth clients for other tools to
use a subscription for inference. Sign-in therefore uses the public client that
OpenAI ships with Codex CLI, against the backend Codex uses, as several other
open-source tools do. Whether a ChatGPT plan may be used this way is for
OpenAI's terms to decide, and those terms can change. The backend is not a
documented API and may change without notice. **For a deployed instance, use
an OpenAI API key** (`AI_PROVIDER=openai`). The login command prints this
caveat every time.

How it works:

- PKCE with a loopback callback on `http://localhost:1455/auth/callback`, the
  only redirect that client has registered, bound to 127.0.0.1. On a host with
  no browser (SSH, or Linux with no display), open the printed link anywhere.
  The last page fails to load a `localhost` address; copy that whole address
  and paste it at the prompt, where it is not echoed. A redirect with the wrong
  `state` is refused.
- The token is sealed with `ENCRYPTION_KEY` and stored in one `Setting` row
  (`ai.login.openai`), **never in `.env`**. Run login where `DATABASE_URL`
  reaches the instance's database. The app in Docker reads the same row. If
  `ENCRYPTION_KEY` changes, the token cannot be opened, and `pnpm ai status`
  says so instead of reporting you as signed out.
- The expiry is stored. A token within a minute of expiring is refreshed on
  use and written back. If another process rotated it first, that token is
  used. A revoked or expired sign-in reaches the reviewer as `authorization`,
  like a rejected key, and is not retried.
- Anonify never reads another tool's credentials. It does not use Codex CLI's
  `auth.json`, Claude Code's store, or anything else on the host. Sharing a
  refresh token between two tools logs one of them out at random.
- No token, authorization code or `state` value is printed or logged. The
  sign-in's own tokens are removed from any refusal before it goes further.
- The model list is read from OpenAI with the signed-in token: the Codex
  backend's `/models`, filtered and ordered the way Codex CLI's own picker
  shows it (`visibility: "list"`, by `priority`). If it cannot be read, a
  typed model ID is verified instead.
- After signing in, `pnpm ai login` carries on into the same model picker and
  probe as `pnpm ai verify`, then writes `AI_PROVIDER`, `AI_MODEL` and
  `AI_MODEL_CAPABILITIES` to `.env`. With `--model`, it does this without
  asking.
- Usage rows are keyed `openai-subscription:<model>`. The plan is not billed
  per token, so by default these rows cost $0 in estimates and against the
  spend cap. Login and setup offer to record a price instead, in
  `AI_MODEL_PRICES` (or pass `--input-price` and `--output-price`). A recorded
  price is used for estimates and the cap. The plan's own usage limits still
  apply. A call refused for them arrives as `rate-limit` or `budget`, as it
  would from an API key.
- Logging out deletes the row. It does not revoke the token at OpenAI, which
  lapses when it expires.

**There is no Anthropic equivalent.** Anthropic's terms reserve Claude Free,
Pro and Max sign-in for Anthropic's own apps. `pnpm ai login --provider
anthropic` explains this and exits. Use `ANTHROPIC_API_KEY`.

## Verifying without setup

`pnpm ai verify` runs setup's probe on its own. It works for any provider and
writes `AI_PROVIDER`, `AI_MODEL` and `AI_MODEL_CAPABILITIES` into the existing
`.env` in place, leaving every other line alone. With a terminal and no model
configured, it shows setup's model picker. Without a terminal, name the model:

```bash
pnpm ai verify --provider ollama --model qwen3-vl:2b-instruct
pnpm ai verify --text-only        # accept a model that cannot read images
pnpm ai verify --input-price 1.25 --output-price 10   # record USD per 1M tokens
pnpm ai verify --print            # print the settings instead of writing .env
```

This is how a scripted install turns "a model is configured" into "a model is
verified". The Local install job in CI configures the instance the same way.

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
(gitignored); no keys are printed or put in the web UI, and the running app
logs a failure's category, never what the provider said.

### When verification fails

Setup, `pnpm ai verify` and `pnpm ai login` say which request failed (the
structured-output check or the image check) and why:

- **Credentials rejected** (HTTP 401/403), **not found** (404: a model this
  account cannot use, or a wrong base URL), **refused** (400: often a model
  without JSON-schema output or image input, or a parameter the endpoint does
  not accept), **rate-limited or over quota** (429), **out of credit** (402),
  or **the provider failed** (5xx), each with what the provider said.
- **Unreachable**: connection refused (nothing listening), a host name that
  does not resolve, a TLS certificate that is not accepted, or no answer
  within two minutes.
- **The model answered badly**: not JSON, JSON that does not fit the schema
  (with the start of what it said), or the wrong answer.

What the provider said is quoted only here, and only because verification
sends synthetic requests, so it cannot quote a document. It is redacted
first: the configured credential values, then anything shaped like a key, a
bearer token or a JWT, and it is cut to 300 characters. In the picker, a
failure that is about the model marks it as failed. A failure that would hit
every model alike, such as a rejected key or a server that is down, leaves the
model available, so the cause gets fixed rather than hidden.

## Prices and limits

`AI_MODEL_PRICES` is a JSON object keyed by `provider:model` for direct providers
or the existing `vendor/model` Gateway identifier. Each entry has nonnegative
`inputPerMillion` and `outputPerMillion` USD rates. For example, using a model ID
returned by your provider:

```dotenv
AI_MODEL_PRICES='{"openai:your-model":{"inputPerMillion":1,"outputPerMillion":2}}'
```

These are operator-supplied estimates, not vendor prices, and they are the
only prices the app enforces.

### List prices in setup

`pnpm setup` shows a list price beside each model when the provider's own
model list publishes one in a documented unit. Today that is the Vercel AI
Gateway and OpenRouter (USD per token) and DeepInfra (cents per token). Together AI and xAI
also return price fields, but their units are not documented, so setup does
not show them. Every other provider's list carries no prices, and setup says
so. A price shown with "first tier" is tiered by prompt length. One shown with
"varies by upstream provider" is representative only.

Choosing a priced model offers to copy its list price into `AI_MODEL_PRICES`,
with the source and age on screen. Nothing is copied without a yes. The default
answer is no when the price is tiered, representative or stale, or when it
would replace a price you set.

Model lists are cached in `.cache/models/<provider>.json`, or under
`ANONIFY_MODEL_CACHE_PATH`. Each file records its source URL, when it was
fetched and which endpoint it describes, and never a credential. Prices go
stale after 24 hours and capabilities after 7 days. A stale list is offered for
refresh. If the refresh fails, it is shown with its age rather than hidden.
Local servers (Ollama, LM Studio, llama.cpp) and the subscription's list are
always read live. Cached capabilities are what the provider
advertises; setup's probe still verifies a model before saving it.

```bash
pnpm models:warm                    # providers with credentials in .env
pnpm models:warm --provider openai  # one provider (repeatable)
pnpm models:warm --all              # every provider; Gateway, DeepInfra and OpenRouter need no key
pnpm models:warm --force            # refetch even when fresh
pnpm models:warm --offline          # report what is cached, without the network
```

It prints provider names, counts and ages, never a credential or a provider's
response. It exits nonzero when an attempted refresh fails. Without the table,
the legacy `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` pair applies
only to the currently selected usage model. Historical models need their own
entries; missing rates produce an unknown cost and an unenforceable spend cap
with an operator warning. The cap sums each model at its own rate.

Local-server rows (Ollama, LM Studio, llama.cpp) have zero provider spend and
`spendStatus` reports `local`. Their default concurrency is one; hosted
providers keep four. The existing
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

The subscription tests run the sign-in, sealed storage, refresh and the Codex
transport against fixtures. No live ChatGPT account is used in CI.

`.github/workflows/local-model.yml` runs a real model weekly, and on pull
requests that change the provider layer. Its Ollama contract job runs
`tests/ollama-contract.test.ts` against a pinned Ollama and Qwen3-VL 2B
Instruct. Its Local install job boots the Compose stack with that model
configured through `pnpm ai verify`. It then runs `pnpm smoke --ai`, which
uploads a letter, lets the model analyse it, and redacts, exports and reads
back the result. Like the contract suite, it asserts that model calls were
made and accounted for, that none failed, and that every suggestion quotes the
document. It does not assert what a 2B model finds.
