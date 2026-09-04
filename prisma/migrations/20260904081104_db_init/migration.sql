-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ttlSeconds" INTEGER NOT NULL DEFAULT 86400,
    "originalName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "sourceBlobKey" TEXT,
    "uploadBlobKey" TEXT,
    "processedBlobKey" TEXT,
    "workflowRunId" TEXT,
    "encryptionKey" TEXT,
    "checksum" TEXT,
    "processedChecksum" TEXT,
    "userFingerprint" TEXT NOT NULL,
    "quotaKey" TEXT,
    "normalizedBlobKey" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redaction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "page" INTEGER,
    "text" TEXT,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "worksheet" TEXT,
    "row" INTEGER,
    "column" INTEGER,
    "reason" TEXT,
    "ruleId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Redaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalRule" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pattern" TEXT NOT NULL,
    "normalizedPattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GlobalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingEvent" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "ProcessingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportArtifact" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blobKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "appliedRedactions" INTEGER NOT NULL DEFAULT 0,
    "metadataSanitized" BOOLEAN NOT NULL DEFAULT false,
    "labelsAdded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ExportArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "pdfPages" INTEGER NOT NULL DEFAULT 0,
    "xlsxCells" INTEGER NOT NULL DEFAULT 0,
    "images" INTEGER NOT NULL DEFAULT 0,
    "docxPages" INTEGER NOT NULL DEFAULT 0,
    "uploads" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "chunks" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Document_userFingerprint_idx" ON "Document"("userFingerprint");

-- CreateIndex
CREATE INDEX "Document_expiresAt_idx" ON "Document"("expiresAt");

-- CreateIndex
CREATE INDEX "Redaction_documentId_idx" ON "Redaction"("documentId");

-- CreateIndex
CREATE INDEX "Redaction_documentId_status_idx" ON "Redaction"("documentId", "status");

-- CreateIndex
CREATE INDEX "GlobalRule_documentId_idx" ON "GlobalRule"("documentId");

-- CreateIndex
CREATE INDEX "ProcessingEvent_documentId_at_idx" ON "ProcessingEvent"("documentId", "at");

-- CreateIndex
CREATE INDEX "ExportArtifact_documentId_idx" ON "ExportArtifact"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_fingerprint_date_key" ON "UsageRecord"("fingerprint", "date");

-- CreateIndex
CREATE INDEX "AiUsage_documentId_idx" ON "AiUsage"("documentId");

-- CreateIndex
CREATE INDEX "RateLimit_updatedAt_idx" ON "RateLimit"("updatedAt");

-- AddForeignKey
ALTER TABLE "Redaction" ADD CONSTRAINT "Redaction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalRule" ADD CONSTRAINT "GlobalRule_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingEvent" ADD CONSTRAINT "ProcessingEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportArtifact" ADD CONSTRAINT "ExportArtifact_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
