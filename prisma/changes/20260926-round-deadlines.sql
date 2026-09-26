-- Apply this additive change explicitly; do not replay historical Prisma migrations.
BEGIN;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "resultRegisteredAt" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS "MatchRound" (
 "competitionId" INTEGER NOT NULL REFERENCES "Competition"(id) ON DELETE CASCADE,
 round TEXT NOT NULL,
 "previousRound" TEXT,
 "expectedMatchCount" INTEGER NOT NULL CHECK ("expectedMatchCount">0),
 "sourceUrl" TEXT NOT NULL,
 "verifiedAt" TIMESTAMP(3) NOT NULL,
 "manualUnlockUntil" TIMESTAMP(3),
 PRIMARY KEY ("competitionId",round),
 CHECK ("previousRound" IS NULL OR "previousRound"<>round),
 FOREIGN KEY ("competitionId","previousRound") REFERENCES "MatchRound"("competitionId",round) DEFERRABLE INITIALLY DEFERRED
);
-- Database trigger covers manual SQL imports as well as API/Google Sheet results.
-- An identical reimport or score correction never restarts the ten-minute delay.
CREATE OR REPLACE FUNCTION record_match_result_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."isFinished" THEN
  IF TG_OP='INSERT' THEN NEW."resultRegisteredAt"=clock_timestamp();
  ELSIF NOT OLD."isFinished" OR OLD."resultRegisteredAt" IS NULL THEN NEW."resultRegisteredAt"=clock_timestamp();
  ELSE NEW."resultRegisteredAt"=OLD."resultRegisteredAt";
  END IF;
 ELSE NEW."resultRegisteredAt"=NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS match_result_registration ON "Match";
CREATE TRIGGER match_result_registration BEFORE INSERT OR UPDATE ON "Match"
 FOR EACH ROW EXECUTE FUNCTION record_match_result_time();
-- Existing finals intentionally remain without a historical timestamp: verify/reimport
-- them when activating each manifest. Never infer completion from a partial import.
COMMIT;
