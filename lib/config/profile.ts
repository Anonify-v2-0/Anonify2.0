/**
 * Which kind of deployment this is.
 *
 * A shared demo rations one endpoint against everybody; a self-hosted install
 * is one person's machine with nobody to ration against. Several unrelated
 * settings — rate limits, daily quotas, batch size and concurrency — pick their
 * defaults from this one answer.
 *
 * It lives on its own, with no imports at all, and that is load-bearing rather
 * than tidy. It used to live in lib/security/rate-limit-config.ts, which reads
 * the database; anything wanting to know the profile therefore pulled a Prisma
 * client in behind it, and the workflow compiler refuses a Node.js dependency
 * reached from inside a workflow function. Asking "what kind of install is
 * this" should not require a database, and now it does not.
 */

export const PROFILES = ["demo", "self-hosted"] as const

export type Profile = (typeof PROFILES)[number]

/** Anything but an explicit `demo` is treated as somebody's own machine. */
export function activeProfile(): Profile {
  const raw = process.env.ANONIFY_PROFILE?.trim().toLowerCase()
  return raw === "demo" ? "demo" : "self-hosted"
}
