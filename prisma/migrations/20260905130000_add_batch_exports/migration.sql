-- CreateTable
CREATE TABLE "BatchExport" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "workflowRunId" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "exported" INTEGER NOT NULL DEFAULT 0,
    "documents" JSONB,
    "options" JSONB,
    "networkKey" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "BatchExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchExport_batchId_idx" ON "BatchExport"("batchId");

-- CreateIndex
CREATE INDEX "BatchExport_batchId_status_idx" ON "BatchExport"("batchId", "status");

-- AddForeignKey
ALTER TABLE "BatchExport" ADD CONSTRAINT "BatchExport_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
