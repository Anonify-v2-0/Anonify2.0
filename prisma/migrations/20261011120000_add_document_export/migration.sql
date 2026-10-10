-- Single exports run in the background (#187). A DocumentExport is one
-- request: its status, progress and the requester's public key, which a
-- vault is sealed to. Each artifact it produces names it, one per variant,
-- so a retried step overwrites its own row. vaultRecipient marks a vault
-- sealed to the requester rather than the document: an envelope Anonify
-- cannot open (docs/security-internals.md §11).
-- AlterTable
ALTER TABLE "ExportArtifact" ADD COLUMN     "exportId" TEXT,
ADD COLUMN     "vaultRecipient" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DocumentExport" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "workflowRunId" TEXT,
    "variants" JSONB NOT NULL,
    "metadataSanitized" BOOLEAN NOT NULL DEFAULT true,
    "recipientKey" TEXT,
    "progress" JSONB,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "DocumentExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentExport_documentId_createdAt_idx" ON "DocumentExport"("documentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExportArtifact_exportId_variant_key" ON "ExportArtifact"("exportId", "variant");

-- AddForeignKey
ALTER TABLE "ExportArtifact" ADD CONSTRAINT "ExportArtifact_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "DocumentExport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentExport" ADD CONSTRAINT "DocumentExport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

