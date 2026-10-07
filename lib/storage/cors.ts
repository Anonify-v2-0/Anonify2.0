/**
 * Whether a bucket's CORS rules let a browser PUT a presigned upload (#185).
 *
 * A direct upload needs the bucket to answer the browser's preflight: PUT,
 * from the app's own origin, with the headers the URL was signed with. When
 * it does not, the browser reports a network error and nothing more, so the
 * server never hears of it. /api/ready reads the rules and says, in the
 * operator's log, exactly what is missing.
 *
 * S3 and Azure express a rule differently but mean the same thing, so each
 * driver turns its own shape into this one and the matching lives here.
 */

/** The rules were read, and they would refuse the upload. */
export class CorsRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CorsRefusal"
  }
}

export type CorsRule = {
  origins: string[]
  methods: string[]
  headers: string[]
}

/**
 * A CORS pattern: `*`, an exact value, or a value with one `*` in it, as S3
 * allows for origins (`https://*.example.org`) and both allow for headers
 * (`x-amz-*`, `x-ms-meta-*`). Compared without case, as both services do.
 */
function matches(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase()
  const v = value.toLowerCase()
  if (p === "*") return true
  const star = p.indexOf("*")
  if (star === -1) return p === v
  const head = p.slice(0, star)
  const tail = p.slice(star + 1)
  return (
    v.length >= head.length + tail.length &&
    v.startsWith(head) &&
    v.endsWith(tail)
  )
}

/**
 * Null when one rule allows the upload, or a sentence saying what no rule
 * does: the closest a rule came, so the fix is one change rather than a hunt.
 */
export function corsRefusal(
  rules: CorsRule[],
  origin: string,
  headers: string[]
): string | null {
  if (rules.length === 0) {
    return "The bucket has no CORS rules, so browsers cannot PUT to it."
  }

  const allows = {
    origin: (rule: CorsRule) => rule.origins.some((o) => matches(o, origin)),
    method: (rule: CorsRule) => rule.methods.some((m) => matches(m, "PUT")),
    headers: (rule: CorsRule) =>
      headers.every((h) => rule.headers.some((a) => matches(a, h))),
  }
  if (
    rules.some((r) => allows.origin(r) && allows.method(r) && allows.headers(r))
  )
    return null

  const forOrigin = rules.filter(allows.origin)
  if (forOrigin.length === 0) {
    return `No CORS rule allows the origin ${origin}.`
  }
  const withPut = forOrigin.filter(allows.method)
  if (withPut.length === 0) {
    return `The CORS rule for ${origin} does not allow PUT.`
  }
  return `The CORS rule for ${origin} does not allow the headers ${headers.join(", ")}.`
}
