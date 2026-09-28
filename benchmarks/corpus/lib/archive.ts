import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

/**
 * A corpus is committed as one archive, `<corpus>.tar.gz`, beside the
 * directory it unpacks to. Six hundred JSON files are six hundred objects in
 * every clone and a pull request nobody can page through; one archive is one.
 * `manifest.json` stays outside it, in plain text, so what the corpus holds
 * and the hash of every file in it can still be read and diffed on GitHub.
 *
 * The directory is the working copy and is ignored by git. Every corpus script
 * brings it up to date with the archive before it reads anything, and those
 * that write pack it again afterwards, so a person who clones the repository
 * runs the same commands as the person who generated it.
 *
 * Bringing it up to date is a three-way merge against what was last unpacked
 * or packed (`.archive-state.json`, in the directory): a file only the archive
 * changed is updated, a file only you changed is kept, and one both changed is
 * kept as yours and named. A file you deleted stays deleted, which is how a
 * document is regenerated. A working copy with no files at all (a fresh clone,
 * a branch switch, `git clean`) is unpacked whole, and `--force` makes it
 * exactly the archive, discarding what differs.
 *
 * The archive is a plain ustar tarball, so `tar -xzf` reads it too. Entries
 * are sorted and carry no times, owners or modes, and it is rewritten only
 * when a file in it changed: gzip output differs between zlib builds, and an
 * archive rewritten with the same contents would be a change in git anyway.
 */

export const MANIFEST = "manifest.json"
const STATE = ".archive-state.json"
const BLOCK = 512

export function archivePath(root: string): string {
  return `${path.resolve(root)}.tar.gz`
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

// --- tar --------------------------------------------------------------------

function field(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, length, "utf8")
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`${name}: name is too long for the corpus archive`)
  }
  const header = Buffer.alloc(BLOCK)
  field(header, 0, 100, name)
  field(header, 100, 8, octal(0o644, 8))
  field(header, 108, 8, octal(0, 8))
  field(header, 116, 8, octal(0, 8))
  field(header, 124, 12, octal(size, 12))
  field(header, 136, 12, octal(0, 12))
  field(header, 148, 8, "        ")
  field(header, 156, 1, "0")
  field(header, 257, 6, "ustar\0")
  field(header, 263, 2, "00")
  let sum = 0
  for (const byte of header) sum += byte
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return header
}

/** Files as a tarball, under `prefix/`, in the order given. */
export function tar(prefix: string, files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const [name, bytes] of files) {
    parts.push(tarHeader(`${prefix}/${name}`, bytes.length), bytes)
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

function text(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? length : end).toString("utf8")
}

/**
 * The regular files in a tarball, by path relative to `prefix/`. Anything
 * outside that directory, or climbing out of it, is refused rather than
 * written somewhere it was never meant to go.
 */
export function untar(prefix: string, archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const name = [text(block, 345, 155), text(block, 0, 100)]
      .filter(Boolean)
      .join("/")
    const size = parseInt(text(block, 124, 12).trim() || "0", 8)
    const type = text(block, 156, 1) || "0"
    offset += BLOCK
    const body = archive.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK
    if (type !== "0") continue
    const relative = path.posix.normalize(name).replace(/^\.\//, "")
    if (
      !relative.startsWith(`${prefix}/`) ||
      relative.split("/").includes("..")
    ) {
      throw new Error(`the archive holds ${name}, outside ${prefix}/`)
    }
    files.set(relative.slice(prefix.length + 1), Buffer.from(body))
  }
  return files
}

// --- the corpus -------------------------------------------------------------

/** Every file in the archive, by path inside the corpus; null if there is none. */
export async function readArchive(
  root: string
): Promise<Map<string, Buffer> | null> {
  let compressed: Buffer
  try {
    compressed = await readFile(archivePath(root))
  } catch {
    return null
  }
  return untar(path.basename(root), gunzipSync(compressed))
}

/** The files that belong in the archive: all of them but the manifest and state. */
export async function readWorkingCopy(
  root: string
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(relative)
      else if (entry.isFile() && relative !== MANIFEST && relative !== STATE)
        files.set(relative, await readFile(path.join(root, relative)))
    }
  }
  await walk("")
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

