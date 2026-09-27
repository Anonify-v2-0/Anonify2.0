-- A daily allowance for Hush, counted in model tokens.
--
-- Analysis is paid for through the document allowances above: a page costs a
-- page, however many times it is asked about. A conversation has no such
-- shape. Every step resends the history and the tool results, so the only
-- unit that tracks what a visitor spends is the tokens themselves, charged
-- step by step as the provider reports them.
ALTER TABLE "UsageRecord" ADD COLUMN "assistantTokens" INTEGER NOT NULL DEFAULT 0;
