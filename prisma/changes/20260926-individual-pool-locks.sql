-- Additive only: do not execute legacy Prisma migrations. Existing pools retain their locks.
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "lockMode" TEXT NOT NULL DEFAULT 'TIME';
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "sourcePoolNumber" INTEGER;
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "sourceCheckedAt" TIMESTAMP(3);
ALTER TABLE "PoolFencer" ADD COLUMN IF NOT EXISTS "firstResultAt" TIMESTAMP(3);
ALTER TABLE "Pool" ALTER COLUMN "lockMode" SET DEFAULT 'FIRST_RESULT';
