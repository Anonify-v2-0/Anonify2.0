/**
 * Interactive setup.
 *
 *   pnpm setup                 walk through it
 *   pnpm setup --local         fully local, defaults for everything
 *   pnpm setup --demo          the deployed demo's services
 *   pnpm setup --defaults      skip the limit questions, take the profile's
 *   pnpm setup --yes           answer every question with its default
 *   pnpm setup --force         overwrite an existing .env without asking
 *   pnpm setup --help
 *
 * Writes a working `.env` and says plainly which values still need a key. The
 * alternative — a list of environment variables in a README and a runtime
 * failure when one is missing — is how a fresh clone becomes an afternoon.
 *
 * It used to stop at the services: database, storage, OCR, secrets. But most of
 * what makes this instance *yours* is in the numbers underneath — how much one
 * person may upload in a day, how fast, how complicated a message may be before
 * it is refused, how many documents one email is allowed to turn into — and
 * those were only discoverable by reading `.env.example` and knowing to look.
 * A limit you did not know you could change is, in practice, a limit you cannot
 * change.
 *
 * So every default shown here is read from the code that enforces it —
 * `defaultsFor`, `DEFAULT_EML_LIMITS`, `DEFAULT_EXPANSION_LIMITS`,
 * `mboxDefaultsFor` — rather than copied into this file. A number printed here
 * and a number in force can then never disagree, which is the only version of
 * this worth having: a setup script that lies about the defaults is worse than
 * no setup script.
 *
 * Sizes are asked for and written as sizes — `32MB`, `512KB` — rather than as
 * byte counts. Nobody types `33554432` correctly, and the way that goes wrong
 * is not a rejected answer but a plausible number off by a factor of a
 * thousand, accepted and in force. A plain number still means bytes, so an
 * existing `.env` keeps working. See lib/config/bytes.ts.
 */

import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import path from "node:path"
import { AI_ENV_KEYS, askAiProvider } from "./setup-ai"
import type { ProviderEnv } from "@/lib/ai/providers/config"

import { formatByteSize } from "@/lib/config/bytes"
import {
  batchDefaultsFor as batchDefaults,
  batchEnvName,
  BATCH_LIMIT_KEYS,
  type BatchLimitKey,
  type BatchLimits,
} from "@/lib/documents/batch-config"
import {
  DEFAULT_EXPANSION_LIMITS,
  expansionEnvName,
  type ExpansionLimits,
} from "@/lib/documents/eml/attachments"
import {
  DEFAULT_EML_LIMITS,
  envName as emlEnvName,
  type EmlLimits,
} from "@/lib/documents/eml/limits"
import {
  mboxDefaultsFor as mboxDefaults,
  mboxEnvName,
  type MboxLimits,
} from "@/lib/documents/mbox/limits"
import {
  defaultsFor as quotaDefaults,
  envName as quotaEnvName,
  USAGE_KINDS,
  type Quotas,
  type UsageKind,
} from "@/lib/security/quota-config"
import {
  defaultsFor as rateDefaults,
  envName as rateEnvName,
  RATE_LIMIT_NAMES,
  type Profile,
  type RateLimitName,
} from "@/lib/security/rate-limit-config"
import {
  DEFAULT_MISTRAL_OCR_MODEL,
  DEFAULT_TESSERACT_LANGUAGE,
  DEFAULT_TESSERACT_MODEL,
  MISTRAL_OCR_MODELS,
  TESSERACT_LANGUAGE_NAMES,
  TESSERACT_LANGUAGES,
  TESSERACT_MODEL_DETAIL,
  TESSERACT_MODELS,
  type MistralOcrModel,
  type TesseractLanguage,
  type TesseractModel,
} from "@/lib/ocr/models"
import {
  DEFAULT_DAILY_SPEND_USD,
  SERVICE_LIMIT_KEYS,
  SERVICES,
  serviceDefaults,
  serviceEnvName,
  SPEND_ENV_NAME,
  type ServiceLimitKey,
  type ServiceLimits,
  type ServiceName,
} from "@/lib/services/limits"
import {
  decodesTo32Bytes,
  parseEnv,
  renderEnv,
  type EnvGroup,
} from "./env-file"
import {
  bullet,
  fail,
  note,
  ok,
  paint,
  Prompter,
  rule,
  say,
  setColor,
  setting,
  spin,
  step,
  warn,
} from "./tty"

const ENV_PATH = path.join(process.cwd(), ".env")
const STEPS = 5

type Mode = "local" | "demo"

/** 32 bytes of hex — what the crypto and identity layers expect. */
function secret(): string {
  return randomBytes(32).toString("hex")
}

// --- port probing -----------------------------------------------------------

/**
 * Whether something already answers on a port.
 *
 * Worth the two seconds it costs. The most common way a fresh local setup fails
 * is a Postgres already running on 5432, and the symptom — Compose starting
 * fine while the app talks to somebody else's database — is a genuinely
 * confusing afternoon.
 */
function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const settle = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    socket.once("error", () => settle(false))
  })
}

// --- the questions ----------------------------------------------------------

type Answers = {
  mode: Mode
  profile: Profile
  ports: {
    app: number
    postgres: number
    rustfs: number
    rustfsConsole: number
  }
  ocr: "tesseract" | "mistral"
  /** Which model the chosen engine reads with, from a validated list. */
  tesseractModel: TesseractModel
  tesseractLanguage: TesseractLanguage
  mistralOcrModel: MistralOcrModel
  ai: ProviderEnv
  services: Partial<Record<ServiceName, Partial<ServiceLimits>>>
  spendCapUsd: number
  quotas: Partial<Quotas>
  rates: Partial<Record<RateLimitName, string>>
  eml: Partial<Record<keyof EmlLimits, string>>
  expansion: Partial<Record<keyof ExpansionLimits, string>>
  mbox: Partial<Record<keyof MboxLimits, string>>
  batch: Partial<BatchLimits>
}

/** What each concurrency setting bounds, since none of them is a rate. */
const BATCH_UNITS: Record<BatchLimitKey, string> = {
  maxFiles: "documents in one batch",
  processing: "of your documents processing at once",
  exporting: "documents exported at once, within one batch export",
}

/** What each allowance counts, since they are not all the same shape. */
const QUOTA_UNITS: Record<UsageKind, string> = {
  pdfPages: "pages of PDF",
  docxPages: "pages of Word documents",
  xlsxCells: "filled cells, across XLSX, CSV and TSV",
  images: "images",
  textPages: "pages of extracted text, for .txt and .rtf",
  emailKilobytes: "KiB of decoded email text",
  pptxSlides: "slides",
  uploads: "files uploaded",
}

