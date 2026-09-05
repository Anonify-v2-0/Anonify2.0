-- Quota counters for the formats added alongside them.
--
-- Text pages and slides are new units because the existing ones would lie: a
-- slide is not a page, and counting an email as a page would charge a one-line
-- reply the same as a forwarded thread. Email is charged by the kibibyte of
-- decoded text instead, which tracks what the pipeline actually does.
--
-- Grid formats share "xlsxCells": a workbook, a CSV and a TSV cost the same
-- per filled cell, so a second column for the same unit would only be a second
-- number to keep in step.
ALTER TABLE "UsageRecord" ADD COLUMN "textPages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "emailKilobytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "pptxSlides" INTEGER NOT NULL DEFAULT 0;
