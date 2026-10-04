-- Classement d'entrée dans le tableau (tête de série) de chaque tireur, publié par la source officielle.
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "seed1" INTEGER;
ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "seed2" INTEGER;
