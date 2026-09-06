import { describe, expect, it } from "vitest"

import {
  formatByteSize,
  parseByteSize,
  readByteSizeEnv,
} from "@/lib/config/bytes"
import {
  DEFAULT_EML_LIMITS,
  emlLimits,
  envName,
} from "@/lib/documents/eml/limits"
import {
  DEFAULT_EXPANSION_LIMITS,
  expansionEnvName,
  expansionLimits,
} from "@/lib/documents/eml/attachments"
import { mboxEnvName, mboxLimits } from "@/lib/documents/mbox/limits"

/**
 * Sizes, written the way people write sizes.
 *
 * These settings were byte counts, which meant bounding a mailbox at 32 MiB was
 * `33554432` typed into a `.env` file. The failure mode is not a syntax error —
 * it is a plausible number off by a factor of a thousand, accepted, in force,
 * and discovered when a file somebody expected to work is refused.
 *
 * Two things have to hold for the fix to be worth anything: what somebody types
 * has to mean what they think, and what was already in their `.env` has to keep
 * working. The second matters more than it looks — this is a setting people
 * have deployed.
 */

describe("reading a size", () => {
  it("reads the units people actually write", () => {
    expect(parseByteSize("32MB")).toBe(32 * 1024 * 1024)
    expect(parseByteSize("512KB")).toBe(512 * 1024)
    expect(parseByteSize("1GB")).toBe(1024 ** 3)
    expect(parseByteSize("1.5GB")).toBe(1.5 * 1024 ** 3)
  })

  it("does not care how it was typed", () => {
    const expected = 32 * 1024 * 1024
    for (const written of [
      "32mb",
      "32 MB",
      " 32Mb ",
      "32MiB",
      "32m",
      "32_MB",
    ]) {
      expect(parseByteSize(written)).toBe(expected)
    }
  })

  it("treats a unit as a power of two, and says so by agreeing with itself", () => {
    // `MB` and `MiB` are the same number here, which is what `ls -h` and
    // `docker --memory` already do. The alternative is being pedantically
    // correct about SI while every neighbouring tool is not, which buys a 2.4%
    // difference in exchange for a surprise.
    expect(parseByteSize("1MB")).toBe(parseByteSize("1MiB"))
    expect(parseByteSize("1KB")).toBe(1024)
  })

  it("still reads a plain number as bytes", () => {
    // The compatibility that matters: an existing .env keeps working, and
    // anyone who thinks in bytes can keep doing so.
    expect(parseByteSize("33554432")).toBe(33_554_432)
    expect(parseByteSize("1048576")).toBe(1024 * 1024)
  })

  it("refuses what is not a size, rather than guessing at it", () => {
    for (const written of [
      "",
      "lots",
      "32TB",
      "-1MB",
      "MB",
      "32 32",
      "1.5",
      "0x20",
    ]) {
      expect(parseByteSize(written)).toBeNull()
    }
  })

  it("refuses zero, because a ceiling of zero refuses every document", () => {
    expect(parseByteSize("0")).toBeNull()
    expect(parseByteSize("0MB")).toBeNull()
  })
})

describe("showing a size", () => {
  it("writes back something that can be typed in again", () => {
    for (const bytes of [1024, 512 * 1024, 32 * 1024 * 1024, 1024 ** 3]) {
      expect(parseByteSize(formatByteSize(bytes))).toBe(bytes)
    }
  })

  it("prefers a whole number of units", () => {
    expect(formatByteSize(32 * 1024 * 1024)).toBe("32MB")
    expect(formatByteSize(512 * 1024)).toBe("512KB")
    expect(formatByteSize(1024 ** 3)).toBe("1GB")
    expect(formatByteSize(25 * 1024 * 1024)).toBe("25MB")
  })

  it("prefers an exact smaller unit to a rounded larger one", () => {
    // 1.5 MB is a whole 1536 KB, and the exact form wins: a default printed as
    // "1.5MB" and a default printed as "1536KB" are the same number, but only
    // one of them is still the same number after somebody edits it.
    expect(formatByteSize(1024 * 1024 + 512 * 1024)).toBe("1536KB")
  })

  it("falls back to one decimal, and then to bytes", () => {
    // Whole in no unit at all, so there is nothing exact left to prefer.
    expect(formatByteSize(1.5 * 1024 ** 3 + 1)).toBe("1.5GB")
    expect(formatByteSize(500)).toBe("500B")
  })
})

describe("a size read out of the environment", () => {
  it("keeps the default when nothing is set", () => {
    delete process.env.ANONIFY_TEST_SIZE
    expect(readByteSizeEnv("ANONIFY_TEST_SIZE", 4096)).toBe(4096)
  })

  it("reports a malformed one rather than ignoring it", () => {
    // A limit somebody believes they set and which is not in force is worse
    // than no setting at all, and the message names the variable because that
    // is the half of the sentence somebody can act on.
    process.env.ANONIFY_TEST_SIZE = "plenty"
    try {
      expect(() => readByteSizeEnv("ANONIFY_TEST_SIZE", 4096)).toThrow(
        /ANONIFY_TEST_SIZE must be a size like 32MB/
      )
    } finally {
      delete process.env.ANONIFY_TEST_SIZE
    }
  })
})

