/**
 * Sending an upload's bytes from the page: through our own route, or straight
 * to the bucket. Kept apart from the panel so the fallback from one to the
 * other can be tested without rendering anything.
 */

/** A request that got no answer, as opposed to one that was refused. */
export class UploadNetworkError extends Error {
  constructor() {
    super("Upload failed")
    this.name = "UploadNetworkError"
  }
}

/**
 * Sends a body with XMLHttpRequest, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch still cannot report upload progress
 * in browsers, and a 25 MB upload with no feedback looks like a hang.
 */
export function sendWithProgress(input: {
  method: "POST" | "PUT"
  url: string
  body: XMLHttpRequestBodyInit
  headers?: Record<string, string>
  onProgress: (percentage: number) => void
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(input.method, input.url)
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      request.setRequestHeader(name, value)
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        input.onProgress((event.loaded / event.total) * 100)
      }
    })

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.responseText)
        return
      }

      let message = "Upload failed"
      try {
        message =
          (JSON.parse(request.responseText) as { error?: string }).error ??
          message
      } catch {
        // Keep the generic message. A storage service answers in XML, and
        // nothing in it is written for the person uploading.
      }
      reject(new Error(message))
    })

    // No answer at all: the connection failed, or — for a bucket — the
    // browser refused the response because CORS did not allow it. The two
    // look the same from here, by design.
    request.addEventListener("error", () => reject(new UploadNetworkError()))
    request.addEventListener("abort", () =>
      reject(new Error("Upload cancelled"))
    )

    request.send(input.body)
  })
}

/**
 * PUTs the bytes through our own route, which streams them to storage (#185).
 *
 * The body is the file and nothing else, so the browser sends its length up
 * front and the route can refuse it before reading any of it.
 */
export async function uploadThroughServer(
  documentId: string,
  body: Blob,
  onProgress: (percentage: number) => void,
  fallback?: "presigned-network-error"
): Promise<{ url: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }
  if (fallback) headers["x-anonify-upload-fallback"] = fallback

  const response = await sendWithProgress({
    method: "PUT",
    url: `/api/upload/local?documentId=${encodeURIComponent(documentId)}`,
    body,
    headers,
    onProgress,
  })
  try {
    return JSON.parse(response) as { url: string }
  } catch {
    throw new Error("Malformed upload response")
  }
}

/**
 * PUTs straight into the bucket with a URL the server presigned for this one
 * object and exactly this many bytes.
 *
 * When that PUT gets no answer at all — a bucket without the CORS rule, almost
 * always — the upload is tried once more through our own route, which says so
 * in the server's log. A misconfigured bucket then costs an operator a warning
 * rather than costing every user their upload. A bucket that answers and
 * refuses is not retried: that is a real answer, and the route would not
 * change it.
 */
export async function uploadStraightToStorage(
  documentId: string,
  body: Blob,
  onProgress: (percentage: number) => void
): Promise<{ url: string }> {
  const presign = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, size: body.size }),
  })
  const signed = (await presign.json()) as {
    url?: string
    headers?: Record<string, string>
    handle?: string
    error?: string
  }
  if (!presign.ok || !signed.url || !signed.handle) {
    throw new Error(signed.error ?? "Upload failed")
  }

  try {
    await sendWithProgress({
      method: "PUT",
      url: signed.url,
      body,
      headers: signed.headers,
      onProgress,
    })
  } catch (error) {
    if (!(error instanceof UploadNetworkError)) throw error
    onProgress(0)
    return uploadThroughServer(
      documentId,
      body,
      onProgress,
      "presigned-network-error"
    )
  }
  return { url: signed.handle }
}
