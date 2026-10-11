-- Export runs a dead worker left behind are restarted by the sweep (#243),
-- as document runs already are (#182). The count stops a run that keeps
-- killing its worker from being restarted forever.
-- AlterTable
ALTER TABLE "DocumentExport" ADD COLUMN     "recoveries" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BatchExport" ADD COLUMN     "recoveries" INTEGER NOT NULL DEFAULT 0;
