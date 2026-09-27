ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "syncIssue" TEXT;
CREATE TABLE IF NOT EXISTS "FtlSyncState" (
 "competitionId" INTEGER PRIMARY KEY,
 "leaseToken" TEXT,
 "leaseUntil" TIMESTAMP(3),
 "lastStartedAt" TIMESTAMP(3),
 "lastFinishedAt" TIMESTAMP(3),
 "nextAutomaticAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
 "failures" INTEGER NOT NULL DEFAULT 0,
 "status" TEXT NOT NULL DEFAULT 'PENDING',
 "lastError" TEXT
);
CREATE INDEX IF NOT EXISTS "FtlSyncState_nextAutomaticAt_idx" ON "FtlSyncState"("nextAutomaticAt");
