-- Recherche des matchs et poules d'un tireur par nom (sans tenir compte des majuscules) : index trigrammes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Match_player1_trgm_idx" ON "Match" USING gin ("player1" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Match_player2_trgm_idx" ON "Match" USING gin ("player2" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "PoolFencer_name_trgm_idx" ON "PoolFencer" USING gin ("name" gin_trgm_ops);