describe("the limits that are sizes", () => {
  /** Sets a variable for one assertion and puts the environment back. */
  function withEnv(name: string, value: string, run: () => void): void {
    const before = process.env[name]
    process.env[name] = value
    try {
      run()
    } finally {
      if (before === undefined) delete process.env[name]
      else process.env[name] = before
    }
  }

  it("reads the mailbox's two sizes as sizes", () => {
    withEnv(mboxEnvName("maxTotalBytes"), "128MB", () => {
      expect(mboxLimits().maxTotalBytes).toBe(128 * 1024 * 1024)
    })
    withEnv(mboxEnvName("maxMessageBytes"), "512KB", () => {
      expect(mboxLimits().maxMessageBytes).toBe(512 * 1024)
    })
  })

  it("reads the email parser's two sizes as sizes", () => {
    withEnv(envName("maxTextBytes"), "8MB", () => {
      expect(emlLimits().maxTextBytes).toBe(8 * 1024 * 1024)
    })
    withEnv(envName("maxHeaderBytes"), "256KB", () => {
      expect(emlLimits().maxHeaderBytes).toBe(256 * 1024)
    })
  })

  it("reads expansion's two sizes as sizes", () => {
    withEnv(expansionEnvName("maxExpandedBytes"), "1GB", () => {
      expect(expansionLimits().maxExpandedBytes).toBe(1024 ** 3)
    })
    withEnv(expansionEnvName("maxAttachmentBytes"), "10MB", () => {
      expect(expansionLimits().maxAttachmentBytes).toBe(10 * 1024 * 1024)
    })
  })

  it("leaves the counts as counts", () => {
    // A count is not a size, and reading `20` as twenty bytes would be a very
    // quiet way to make a batch of one.
    withEnv(mboxEnvName("maxMessages"), "500", () => {
      expect(mboxLimits().maxMessages).toBe(500)
    })
    withEnv(expansionEnvName("maxChildren"), "9", () => {
      expect(expansionLimits().maxChildren).toBe(9)
    })
    withEnv(envName("maxParts"), "50", () => {
      expect(emlLimits().maxParts).toBe(50)
    })
  })

  it("reports a malformed size against every one of them", () => {
    for (const name of [
      mboxEnvName("maxTotalBytes"),
      mboxEnvName("maxMessageBytes"),
      envName("maxTextBytes"),
      envName("maxHeaderBytes"),
      expansionEnvName("maxExpandedBytes"),
      expansionEnvName("maxAttachmentBytes"),
    ]) {
      withEnv(name, "loads", () => {
        const read = name.includes("MBOX")
          ? mboxLimits
          : name.includes("EXPANSION")
            ? expansionLimits
            : emlLimits
        expect(read).toThrow(new RegExp(`${name} must be a size`))
      })
    }
  })

  it("still accepts the byte counts an older .env holds", () => {
    // The defaults themselves, written the old way. Nobody's deployment breaks
    // because the units got friendlier.
    withEnv(
      envName("maxTextBytes"),
      String(DEFAULT_EML_LIMITS.maxTextBytes),
      () => {
        expect(emlLimits().maxTextBytes).toBe(DEFAULT_EML_LIMITS.maxTextBytes)
      }
    )
    withEnv(
      expansionEnvName("maxAttachmentBytes"),
      String(DEFAULT_EXPANSION_LIMITS.maxAttachmentBytes),
      () => {
        expect(expansionLimits().maxAttachmentBytes).toBe(
          DEFAULT_EXPANSION_LIMITS.maxAttachmentBytes
        )
      }
    )
    withEnv(mboxEnvName("maxTotalBytes"), "33554432", () => {
      expect(mboxLimits().maxTotalBytes).toBe(32 * 1024 * 1024)
    })
  })

  it("shows every default as something that can be typed back in", () => {
    // The property the setup script relies on: what it prints as a default is
    // a valid answer to the question it just asked.
    for (const bytes of [
      DEFAULT_EML_LIMITS.maxTextBytes,
      DEFAULT_EML_LIMITS.maxHeaderBytes,
      DEFAULT_EXPANSION_LIMITS.maxExpandedBytes,
      DEFAULT_EXPANSION_LIMITS.maxAttachmentBytes,
      mboxLimits("demo").maxTotalBytes,
      mboxLimits("demo").maxMessageBytes,
      mboxLimits("self-hosted").maxTotalBytes,
      mboxLimits("self-hosted").maxMessageBytes,
    ]) {
      expect(parseByteSize(formatByteSize(bytes))).toBe(bytes)
    }
  })
})
