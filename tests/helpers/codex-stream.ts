/**
 * An answer from the ChatGPT Codex backend, in the shape the real one sends.
 *
 * Recorded against the live backend (2026-09-27, `store: false`): the answer
 * arrives only in the streamed events, and `response.completed` carries the
 * response with `output: []` and a usage block that also holds per-item
 * attribution. The first fakes put the answer inside `response.completed`,
 * which the real backend does not, so the tests passed while every real
 * verification failed with "answered, but not with JSON". Every test that
 * fakes this backend uses this, so that cannot happen again.
 */
export function codexStream(
  model: string,
  text: string,
  usage: { input: number; output: number } = { input: 18, output: 8 }
): Response {
  const messageId = "msg_fixture"
  const item = {
    id: messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", annotations: [], text }],
  }
  const response = (status: string) => ({
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status,
    model,
    output: [],
    usage:
      status === "completed"
        ? {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
            attribution: {
              items: {
                [messageId]: {
                  cache_write_tokens: 0,
                  cached_tokens: 0,
                  input_tokens: usage.input,
                },
              },
            },
          }
        : null,
  })
  // Split like the real stream, which sends the text in several deltas.
  const third = Math.ceil(text.length / 3)
  const deltas = [0, 1, 2]
    .map((index) => text.slice(index * third, (index + 1) * third))
    .filter(Boolean)
  const events = [
    { type: "response.created", response: response("in_progress") },
    { type: "response.in_progress", response: response("in_progress") },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    },
    ...deltas.map((delta) => ({
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", annotations: [], text },
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: response("completed") },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(""),
    // The real backend sends no content type on this stream.
    { status: 200 }
  )
}