async function readState(root: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path.join(root, STATE), "utf8"))
  } catch {
    return {}
  }
}

async function writeState(root: string, files: Map<string, Buffer>) {
  const state = Object.fromEntries(
    [...files].map(([name, bytes]) => [name, sha256(bytes)])
  )
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`)
}

export type SyncResult = {
  /** Whether there was an archive to sync from. */
  archive: boolean
  written: string[]
  removed: string[]
  /** Changed both here and in the archive; the local file was kept. */
  conflicts: string[]
}

/**
 * Brings the working copy up to date with the archive, keeping local work.
 * See the comment at the top of this file for how each case is decided.
 */
export async function unpack(
  root: string,
  options: { force?: boolean } = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    archive: false,
    written: [],
    removed: [],
    conflicts: [],
  }
  const archived = await readArchive(root)
  if (!archived) return result
  result.archive = true
  const local = await readWorkingCopy(root)
  const fresh = options.force || local.size === 0
  const base = fresh ? {} : await readState(root)
  const hashes = new Map(
    [...local].map(([name, bytes]) => [name, sha256(bytes)])
  )

  for (const [name, bytes] of archived) {
    const theirs = sha256(bytes)
    const mine = hashes.get(name)
    if (mine === theirs) continue
    const locallyChanged =
      !options.force &&
      (mine === undefined ? name in base : mine !== base[name])
    if (locallyChanged && base[name] !== theirs) {
      // Deleted or edited here, and the archive has moved on too.
      if (mine !== undefined) result.conflicts.push(name)
      continue
    }
    if (locallyChanged) continue
    const file = path.join(root, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
    result.written.push(name)
  }
  for (const [name, mine] of hashes) {
    if (archived.has(name)) continue
    // Removed from the archive, and untouched here since: remove it here too.
    if (options.force || base[name] === mine) {
      await rm(path.join(root, name))
      result.removed.push(name)
    }
  }
  await writeState(root, archived)
  return result
}

export type PackResult = { files: number; changed: boolean; bytes: number }

/** Writes the working copy to the archive, if anything in it changed. */
export async function pack(root: string): Promise<PackResult> {
  const files = await readWorkingCopy(root)
  const tarball = tar(path.basename(root), files)
  let existing: Buffer | null = null
  try {
    existing = gunzipSync(await readFile(archivePath(root)))
  } catch {
    existing = null
  }
  let bytes = 0
  const changed = !existing || !existing.equals(tarball)
  if (changed) {
    const compressed = gzipSync(tarball, { level: 9 })
    compressed[9] = 255 // "unknown" OS, rather than whichever built this zlib
    await writeFile(archivePath(root), compressed)
    bytes = compressed.length
  }
  await writeState(root, files)
  return { files: files.size, changed, bytes }
}

/** One line about a sync, or null when there is nothing worth saying. */
export function describeSync(root: string, result: SyncResult): string | null {
  const name = path.basename(root)
  const parts: string[] = []
  if (result.written.length)
    parts.push(`${result.written.length} file(s) unpacked from ${name}.tar.gz`)
  if (result.removed.length)
    parts.push(
      `${result.removed.length} removed that the archive no longer has`
    )
  if (result.conflicts.length)
    parts.push(
      `${result.conflicts.length} changed both here and in the archive, kept as yours: ${result.conflicts.slice(0, 5).join(", ")}${result.conflicts.length > 5 ? ", …" : ""}`
    )
  return parts.length ? parts.join("; ") : null
}

/** Unpacks before a script reads the corpus, and says what changed. */
export async function syncBeforeRun(root: string): Promise<void> {
  const note = describeSync(root, await unpack(root))
  if (note) console.log(note)
}

/** Packs after a script wrote to the corpus, and says so. */
export async function packAfterRun(root: string): Promise<void> {
  const result = await pack(root)
  if (result.changed) {
    console.log(
      `\nPacked ${result.files} files into ${path.relative(process.cwd(), archivePath(root))} (${(result.bytes / 1024 / 1024).toFixed(1)} MB). Commit it with manifest.json.`
    )
  }
}
