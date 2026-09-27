-- Additive only. Apply this migration explicitly, not the legacy migration chain.
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "ftlSourceUrl" TEXT;
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "ftlEventId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Tournament_ftlSourceUrl_key" ON "Tournament"("ftlSourceUrl");
CREATE UNIQUE INDEX IF NOT EXISTS "Competition_ftlEventId_key" ON "Competition"("ftlEventId");
CREATE TABLE IF NOT EXISTS "PushSubscription" (
 "id" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "endpoint" TEXT NOT NULL UNIQUE, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "tournamentIds" INTEGER[] NOT NULL DEFAULT '{}', "competitionIds" INTEGER[] NOT NULL DEFAULT '{}',
 "lastEventId" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");
CREATE TABLE IF NOT EXISTS "PushEvent" (
 "id" SERIAL PRIMARY KEY,"matchId" INTEGER NOT NULL UNIQUE,"competitionId" INTEGER NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PushEvent_createdAt_idx" ON "PushEvent"("createdAt");
CREATE TABLE IF NOT EXISTS "PushDelivery" (
 "id" TEXT PRIMARY KEY,"subscriptionId" TEXT NOT NULL REFERENCES "PushSubscription"("id") ON DELETE CASCADE,
 "competitionId" INTEGER NOT NULL,"throughEventId" INTEGER NOT NULL,"matchIds" INTEGER[] NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING',"attempts" INTEGER NOT NULL DEFAULT 0,"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3),"sentAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("subscriptionId","competitionId","throughEventId")
);
CREATE INDEX IF NOT EXISTS "PushDelivery_status_nextAttemptAt_idx" ON "PushDelivery"("status","nextAttemptAt");
