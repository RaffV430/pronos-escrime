-- Additive change only; do not run the legacy Prisma migration history.
BEGIN;

-- CreateTable
CREATE TABLE "Pool" (
    "id" SERIAL NOT NULL,
    "competitionId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolFencer" (
    "id" SERIAL NOT NULL,
    "poolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "wins" INTEGER,
    "losses" INTEGER,
    "indicator" INTEGER,

    CONSTRAINT "PoolFencer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolPrediction" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "fencerId" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "indicator" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pointsEarned" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoolPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pool_competitionId_name_key" ON "Pool"("competitionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PoolFencer_poolId_position_key" ON "PoolFencer"("poolId", "position");

-- CreateIndex
CREATE INDEX "PoolPrediction_fencerId_idx" ON "PoolPrediction"("fencerId");

-- CreateIndex
CREATE UNIQUE INDEX "PoolPrediction_userId_fencerId_key" ON "PoolPrediction"("userId", "fencerId");

-- AddForeignKey
ALTER TABLE "Pool" ADD CONSTRAINT "Pool_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolFencer" ADD CONSTRAINT "PoolFencer_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolPrediction" ADD CONSTRAINT "PoolPrediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolPrediction" ADD CONSTRAINT "PoolPrediction_fencerId_fkey" FOREIGN KEY ("fencerId") REFERENCES "PoolFencer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