const EML_UNITS: Record<keyof EmlLimits, string> = {
  maxDepth: "how deeply multiparts may nest",
  maxParts: "parts across the whole tree",
  maxTextBytes: "decoded text, across every part",
  maxHeaderBytes: "one part's header block",
  maxAttachments: "attachments one message may carry",
  maxNestedMessages: "forwarded messages inside one another",
}

const EXPANSION_UNITS: Record<keyof ExpansionLimits, string> = {
  maxChildren: "documents one message may produce",
  maxExpandedBytes: "across all of them",
  maxAttachmentBytes: "any single attachment",
  maxDepth: "a message inside a message inside a message",
}

const MBOX_UNITS: Record<keyof MboxLimits, string> = {
  maxMessages: "documents one mailbox may produce",
  maxTotalBytes: "across every message in it",
  maxMessageBytes: "any single message",
  maxDepth: "a mailbox forwarded inside a mailbox",
}

/**
 * The limits that are a size rather than a count, so the prompt asks for one.
 *
 * Kept beside the unit labels rather than imported from the three limit
 * modules: those export the sets they enforce with, and a second import here
 * would make this file look like it was deciding something it is not. What it
 * decides is only how to ask.
 */
const EML_SIZES = new Set<keyof EmlLimits>(["maxTextBytes", "maxHeaderBytes"])
const EXPANSION_SIZES = new Set<keyof ExpansionLimits>([
  "maxExpandedBytes",
  "maxAttachmentBytes",
])
const MBOX_SIZES = new Set<keyof MboxLimits>([
  "maxTotalBytes",
  "maxMessageBytes",
])

/** A default, shown the way it may be typed back in. */
function shownAs(value: number, isSize: boolean): string {
  return isSize ? formatByteSize(value) : String(value)
}

/** What each external-service setting bounds, since none of them is a quota. */
const SERVICE_UNITS: Record<ServiceLimitKey, string> = {
  concurrency: "requests in flight at once, across every document",
  requestsPerMinute: "sustained requests per minute; 0 paces nothing",
  maxAttempts: "tries per request before it is given up",
}

const SERVICE_TITLES: Record<ServiceName, string> = {
  ai: "AI provider",
  ocr: "Hosted OCR (Mistral)",
}

/**
 * The limits belonging to services this install does not own.
 *
 * Asked separately from the rate limits above because they are the opposite
 * question. Those ration people arriving here; these pace us arriving somewhere
 * else, where being refused costs a page of somebody's document rather than
 * producing a tidy 429.
 *
 * Only the services actually in use are asked about. A fully local install
 * running Tesseract has no hosted OCR to pace, and asking anyway invites a
 * number that does nothing.
 */
async function askServiceLimits(
  prompt: Prompter,
  answers: { ocr: Answers["ocr"] }
): Promise<Answers["services"]> {
  const relevant: ServiceName[] =
    answers.ocr === "mistral" ? [...SERVICES] : ["ai"]

  say()
  say(`  ${paint.bold("External service limits")}`)
  say()
  note("Mistral meters OCR requests per second; the AI Gateway meters spend.")
  note("Neither ceiling is yours to raise, and the only thing you control is")
  note("how hard this instance pushes at it. A request held back for a moment")
  note("costs a moment; one refused costs a page of somebody's document.")
  if (answers.ocr !== "mistral") {
    say()
    note("Tesseract runs locally and answers to no limit, so only the gateway")
    note("is asked about here.")
  }
  say()
  for (const service of relevant) {
    const defaults = serviceDefaults(service)
    for (const key of SERVICE_LIMIT_KEYS) {
      setting(serviceEnvName(service, key), String(defaults[key]), {
        defaulted: true,
      })
    }
  }
  say()

  if (await prompt.confirm("Keep these service limits?", true)) return {}

  const chosen: Answers["services"] = {}
  for (const service of relevant) {
    const defaults = serviceDefaults(service)
    say()
    say(`    ${paint.gray(SERVICE_TITLES[service])}`)
    const picked: Partial<ServiceLimits> = {}
    for (const key of SERVICE_LIMIT_KEYS) {
      picked[key] = await prompt.askInteger(serviceEnvName(service, key), {
        fallback: defaults[key],
        // 0 is a real answer for a rate — it means do not pace — and a refusal
        // for the other two, which is what `serviceLimits` bounds enforce.
        allowZero: key === "requestsPerMinute",
        unit: `(${SERVICE_UNITS[key]})`,
      })
    }
    chosen[service] = picked
  }
  return chosen
}

/**
 * The gateway's real ceiling.
 *
 * Asked apart from the numbers above because it is a different kind of thing:
 * not a rate, but an amount of money per day, enforced by this application
 * against its own recorded token counts. It only means anything where prices
 * are configured, so the question says so rather than offering a number that
 * silently does nothing.
 */
async function askSpendCap(prompt: Prompter): Promise<number> {
  say()
  say(
    `  ${paint.bold("Daily AI spend cap")} ${paint.gray("— USD, per UTC day")}`
  )
  say()
  note("The AI Gateway meters spend rather than requests, so this is the")
  note("ceiling that is actually there. Estimated from recorded tokens and the")
  note("prices in AI_PRICE_*, which means it needs those set to do anything.")
  note("At 80% the model runs one call at a time; at 100% the contextual pass")
  note("is skipped for the rest of the day and pattern detection carries on.")
  say()
  setting(SPEND_ENV_NAME, "no cap", { defaulted: true })
  say()

  if (await prompt.confirm("Leave AI spend uncapped?", true)) {
    return DEFAULT_DAILY_SPEND_USD
  }

  return prompt.askAmount(SPEND_ENV_NAME, {
    fallback: DEFAULT_DAILY_SPEND_USD,
    unit: "(USD per day, 0 for no cap)",
  })
}

/**
 * Which model Tesseract reads with.
 *
 * A list rather than free text, and that is the point rather than an
 * implementation detail: this value ends up in a compose file, where a typo
 * becomes a container that builds, starts, accepts an upload and fails on the
 * first scanned page with a 404 from a CDN. Asked here, the same typo is a
 * re-prompt that never leaves the terminal.
 */
async function askTesseractModel(prompt: Prompter): Promise<TesseractModel> {
  return prompt.choose<TesseractModel>(
    "Which Tesseract model?",
    TESSERACT_MODELS.map((value) => {
      const { approxMb, summary } = TESSERACT_MODEL_DETAIL[value]
      return {
        value,
        label: value === DEFAULT_TESSERACT_MODEL ? `${value} (default)` : value,
        detail: [
          summary,
          `About ${approxMb} MB per language, downloaded once.`,
        ],
      }
    }),
    TESSERACT_MODELS.indexOf(DEFAULT_TESSERACT_MODEL)
  )
}

/**
 * Which language it reads.
 *
 * Detection is still English-shaped (#43), so a non-English document is only
 * half-served by this — but OCR that cannot read the page at all serves it
 * not at all, and that half is worth having on its own.
 */
