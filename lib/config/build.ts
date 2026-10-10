/**
 * Which build this process is running (#178).
 *
 * `ANONIFY_BUILD_ID` is set when the image is built: the release version and
 * short commit for a published image, `dev` for one built locally. The same
 * value is the Next.js `deploymentId` (see next.config.ts), so two replicas
 * that disagree about it are two versions, and a browser that loaded one is
 * reloaded rather than handed the other's assets. It is reported by
 * /api/health and in the startup log, so an operator can see which version a
 * replica runs.
 */
export function buildId(): string {
  return process.env.ANONIFY_BUILD_ID?.trim() || "dev"
}

/**
 * The release this image was built as (`ANONIFY_BUILD_VERSION`, from the
 * release job's version), or "dev". For the metrics' `build_info` (#188).
 */
export function buildVersion(): string {
  return process.env.ANONIFY_BUILD_VERSION?.trim() || "dev"
}
