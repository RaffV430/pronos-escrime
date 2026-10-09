ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "federationCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Club_federationCode_key" ON "Club"("federationCode");
