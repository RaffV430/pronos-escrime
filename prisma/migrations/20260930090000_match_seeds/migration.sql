-- Classement d'entrée dans le tableau (tête de série) de chaque tireur, tel que publié par la source officielle.
ALTER TABLE "Match" ADD COLUMN "seed1" INTEGER;
ALTER TABLE "Match" ADD COLUMN "seed2" INTEGER;
