-- Cluster-wide concurrency leases for outbound services (#184). Used only with
-- ANONIFY_SERVICE_LIMIT_SCOPE=cluster and ANONIFY_RATE_STORE=postgres; a slot
-- per row, at most ANONIFY_{AI,OCR}_CONCURRENCY of them per service, so it
-- never grows past a few dozen rows and needs no pruning.
CREATE TABLE "ServiceLease" (
    "key" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceLease_pkey" PRIMARY KEY ("key","slot")
);