async function askTesseractLanguage(
  prompt: Prompter
): Promise<TesseractLanguage> {
  say()
  note("Only the languages available in every model variant are listed, so")
  note("changing the variant later cannot leave you without the data for it.")

  return prompt.choose<TesseractLanguage>(
    "Which language?",
    TESSERACT_LANGUAGES.map((value) => ({
      value,
      label: `${TESSERACT_LANGUAGE_NAMES[value]} (${value})`,
    })),
    TESSERACT_LANGUAGES.indexOf(DEFAULT_TESSERACT_LANGUAGE)
  )
}

async function askMistralOcrModel(prompt: Prompter): Promise<MistralOcrModel> {
  return prompt.choose<MistralOcrModel>(
    "Which Mistral OCR model?",
    MISTRAL_OCR_MODELS.map((value) => ({
      value,
      label: value,
      detail:
        value === DEFAULT_MISTRAL_OCR_MODEL
          ? [
              "Follows Mistral's newest OCR release. The right default here:",
              "a better reader is strictly better, and no output format breaks.",
            ]
          : [
              "Pinned to one release, for an install that has validated its",
              "results against this one and would rather they not move.",
            ],
    })),
    MISTRAL_OCR_MODELS.indexOf(DEFAULT_MISTRAL_OCR_MODEL)
  )
}

async function askQuotas(
  prompt: Prompter,
  profile: Profile
): Promise<Partial<Quotas>> {
  const defaults = quotaDefaults(profile)
  const unlimited = USAGE_KINDS.every((kind) => defaults[kind] === 0)

  say()
  say(
    `  ${paint.bold("Daily allowances")} ${paint.gray("— per person, per UTC day")}`
  )
  say()
  if (unlimited) {
    note("A self-hosted install has nobody to ration against, so nothing is")
    note("capped. Set a number here only if this instance is shared.")
  } else {
    note("This profile rations a shared endpoint, so one visitor's workbook")
    note("cannot be everyone's budget.")
  }
  say()
  for (const kind of USAGE_KINDS) {
    setting(
      quotaEnvName(kind),
      defaults[kind] === 0 ? "unlimited" : String(defaults[kind]),
      { defaulted: true }
    )
  }
  say()

  if (await prompt.confirm("Keep these daily allowances?", true)) return {}

  note("0 means unlimited. Blank keeps the default.")
  const chosen: Partial<Quotas> = {}
  for (const kind of USAGE_KINDS) {
    chosen[kind] = await prompt.askInteger(quotaEnvName(kind), {
      fallback: defaults[kind],
      allowZero: true,
      unit: `(${QUOTA_UNITS[kind]})`,
    })
  }
  return chosen
}

async function askRates(
  prompt: Prompter,
  profile: Profile
): Promise<Partial<Record<RateLimitName, string>>> {
  const defaults = rateDefaults(profile)

  say()
  say(
    `  ${paint.bold("Rate limits")} ${paint.gray("— requests per window, as requests/seconds")}`
  )
  say()
  note("A token bucket that refills continuously, so a window is a rate")
  note("rather than a boundary to burst across.")
  say()
  for (const name of RATE_LIMIT_NAMES) {
    setting(
      rateEnvName(name),
      `${defaults[name].limit}/${defaults[name].windowSeconds}`,
      { defaulted: true }
    )
  }
  say()
  note("`pnpm rate-limit set` changes these later without a restart.")
  say()

  if (await prompt.confirm("Keep these rate limits?", true)) return {}

  const chosen: Partial<Record<RateLimitName, string>> = {}
  for (const name of RATE_LIMIT_NAMES) {
    chosen[name] = await prompt.askRate(rateEnvName(name), {
      fallback: `${defaults[name].limit}/${defaults[name].windowSeconds}`,
    })
  }
  return chosen
}

async function askEmlLimits(
  prompt: Prompter
): Promise<Partial<Record<keyof EmlLimits, string>>> {
  say()
  say(`  ${paint.bold("Email parser limits")}`)
  say()
  note("An email is the one format here that arrives from strangers by")
  note("design, and MIME is a recursive container with no natural bound.")
  note("Exceeding one of these refuses the message with a reason — never a")
  note("truncated document presented as a complete one.")
  say()
  for (const key of Object.keys(DEFAULT_EML_LIMITS) as (keyof EmlLimits)[]) {
    setting(
      emlEnvName(key),
      shownAs(DEFAULT_EML_LIMITS[key], EML_SIZES.has(key)),
      {
        defaulted: true,
      }
    )
  }
  say()

  if (await prompt.confirm("Keep these parser limits?", true)) return {}

  const chosen: Partial<Record<keyof EmlLimits, string>> = {}
  for (const key of Object.keys(DEFAULT_EML_LIMITS) as (keyof EmlLimits)[]) {
    chosen[key] = EML_SIZES.has(key)
      ? await prompt.askSize(emlEnvName(key), {
          fallback: DEFAULT_EML_LIMITS[key],
          unit: `(${EML_UNITS[key]})`,
        })
      : String(
          await prompt.askInteger(emlEnvName(key), {
            fallback: DEFAULT_EML_LIMITS[key],
            unit: `(${EML_UNITS[key]})`,
          })
        )
  }
  return chosen
}

async function askExpansionLimits(
  prompt: Prompter
): Promise<Partial<Record<keyof ExpansionLimits, string>>> {
  say()
  say(`  ${paint.bold("Email attachment expansion")}`)
  say()
  note("A message carrying attachments becomes a batch: the message is one")
  note("document and each attachment is another, with its own run, its own")
  note("allowance and its own export. Parsing a message and expanding one are")
  note("different costs, so they are bounded separately.")
  say()
  for (const key of Object.keys(
    DEFAULT_EXPANSION_LIMITS
  ) as (keyof ExpansionLimits)[]) {
    setting(
      expansionEnvName(key),
      shownAs(DEFAULT_EXPANSION_LIMITS[key], EXPANSION_SIZES.has(key)),
      { defaulted: true }
    )
  }
  say()

  if (await prompt.confirm("Keep these expansion limits?", true)) return {}

  const chosen: Partial<Record<keyof ExpansionLimits, string>> = {}
  for (const key of Object.keys(
    DEFAULT_EXPANSION_LIMITS
  ) as (keyof ExpansionLimits)[]) {
    chosen[key] = EXPANSION_SIZES.has(key)
      ? await prompt.askSize(expansionEnvName(key), {
          fallback: DEFAULT_EXPANSION_LIMITS[key],
          unit: `(${EXPANSION_UNITS[key]})`,
        })
      : String(
          await prompt.askInteger(expansionEnvName(key), {
            fallback: DEFAULT_EXPANSION_LIMITS[key],
            unit: `(${EXPANSION_UNITS[key]})`,
          })
        )
  }
  return chosen
}

