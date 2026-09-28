ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS preferences JSONB;
ALTER TABLE "PushDelivery" ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'MATCHES';
ALTER TABLE "PushDelivery" ADD COLUMN IF NOT EXISTS round TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "PushDelivery_scope_event_kind_round_key" ON "PushDelivery"("subscriptionId","competitionId","throughEventId",kind,round);
ALTER TABLE "PushDelivery" DROP CONSTRAINT IF EXISTS "PushDelivery_subscriptionId_competitionId_throughEventId_key";
DROP INDEX IF EXISTS "PushDelivery_subscriptionId_competitionId_throughEventId_key";
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "preferencesSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
