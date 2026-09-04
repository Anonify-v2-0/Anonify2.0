/**
 * Reading a failed response the way a person needs to hear it.
 *
 * Every mutation in the editor used to answer a failure with the same sentence
 * — "That change could not be saved" — no matter what the server said. A rate
 * limit is the case where that hurts most: the server knows exactly what
 * happened and exactly how long the wait is, and all of it was being thrown
 * away in favour of a shrug.
 */

export type ApiFailure = {
  message: string
  status: number
  /** True when the request was refused for pace or volume, not correctness. */
  rateLimited: boolean
  retryAfterSeconds?: number
}

export async function readFailure(
  response: Response,
  fallback: string
): Promise<ApiFailure> {
  let payload: {
    error?: string
    rateLimited?: boolean
    retryAfterSeconds?: number
  } = {}

  try {
    payload = (await response.json()) as typeof payload
  } catch {
    // A failure with no body is still a failure; the status carries it.
  }

  const rateLimited = response.status === 429 || payload.rateLimited === true

  return {
    message: payload.error?.trim() || fallback,
    status: response.status,
    rateLimited,
    retryAfterSeconds:
      payload.retryAfterSeconds ??
      (Number(response.headers.get("retry-after")) || undefined),
  }
}

/** Reports a failed response, saying what the server said. */
export async function toastFailure(
  toast: { error: (message: string) => void },
  response: Response,
  fallback: string
): Promise<ApiFailure> {
  const failure = await readFailure(response, fallback)
  toast.error(failure.message)
  return failure
}