/**
 * The mailbox limits.
 *
 * Asked after attachment expansion because it is the same question one scale
 * up, and the answer to the first one makes the second one legible: a message
 * with attachments becomes a small batch, and a mailbox becomes a large one.
 *
 * These are per profile, unlike the two above, because a shared demo absorbing
 * everybody's archive and a laptop expanding its owner's are not answering the
 * same question.
 */
async function askMboxLimits(
  prompt: Prompter,
  profile: Profile
): Promise<Partial<Record<keyof MboxLimits, string>>> {
  const defaults = mboxDefaults(profile)

  say()
  say(`  ${paint.bold("Mailbox expansion")}`)
  say()
  note("An .mbox is not a document, it is hundreds of them. It expands into a")
  note("batch: one document per message, each with its own run, its own")
  note(
    "allowance and its own export, and the mailbox itself is never redacted."
  )
  note("This is the first format where the amplification factor is the point —")
  note("one upload becoming nine hundred documents — so it is bounded on its")
  note("own terms rather than by the upload size.")
  say()
  for (const key of Object.keys(defaults) as (keyof MboxLimits)[]) {
    setting(mboxEnvName(key), shownAs(defaults[key], MBOX_SIZES.has(key)), {
      defaulted: true,
    })
  }
  say()
  note("The message count is its own number rather than the batch cap — that")
  note("one is how many files a person may drag in at once, and a mailbox is")
  note("one file — but it is floored at it either way, so a mailbox can never")
  note("produce a smaller batch than you could assemble by hand.")
  say()

  if (await prompt.confirm("Keep these mailbox limits?", true)) return {}

  const chosen: Partial<Record<keyof MboxLimits, string>> = {}
  for (const key of Object.keys(defaults) as (keyof MboxLimits)[]) {
    chosen[key] = MBOX_SIZES.has(key)
      ? await prompt.askSize(mboxEnvName(key), {
          fallback: defaults[key],
          unit: `(${MBOX_UNITS[key]})`,
        })
      : String(
          await prompt.askInteger(mboxEnvName(key), {
            fallback: defaults[key],
            unit: `(${MBOX_UNITS[key]})`,
          })
        )
  }
  return chosen
}

async function askBatchLimits(
  prompt: Prompter,
  profile: Profile
): Promise<Partial<BatchLimits>> {
  const defaults = batchDefaults(profile)

  say()
  say(`  ${paint.bold("Batch size and concurrency")}`)
  say()
  note("How much happens at once, which is a different question from how often")
  note("it may start. A rate limit refills while work is still running; these")
  note("are what actually bound memory, database connections and model spend.")
  note("A document waiting for a slot shows as queued and starts on its own.")
  say()
  for (const key of BATCH_LIMIT_KEYS) {
    setting(batchEnvName(key), String(defaults[key]), { defaulted: true })
  }
  say()

  if (await prompt.confirm("Keep these batch limits?", true)) return {}

  const chosen: Partial<BatchLimits> = {}
  for (const key of BATCH_LIMIT_KEYS) {
    chosen[key] = await prompt.askInteger(batchEnvName(key), {
      fallback: defaults[key],
      unit: `(${BATCH_UNITS[key]})`,
    })
  }
  return chosen
}

// --- assembling the file ----------------------------------------------------

function limitGroups(answers: Answers): EnvGroup[] {
  const quotaDefaultsForProfile = quotaDefaults(answers.profile)
  const rateDefaultsForProfile = rateDefaults(answers.profile)

  return [
    {
      heading: "Rate limits",
      note: [
        "requests/seconds. `pnpm rate-limit set` beats these and takes effect",
        "without a restart; `pnpm rate-limit show` says what is actually in force.",
      ],
      lines: RATE_LIMIT_NAMES.map((name) => {
        const fallback = `${rateDefaultsForProfile[name].limit}/${rateDefaultsForProfile[name].windowSeconds}`
        const chosen = answers.rates[name]
        return {
          key: rateEnvName(name),
          value: chosen ?? fallback,
          commented: chosen === undefined || chosen === fallback,
        }
      }),
    },
    {
      heading: "Daily quotas",
      note: [
        "Per identity, per UTC day. 0 is unlimited, which is the self-hosted",
        "default: your machine has nobody to ration against.",
      ],
      lines: USAGE_KINDS.map((kind) => {
        const fallback = quotaDefaultsForProfile[kind]
        const chosen = answers.quotas[kind]
        return {
          key: quotaEnvName(kind),
          value: String(chosen ?? fallback),
          comment: QUOTA_UNITS[kind],
          commented: chosen === undefined || chosen === fallback,
        }
      }),
    },
    {
      heading: "Email parser limits",
      note: [
        "What one message may cost to read, independently of the upload size —",
        "raising the upload ceiling must not mean unlimited MIME complexity.",
        "Exceeding one is a refusal with a reason, never a partial result.",
      ],
      lines: (Object.keys(DEFAULT_EML_LIMITS) as (keyof EmlLimits)[]).map(
        (key) => {
          const fallback = shownAs(DEFAULT_EML_LIMITS[key], EML_SIZES.has(key))
          const chosen = answers.eml[key]
          return {
            key: emlEnvName(key),
            value: chosen ?? fallback,
            comment: EML_UNITS[key],
            commented: chosen === undefined || chosen === fallback,
          }
        }
      ),
    },
    {
      heading: "Email attachment expansion",
      note: [
        "A message with attachments becomes a batch: one document per supported",
        "attachment, each with its own run, allowance and export. Bounded apart",
        "from parsing because it is a different cost with a different",
        "amplification factor.",
      ],
      lines: (
        Object.keys(DEFAULT_EXPANSION_LIMITS) as (keyof ExpansionLimits)[]
      ).map((key) => {
        const fallback = shownAs(
          DEFAULT_EXPANSION_LIMITS[key],
          EXPANSION_SIZES.has(key)
        )
        const chosen = answers.expansion[key]
        return {
          key: expansionEnvName(key),
          value: chosen ?? fallback,
          comment: EXPANSION_UNITS[key],
          commented: chosen === undefined || chosen === fallback,
        }
      }),
    },
    {
      heading: "Mailbox expansion",
      note: [
        "An .mbox is not a document, it is hundreds of them: it expands into a",
        "batch of one document per message and is never redacted as a file. The",
        "first format where the amplification factor is the point, so it is",
        "bounded on its own terms. Sizes, not byte counts — 32MB, 512KB, 1GB.",
        "The message count is floored at the batch cap, so a mailbox can never",
        "produce a smaller batch than somebody could assemble by hand.",
      ],
      lines: (
        Object.keys(mboxDefaults(answers.profile)) as (keyof MboxLimits)[]
      ).map((key) => {
        const fallback = shownAs(
          mboxDefaults(answers.profile)[key],
          MBOX_SIZES.has(key)
        )
        const chosen = answers.mbox[key]
        return {
          key: mboxEnvName(key),
          value: chosen ?? fallback,
          comment: MBOX_UNITS[key],
          commented: chosen === undefined || chosen === fallback,
        }
      }),
    },
    {
      heading: "External service limits",
      note: [
        "The other direction from the rate limits above: those ration callers",
        "arriving here, these pace this instance arriving somewhere else. A",
        "request held back waits; one refused by the provider costs a page of",
        "somebody's document. Only the OCR pair applies to a hosted engine —",
        "Tesseract runs locally and answers to no limit.",
      ],
      lines: SERVICES.flatMap((service) =>
        SERVICE_LIMIT_KEYS.map((key) => {
          const fallback = serviceDefaults(service)[key]
          const chosen = answers.services[service]?.[key]
          return {
            key: serviceEnvName(service, key),
            value: String(chosen ?? fallback),
            comment: SERVICE_UNITS[key],
            commented: chosen === undefined || chosen === fallback,
          }
        })
      ),
    },
    {
      heading: "Batch size and concurrency",
      note: [
        "How much happens at once, as opposed to how often it may start. A rate",
        "limit refills while work is still running; these bound what is in",
        "flight. A document waiting for a slot reads as queued and starts by",
        "itself when one frees up.",
      ],
      lines: BATCH_LIMIT_KEYS.map((key) => {
        const fallback = batchDefaults(answers.profile)[key]
        const chosen = answers.batch[key]
        return {
          key: batchEnvName(key),
          value: String(chosen ?? fallback),
          comment: BATCH_UNITS[key],
          commented: chosen === undefined || chosen === fallback,
        }
      }),
    },
  ]
}

