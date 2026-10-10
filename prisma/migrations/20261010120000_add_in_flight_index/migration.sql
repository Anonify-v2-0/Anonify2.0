-- Documents with a run in flight (#181, #182). Two queries look for them
-- across every owner: the global admission cap counts them, and the
-- lost-worker sweep looks for the ones whose last progress is too old. Both
-- would otherwise scan every document.
--
-- Partial, like the admission queue's index: only documents a run is working
-- on are in it, so it stays the size of the work in flight. schema.prisma
-- declares the same name and column without the WHERE, which Prisma's schema
-- cannot express.
CREATE INDEX "Document_in_flight_idx"
  ON "Document" ("updatedAt")
  WHERE "workflowRunId" IS NOT NULL
    AND "status" IN ('queued', 'extracting', 'normalizing', 'analyzing');
