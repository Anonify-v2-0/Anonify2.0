import { attachedEml, EML, type AttachmentSpec } from "./eml-fixtures"

/**
 * Mailboxes built by hand, byte by byte.
 *
 * Same rule as the message fixtures: the interesting ones are shapes no
 * well-behaved exporter would produce, and a fixture that can only be built by
 * a correct writer tests the happy path twice. So there are mailboxes here
 * with a `From ` line in a body, with a message that has no body at all, with
 * two messages claiming the same `Message-ID`, and with a mailbox inside a
 * mailbox.
 *
 * CRLF throughout, because that is what messages use.
 */

function crlf(lines: string[]): string {
  return lines.join("\r\n")
}

/**
 * The separator line, in the shape real exporters write it.
 *
 * The envelope sender varies on purpose across the fixtures — an address,
 * `MAILER-DAEMON`, and the bare `-` Thunderbird uses — because all three are
 * real and a splitter that only knows the first one works on one person's
 * archive.
 */
export function fromLine(sender = "dickens@example.com", day = 2): string {
  return `From ${sender} Fri Jan ${String(day).padStart(2, " ")} 03:04:05 2026`
}

/** Guarantees the message ends where a mailbox expects it to. */
function terminated(message: string): string {
  return message.endsWith("\r\n") ? message : `${message}\r\n`
}

/**
 * A mailbox holding these messages, in this order.
 *
 * Each message gets a separator, and each is followed by the blank line the
 * format terminates a message with — including the last one, which is what a
 * real exporter writes and which the splitter has to trim rather than hand on.
 */
export function mailbox(
  messages: string[],
  options: { senders?: string[] } = {}
): string {
  return messages
    .map((message, index) => {
      const sender = options.senders?.[index] ?? "dickens@example.com"
      return `${fromLine(sender, (index % 28) + 1)}\r\n${terminated(message)}\r\n`
    })
    .join("")
}

/** An ordinary message, numbered so a mailbox of them is distinguishable. */
export function numberedMessage(
  index: number,
  overrides: { messageId?: string | null; body?: string } = {}
): string {
  const messageId =
    overrides.messageId === null
      ? null
      : (overrides.messageId ?? `<msg-${index}@mail.example.com>`)

  return crlf([
    `From: ${EML.person} <${EML.email}>`,
    `To: ${EML.colleague} <${EML.colleagueEmail}>`,
    `Subject: Message number ${index}`,
    "Date: Mon, 3 Mar 2026 09:14:02 +0000",
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    overrides.body ?? `You can reach ${EML.person} on ${EML.phone}.`,
    "",
  ])
}

/**
 * The classic hazard: a body that talks about where things came from.
 *
 * Three lines that a naive splitter fractures on. The first is escaped the way
 * an exporter escapes it and has to come back unescaped; the second is
 * unescaped and merely starts with the word; the third is a full separator
 * line quoted inside a paragraph, which is the one that would actually cut the
 * message in half if the blank-line rule were not enforced.
 */
export function quotingHazardMessage(): string {
  return crlf([
    `From: ${EML.person} <${EML.email}>`,
    "Subject: Where it came from",
    "Date: Mon, 3 Mar 2026 09:14:02 +0000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    ">From the top, then: the numbers are wrong.",
    "From what I can tell nobody checked them.",
    `The header in the export reads ${fromLine("someone@example.com")} and`,
    "that is where the confusion started.",
    ">>From the archive I pulled last week, same thing.",
    "",
  ])
}

/** Headers and nothing else — a message whose body is empty. */
export function bodylessMessage(index: number): string {
  return crlf([
    `From: ${EML.person} <${EML.email}>`,
    `Subject: Nothing to say ${index}`,
    "Date: Mon, 3 Mar 2026 09:14:02 +0000",
    `Message-ID: <empty-${index}@mail.example.com>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "",
  ])
}

/** A message that is nothing but its enclosures. */
export function attachmentOnlyMessage(attachments: AttachmentSpec[]): string {
  return attachedEml(attachments)
}

/**
 * A message carrying a mailbox as an attachment: a forwarded archive.
 *
 * The second recursion axis. The inner mailbox is a perfectly ordinary one,
 * and the only thing that stops it expanding forever is the depth limit.
 */
export function forwardedMailboxMessage(inner: string): string {
  return attachedEml([
    {
      filename: "archive.mbox",
      contentType: "application/mbox",
      bytes: new Uint8Array(Buffer.from(inner, "latin1")),
    },
  ])
}

/** A mailbox of `count` ordinary messages. */
export function mailboxOf(count: number): string {
  return mailbox(
    Array.from({ length: count }, (_, index) => numberedMessage(index + 1))
  )
}
