import type { TextSpan } from "@/types/document"

/**
 * Accumulates spans into a page's flat text stream, keeping every span's
 * offsets pointing at the exact characters it contributed. Offsets are how a
 * detection made against the normalized text finds its way back to a run, a
 * cell or a glyph box at export time.
 */
export class TextStreamBuilder {
  private buffer = ""
  private readonly collected: TextSpan[] = []

  get length(): number {
    return this.buffer.length
  }

  append(
    id: string,
    text: string,
    extra: Omit<TextSpan, "id" | "text" | "start" | "end"> = {}
  ): TextSpan {
    const start = this.buffer.length
    this.buffer += text
    const span: TextSpan = { id, text, start, end: this.buffer.length, ...extra }
    this.collected.push(span)
    return span
  }

  /** Separator text that belongs to no span (spaces, newlines between runs). */
  pad(text: string): void {
    this.buffer += text
  }

  get text(): string {
    return this.buffer
  }

  get spans(): TextSpan[] {
    return this.collected
  }
}

/** Case- and whitespace-folded form used for local entity matching. */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}
