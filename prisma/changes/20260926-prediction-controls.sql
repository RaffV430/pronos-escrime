BEGIN;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "manualUnlock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "winner" INTEGER;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "resultType" TEXT;
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "podiumManualUnlock" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_casefold_key" ON "User" (lower(btrim(email)));
CREATE UNIQUE INDEX IF NOT EXISTS "User_name_casefold_key" ON "User" (lower(btrim(name)));
COMMIT;
