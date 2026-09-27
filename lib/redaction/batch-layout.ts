import { baseName } from "@/lib/redaction/archive"
import type { DocumentKind } from "@/types/document"

/**
 * Where each file in a batch download goes.
 *
 * A batch is flat in the database — every document is a row with a batch id —
 * but it was not flat when it arrived. A mailbox became nine hundred messages,
 * a message became a covering note and three enclosures, and each child
 * records the parent it came out of and where in it (`parentDocumentId`,
 * `sourcePartPath`). This file turns those two columns back into the shape the
 * reviewer uploaded, and it is a pure function of them: no storage, no
 * database, nothing that could disagree between the pass that decides what
 * goes in a download and the pass that writes it.
 *
 * It answers for the two things a reviewer can ask for:
 *
 *   - **the original format**: one file per thing that was uploaded, a
 *     mailbox as a mailbox and a message carrying its own enclosures;
 *   - **the processed files**: every document's own output, in folders that
 *     mirror where it came from.
 *
 * **Folders are named by position, never by content.** A top-level upload is
 * named after its own filename, which the reviewer chose and already knows.
 * Everything under it is named by message number and MIME part path — never
 * by subject, never by an attachment's filename — because both are regularly
 * the personal data the batch exists to remove, and a folder name ends up on a
 * disk, in a zip listing and in a file manager's recent items.
 */

export const BATCH_OUTPUTS = ["original", "processed", "both"] as const

/** What the reviewer asked to download. */
export type BatchOutput = (typeof BATCH_OUTPUTS)[number]

/**
 * The original format, because that is the thing that was uploaded: someone
 * who handed over `inbox.mbox` wants `inbox-redacted.mbox` back, not nine
 * hundred loose messages and every attachment twice.
 */
export const DEFAULT_BATCH_OUTPUT: BatchOutput = "original"

export function isBatchOutput(value: unknown): value is BatchOutput {
  return (
    typeof value === "string" &&
    (BATCH_OUTPUTS as readonly string[]).includes(value)
  )
}

/** One document, as far as its place in the batch is concerned. */
export type LayoutDocument = {
  id: string
  originalName: string
  kind: DocumentKind
  parentDocumentId: string | null
  sourcePartPath: string | null
}

export type LayoutNode = {
  document: LayoutDocument
  parent: LayoutNode | null
  children: LayoutNode[]
}

/** `msg-12` → 12: a message's zero-based position in its mailbox. */
export function messageIndex(partPath: string | null): number | null {
  const match = /^msg-(\d+)$/.exec(partPath ?? "")
  return match ? Number(match[1]) : null
}

/**
 * The order children come out of their parent in.
 *
 * Messages by index and MIME parts segment by segment, numerically — `0.10`
 * after `0.9`, which a string sort gets wrong — so a mailbox is rebuilt in the
 * order it was written and a folder listing agrees with the batch.
 */
export function comparePartPaths(a: string | null, b: string | null): number {
  const left = messageIndex(a)
  const right = messageIndex(b)
  if (left !== null && right !== null) return left - right

  const segments = (value: string | null) =>
    (value ?? "").split(".").map((segment) => Number(segment))
  const x = segments(a)
  const y = segments(b)
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const difference = (x[index] ?? -1) - (y[index] ?? -1)
    if (Number.isFinite(difference) && difference !== 0) return difference
  }
  return (a ?? "").localeCompare(b ?? "")
}

/**
 * The batch as the tree it arrived as.
 *
 * Top-level uploads keep the order they are given in, which is the batch's
 * own order. A child whose parent is not in the list — expired before it, or
 * outside the batch — stands at the top on its own rather than disappearing:
 * a document with nowhere to go is still a document in the download.
 */
export function provenanceTree(documents: LayoutDocument[]): LayoutNode[] {
  const nodes = new Map<string, LayoutNode>(
    documents.map((document) => [
      document.id,
      { document, parent: null, children: [] },
    ])
  )

  const roots: LayoutNode[] = []
  for (const document of documents) {
    const node = nodes.get(document.id) as LayoutNode
    const parent = document.parentDocumentId
      ? nodes.get(document.parentDocumentId)
      : undefined
    if (parent && parent !== node) {
      node.parent = parent
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) =>
      comparePartPaths(a.document.sourcePartPath, b.document.sourcePartPath)
    )
  }

  return roots
}

/** Every node under these, parents before their children. */
export function walk(roots: LayoutNode[]): LayoutNode[] {
  const out: LayoutNode[] = []
  const visit = (node: LayoutNode) => {
    out.push(node)
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  return out
}

/** The top-level upload a document came out of. */
export function rootOf(node: LayoutNode): LayoutNode {
  let current = node
  while (current.parent) current = current.parent
  return current
}

/**
 * Where a document sits inside its top-level upload, as part paths.
 *
 * `["msg-3", "0.2"]` is the second part of the fourth message. Ids and paths
 * only, which is what lets the batch report say which container a file went
 * into without naming a single file.
 */
export function provenancePath(node: LayoutNode): string[] {
  const path: string[] = []
  let current: LayoutNode | null = node
  while (current?.parent) {
    path.unshift(current.document.sourcePartPath ?? current.document.id)
    current = current.parent
  }
  return path
}

/**
 * A part path as a folder or file name.
 *
 * It is already `0.2` or `msg-3` — digits, dots, a prefix this code chose —
 * and this only makes sure it stays that way whatever a future path looks like.
 */
function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "part"
}

/** `0001`: a message's folder, numbered from one like the batch names it. */
export function messageLabel(index: number, width: number): string {
  return String(index + 1).padStart(width, "0")
}

