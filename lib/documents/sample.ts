/**
 * How much of a file content sniffing may read.
 *
 * `detectDocumentType` decides from the head of a file and never looks past
 * this many bytes — the zip part scan and the text check read exactly this
 * much, and every other signature sits well inside it. That contract is what
 * lets the pipeline sniff without holding the file: ingest reads this much of
 * an upload, decides, and streams the rest straight into the sealer; a
 * mailbox keeps this much of each message and nothing more.
 *
 * A module of its own, with no imports, because both the detector and the
 * mailbox scanner need it and each already imports the other's neighbour.
 */
export const DETECTION_SAMPLE_BYTES = 64 * 1024
