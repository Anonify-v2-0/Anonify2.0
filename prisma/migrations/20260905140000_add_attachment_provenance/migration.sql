-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "parentDocumentId" TEXT,
ADD COLUMN     "sourcePartPath" TEXT;

-- CreateIndex
CREATE INDEX "Document_parentDocumentId_idx" ON "Document"("parentDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_parentDocumentId_sourcePartPath_key" ON "Document"("parentDocumentId", "sourcePartPath");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentDocumentId_fkey" FOREIGN KEY ("parentDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