function labelWidth(children: LayoutNode[]): number {
  const highest = children.reduce(
    (max, child) =>
      Math.max(max, messageIndex(child.document.sourcePartPath) ?? 0),
    0
  )
  return Math.max(4, String(highest + 1).length)
}

/**
 * Where one document's output goes: `${dir}${stem}-redacted.<ext>`, with its
 * report and vault named from the same two parts.
 */
export type Placement = { dir: string; stem: string }

export function artifactPath(placement: Placement, extension: string): string {
  return `${placement.dir}${placement.stem}-redacted.${extension}`
}

/** Reports mirror the files they describe, under one `reports/` folder. */
export function reportPath(placement: Placement): string {
  return `reports/${placement.dir}${placement.stem}-redaction-report.json`
}

/** Beside the file it opens, never inside it. */
export function vaultPath(placement: Placement): string {
  return `${placement.dir}${placement.stem}-vault.json`
}

/**
 * What each top-level upload is called in a download, unique across them.
 *
 * Two uploads can share a name — two `invoice.pdf`s, or `invoice.pdf` and
 * `invoice.docx` — and everything named after an upload is named from this:
 * its file, its folder, its report and its vault. Made unique here, once, so
 * that a reviewer holding `invoice-2-vault.json` can tell it opens
 * `invoice-2-redacted.docx`; left to the archive, the files and the vaults
 * would each be numbered on their own and could disagree. Suffixed rather than
 * replaced, so the name the reviewer recognises survives.
 */
export function rootStems(roots: LayoutNode[]): Map<string, string> {
  const taken = new Set<string>()
  const stems = new Map<string, string>()

  for (const root of roots) {
    const base = baseName(root.document.originalName)
    let stem = base
    for (let counter = 2; taken.has(stem); counter++) {
      stem = `${base}-${counter}`
    }
    taken.add(stem)
    stems.set(root.document.id, stem)
  }

  return stems
}

/**
 * Every document's place in the processed layout.
 *
 * ```
 * inbox-redacted/
 *   0001/
 *     message-redacted.eml
 *     attachments/
 *       0.2-redacted.pdf
 * letter-redacted/
 *   letter-redacted.eml
 *   attachments/0.2-redacted.pdf
 * contract-redacted.pdf
 * ```
 *
 * A top-level upload with nothing inside it is a file at the top. One that
 * expanded is a folder named after it, holding its own output (a message's;
 * a mailbox has none) and its children: a mailbox's messages in one folder
 * each, numbered, and a message's enclosures under `attachments/` by part
 * path. An enclosure that expanded in turn — a forwarded message with files of
 * its own — is a folder of the same shape, one level down.
 */
export function processedPlacements(
  roots: LayoutNode[]
): Map<string, Placement> {
  const placements = new Map<string, Placement>()
  const stems = rootStems(roots)

  const place = (node: LayoutNode, folder: string) => {
    const { kind } = node.document

    if (kind === "mbox") {
      const width = labelWidth(node.children)
      for (const child of node.children) {
        const index = messageIndex(child.document.sourcePartPath)
        const label =
          index === null
            ? safePart(child.document.sourcePartPath ?? child.document.id)
            : messageLabel(index, width)
        const inner = `${folder}${label}/`
        placements.set(child.document.id, { dir: inner, stem: "message" })
        place(child, inner)
      }
      return
    }

    for (const child of node.children) {
      const part = safePart(child.document.sourcePartPath ?? child.document.id)
      if (child.children.length === 0) {
        placements.set(child.document.id, {
          dir: `${folder}attachments/`,
          stem: part,
        })
      } else {
        const inner = `${folder}attachments/${part}/`
        placements.set(child.document.id, { dir: inner, stem: part })
        place(child, inner)
      }
    }
  }

  for (const root of roots) {
    const stem = stems.get(root.document.id) as string

    if (root.children.length === 0) {
      placements.set(root.document.id, { dir: "", stem })
      continue
    }

    const folder = `${stem}-redacted/`
    placements.set(root.document.id, { dir: folder, stem })
    place(root, folder)
  }

  return placements
}

/** One thing that was uploaded, as it goes back out in its own format. */
export type OriginalEntry =
  /**
   * A file's own export. For a message that carried attachments this is
   * already the whole thing: the message export substitutes its redacted
   * enclosures back in and verifies each one byte for byte.
   */
  | { kind: "file"; node: LayoutNode; stem: string }
  /** A mailbox, rebuilt from its messages' exports, in mailbox order. */
  | { kind: "mailbox"; node: LayoutNode; stem: string; messages: LayoutNode[] }

/** One entry per top-level upload, in upload order. */
export function originalEntries(roots: LayoutNode[]): OriginalEntry[] {
  const stems = rootStems(roots)

  return roots.map((node) => {
    const stem = stems.get(node.document.id) as string
    return node.document.kind === "mbox"
      ? {
          kind: "mailbox" as const,
          node,
          stem,
          messages: node.children.filter(
            (child) => messageIndex(child.document.sourcePartPath) !== null
          ),
        }
      : { kind: "file" as const, node, stem }
  })
}

/** The vault for one message of a rebuilt mailbox: beside it, never in it. */
export function mailboxVaultPath(
  stem: string,
  message: LayoutNode,
  width: number
): string {
  const index = messageIndex(message.document.sourcePartPath) ?? 0
  return `${stem}-vaults/${messageLabel(index, width)}-vault.json`
}

/** The label width for a mailbox's messages, shared by folders and vaults. */
export function mailboxLabelWidth(mailbox: LayoutNode): number {
  return labelWidth(mailbox.children)
}
