import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

/**
 * OpenTelemetry traces, when an endpoint is configured (#188).
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 * turns it on: Next.js's own spans for each request and route, and the
 * workflow runtime's span for each step and attempt, exported over OTLP/HTTP
 * (protobuf, or JSON with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`).
 * `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` are read as usual.
 *
 * The same rule as the metrics: nothing from a document leaves in a span. A
 * step that fails records its error's message, and a parser's error message
 * is not guaranteed to be free of the text it was parsing (see
 * lib/workflows/failure.ts). So every span passes through `scrubSpan` before
 * export: messages and stack traces are dropped, and URLs lose their query
 * strings, which can carry a signed token.
 */

type Env = Record<string, string | undefined>

type Attributes = ReadableSpan["attributes"]

/** Keys whose values may carry text from a document, or a stack. */
const DROPPED = /(^|\.)(message|stacktrace|statement|query\.text)$/i
/** Keys holding a URL, kept without its query string. */
const URLS = /(^|\.)(url|url\.full|target|http\.url|http\.target)$/i

export function scrubAttributes(
  attributes: Attributes | undefined
): Attributes {
  const clean: Attributes = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (DROPPED.test(key)) continue
    if (key === "url.query") continue
    if (URLS.test(key) && typeof value === "string") {
      clean[key] = value.split("?")[0]
      continue
    }
    clean[key] = value
  }
  return clean
}

/** The span as it may leave the process. */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  const copy = Object.create(span) as ReadableSpan
  Object.defineProperties(copy, {
    attributes: { value: scrubAttributes(span.attributes) },
    events: {
      value: span.events.map((event) => ({
        ...event,
        attributes: scrubAttributes(event.attributes),
      })),
    },
    // An error status carries the error's message too.
    status: { value: { code: span.status.code } },
  })
  return copy
}

/** Wraps an exporter so nothing it sends was not scrubbed first. */
export class ScrubbingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    done: Parameters<SpanExporter["export"]>[1]
  ): void {
    this.inner.export(spans.map(scrubSpan), done)
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}

/** Where traces go: the traces endpoint, else the base one plus /v1/traces. */
export function tracesEndpoint(env: Env = process.env): string | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (traces) return traces
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!base) return undefined
  return `${base.replace(/\/+$/, "")}/v1/traces`
}

/** `OTEL_EXPORTER_OTLP_HEADERS`: `key=value,key2=value2`, values URL-encoded. */
export function otlpHeaders(env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = {}
  const raw =
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS
  for (const pair of raw?.split(",") ?? []) {
    const at = pair.indexOf("=")
    if (at <= 0) continue
    headers[pair.slice(0, at).trim()] = decodeURIComponent(
      pair.slice(at + 1).trim()
    )
  }
  return headers
}

/**
 * Registers the tracer, when an endpoint is set. Called first in
 * instrumentation.ts, so the spans of everything after it are recorded.
 * Returns whether it did.
 */
export async function startTracing(
  attributes: Record<string, string>,
  env: Env = process.env
): Promise<boolean> {
  const url = tracesEndpoint(env)
  if (!url) return false

  const otel = await import("@vercel/otel")
  const headers = otlpHeaders(env)
  const protocol = (
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL
  )?.trim()
  const exporter =
    protocol === "http/json"
      ? new otel.OTLPHttpJsonTraceExporter({ url, headers })
      : new otel.OTLPHttpProtoTraceExporter({ url, headers })

  otel.registerOTel({
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "anonify",
    attributes,
    traceExporter: new ScrubbingExporter(exporter),
  })
  return true
}
