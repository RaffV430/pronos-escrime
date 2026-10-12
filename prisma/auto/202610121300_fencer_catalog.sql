ALTER TABLE "FencerAffiliation" ADD COLUMN IF NOT EXISTS "federationKey" TEXT;
ALTER TABLE "FencerAffiliation" ADD COLUMN IF NOT EXISTS "birthYear" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "FencerAffiliation_federationKey_key" ON "FencerAffiliation"("federationKey");
ALTER TABLE "FollowedFencer" ALTER COLUMN "originCompetitionId" DROP NOT NULL;
ALTER TABLE "FollowedFencer" ADD COLUMN IF NOT EXISTS "affiliationId" INTEGER REFERENCES "FencerAffiliation"("id");
