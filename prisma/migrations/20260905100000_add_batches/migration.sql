-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userFingerprint" TEXT NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchRule" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pattern" TEXT NOT NULL,
    "normalizedPattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "originDocumentId" TEXT,

    CONSTRAINT "BatchRule_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "batchId" TEXT;

-- AlterTable
ALTER TABLE "GlobalRule" ADD COLUMN     "batchRuleId" TEXT;

-- CreateIndex
CREATE INDEX "Batch_userFingerprint_idx" ON "Batch"("userFingerprint");

-- CreateIndex
CREATE INDEX "BatchRule_batchId_idx" ON "BatchRule"("batchId");

-- CreateIndex
CREATE INDEX "Document_batchId_idx" ON "Document"("batchId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchRule" ADD CONSTRAINT "BatchRule_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