function buildEnv(answers: Answers, kept: Map<string, string>): string {
  const keep = (key: string, fallback = "") => kept.get(key) || fallback
  const secretFor = (key: string) =>
    decodesTo32Bytes(kept.get(key) ?? "") ? kept.get(key)! : secret()

  const shared: EnvGroup[] = [
    {
      heading: "Runtime profile",
      note: [
        answers.profile === "demo"
          ? "This instance is public and shared: strict limits, small allowances."
          : "Your machine, your rules: generous limits, no daily quotas.",
      ],
      lines: [{ key: "ANONIFY_PROFILE", value: answers.profile }],
    },
  ]

  const services: EnvGroup[] =
    answers.mode === "local"
      ? [
          {
            heading: "Database (docker compose)",
            lines: [
              {
                key: "DATABASE_URL",
                value: keep(
                  "DATABASE_URL",
                  `postgresql://anonify:anonify@localhost:${answers.ports.postgres}/anonify`
                ),
                // Said out loud, because a connection string carried over from
                // a previous run can point somewhere else entirely, and a
                // heading that says "docker compose" over a remote database is
                // exactly the kind of quiet disagreement that costs an evening.
                comment: kept.has("DATABASE_URL")
                  ? "Kept from your previous .env. Compose's own is postgresql://anonify:anonify@localhost:" +
                    `${answers.ports.postgres}/anonify`
                  : undefined,
              },
              {
                key: "DATABASE_DRIVER",
                value: "postgres",
                comment: "Neon's serverless driver is only for Neon.",
              },
              {
                key: "TEST_DATABASE_URL",
                value: keep("TEST_DATABASE_URL"),
                comment:
                  "`pnpm test:db` creates and deletes rows — never DATABASE_URL.",
              },
            ],
          },
          {
            heading: "Object storage (RustFS, via docker compose)",
            lines: [
              { key: "STORAGE_DRIVER", value: "s3" },
              {
                key: "S3_ENDPOINT",
                value: `http://localhost:${answers.ports.rustfs}`,
              },
              { key: "S3_BUCKET", value: "anonify" },
              { key: "S3_REGION", value: "us-east-1" },
              { key: "S3_ACCESS_KEY_ID", value: "anonify" },
              { key: "S3_SECRET_ACCESS_KEY", value: "anonify-dev-secret" },
              { key: "S3_FORCE_PATH_STYLE", value: "true" },
            ],
          },
          {
            heading: "Docker Compose host ports",
            note: [
              "Only the host side. The addresses used inside the compose network",
              "are fixed and unaffected by these.",
            ],
            lines: [
              { key: "APP_PORT", value: String(answers.ports.app) },
              { key: "POSTGRES_PORT", value: String(answers.ports.postgres) },
              { key: "RUSTFS_PORT", value: String(answers.ports.rustfs) },
              {
                key: "RUSTFS_CONSOLE_PORT",
                value: String(answers.ports.rustfsConsole),
              },
            ],
          },
        ]
      : [
          {
            heading: "Database — Neon (https://neon.tech)",
            lines: [
              {
                key: "DATABASE_URL",
                value: keep("DATABASE_URL"),
                comment: "REQUIRED. The pooled connection string.",
              },
              {
                key: "TEST_DATABASE_URL",
                value: keep("TEST_DATABASE_URL"),
                comment:
                  "`pnpm test:db` creates and deletes rows — never DATABASE_URL.",
              },
            ],
          },
          {
            heading: "Object storage — Vercel Blob",
            lines: [
              {
                key: "BLOB_READ_WRITE_TOKEN",
                value: keep("BLOB_READ_WRITE_TOKEN"),
                comment: "REQUIRED. From the Vercel dashboard, Storage tab.",
              },
            ],
          },
        ]

  const ocr: EnvGroup = {
    heading: "OCR",
    note: [
      "The engine and the model it reads with are separate choices. Every model",
      "value here is one of a fixed set, checked when it was chosen — a typo in",
      "one of these is a 404 on the first scanned page, not a startup error.",
    ],
    lines:
      answers.ocr === "tesseract"
        ? [
            {
              key: "OCR_PROVIDER",
              value: "tesseract",
              comment:
                "Runs locally, no account, per-word boxes. `pnpm ocr:warm` fetches the model.",
            },
            {
              key: "OCR_TESSERACT_MODEL",
              value: answers.tesseractModel,
              comment: `One of: ${TESSERACT_MODELS.join(", ")}. ${
                TESSERACT_MODEL_DETAIL[answers.tesseractModel].summary
              }`,
              commented: answers.tesseractModel === DEFAULT_TESSERACT_MODEL,
            },
            {
              key: "OCR_TESSERACT_LANGUAGE",
              value: answers.tesseractLanguage,
              comment: "Join several with +, as in eng+deu. See .env.example.",
              commented:
                answers.tesseractLanguage === DEFAULT_TESSERACT_LANGUAGE,
            },
            {
              key: "TESSERACT_CACHE_PATH",
              value: keep("TESSERACT_CACHE_PATH"),
              comment:
                "Defaults to .cache/tesseract. A mounted volume if you run in a container.",
            },
          ]
        : [
            { key: "OCR_PROVIDER", value: "mistral" },
            {
              key: "MISTRAL_API_KEY",
              value: keep("MISTRAL_API_KEY"),
              comment:
                "REQUIRED for OCR. Mistral locates text per paragraph, so a redaction covers the block.",
            },
            {
              key: "MISTRAL_OCR_MODEL",
              value: answers.mistralOcrModel,
              comment: `One of: ${MISTRAL_OCR_MODELS.join(", ")}.`,
              commented: answers.mistralOcrModel === DEFAULT_MISTRAL_OCR_MODEL,
            },
          ],
  }

  const rest: EnvGroup[] = [
    {
      heading: "AI detection",
      note: [
        "Optional. Without a key the contextual pass is skipped and pattern",
        "detection, manual redaction, rules and export all still work.",
      ],
      lines: [
        ...AI_ENV_KEYS.filter(
          (key) => key !== "MISTRAL_API_KEY" || answers.ocr !== "mistral"
        ).map((key) => ({ key, value: answers.ai[key] ?? keep(key) })),
        {
          key: "AI_PRICE_INPUT_PER_MTOK",
          value: keep("AI_PRICE_INPUT_PER_MTOK"),
          comment:
            "USD per million tokens. Unset reports tokens and duration without a cost, and leaves the spend cap below unenforceable.",
        },
        {
          key: "AI_PRICE_OUTPUT_PER_MTOK",
          value: keep("AI_PRICE_OUTPUT_PER_MTOK"),
        },
        {
          key: SPEND_ENV_NAME,
          value: String(answers.spendCapUsd),
          comment:
            "USD per UTC day, estimated from the prices above. 0 is no cap. At 80% the gateway drops to one call at a time; at 100% the contextual pass is skipped and pattern detection carries on.",
          commented: answers.spendCapUsd === DEFAULT_DAILY_SPEND_USD,
        },
      ],
    },
    {
      heading: "Secrets — keep these",
      note: [
        "Both decode to 32 bytes. Losing ENCRYPTION_KEY makes every document",
        "already stored unreadable; there is no recovery path and there is not",
        "meant to be one.",
      ],
      lines: [
        { key: "ENCRYPTION_KEY", value: secretFor("ENCRYPTION_KEY") },
        { key: "FINGERPRINT_SECRET", value: secretFor("FINGERPRINT_SECRET") },
      ],
    },
    {
      heading: "Scheduled cleanup",
      note: [
        "Gates the expiry sweep. The container runs as production, where the",
        "endpoint refuses any request that does not carry it.",
      ],
      lines: [
        { key: "CRON_SECRET", value: secretFor("CRON_SECRET") },
        {
          key: "ANONIFY_URL",
          value: keep("ANONIFY_URL", "http://app:3000"),
          comment:
            "The app as the scheduler container sees it. host.docker.internal if it runs on the host.",
        },
        {
          key: "CLEANUP_INTERVAL_SECONDS",
          value: keep("CLEANUP_INTERVAL_SECONDS", "900"),
        },
      ],
    },
    ...limitGroups(answers),
  ]

  return renderEnv(
    answers.mode === "local"
      ? "Anonify — fully local"
      : "Anonify — demo-compatible",
    [...shared, ...services, ocr, ...rest]
  )
}

