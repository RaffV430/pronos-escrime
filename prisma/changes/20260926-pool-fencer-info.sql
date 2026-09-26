-- Additive metadata only. Do not run legacy migrations.
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "rankingSystem" TEXT;
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "rankingSourceUrl" TEXT;
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "rankingAsOf" TIMESTAMP(3);
ALTER TABLE "PoolFencer" ADD COLUMN IF NOT EXISTS "countryCode" TEXT;
ALTER TABLE "PoolFencer" ADD COLUMN IF NOT EXISTS "ranking" INTEGER;
