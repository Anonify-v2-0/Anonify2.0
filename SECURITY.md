# Security policy

Anonify's job is to make information leave a document. A bug here is not a
crash — it is a value someone believed was gone, sitting in a file they have
already sent to somebody else. Please report those privately first.

## Reporting

**Use GitHub's private vulnerability reporting:** the **Security** tab of
[nabeel-w/Anonify2.0](https://github.com/nabeel-w/Anonify2.0/security) →
**Report a vulnerability**. That opens a private advisory only the maintainers
can read, and it is the fastest way to reach us.

If that is unavailable to you, open a normal issue saying only *"I have a
security report, how should I send it"* — no details — and you will be pointed
somewhere private.

Please do **not** open a public issue or PR that demonstrates a bypass, even a
small one. The demonstration is the dangerous part: this repo is cloned and run
by people on their own documents, and a public recipe reaches them before a fix
does.

### What to include

- What you did, at the level of "upload this file, accept this suggestion,
  export".
- What you got back, and which value survived.
- A **synthetic** file that reproduces it. Never attach a document containing
  somebody's real personal data — a fixture with `john.smith@example.com` in it
  proves the same bug, and `tests/fixtures.ts` builds files of exactly this kind.
- The commit or release you tested.

### What to expect

This is a small project run by volunteers, so no clock is promised. In practice:
an acknowledgement within a few days, an assessment of whether it breaks one of
the invariants below, and a fix with a regression test before the advisory is
made public. You will be credited in the advisory unless you ask not to be.

## What counts

A report is in scope if it breaks one of the invariants in
[CONTRIBUTING.md](CONTRIBUTING.md#the-invariants). Concretely, we want to hear
about anything of this shape:

- **A value survives an export.** Text recoverable from an exported PDF, DOCX,
  XLSX or image after being accepted — by copy-paste, by `strings`, by unzipping
  the OOXML, by reading an XMP or EXIF block, by an undo history, by a thumbnail
  or preview image the format kept, or by any other route.
- **The verification pass can be fooled.** An export that ships despite an
  accepted value still being present, because the check looked for the value in
  a different normalization than the one the file stored it in.
- **The canvas and the export disagree.** A black box drawn in one place and
  burned in another. Anonify tells users that what they see is what they get,
  so a placement bug is a security bug, not a visual one.
- **A redaction that covers rather than removes.** An overlay, a white-on-white
  run, a deletable annotation, a clipping path — anything where the original
  content is still in the bytes.
- **Cross-tenant reads.** Any way to read, export or delete a document that is
  not yours: a document id that is guessable, an ownership check that is missing
  or comparing the wrong key, a signed URL that outlives its grant or works for
  a different document.
- **Content in a log.** Document text, extracted spans, OCR output, prompts,
  model responses or encryption keys reaching stdout, a log line, or an error
  message returned to the client.
- **Key and crypto handling.** Anything derived rather than random, a nonce
  reused, a ciphertext accepted without its tag being checked.
- **A quota or rate limit enforced only in the browser.**

## What does not count

Not because these do not matter, but because they are known and written down:

- **Blur and pixelate are not equivalent to a solid fill.** Both re-encode the
  pixels, so the original data is gone from the output — but a blurred region of
  known text is a puzzle with a small answer space, and heavy blurring has been
  attacked in public research. Solid fill is the default for that reason, text
  is always filled solid regardless of the chosen style, and the trade-off is
  stated in the export dialog. An attack on a *blurred face* is expected
  behaviour; an attack recovering pixels a *solid* fill covered is a real bug.
- **A rasterized PDF page loses its text layer.** Known, deliberate, and
  [tracked](CONTRIBUTING.md#34-depth-on-what-exists). Removal beats
  selectability until content-stream surgery lands behind the same verification.
- **The model missed something.** Detection is a proposal and a human decides;
  a missed entity is a quality issue, not a vulnerability. A model *inventing* a
  value that then gets applied would be one — but the pipeline discards any
  reported value it cannot locate in the source, so if you find a path around
  that, please do report it.
- **The hosted demo has no accounts.** It is anonymous by design: a session
  cookie is the identity. Guessing *your own* cookie is not a finding. Reading
  somebody else's documents is.
- **Findings from a scanner with no working proof.** A dependency advisory for a
  code path this project does not call, or a header-grading report, will
  probably be closed. A version bump PR for a real advisory is welcome.

## Supported versions

There are no releases yet. `main` is the supported version, and fixes land
there. If you are running a self-hosted install, pull.

## Reporting to a self-hosted operator

Anonify is designed to be run on your own machine, against your own database and
storage, with no telemetry. That means we cannot see your instance and cannot
notify you. If you deploy it for other people, subscribe to this repository's
security advisories.