// --- flow -------------------------------------------------------------------

const HELP = `
  ${paint.bold("pnpm setup")} — write a working .env

    --local        fully local: Postgres and RustFS in Docker, Tesseract OCR
    --demo         the deployed demo's services: Neon, Vercel Blob, Mistral
    --private      just you, or a team on a private network (the default)
    --public       this instance is shared: strict limits, small allowances
    --defaults     skip the limit questions and take this profile's defaults
    --yes, -y      answer every question with its default
    --force, -f    overwrite an existing .env without asking
    --no-color     plain text
    --help, -h     this

  With no flags it asks. Every limit it can set is documented in .env.example,
  and every default it prints is read from the code that enforces it.
`

const SETUP_VERSION = (() => {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as { version?: unknown }
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "development"
  } catch {
    return process.env.npm_package_version ?? "development"
  }
})()

function banner(): void {
  say()
  say(`  ${paint.gray("┌──────────────┐")}`)
  say(`  ${paint.gray("│")} ${paint.cyan("▰▰▰▰▰▰▰▰")} ${paint.gray("│")}`)
  say(
    `  ${paint.gray("│")} ${paint.bold(paint.cyan("ANONIFY"))} ${paint.gray("│")}`
  )
  say(`  ${paint.gray("│")} ${paint.red("████  ████")} ${paint.gray("│")}`)
  say(`  ${paint.gray("└──────────────┘")}`)
  say(`  ${paint.bold(paint.cyan("Welcome to Anonify setup"))}`)
  say(
    `  ${paint.gray(`v${SETUP_VERSION} · your documents stay on this machine`)}`
  )
  note("Let's redact the sharp edges first, then get your instance running.")
  rule()
}

async function choosePorts(prompt: Prompter): Promise<Answers["ports"]> {
  const wanted = {
    app: 3000,
    postgres: 5432,
    rustfs: 9000,
    rustfsConsole: 9001,
  }

  const probe = spin("Checking whether those ports are free")
  const taken: string[] = []
  for (const [name, port] of Object.entries(wanted)) {
    if (await portInUse(port)) taken.push(`${name} (${port})`)
  }
  probe.stop()

  if (taken.length === 0) {
    ok("Ports 3000, 5432, 9000 and 9001 are free.")
    return wanted
  }

  warn(`Something is already listening on: ${taken.join(", ")}.`)
  note("A Postgres already on 5432 is the usual one, and the symptom is")
  note(
    "confusing: Compose starts fine and the app talks to the wrong database."
  )

  // Nobody to ask, so the warning is the whole contribution. Offering a
  // question whose answer is already known to be the default is noise in a log.
  if (!prompt.interactive) {
    note("Run `pnpm setup` without --yes to pick different host ports.")
    return wanted
  }

  say()
  if (!(await prompt.confirm("Choose different host ports?", true))) {
    return wanted
  }

  return {
    app: await prompt.askInteger("APP_PORT", { fallback: wanted.app }),
    postgres: await prompt.askInteger("POSTGRES_PORT", {
      fallback: wanted.postgres,
    }),
    rustfs: await prompt.askInteger("RUSTFS_PORT", { fallback: wanted.rustfs }),
    rustfsConsole: await prompt.askInteger("RUSTFS_CONSOLE_PORT", {
      fallback: wanted.rustfsConsole,
    }),
  }
}

const MODE_LABELS: Record<Mode, string> = {
  local: "fully local, Postgres and RustFS in Docker",
  demo: "the deployed demo's services",
}

