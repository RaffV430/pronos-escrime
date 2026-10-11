-- Pronostics simplifiés : vainqueur seul (match) et victoires seules (poule, indice facultatif).
ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "winnerOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PoolPrediction" ALTER COLUMN "indicator" DROP NOT NULL;
