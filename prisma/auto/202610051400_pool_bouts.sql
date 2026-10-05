-- Matrice complète des assauts de chaque poule (lecture seule, affichage des résultats).
ALTER TABLE "Pool" ADD COLUMN IF NOT EXISTS "bouts" JSONB;
