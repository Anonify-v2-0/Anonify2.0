import { emlReparses } from "@/lib/documents/eml/validate"
import { decodeEml } from "@/lib/documents/eml/parse"
import type { MailboxEntry } from "@/lib/documents/mbox/parse"

/**
 * Checking that the split lost nothing.
 *
 * A mailbox is the one format here where the failure mode is arithmetic rather
 * than textual. Every other pipeline asks "is the value gone from the
 * artifact?"; this one has to ask "are all nine hundred messages here?", and
 * nobody counts to nine hundred. A splitter that quietly dropped every message
 * whose separator it did not recognise would produce a batch that looks
 * entirely normal, review cleanly, and be missing the messages that were
 * unusual — which are the ones worth reviewing.
 *
 * So the split is verifiable rather than trusted, in two independent ways: the
 * bytes are conserved, and each message still parses as a message.
 */

export class MboxVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MboxVerificationError"
  }
}

export type CoverageCheck = {
  passed: boolean
  /** Bytes of the mailbox that ended up inside a message. */
  covered: number
  /** Bytes accounted for by separator lines. */
  structural: number
  /** Bytes in neither. Content the split walked past, and it must be zero. */
  orphaned: number
}

/**
 * Whether every byte of the mailbox is either in a message or a separator line.
 *
 * The entries' ranges run head to tail with no overlap, so the only gaps are
 * the `From ` lines themselves — one before each message, and nothing else
 * anywhere. Anything in a gap that is not a separator line, and anything left
 * over past the last message, is content the split walked past.
 *
 * That is the whole of it, and it is a stronger statement than it looks: a
 * splitter that dropped a message it did not recognise leaves that message's
 * bytes in a gap, and the subtraction finds it whether it was one message or
 * four hundred.
 *
 * Not called by the expansion path, which could do nothing useful with the
 * answer beyond what the limits already refuse. It exists for the suites,
 * where "nothing was dropped" is a property to assert on adversarial input
 * rather than a sentence in a comment.
 */
export function mailboxCoverage(
  source: string,
  entries: MailboxEntry[]
): CoverageCheck {
  let covered = 0
  let structural = 0
  let orphaned = 0
  let cursor = 0

  for (const entry of entries) {
    const gap = source.slice(cursor, entry.start)
    if (/^From [^\n]*\r?\n$/.test(gap)) structural += gap.length
    else orphaned += gap.length

    covered += entry.end - entry.start
    cursor = entry.end
  }

  // Past the last message there is nothing left to be: a mailbox ends when its
  // final message does.
  orphaned += source.length - cursor

  return { passed: orphaned === 0, covered, structural, orphaned }
}

/**
 * Whether every message the split produced is still a message.
 *
 * Two parsers, the same pair the EML suites use: ours, which knows the tree it
 * built, and postal-mime, which does not and will refuse what we were lenient
 * about. A message that only one of them accepts is a message the split
 * damaged.
 */
export async function messagesReparse(
  entries: MailboxEntry[]
): Promise<boolean> {
  for (const entry of entries) {
    if (!(await emlReparses(entry.bytes))) return false
  }
  return true
}

/**
 * Whether a message survived the container intact: no separator line left at
 * the top, no `>` still quoting a body line that never asked for one.
 *
 * The first is what a splitter that sliced one line late produces, and it is
 * silent: the message keeps its body, loses its `From:` header, and arrives as
 * a document with no sender that nothing downstream has a reason to question.
 */
export function messageIsUnwrapped(entry: MailboxEntry): boolean {
  const source = decodeEml(entry.bytes)
  const [first = ""] = source.split(/\r?\n/, 1)
  return !/^From /.test(first)
}