const NEXT_STEPS: Record<Mode, string[]> = {
  local: [
    "docker compose up -d      # Postgres + RustFS, with the bucket created",
    "pnpm db:migrate           # apply the schema",
    "pnpm ocr:warm             # fetch the configured OCR model now, not mid-redaction",
    "pnpm dev                  # http://localhost:3000",
  ],
  demo: [
    "Fill in the REQUIRED values in .env",
    "pnpm db:migrate           # apply the schema to your Neon database",
    "pnpm dev                  # http://localhost:3000",
  ],
}

async function runCommand(
  command: string,
  args: string[],
  description: string
): Promise<boolean> {
  say()
  note(`${description} …`)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: "inherit", shell: true })
      child.once("error", reject)
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`command exited with status ${code ?? "unknown"}`))
      )
    })
    ok(description)
    return true
  } catch (error) {
    warn(
      `${description} failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

async function finishSetup(
  prompt: Prompter,
  mode: Mode,
  ocr: "tesseract" | "mistral"
): Promise<void> {
  if (!prompt.interactive) return

  const action = await prompt.choose("What would you like to do next?", [
    {
      value: "print",
      label: "Print the next steps and exit",
      detail: ["You can run them whenever you are ready."],
    },
    ...(mode === "local"
      ? [
          {
            value: "complete",
            label: "Finish local setup",
            detail: ["Start services, migrate the database, and warm OCR."],
          },
          {
            value: "start",
            label: "Finish setup and run the app",
            detail: [
              "Also starts pnpm dev after the local services are ready.",
            ],
          },
        ]
      : []),
  ])
  if (action === "print") return

  const steps = [
    ["docker", ["compose", "up", "-d"], "Started Postgres and RustFS"] as const,
    ["pnpm", ["db:migrate"], "Applied database migrations"] as const,
    ...(ocr === "tesseract"
      ? [["pnpm", ["ocr:warm"], "Warmed the OCR model"] as const]
      : []),
  ]
  for (const [command, args, description] of steps) {
    if (!(await runCommand(command, [...args], description))) {
      note("The remaining commands are printed below so you can retry them.")
      return
    }
  }
  if (action === "start") {
    await runCommand("pnpm", ["dev"], "Started the Anonify app")
  }
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2))

  if (argv.has("--help") || argv.has("-h")) {
    say(HELP)
    return
  }
  if (argv.has("--no-color")) setColor(false)

  const assumeYes = argv.has("--yes") || argv.has("-y")
  const interactive = Boolean(process.stdin.isTTY) && !assumeYes
  const prompt = new Prompter(interactive)

  // Ctrl-C during a question leaves the terminal in a strange state unless the
  // interface is closed, and an unexplained exit reads as a crash.
  const onInterrupt = () => {
    prompt.close()
    say()
    note("Stopped. Nothing was written.")
    say()
    process.exit(130)
  }
  process.on("SIGINT", onInterrupt)

  try {
    banner()

    // Resolve reuse before asking for provider credentials; a rerun must show
    // the operator's current provider/model and never restore an old choice later.
    let kept = new Map<string, string>()
    if (existsSync(ENV_PATH)) {
      const existing = await readFile(ENV_PATH, "utf8")
      const values = parseEnv(existing)
      const hasValues = [...values.values()].some((value) => value.length > 0)
      if (
        hasValues &&
        !argv.has("--force") &&
        !argv.has("-f") &&
        !(await prompt.confirm("Overwrite the existing .env?", false))
      ) {
        note("Left .env alone. Nothing was changed.")
        return
      }
      if (hasValues) {
        if (
          await prompt.confirm(
            "Reuse the secrets and keys already in it?",
            true
          )
        )
          kept = values
        await writeFile(`${ENV_PATH}.backup`, existing, {
          encoding: "utf8",
          mode: 0o600,
        })
        ok("Previous .env copied to .env.backup")
      }
    }

    if (!interactive && !assumeYes) {
      note("stdin is not a terminal, so every question takes its default.")
    }

    // 1. How to run it.
    step(1, STEPS, "How would you like to run Anonify?")
    const flagged: Mode | null = argv.has("--demo")
      ? "demo"
      : argv.has("--local")
        ? "local"
        : null
    if (flagged) note(`--${flagged}: ${MODE_LABELS[flagged]}.`)

    const mode: Mode =
      flagged ??
      (await prompt.choose<Mode>(
        "Choose",
        [
          {
            value: "local",
            label: "Fully local",
            detail: [
              "Postgres and RustFS through Docker Compose, Tesseract for OCR.",
              "No accounts, no API keys, nothing leaves your machine.",
            ],
          },
          {
            value: "demo",
            label: "Demo-compatible",
            detail: [
              "The same services as the deployed demo: Neon, Vercel Blob",
              "and Mistral OCR. You provide your own keys.",
            ],
          },
        ],
        0
      ))

    // 2. Who can reach it. Asked before the limits because it chooses every
    //    default underneath them, and asked separately from the services
    //    because they are genuinely different questions: which database you
    //    use says nothing about who can reach the instance. Conflating the two
    //    is how a self-hosted install on Neon ended up with a shared demo's
    //    quotas and refused an ordinary spreadsheet.
    step(2, STEPS, "Who can reach this instance?")
    const flaggedProfile: Profile | null = argv.has("--public")
      ? "demo"
      : argv.has("--private")
        ? "self-hosted"
        : null
    if (flaggedProfile) {
      note(
        `--${flaggedProfile === "demo" ? "public" : "private"}: ${
          flaggedProfile === "demo"
            ? "strict limits and small daily allowances"
            : "generous limits, no daily quotas"
        }.`
      )
    }

    const profile: Profile =
      flaggedProfile ??
      (await prompt.choose<Profile>(
        "Choose",
        [
          {
            value: "self-hosted",
            label: "Just me, or my team on a private network",
            detail: [
              "Generous rate limits and no daily quotas at all.",
              "There is nobody to ration against.",
            ],
          },
          {
            value: "demo",
            label: "It is public and shared",
            detail: [
              "Strict rate limits and small daily allowances, so one visitor's",
              "workbook cannot be everyone's budget.",
            ],
          },
        ],
        0
      ))

    // 3. Services.
    step(3, STEPS, "Services")
    const ports =
      mode === "local"
        ? await choosePorts(prompt)
        : { app: 3000, postgres: 5432, rustfs: 9000, rustfsConsole: 9001 }

    const ocr =
      mode === "local"
        ? "tesseract"
        : await prompt.choose<"tesseract" | "mistral">(
            "Which OCR provider?",
            [
              {
                value: "tesseract",
                label: "Tesseract",
                detail: [
                  "Local, no account, and gives per-word boxes — so a redaction",
                  "covers the exact characters it matched.",
                ],
              },
              {
                value: "mistral",
                label: "Mistral",
                detail: [
                  "Reads difficult scans better, but locates text per paragraph,",
                  "so a redaction covers the whole block.",
                ],
              },
            ],
            0
          )

    // The model each engine reads with. A validated list rather than free
    // text: the answer ends up in a compose file, and a typo there is a
    // container that starts and then fails on the first scanned page.
    const tesseractModel =
      ocr === "tesseract"
        ? await askTesseractModel(prompt)
        : DEFAULT_TESSERACT_MODEL
    const tesseractLanguage =
      ocr === "tesseract"
        ? await askTesseractLanguage(prompt)
        : DEFAULT_TESSERACT_LANGUAGE
    const mistralOcrModel =
      ocr === "mistral"
        ? await askMistralOcrModel(prompt)
        : DEFAULT_MISTRAL_OCR_MODEL

    const ai = await askAiProvider(
      prompt,
      {
        ...Object.fromEntries(kept),
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined)
        ),
      },
      mode === "local"
    )
    // The same provider determines defaults shown here and enforced at runtime.
    process.env.AI_PROVIDER = ai.AI_PROVIDER || "gateway"
    if (ai.MISTRAL_API_KEY) kept.set("MISTRAL_API_KEY", ai.MISTRAL_API_KEY)

    // 4. Limits.
    step(4, STEPS, "Limits")
    const skipLimits = argv.has("--defaults")

    if (skipLimits) {
      note("--defaults: taking this profile's limits, written into .env as")
      note("commented lines so they are there to change later.")
    } else {
      note("Every default below is read from the code that enforces it, so")
      note("what you see here is what is actually in force.")
    }

    const quotas = skipLimits ? {} : await askQuotas(prompt, profile)
    const rates = skipLimits ? {} : await askRates(prompt, profile)
    const services = skipLimits ? {} : await askServiceLimits(prompt, { ocr })
    const spendCapUsd = skipLimits
      ? DEFAULT_DAILY_SPEND_USD
      : await askSpendCap(prompt)
    const eml = skipLimits ? {} : await askEmlLimits(prompt)
    const expansion = skipLimits ? {} : await askExpansionLimits(prompt)
    const mbox = skipLimits ? {} : await askMboxLimits(prompt, profile)
    const batch = skipLimits ? {} : await askBatchLimits(prompt, profile)

    // 5. Write.
    step(5, STEPS, "Writing .env")

    const contents = buildEnv(
      {
        mode,
        profile,
        ports,
        ocr,
        tesseractModel,
        tesseractLanguage,
        mistralOcrModel,
        ai,
        services,
        spendCapUsd,
        quotas,
        rates,
        eml,
        expansion,
        mbox,
        batch,
      },
      kept
    )

    let written = new Map<string, string>()
    const writing = spin("Writing .env and reading it back")
    try {
      // Through a temporary file: an interrupted write over the real one is a
      // truncated .env, and the value most likely to be lost that way is the
      // encryption key.
      await writeFile(`${ENV_PATH}.tmp`, contents, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(`${ENV_PATH}.tmp`, ENV_PATH)

      written = parseEnv(await readFile(ENV_PATH, "utf8"))
      for (const required of ["ENCRYPTION_KEY", "FINGERPRINT_SECRET"]) {
        if (!decodesTo32Bytes(written.get(required) ?? "")) {
          throw new Error(`${required} did not survive the write`)
        }
      }
      writing.succeed("Wrote .env")
    } catch (error) {
      writing.fail("Could not write .env")
      throw error
    }

    // --- what it did.
    say()
    say(`  ${paint.bold("What this instance is")}`)
    say()
    setting("Setup", mode === "local" ? "fully local" : "demo-compatible")
    setting("Profile", profile === "demo" ? "public and shared" : "self-hosted")
    setting(
      "OCR",
      ocr === "tesseract"
        ? `${ocr} · ${tesseractModel} · ${tesseractLanguage}`
        : `${ocr} · ${mistralOcrModel}`
    )
    setting("AI provider", ai.AI_PROVIDER || "gateway")
    setting("AI model", ai.AI_MODEL || "built-in default", {
      defaulted: !ai.AI_MODEL,
    })
    setting(
      "AI spend cap",
      spendCapUsd > 0 ? `$${spendCapUsd} per UTC day` : "none",
      { defaulted: spendCapUsd === DEFAULT_DAILY_SPEND_USD }
    )

    const changed = [
      ...Object.keys(quotas),
      ...Object.keys(rates),
      ...Object.values(services).flatMap((limits) => Object.keys(limits)),
      ...Object.keys(eml),
      ...Object.keys(expansion),
    ].length
    setting(
      "Limits",
      changed === 0
        ? "profile defaults, written down in .env"
        : `${changed} changed from the defaults`,
      { defaulted: changed === 0 }
    )
    setting(
      "Secrets",
      kept.size > 0 ? "reused from the previous .env" : "generated"
    )

    // Read back from the file rather than assumed from the mode: a value
    // carried over from a previous run is not still needed, and listing it as
    // though it were sends somebody to a dashboard for a token they already
    // have.
    const missing = [
      ["DATABASE_URL", "a connection string for your database"],
      ...(mode === "demo"
        ? [["BLOB_READ_WRITE_TOKEN", "a Vercel Blob token"] as const]
        : []),
      ...(ocr === "mistral" ? [["MISTRAL_API_KEY", "for OCR"] as const] : []),
    ].filter(([key]) => !written.get(key))

    if (missing.length > 0) {
      say()
      warn("Still needed — this script cannot generate them:")
      for (const [key, what] of missing) {
        bullet(`${paint.bold(key.padEnd(22))} ${paint.gray(what)}`)
      }
    }

    // A cap computed from prices nobody set is a cap that does nothing, and
    // silently doing nothing is exactly what a spend limit must not do.
    if (
      spendCapUsd > 0 &&
      !(
        written.get("AI_PRICE_INPUT_PER_MTOK") &&
        written.get("AI_PRICE_OUTPUT_PER_MTOK")
      )
    ) {
      say()
      warn(
        `${SPEND_ENV_NAME} is set but the prices it is computed from are not.`
      )
      note(
        "Set AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK, or the cap"
      )
      note("cannot be enforced and the app will say so on every document.")
    }

    say()
    say(`  ${paint.bold("Next")}`)
    say()
    for (const line of NEXT_STEPS[mode]) say(`    ${paint.gray(line)}`)
    await finishSetup(prompt, mode, ocr)
    say()
    note("Every variable, with its units and why it exists: .env.example")
    note("The full walkthrough: README.md")
    say()
  } finally {
    process.off("SIGINT", onInterrupt)
    prompt.close()
  }
}

main().catch((error: unknown) => {
  say()
  fail(error instanceof Error ? error.message : String(error))
  say()
  process.exitCode = 1
})
