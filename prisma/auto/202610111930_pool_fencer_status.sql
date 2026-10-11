-- Statut particulier d'un tireur en poule (absent, retrait médical, exclu), saisi par l'administration.
ALTER TABLE "PoolFencer" ADD COLUMN IF NOT EXISTS "status" TEXT;
