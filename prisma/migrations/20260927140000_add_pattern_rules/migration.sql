-- AlterTable
ALTER TABLE "BatchRule" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'literal',
ADD COLUMN     "matchCase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wholeWord" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GlobalRule" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'literal',
ADD COLUMN     "matchCase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerRuleId" TEXT,
ADD COLUMN     "wholeWord" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OwnerRule" (
    "id" TEXT NOT NULL,
    "userFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'literal',
    "sealedPattern" TEXT NOT NULL,
    "matchCase" BOOLEAN NOT NULL DEFAULT false,
    "wholeWord" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "originDocumentId" TEXT,

    CONSTRAINT "OwnerRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GlobalRule_batchRuleId_idx" ON "GlobalRule"("batchRuleId");

-- CreateIndex
CREATE INDEX "GlobalRule_ownerRuleId_idx" ON "GlobalRule"("ownerRuleId");

-- CreateIndex
CREATE INDEX "OwnerRule_userFingerprint_idx" ON "OwnerRule"("userFingerprint");

-- CreateIndex
CREATE INDEX "OwnerRule_expiresAt_idx" ON "OwnerRule"("expiresAt");
