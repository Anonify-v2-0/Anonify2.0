-- The admission queue (#171). admitStalled runs on every cron tick, and
-- admitQueued whenever a run finishes, and both look for documents that are
-- queued with no workflow run, oldest first, per owner. Without this they
-- scan every document.
--
-- Partial: only queued documents with no run are in it, so it stays small
-- however many documents a deployment holds. schema.prisma declares the same
-- name and columns, without the WHERE, which Prisma's schema cannot express;
-- `prisma migrate diff` compares names and columns, so the two agree.
--
-- Not CONCURRENTLY: Prisma runs each migration in a transaction, where that
-- is not allowed. Building it takes a lock that blocks writes to "Document"
-- for as long as the build, which is a moment at the table sizes this runs at.
CREATE INDEX "Document_admission_queue_idx"
  ON "Document" ("userFingerprint", "createdAt")
  WHERE "status" = 'queued' AND "workflowRunId" IS NULL;
