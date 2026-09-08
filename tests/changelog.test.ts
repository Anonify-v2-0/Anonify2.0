import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  insertSection,
  MARKER,
  readFragments,
  renderBody,
  renderEntry,
  renderSection,
} from "@/scripts/changelog.mjs"
import {
  bumpForLabel,
  bumpsVersion,
  resolveBump,
} from "@/scripts/release-labels.mjs"

/**
 * The changelog is assembled by a workflow, which is the one place a mistake
 * cannot be caught by reading the diff — nobody reviews a release commit before
 * it exists. So the logic behind it is tested here rather than discovered in a
 * release body.
 */

function fragmentDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-"))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

describe("the label table", () => {
  it("reads a feature as a minor and a fix as a patch", () => {
    expect(bumpForLabel("enhancement")).toBe("minor")
    expect(bumpForLabel("formats")).toBe("minor")
    expect(bumpForLabel("bug")).toBe("patch")
    expect(bumpForLabel("performance")).toBe("patch")
  })

  it("treats a security fix as urgent, not incompatible", () => {
    expect(bumpForLabel("security")).toBe("patch")
  })

  it("asks for nothing from a label that is not about the product", () => {
    expect(bumpForLabel("docs")).toBe("none")
    expect(bumpForLabel("documentation")).toBe("none")
    expect(bumpForLabel("question")).toBe("none")
    expect(bumpForLabel("good first issue")).toBe("none")
  })

  it("lets no label reach a major", () => {
    const everyLabel = [
      "enhancement",
      "formats",
      "bug",
      "performance",
      "testing",
      "ci",
      "infrastructure",
      "ux",
      "accessibility",
      "security",
      "benchmark",
      "docs",
    ]

    expect(resolveBump(everyLabel).bump).not.toBe("major")
  })

  it("takes the highest bump when labels disagree", () => {
    expect(resolveBump(["bug", "enhancement"]).bump).toBe("minor")
    expect(resolveBump(["formats", "testing"]).bump).toBe("minor")
  })

  it("does not let docs veto a bump, only fail to raise one", () => {
    expect(resolveBump(["docs", "bug"]).bump).toBe("patch")
    expect(resolveBump(["docs"]).bump).toBe("none")
  })

  it("agrees with itself about whether a pull request releases", () => {
    expect(bumpsVersion(["bug"])).toBe(true)
    expect(bumpsVersion(["docs"])).toBe(false)
    expect(bumpsVersion([])).toBe(false)
  })
})

describe("reading fragments", () => {
  it("parses the number and the section out of the filename", () => {
    const dir = fragmentDir({
      "88.added.md": "MBOX mailboxes open as a batch\n",
      "103.fixed.md": "OCR no longer times out\n",
    })

    const fragments = readFragments(dir)

    expect(fragments).toHaveLength(2)
    expect(fragments[0]).toMatchObject({ reference: 103, type: "fixed" })
    expect(fragments[1]).toMatchObject({ reference: 88, type: "added" })
  })

  it("accepts a name that is not a number, and gives it no reference", () => {
    const dir = fragmentDir({ "mbox-batches.added.md": "Mailboxes\n" })

    expect(readFragments(dir)[0]).toMatchObject({
      name: "mbox-batches",
      reference: null,
    })
  })

  it("ignores the directory's own documentation", () => {
    const dir = fragmentDir({
      "README.md": "# how to write one",
      "88.added.md": "Something\n",
    })

    expect(readFragments(dir).map((f) => f.file)).toEqual(["88.added.md"])
  })

  // Each of these would otherwise be dropped silently, and the entry would be
  // missing from a release nobody thought to check.
  it("refuses a filename it cannot parse", () => {
    const dir = fragmentDir({ "notes.md": "Something" })
    expect(() => readFragments(dir)).toThrow(/not a changelog fragment/)
  })

  it("refuses a section that does not exist", () => {
    const dir = fragmentDir({ "88.fix.md": "Something" })
    expect(() => readFragments(dir)).toThrow(/unknown section "fix"/)
  })

  it("refuses an empty fragment", () => {
    const dir = fragmentDir({ "88.added.md": "   \n\n" })
    expect(() => readFragments(dir)).toThrow(/is empty/)
  })

  it("has nothing to say about a directory that does not exist", () => {
    expect(readFragments(join(tmpdir(), "no-such-directory-here"))).toEqual([])
  })
})

describe("rendering", () => {
  it("puts the reference at the end of the entry, not mid-sentence", () => {
    const entry = renderEntry({
      text: "MBOX mailboxes are accepted as an upload, and open as a batch\nwith one document per message",
      reference: 88,
    })

    expect(entry).toBe(
      "- MBOX mailboxes are accepted as an upload, and open as a batch\n  with one document per message (#88)"
    )
  })

  it("does not repeat a reference the author already wrote", () => {
    const entry = renderEntry({ text: "Fixes the thing (#88)", reference: 88 })
    expect(entry).toBe("- Fixes the thing (#88)")
  })

  it("orders sections the way Keep a Changelog does", () => {
    const dir = fragmentDir({
      "1.security.md": "A value survived redaction",
      "2.added.md": "A format",
      "3.fixed.md": "A crash",
      "4.changed.md": "A default",
    })

    const headings = renderBody(readFragments(dir))
      .split("\n")
      .filter((line) => line.startsWith("### "))

    expect(headings).toEqual([
      "### Added",
      "### Changed",
      "### Fixed",
      "### Security",
    ])
  })

  it("orders entries within a section by their number", () => {
    const dir = fragmentDir({
      "103.added.md": "Later",
      "88.added.md": "Earlier",
    })

    expect(renderBody(readFragments(dir))).toBe(
      "### Added\n\n- Earlier (#88)\n- Later (#103)"
    )
  })

  it("says so plainly when a release carries no entries", () => {
    expect(renderBody([])).toMatch(/No user-facing changes/)
  })

  it("heads a section with its version and date", () => {
    const section = renderSection("1.2.0", "2026-09-08", [])
    expect(section.split("\n")[0]).toBe("## [1.2.0] - 2026-09-08")
  })
})

describe("inserting into the changelog", () => {
  const changelog = `# Changelog\n\nPreamble.\n\n${MARKER}\n\n## [1.1.1] - 2026-09-08\n\n### Fixed\n\n- Something\n`

  it("puts the newest version directly below the marker", () => {
    const updated = insertSection(
      changelog,
      "## [1.2.0] - 2026-09-09\n\n### Added\n\n- A thing"
    )
    const versions = updated
      .split("\n")
      .filter((line) => line.startsWith("## ["))

    expect(versions).toEqual([
      "## [1.2.0] - 2026-09-09",
      "## [1.1.1] - 2026-09-08",
    ])
  })

  it("keeps the history it found", () => {
    const updated = insertSection(
      changelog,
      "## [1.2.0] - 2026-09-09\n\n- A thing"
    )
    expect(updated).toContain("## [1.1.1] - 2026-09-08")
    expect(updated).toContain("Preamble.")
  })

  it("refuses a changelog with nowhere to put the section", () => {
    expect(() =>
      insertSection("# Changelog\n\nNo marker here.\n", "## [1.2.0]")
    ).toThrow(/marker/)
  })
})
