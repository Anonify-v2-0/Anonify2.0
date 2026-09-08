# Changelog

What changed in each release of Anonify, written for someone deciding whether
to pull. What changed in the output, what changed in the configuration, what
needs a migration — not the refactors.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes that have not shipped yet are not listed here. They are one file each in
[`changelog.d/`](changelog.d/), and the release workflow assembles them into a
new section below at the moment it moves the version. See
[CONTRIBUTING.md](CONTRIBUTING.md#releases) for how to write one.

<!-- next-version -->

## [1.2.0] - 2026-09-08

### Changed

- Release notes are written by the people who make the changes. Each pull request
  that moves the version now carries a fragment in `changelog.d/`, and the release
  workflow assembles them into `CHANGELOG.md` and publishes that as the release
  body — in place of a generated list of pull request titles (#105)

## [1.1.1] - 2026-09-08

### Added

- Email bodies written in HTML are converted to markdown before analysis, so
  detection reads the text a person sees rather than the markup around it. A
  message now folds into its parts — body, alternatives, attachments — each
  handled as its own document (#103)

### Changed

- Releases are cut by a workflow rather than by hand. A merged pull request's
  labels decide which part of the version moves, and the tag, the version in
  `package.json` and the GitHub release can no longer disagree with each other
  (#106, #108, #109, #111)

## [1.1.0] - 2026-09-06

### Added

- MBOX mailboxes are accepted as an upload, and open as a batch with one
  document per message (#100)

## [1.0.0] - 2026-09-06

The first release.

### Added

- Support for CSV, TSV, plain text, RTF, EML and PPTX, alongside the PDF, DOCX,
  XLSX and image formats already handled (#72)
- An email attachment is treated as a document in its own right, and a message
  carrying attachments opens as a batch (#75)
- Anonymisation beyond masking: a method chosen per category, consistent
  variants for a repeated value, and restore for anything applied (#95)
- Exportable reports, batch review, and detection presets named for what they
  look for rather than for how they work (#71)
- A link to the repository throughout the interface (#92)

### Changed

- Batch processing runs with bounded concurrency instead of one document at a
  time (#95)
- Calls to external services are paced and retried, and their limits are
  configuration rather than constants (#97)

### Fixed

- A document that fails partway reports what actually happened instead of a
  generic error, and only the stages that can succeed are retried (#69)
