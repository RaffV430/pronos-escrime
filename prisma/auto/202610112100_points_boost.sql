-- Points ×2 : coefficient figé par match, poule et podium, doublements actifs par épreuve.
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "pointsMultiplier" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "pointsMultiplier" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "pointsBoosts" JSONB;
ALTER TABLE "Competition" ADD COLUMN IF NOT EXISTS "podiumMultiplier" INTEGER NOT NULL DEFAULT 1;
